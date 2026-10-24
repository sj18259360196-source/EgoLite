import assert from "node:assert/strict";
import test from "node:test";

import { EgoProtocolError, type TaskSpaceRecord } from "@ego-compat/protocol";

import { FakeBrowserBackend } from "./backend.ts";
import { AgentRegistry } from "./agent-registry.ts";
import { BrokerCore } from "./broker.ts";
import { CollectionService } from "./collection-service.ts";
import { TaskSpaceService } from "./task-space-service.ts";

test("fake backend provides a complete task, tab, snapshot, and CDP slice", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  const space = await broker.createTaskSpace("poc", "agent-a");
  const epoch = broker.spaces.currentLease("agent-a").epoch;
  const tab = await broker.createTab("agent-a", epoch, "https://example.test");

  assert.equal(tab.active, true);
  assert.deepEqual((await broker.listTabs("agent-a")).tabs, [tab]);
  assert.match((await broker.snapshot("agent-a", epoch)).content, /example\.test/);

  const response = JSON.parse(
    await broker.sendCdp(
      "agent-a",
      epoch,
      JSON.stringify({ id: 7, method: "Runtime.enable" }),
    ),
  );
  assert.equal(response.id, 7);
  assert.equal(response.result.method, "Runtime.enable");
  const second = await broker.createTab("agent-a", epoch, "https://second.test");
  assert.equal((await broker.listTabs("agent-a")).tabs.length, 2);
  assert.equal(await broker.activateTab(tab.targetId), true);
  assert.equal((await broker.listTabs("agent-a")).tabs.find((item) => item.targetId === tab.targetId)?.active, true);
  assert.equal(await broker.closeTab(second.targetId), true);
  assert.deepEqual((await broker.listTabs("agent-a")).tabs, [{ ...tab, active: true }]);
  assert.equal(space.name, "poc");
});

test("broker blocks tab creation after handoff", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  await broker.createTaskSpace("poc", "agent-a");
  const epoch = broker.spaces.currentLease("agent-a").epoch;
  await broker.handOffTaskSpace("agent-a");

  await assert.rejects(
    () => broker.createTab("agent-a", epoch),
    (error: unknown) =>
      error instanceof EgoProtocolError &&
      error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
});

test("manual control mode blocks agent mutations while keeping the desktop path usable", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  const created = await broker.createTaskSpace("manual mode", "agent-a");
  const epoch = broker.spaces.currentLease("agent-a").epoch;

  await broker.setControlMode("manual");

  assert.equal(broker.controlMode(), "manual");
  assert.equal(broker.spaces.byId(created.id).controlMode, "manual");
  await assert.rejects(
    () => broker.createTab("agent-a", epoch, "https://blocked.example"),
    (error: unknown) =>
      error instanceof EgoProtocolError &&
      error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );

  const desktopSpace = await broker.createTaskSpace("desktop task", "desktop-ui");
  assert.equal(desktopSpace.ownership, "agent");
  assert.equal(desktopSpace.controlMode, "manual");
});

test("explicit consent is the default control consent policy", () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  assert.equal(broker.controlConsentPolicy(), "strict");
  assert.equal(broker.controlHandoffEnabled(), true);

  const disabled = new BrokerCore(
    new TaskSpaceService(),
    new FakeBrowserBackend(),
    new CollectionService(),
    new AgentRegistry(),
    { controlHandoffEnabled: false },
  );
  assert.equal(disabled.controlHandoffEnabled(), false);
});

test("disabling control handoff clears pending user-control state and restores ordinary claiming", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  const created = await broker.createTaskSpace("disabled handoff", "codex-cli-original");
  await broker.externalAgentDisconnected("codex-cli-original");
  const pending = await broker.returnToAgentTaskSpace(created.id, "desktop-user");
  assert.equal(pending.space.pendingAgentReturn, true);

  assert.equal(await broker.setControlHandoffEnabled(false), false);
  const cleared = broker.spaces.byId(created.id);
  assert.equal(cleared.ownership, "user");
  assert.equal(cleared.lifecycle, "inactive");
  assert.equal(cleared.pendingAgentReturn, undefined);
  assert.equal(cleared.agentBlocked, undefined);

  const claimed = await broker.claimTaskSpace(created.id, "codex-cli-original");
  assert.equal(claimed.ownership, "agent");
  assert.equal(claimed.lifecycle, "active");
});

