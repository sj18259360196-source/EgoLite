import assert from "node:assert/strict";
import test from "node:test";
import { BrokerCore } from "./broker.ts";
import { FakeBrowserBackend } from "./backend.ts";
import { TaskSpaceService } from "./task-space-service.ts";

test("legacy stable identities retain a pending return across restart", async () => {
  const digest = "abcdef0123456789abcdef01";
  const original = new TaskSpaceService();
  const created = original.create("old record", `codex-cli-${digest}`);
  original.userTakeover(created.id);
  original.returnToAgent(created.id, "desktop-user");
  const record = { ...original.byId(created.id), lastAgentClientId: `codex-mcp-${digest}` };
  const restored = new TaskSpaceService({ store: { load: () => [record], save() {} } });
  restored.recoverAfterRestart();
  const broker = new BrokerCore(restored, new FakeBrowserBackend());
  broker.setControlConsentPolicy("strict");
  const taken = await broker.useOrCreateTaskSpace(created.id, `codex-${digest}`);
  assert.equal(taken.ownership, "agent");
  assert.equal(taken.lastAgentClientId, `codex-${digest}`);
  assert.equal(broker.spaces.currentLease(`codex-cli-${digest}`).epoch, taken.leaseEpoch);
});

test("failed creation releases its name lock and permits retry", async () => {
  let fail = true;
  const backend = new class extends FakeBrowserBackend {
    override async createSpace(space: Parameters<FakeBrowserBackend["createSpace"]>[0]) {
      if (fail) { fail = false; throw new Error("creation failed"); }
      await super.createSpace(space);
    }
  }();
  const broker = new BrokerCore(new TaskSpaceService(), backend);
  const outcomes = await Promise.allSettled([
    broker.useOrCreateTaskSpace("retry", "agent-a"),
    broker.useOrCreateTaskSpace("retry", "agent-a"),
  ]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "fulfilled");
  assert.equal(broker.spaces.list().length, 1);
});

test("ordinary create and atomic use share the same name lock", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  const [first, reused] = await Promise.all([
    broker.createTaskSpace("unique", "agent-a"),
    broker.useOrCreateTaskSpace("unique", "agent-a"),
  ]);
  assert.equal(first.id, reused.id);
  await assert.rejects(() => broker.createTaskSpace("unique", "agent-b"), /already exists/);
});

test("atomic use respects strict consent and a user stop", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  const first = await broker.useOrCreateTaskSpace("permissions", "agent-a");
  broker.setControlConsentPolicy("strict");
  await broker.userTakeoverTaskSpace(first.id);
  await assert.rejects(() => broker.useOrCreateTaskSpace("permissions", "agent-a"), /consent/);
  broker.authorizeTakeover(first.id);
  assert.equal((await broker.useOrCreateTaskSpace("permissions", "agent-a")).ownership, "agent");
  await broker.stopAgentTaskSpace(first.id);
  broker.setControlConsentPolicy("automatic");
  await assert.rejects(() => broker.useOrCreateTaskSpace("permissions", "agent-a"), /stopped/);
  assert.equal(broker.spaces.list().length, 1);
});

test("concurrent useOrCreate requests await one backend creation", async () => {
  let creations = 0;
  const backend = new class extends FakeBrowserBackend {
    override async createSpace(space: Parameters<FakeBrowserBackend["createSpace"]>[0]) {
      creations++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      await super.createSpace(space);
    }
  }();
  const broker = new BrokerCore(new TaskSpaceService(), backend);
  const results = await Promise.all(Array.from({ length: 12 }, () => broker.useOrCreateTaskSpace("shared", "agent-a")));
  assert.equal(creations, 1);
  assert.equal(new Set(results.map((space) => space.id)).size, 1);
  await assert.rejects(() => broker.useOrCreateTaskSpace("shared", "agent-b"), /another agent/);
  assert.equal(broker.listTaskSpaces().taskSpaces.length, 1);
});

test("ambiguous old names remain untouched and explicit IDs work", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  const first = await broker.createTaskSpace("duplicate", "agent-a");
  const legacy = broker.spaces.create("duplicate", "agent-a");
  await broker.backend.createSpace(legacy);
  await assert.rejects(() => broker.useOrCreateTaskSpace("duplicate", "agent-a"), /ambiguous/);
  assert.equal((await broker.useOrCreateTaskSpace(first.id, "agent-a")).id, first.id);
  assert.equal(broker.listTaskSpaces().taskSpaces.length, 2);
});

test("concurrent tab reuse creates once and all matching modes stay task scoped", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  const space = await broker.useOrCreateTaskSpace("tabs", "agent-a");
  const open = (url: string, match = "exact") => broker.openOrReuseTab("agent-a", space.leaseEpoch, url, match, space.id);
  const tabs = await Promise.all(Array.from({ length: 12 }, () => open("https://example.test/path/?a=1")));
  assert.equal(tabs.filter((tab) => !tab.reused).length, 1);
  assert.equal(new Set(tabs.map((tab) => tab.targetId)).size, 1);
  assert.equal((await open("https://example.test/other", "origin")).reused, true);
  assert.equal((await open("https://example.test/path?b=2", "origin+path")).reused, true);
  assert.equal((await open("example.test/path", "includes")).reused, true);
  assert.equal((await open("https://example.test/path?b=2", "exact")).reused, false);
  const other = await broker.useOrCreateTaskSpace("other", "agent-b");
  assert.equal((await broker.openOrReuseTab("agent-b", other.leaseEpoch, "https://example.test/path/?a=1", "exact", other.id)).reused, false);
});

test("takeover during tab lookup fences both running and queued requests", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const backend = new class extends FakeBrowserBackend {
    override async listTabs(taskId: string) { entered(); await gate; return super.listTabs(taskId); }
  }();
  const broker = new BrokerCore(new TaskSpaceService(), backend);
  const space = await broker.useOrCreateTaskSpace("fence", "agent-a");
  const work = Promise.allSettled(Array.from({ length: 2 }, () => broker.openOrReuseTab("agent-a", space.leaseEpoch, "https://example.test", "exact", space.id)));
  await started;
  await broker.userTakeoverTaskSpace(space.id);
  release();
  assert.ok((await work).every((result) => result.status === "rejected"));
  assert.equal(backend.tabs.get(space.taskId)?.length, 0);
});
