import assert from "node:assert/strict";
import test from "node:test";
import { TaskSpaceService } from "./task-space-service.ts";
import { BrokerCore } from "./broker.ts";
import { FakeBrowserBackend } from "./backend.ts";

test("autonomous Agents share a workspace without expiry or epoch churn", () => {
  let now = 0;
  const spaces = new TaskSpaceService({ controlMode: "agent", clock: { now: () => now } });
  const a = spaces.create("shared", "a");
  const events: unknown[] = [];
  spaces.onLeaseRevoked(event => events.push(event));
  assert.equal(spaces.select(a.id, "b").leaseEpoch, a.leaseEpoch);
  assert.equal(spaces.claim(a.id, "c").leaseEpoch, a.leaseEpoch);
  now = 1_000_000;
  for (const client of ["a", "b", "c"]) {
    assert.equal(spaces.assertMutationAllowed(client, a.leaseEpoch, a.id).id, a.id);
    assert.equal(spaces.heartbeat(client, a.leaseEpoch, a.id).epoch, a.leaseEpoch);
  }
  assert.deepEqual(events, []);
});

test("autonomous explicit targets survive another selection by the same client", () => {
  const spaces = new TaskSpaceService({ controlMode: "agent" });
  const first = spaces.create("first", "desktop-a");
  spaces.create("second", "desktop-a");
  assert.equal(spaces.assertMutationAllowed("desktop-a", first.leaseEpoch, first.id).id, first.id);
  spaces.forceClose(first.id);
  assert.throws(() => spaces.assertMutationAllowed("desktop-a", first.leaseEpoch, first.id), /inactive/);
});

test("autonomous handoff and keeping a completed workspace do not interrupt peers", () => {
  const spaces = new TaskSpaceService({ controlMode: "agent" });
  const shared = spaces.create("shared", "a");
  spaces.select(shared.id, "b");
  spaces.handoff("a");
  assert.equal(spaces.assertMutationAllowed("b", shared.leaseEpoch, shared.id).id, shared.id);
  spaces.select(shared.id, "a");
  spaces.complete("b", true, shared.id);
  assert.equal(spaces.assertMutationAllowed("a", shared.leaseEpoch, shared.id).id, shared.id);
});

test("stopping or changing modes fences every autonomous writer", () => {
  for (const action of ["stop", "manual", "collaborative"] as const) {
    const spaces = new TaskSpaceService({ controlMode: "agent" });
    const first = spaces.create("shared", "a");
    spaces.select(first.id, "b");
    const revoked: string[] = [];
    spaces.onLeaseRevoked(event => revoked.push(event.clientId));
    if (action === "stop") spaces.stopAgent(first.id);
    else spaces.setControlMode(action);
    for (const client of ["a", "b"]) assert.throws(() => spaces.assertMutationAllowed(client, first.leaseEpoch, first.id));
    assert.deepEqual(new Set(revoked), new Set(["a", "b"]));
    if (action === "stop") assert.throws(() => spaces.claim(first.id, "c"), /user control|stopped/);
  }
});

test("autonomous Broker allows concurrent Agents and disconnect does not revoke peers", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend(), undefined, undefined, { controlMode: "agent" });
  const a = await broker.createTaskSpace("shared", "a");
  await broker.useTaskSpace(a.id, "b");
  await broker.claimTaskSpace(a.id, "c");
  const tabs = await Promise.all(["a", "b", "c"].map(client =>
    broker.openOrReuseTab(client, a.leaseEpoch, `https://example.test/${client}`, "exact", a.id)));
  assert.equal(new Set(tabs.map(tab => tab.targetId)).size, 3);
  assert.equal(broker.controlState(a.id).controllerClientId, undefined);
  await broker.externalAgentDisconnected("c");
  assert.equal(broker.assertMutationAllowed("a", a.leaseEpoch, a.id).id, a.id);
});