test("disabling handoff clears the previous agent current-task marker", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  broker.agents.register({ clientId: "agent-current", clientKind: "codex", displayName: "Codex" });
  const created = await broker.createTaskSpace("clear current task", "agent-current");
  await broker.userTakeoverTaskSpace(created.id);
  assert.equal(broker.agents.get("agent-current")?.currentTaskId, created.taskId);

  await broker.setControlHandoffEnabled(false);

  assert.equal(broker.agents.get("agent-current")?.currentTaskId, undefined);
});

test("autonomous disconnect and handoff leave shared spaces available", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  await broker.setControlHandoffEnabled(false);
  broker.agents.register({ clientId: "agent-disconnect", clientKind: "codex", displayName: "Disconnect" });
  const disconnected = await broker.createTaskSpace("disabled disconnect", "agent-disconnect");
  await broker.externalAgentDisconnected("agent-disconnect");
  assert.equal(broker.spaces.byId(disconnected.id).ownership, "agent");
  assert.equal(broker.spaces.byId(disconnected.id).lifecycle, "active");

  broker.agents.register({ clientId: "agent-handoff", clientKind: "codex", displayName: "Handoff" });
  const handedOff = await broker.createTaskSpace("disabled agent handoff", "agent-handoff");
  await broker.handOffTaskSpace("agent-handoff");
  assert.equal(broker.spaces.byId(handedOff.id).ownership, "agent");
  assert.equal(broker.spaces.byId(handedOff.id).lifecycle, "active");
  assert.equal(broker.agents.get("agent-handoff")?.currentTaskId, undefined);
});

test("disabling handoff is serialized after an in-flight agent handoff", async () => {
  let enterRelinquish!: () => void;
  let releaseRelinquish!: () => void;
  const relinquishing = new Promise<void>((resolve) => { enterRelinquish = resolve; });
  const released = new Promise<void>((resolve) => { releaseRelinquish = resolve; });
  const backend = new (class extends FakeBrowserBackend {
    override async relinquishControl(): Promise<void> {
      enterRelinquish();
      await released;
    }
  })();
  const broker = new BrokerCore(new TaskSpaceService(), backend);
  const created = await broker.createTaskSpace("serialized handoff", "agent-a");
  const events: TaskSpaceRecord[] = [];
  broker.onSpaceChanged(({ space }) => events.push(space));

  const handoff = broker.handOffTaskSpace("agent-a");
  await relinquishing;
  const disabling = broker.setControlHandoffEnabled(false);
  releaseRelinquish();
  await Promise.all([handoff, disabling]);

  const finalSpace = broker.spaces.byId(created.id);
  assert.equal(finalSpace.ownership, "user");
  assert.equal(finalSpace.lifecycle, "inactive");
  assert.equal(events.at(-1)?.ownership, "user");
  assert.equal(events.at(-1)?.lifecycle, "inactive");
});

test("disabling handoff broadcasts every cleared space even when backend sync fails", async () => {
  const backend = new (class extends FakeBrowserBackend {
    failUpdates = false;
    override async updateSpaceState(): Promise<void> {
      if (this.failUpdates) throw new Error("backend update failed");
    }
  })();
  const broker = new BrokerCore(new TaskSpaceService(), backend);
  const first = await broker.createTaskSpace("first delegated", "agent-a");
  await broker.handOffTaskSpace("agent-a");
  const second = await broker.createTaskSpace("second delegated", "agent-a");
  await broker.handOffTaskSpace("agent-a");
  const events: TaskSpaceRecord[] = [];
  broker.onSpaceChanged(({ space }) => events.push(space));
  backend.failUpdates = true;

  assert.equal(await broker.setControlHandoffEnabled(false), false);

  assert.deepEqual(new Set(events.map((space) => space.id)), new Set([first.id, second.id]));
  assert.ok(events.every((space) => space.ownership === "user" && space.lifecycle === "inactive"));
});

