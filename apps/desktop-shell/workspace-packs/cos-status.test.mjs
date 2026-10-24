import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CosStatus } from "./cos-status.mjs";

async function fixture(t, overrides = {}) {
  const base = resolve(".tmp/codex/cos-integration/unit");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "status-"));
  const calls = [];
  const runtime = {
    state: "ready",
    async invoke(channel, payload) {
      calls.push({ channel, payload });
      return { ok: true, data: channel === "sessions:outbox"
        ? [{ id: "input-1", sessionId: "session-1", state: "queued", createdAt: 1, text: "private prompt" }]
        : { total: 1, nextCursor: null, sessions: [{ id: "session-1", title: "Task", updatedAt: 1, messages: ["private conversation"] }] } };
    },
  };
  const service = new CosStatus({
    discoveryPath: join(root, "endpoint.json"),
    describe: () => ({ id: "cos", enabled: true, state: "ready", config: { token: "private token" }, directory: "private path" }),
    runtime: () => runtime,
    agents: async () => ({ agents: [{ clientId: "codex-test", status: "executing", currentTaskId: "task-1", credentials: "private credentials" }] }),
    ...overrides,
  });
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  await service.start();
  const discovery = JSON.parse(await readFile(service.discoveryPath, "utf8"));
  const request = (path, options = {}) => fetch(discovery.url + path, {
    ...options, headers: { Authorization: `Bearer ${discovery.token}`, ...options.headers },
  });
  return { root, calls, runtime, service, discovery, request };
}

test("CoS status discovers a loopback endpoint and exposes only task metadata", async t => {
  const { request, calls, service, discovery } = await fixture(t);
  assert.match(discovery.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(discovery.token.length, 64);
  assert.equal(discovery.pid, process.pid);
  const health = await request("/v1/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  const response = await request("/v1/packages/cos/instances/default/status");
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.taskState, "observed");
  assert.equal(status.tasks[0].state, "queued");
  assert.equal(status.sessions.sessions[0].id, "session-1");
  assert.doesNotMatch(JSON.stringify(status), /private/);
  assert.ok(Date.parse(status.expiresAt) > Date.parse(status.observedAt));
  const cursor = { updatedAt: 1, id: "session-1" };
  await request(`/v1/packages/cos/instances/default/sessions?cursor=${encodeURIComponent(JSON.stringify(cursor))}`);
  assert.deepEqual(calls.at(-1).payload, { limit: 20, cursor });
  assert.equal((await service.agents()).agents[0].status, "executing");
  assert.doesNotMatch(JSON.stringify(await service.agents()), /private/);
  assert.equal((await service.agents({ clientId: "missing" })).agents.length, 0);
});

test("CoS status rejects missing credentials, browser origins and write requests", async t => {
  const { request, discovery } = await fixture(t);
  for (const authorization of ["", "Bearer invalid", discovery.token]) {
    assert.equal((await request("/v1/health", { headers: { Authorization: authorization } })).status, 401);
  }
  for (const headers of [{ Origin: "https://example.com" }, { "Sec-Fetch-Site": "cross-site" }]) {
    assert.equal((await request("/v1/health", { headers })).status, 403);
  }
  assert.equal((await request("/v1/health", { method: "POST" })).status, 405);
  assert.equal((await request("/v1/unknown")).status, 404);
  assert.equal((await request("/v1/packages/cos/instances/foreign/status")).status, 400);
  assert.equal((await request("/v1/events?timeoutMs=30000")).status, 400);
  assert.equal((await request("/v1/packages/cos/instances/default/sessions?cursor=broken")).status, 400);
});

test("CoS status distinguishes missing runtime and unknown external agents from completion", async t => {
  const { runtime, service } = await fixture(t, { agents: async () => { throw new Error("disconnected"); } });
  runtime.state = "stopped";
  assert.equal((await service.status()).taskState, "unavailable");
  runtime.state = "ready";
  runtime.invoke = async () => ({ ok: false, error: "runtime unavailable" });
  assert.equal((await service.status()).taskState, "unavailable");
  assert.equal((await service.agents()).available, false);
  assert.equal((await service.agents({ sourceScope: "codex-desktop" })).available, false);
  await assert.rejects(service.status({ packageId: "other" }), /Unknown workspace/);
});

test("CoS event cursors wait for changes, bound history and reset after restart", async t => {
  const { service } = await fixture(t);
  const cursor = service.cursor;
  const waiting = service.wait({ afterCursor: cursor, timeoutMs: 1000 });
  service.publish("sessions:changed");
  const changed = await waiting;
  assert.deepEqual(changed.events.map(event => event.kind), ["sessions:changed"]);
  const timeout = await service.wait({ afterCursor: service.cursor, timeoutMs: 5 });
  assert.deepEqual(timeout.events, []);
  assert.equal(timeout.resetRequired, false);
  for (let n = 0; n < 260; n++) service.publish("runtime.changed");
  assert.equal(service.events(cursor).resetRequired, true);
  assert.equal(service.events(cursor).events.length, 256);
  assert.equal(service.events(`${service.cursor}:extra`).resetRequired, true);
  const previous = service.cursor;
  await service.stop();
  await service.start();
  assert.equal(service.events(previous).resetRequired, true);
});

test("CoS stop removes discovery, closes access and rotates credentials on enable", async t => {
  const { service, discovery, request, root } = await fixture(t);
  await service.stop();
  await assert.rejects(readFile(service.discoveryPath), { code: "ENOENT" });
  await assert.rejects(request("/v1/health"));
  await service.start();
  const next = JSON.parse(await readFile(service.discoveryPath, "utf8"));
  assert.notEqual(next.token, discovery.token);
  assert.equal((await fetch(next.url + "/v1/health", { headers: { Authorization: `Bearer ${discovery.token}` } })).status, 401);
  assert.deepEqual(await readdir(root), ["endpoint.json"]);
});

test("CoS stop preserves a discovery file owned by another instance", async t => {
  const { service } = await fixture(t);
  await writeFile(service.discoveryPath, JSON.stringify({ token: "another-instance" }));
  await service.stop();
  assert.equal(JSON.parse(await readFile(service.discoveryPath, "utf8")).token, "another-instance");
});

test("CoS stop closes its server even if discovery data is malformed", async t => {
  const { service, request } = await fixture(t);
  await writeFile(service.discoveryPath, "{incomplete");
  await service.stop();
  await assert.rejects(request("/v1/health"));
  assert.equal(await readFile(service.discoveryPath, "utf8"), "{incomplete");
});