test("disabled control handoff rejects desktop takeover, stop, return, and authorization", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  const created = await broker.createTaskSpace("disabled controls", "agent-a");
  await broker.setControlHandoffEnabled(false);
  for (const action of [
    () => broker.userTakeoverTaskSpace(created.id),
    () => broker.stopAgentTaskSpace(created.id),
    () => broker.returnToAgentTaskSpace(created.id, "desktop-user"),
    () => broker.takeOverTaskSpace(created.id, "agent-a"),
  ]) {
    await assert.rejects(
      action,
      (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_INVALID_ARGUMENT",
    );
  }
  assert.throws(
    () => broker.authorizeTakeover(created.id),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_INVALID_ARGUMENT",
  );
});

test("desktop force close works with handoff disabled and emits one final removal", async () => {
  const backend = new (class extends FakeBrowserBackend {
    readonly closeCalls: Array<{ taskId: string; visualSync: boolean | undefined }> = [];

    override async closeSpace(taskId: string, options?: { visualSync?: boolean }): Promise<void> {
      this.closeCalls.push({ taskId, visualSync: options?.visualSync });
      await super.closeSpace(taskId);
    }
  })();
  const registry = new AgentRegistry();
  const broker = new BrokerCore(
    new TaskSpaceService(),
    backend,
    new CollectionService(),
    registry,
    { controlHandoffEnabled: false },
  );
  registry.register({ clientId: "agent-delete", clientKind: "codex", displayName: "Delete Agent" });
  const created = await broker.createTaskSpace("delete while running", "agent-delete");
  registry.startActivity(
    "agent-delete",
    { tool: "browser.click", startedAt: new Date().toISOString() },
    created.taskId,
  );
  const oldEpoch = created.leaseEpoch;
  const events: Array<{ space: TaskSpaceRecord; removed?: boolean }> = [];
  broker.onSpaceChanged((event) => events.push(event));

  const closed = await broker.forceCloseTaskSpace(created.id);

  assert.equal(closed.ownership, "user");
  assert.equal(closed.lifecycle, "closed");
  assert.ok(closed.leaseEpoch > oldEpoch);
  assert.deepEqual(backend.closeCalls, [{ taskId: created.taskId, visualSync: true }]);
  assert.equal(backend.tabs.has(created.taskId), false);
  assert.equal(broker.spaces.leaseHolder(created.taskId), undefined);
  assert.deepEqual(broker.listTaskSpaces().taskSpaces, []);
  assert.equal(registry.get("agent-delete")?.status, "online");
  assert.equal(registry.get("agent-delete")?.currentTaskId, undefined);
  assert.equal(registry.get("agent-delete")?.currentAction, undefined);
  assert.deepEqual(events, [{ space: closed, removed: true }]);
  assert.throws(
    () => broker.spaces.assertMutationAllowed("agent-delete", oldEpoch),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_NOT_SELECTED",
  );
});

test("force close still emits removal when backend cleanup fails", async () => {
  const backend = new (class extends FakeBrowserBackend {
    override async closeSpace(): Promise<void> {
      throw new Error("backend close failed");
    }
  })();
  const broker = new BrokerCore(new TaskSpaceService(), backend);
  const created = await broker.createTaskSpace("backend failure", "agent-delete-failure");
  const events: Array<{ space: TaskSpaceRecord; removed?: boolean }> = [];
  broker.onSpaceChanged((event) => events.push(event));

  await assert.rejects(
    () => broker.forceCloseTaskSpace(created.id),
    /backend close failed/,
  );

  const closed = broker.spaces.byId(created.id);
  assert.equal(closed.ownership, "user");
  assert.equal(closed.lifecycle, "closed");
  assert.deepEqual(broker.listTaskSpaces().taskSpaces, []);
  assert.deepEqual(events, [{ space: closed, removed: true }]);
});

test("backend control-loss callbacks cannot rebroadcast a force-closed space", async () => {
  const backend = new (class extends FakeBrowserBackend {
    controlLost: ((taskId: string, reason: string) => void) | undefined;

    onControlLost(listener: (taskId: string, reason: string) => void): () => void {
      this.controlLost = listener;
      return () => { this.controlLost = undefined; };
    }

    override async closeSpace(taskId: string): Promise<void> {
      this.controlLost?.(taskId, "space closed");
      await super.closeSpace(taskId);
    }
  })();
  const broker = new BrokerCore(new TaskSpaceService(), backend);
  const created = await broker.createTaskSpace("control loss during close", "agent-delete-control-loss");
  const events: Array<{ space: TaskSpaceRecord; removed?: boolean }> = [];
  broker.onSpaceChanged((event) => events.push(event));

  const closed = await broker.forceCloseTaskSpace(created.id);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [{ space: closed, removed: true }]);
});

test("returning control prepares the browser backend and lets the same agent continue", async () => {
  const backend = new (class extends FakeBrowserBackend {
    readonly prepared: string[] = [];
    readonly relinquished: string[] = [];

    override async prepareControl(taskId: string): Promise<void> {
      this.prepared.push(taskId);
    }

    override async relinquishControl(taskId: string): Promise<void> {
      this.relinquished.push(taskId);
    }
  })();
  const broker = new BrokerCore(new TaskSpaceService(), backend);
  broker.agents.register({ clientId: "agent-a", clientKind: "codex", displayName: "Agent A" });
  const created = await broker.createTaskSpace("returnable", "agent-a");

  await broker.userTakeoverTaskSpace(created.id);
  const returned = await broker.returnToAgentTaskSpace(created.id, "desktop-user");
  const resumedTab = await broker.createTab("agent-a", returned.space.leaseEpoch, "https://resumed.test");

  assert.deepEqual(backend.relinquished, [created.taskId]);
  assert.deepEqual(backend.prepared, [created.taskId]);
  assert.equal(returned.space.ownership, "agent");
  assert.equal(resumedTab.url, "https://resumed.test");
});

test("automatic control policy lets a successor with a new id reclaim unless the user stopped the agent", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  broker.setControlConsentPolicy("automatic");
  broker.agents.register({ clientId: "agent-a", clientKind: "codex", displayName: "Agent A" });
  const created = await broker.createTaskSpace("automatic", "agent-a");

  await broker.userTakeoverTaskSpace(created.id);
  const reclaimed = await broker.takeOverTaskSpace(created.id, "agent-b");
  assert.equal(reclaimed.ownership, "agent");
  assert.equal(reclaimed.lastAgentClientId, "agent-b");

  await broker.stopAgentTaskSpace(created.id);
  await assert.rejects(
    () => broker.takeOverTaskSpace(created.id, "agent-c"),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
});

test("a stopped space stays hard blocked across broker restart and the desktop can unlock it", async () => {
  let persisted: TaskSpaceRecord[] = [];
  const store = { load: () => persisted, save: (spaces: TaskSpaceRecord[]) => { persisted = structuredClone(spaces); } };
  const first = new BrokerCore(new TaskSpaceService({ store }), new FakeBrowserBackend());
  const created = await first.createTaskSpace("restart blocked", "codex-mcp-original");
  await first.stopAgentTaskSpace(created.id);

  const recoveredSpaces = new TaskSpaceService({ store });
  recoveredSpaces.recoverAfterRestart();
  const restarted = new BrokerCore(recoveredSpaces, new FakeBrowserBackend());
  restarted.setControlConsentPolicy("balanced");
  const blocked = restarted.spaces.byId(created.id);
  assert.equal(blocked.ownership, "agentDelegatedToUser");
  assert.equal(blocked.agentBlocked, true);
  await assert.rejects(
    () => restarted.takeOverTaskSpace(created.id, "codex-mcp-wrong"),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );

  const unlocked = await restarted.returnToAgentTaskSpace(created.id, "desktop-user");
  assert.equal(unlocked.space.agentBlocked, false);
  assert.equal(unlocked.space.pendingAgentReturn, true);
  restarted.agents.register({ clientId: "codex-mcp-original", clientKind: "codex", displayName: "Codex" });
  const resumed = await restarted.takeOverTaskSpace(created.id, "codex-mcp-original");
  assert.equal(resumed.ownership, "agent");
  assert.equal(resumed.pendingAgentReturn, undefined);
});

test("strict user takeover survives broker restart and cannot be bypassed with claim or takeover", async () => {
  let persisted: TaskSpaceRecord[] = [];
  const store = { load: () => persisted, save: (spaces: TaskSpaceRecord[]) => { persisted = structuredClone(spaces); } };
  const first = new BrokerCore(new TaskSpaceService({ store }), new FakeBrowserBackend());
  const created = await first.createTaskSpace("restart user control", "codex-cli-original");
  await first.userTakeoverTaskSpace(created.id);

  const recoveredSpaces = new TaskSpaceService({ store });
  recoveredSpaces.recoverAfterRestart();
  const restarted = new BrokerCore(recoveredSpaces, new FakeBrowserBackend());
  restarted.setControlConsentPolicy("strict");
  assert.equal(restarted.spaces.byId(created.id).ownership, "agentDelegatedToUser");
  await assert.rejects(
    () => restarted.claimTaskSpace(created.id, "codex-cli-wrong"),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  await assert.rejects(
    () => restarted.takeOverTaskSpace(created.id, "codex-cli-wrong"),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
});

test("strict pending return survives broker restart and only the original stable agent can consume it", async () => {
  let persisted: TaskSpaceRecord[] = [];
  const store = { load: () => persisted, save: (spaces: TaskSpaceRecord[]) => { persisted = structuredClone(spaces); } };
  const first = new BrokerCore(new TaskSpaceService({ store }), new FakeBrowserBackend());
  const created = await first.createTaskSpace("restart pending", "codex-cli-original");
  await first.externalAgentDisconnected("codex-cli-original");
  await first.returnToAgentTaskSpace(created.id, "desktop-user");

  const recoveredSpaces = new TaskSpaceService({ store });
  recoveredSpaces.recoverAfterRestart();
  const restarted = new BrokerCore(recoveredSpaces, new FakeBrowserBackend());
  restarted.setControlConsentPolicy("strict");
  assert.equal(restarted.spaces.byId(created.id).pendingAgentReturn, true);
  restarted.agents.register({ clientId: "codex-cli-wrong", clientKind: "codex", displayName: "Codex" });
  await assert.rejects(
    () => restarted.takeOverTaskSpace(created.id, "codex-cli-wrong"),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  assert.equal(restarted.spaces.byId(created.id).pendingAgentReturn, true);

  restarted.agents.register({ clientId: "codex-cli-original", clientKind: "codex", displayName: "Codex" });
  const resumed = await restarted.takeOverTaskSpace(created.id, "codex-cli-original");
  assert.equal(resumed.ownership, "agent");
  assert.equal(resumed.pendingAgentReturn, undefined);
});

test("an offline agent return remains pending without throwing", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  broker.agents.register({ clientId: "agent-old", clientKind: "codex", displayName: "Codex CLI", version: "1" });
  const created = await broker.createTaskSpace("pending return", "agent-old");
  broker.agents.disconnect("agent-old");
  await broker.externalAgentDisconnected("agent-old");

  const returned = await broker.returnToAgentTaskSpace(created.id, "desktop-user");
  assert.equal(returned.agentClientId, undefined);
  assert.equal(returned.space.ownership, "agentDelegatedToUser");
  assert.equal(returned.space.pendingAgentReturn, true);
  assert.equal(broker.spaces.leaseHolder(created.taskId), undefined);
});

test("a unique online successor receives an offline agent's returned space immediately", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  broker.agents.register({ clientId: "cli-agent-old", clientKind: "codex", displayName: "Codex CLI", version: "1" });
  const created = await broker.createTaskSpace("successor", "cli-agent-old");
  broker.agents.disconnect("cli-agent-old");
  await broker.externalAgentDisconnected("cli-agent-old");
  broker.agents.register({ clientId: "codex-mcp-agent-new", clientKind: "codex", displayName: "Codex CLI", version: "1" });

  const returned = await broker.returnToAgentTaskSpace(created.id, "desktop-user");
  assert.equal(returned.agentClientId, "codex-mcp-agent-new");
  assert.equal(returned.space.ownership, "agent");
  assert.equal(returned.space.pendingAgentReturn, undefined);
  assert.equal(broker.spaces.leaseHolder(created.taskId)?.clientId, "codex-mcp-agent-new");
});

test("ambiguous online successors leave the agent return pending", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  broker.agents.register({ clientId: "cli-agent-old", clientKind: "codex", displayName: "Codex CLI", version: "1" });
  const created = await broker.createTaskSpace("ambiguous", "cli-agent-old");
  broker.agents.disconnect("cli-agent-old");
  await broker.externalAgentDisconnected("cli-agent-old");
  broker.agents.register({ clientId: "codex-mcp-agent-new-a", clientKind: "codex", displayName: "Codex CLI", version: "1" });
  broker.agents.register({ clientId: "codex-mcp-agent-new-b", clientKind: "codex", displayName: "Codex CLI", version: "1" });

  const returned = await broker.returnToAgentTaskSpace(created.id, "desktop-user");
  assert.equal(returned.agentClientId, undefined);
  assert.equal(returned.space.pendingAgentReturn, true);
  assert.equal(returned.space.ownership, "agentDelegatedToUser");
});

for (const policy of ["balanced", "strict"] as const) {
  test(`${policy} pending return rejects a different stable agent without consuming authorization`, async () => {
    const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
    const created = await broker.createTaskSpace(`${policy} bound`, "codex-mcp-original");
    broker.setControlConsentPolicy(policy);
    await broker.externalAgentDisconnected("codex-mcp-original");
    await broker.returnToAgentTaskSpace(created.id, "desktop-user");
    broker.agents.register({ clientId: "codex-mcp-wrong", clientKind: "codex", displayName: "Codex" });

    await assert.rejects(
      () => broker.takeOverTaskSpace(created.id, "codex-mcp-wrong"),
      (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
    );
    assert.equal(broker.spaces.byId(created.id).pendingAgentReturn, true);

    broker.agents.register({ clientId: "codex-mcp-original", clientKind: "codex", displayName: "Codex" });
    const resumed = await broker.takeOverTaskSpace(created.id, "codex-mcp-original");
    assert.equal(resumed.ownership, "agent");
    assert.equal(resumed.pendingAgentReturn, undefined);
  });

  test(`${policy} pending return accepts one compatible legacy CLI successor`, async () => {
    const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
    broker.agents.register({ clientId: "cli-original", clientKind: "other", displayName: "Agent" });
    const created = await broker.createTaskSpace(`${policy} legacy`, "cli-original");
    broker.setControlConsentPolicy(policy);
    broker.agents.disconnect("cli-original");
    await broker.externalAgentDisconnected("cli-original");
    await broker.returnToAgentTaskSpace(created.id, "desktop-user");
    broker.agents.register({ clientId: "codex-cli-successor", clientKind: "codex", displayName: "Codex" });

    const resumed = await broker.takeOverTaskSpace(created.id, "codex-cli-successor");
    assert.equal(resumed.ownership, "agent");
    assert.equal(resumed.pendingAgentReturn, undefined);
  });
}

test("multiple compatible legacy CLI successors do not consume a balanced pending return", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  broker.agents.register({ clientId: "cli-original", clientKind: "other", displayName: "Agent" });
  const created = await broker.createTaskSpace("balanced ambiguous migration", "cli-original");
  broker.setControlConsentPolicy("balanced");
  broker.agents.disconnect("cli-original");
  await broker.externalAgentDisconnected("cli-original");
  await broker.returnToAgentTaskSpace(created.id, "desktop-user");
  broker.agents.register({ clientId: "codex-mcp-successor-a", clientKind: "codex", displayName: "Codex" });
  broker.agents.register({ clientId: "codex-mcp-successor-b", clientKind: "codex", displayName: "Codex" });

  await assert.rejects(
    () => broker.takeOverTaskSpace(created.id, "codex-mcp-successor-a"),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  assert.equal(broker.spaces.byId(created.id).pendingAgentReturn, true);
  broker.agents.disconnect("codex-mcp-successor-b");
  const resumed = await broker.takeOverTaskSpace(created.id, "codex-mcp-successor-a");
  assert.equal(resumed.ownership, "agent");
  assert.equal(resumed.pendingAgentReturn, undefined);
});

test("the original agent reconnecting completes one pending return without an explicit takeover", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  broker.agents.register({ clientId: "codex-mcp-original", clientKind: "codex", displayName: "Codex" });
  const created = await broker.createTaskSpace("automatic reconnect", "codex-mcp-original");
  broker.setControlConsentPolicy("strict");
  broker.agents.disconnect("codex-mcp-original");
  await broker.externalAgentDisconnected("codex-mcp-original");
  await broker.returnToAgentTaskSpace(created.id, "desktop-user");

  broker.agents.register({ clientId: "codex-mcp-original", clientKind: "codex", displayName: "Codex" });
  const resumed = await broker.resumePendingAgentReturns("codex-mcp-original");
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]?.ownership, "agent");
  assert.equal(resumed[0]?.pendingAgentReturn, undefined);

  await broker.useTaskSpace(created.id, "codex-mcp-original");
  const lease = broker.spaces.currentLease("codex-mcp-original");
  const tab = await broker.createTab("codex-mcp-original", lease.epoch, "https://reconnected.test");
  assert.equal(tab.url, "https://reconnected.test");
});

test("the original stable agent reconnecting resumes all of its pending spaces", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  const clientId = "codex-mcp-multiple";
  broker.agents.register({ clientId, clientKind: "codex", displayName: "Codex" });
  const first = await broker.createTaskSpace("pending first", clientId);
  const second = await broker.createTaskSpace("pending second", clientId);
  broker.agents.disconnect(clientId);
  await broker.externalAgentDisconnected(clientId);
  await broker.returnToAgentTaskSpace(first.id, "desktop-user");
  await broker.returnToAgentTaskSpace(second.id, "desktop-user");

  broker.agents.register({ clientId, clientKind: "codex", displayName: "Codex" });
  const resumed = await broker.resumePendingAgentReturns(clientId);

  assert.deepEqual(new Set(resumed.map((space) => space.id)), new Set([first.id, second.id]));
  assert.ok(resumed.every((space) => space.ownership === "agent" && space.pendingAgentReturn === undefined));
  await broker.useTaskSpace(first.id, clientId);
  assert.equal(broker.spaces.currentLease(clientId).taskId, first.taskId);
});

test("automatic pending resume waits while legacy CLI successors are ambiguous", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  broker.agents.register({ clientId: "cli-original", clientKind: "other", displayName: "Agent" });
  const created = await broker.createTaskSpace("automatic ambiguous", "cli-original");
  broker.agents.disconnect("cli-original");
  await broker.externalAgentDisconnected("cli-original");
  await broker.returnToAgentTaskSpace(created.id, "desktop-user");
  broker.agents.register({ clientId: "codex-mcp-successor-a", clientKind: "codex", displayName: "Codex" });
  broker.agents.register({ clientId: "codex-mcp-successor-b", clientKind: "codex", displayName: "Codex" });

  assert.deepEqual(await broker.resumePendingAgentReturns("codex-mcp-successor-a"), []);
  assert.deepEqual(await broker.resumePendingAgentReturns("codex-mcp-successor-b"), []);
  assert.equal(broker.spaces.byId(created.id).pendingAgentReturn, true);

  broker.agents.disconnect("codex-mcp-successor-b");
  const resumed = await broker.resumePendingAgentReturns("codex-mcp-successor-a");
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]?.ownership, "agent");
});
