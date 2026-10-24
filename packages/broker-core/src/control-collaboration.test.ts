import assert from "node:assert/strict";
import test from "node:test";
import { BrokerCore } from "./broker.ts";
import { FakeBrowserBackend } from "./backend.ts";
import { TaskSpaceService } from "./task-space-service.ts";

function setup() {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend());
  broker.agents.observe("agent-a");
  broker.agents.observe("agent-b");
  return broker;
}

test("observers retain their selection and cannot steal the writer lease", async () => {
  const broker = setup();
  const a = await broker.createTaskSpace("A", "agent-a");
  const b = await broker.createTaskSpace("B", "agent-b");
  await broker.openOrReuseTab("agent-a", a.leaseEpoch, "https://example.test", "exact", a.id);
  const observed = await broker.observeTaskSpace(a.id);
  assert.equal(observed.tabs.length, 1);
  assert.equal(observed.controllerClientId, "agent-a");
  assert.ok((await broker.observeTaskSpace(a.id, observed.tabs[0]!.targetId)).snapshot);
  await assert.rejects(broker.observeTaskSpace(b.id, observed.tabs[0]!.targetId), /does not belong/);
  assert.equal(broker.spaces.selected("agent-b").id, b.id);
  await assert.rejects(broker.claimTaskSpace(a.id, "agent-b"), /Request control/);
  broker.spaces.assertMutationAllowed("agent-a", a.leaseEpoch, a.id);
});

test("explicit approval is idempotent per pending request and fences the former writer", async () => {
  const broker = setup();
  const a = await broker.createTaskSpace("A", "agent-a");
  const events: number[] = [];
  broker.onControlChanged((state) => events.push(state.revision));
  const request = broker.requestControl(a.id, "agent-b");
  assert.equal(broker.requestControl(a.id, "agent-b").id, request.id);
  const results = await Promise.allSettled([
    broker.approveControl(a.id, request.id, "desktop-user"),
    broker.approveControl(a.id, request.id, "desktop-user"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(broker.controlState(a.id).controllerClientId, "agent-b");
  assert.throws(() => broker.spaces.assertMutationAllowed("agent-a", a.leaseEpoch, a.id));
  broker.spaces.assertMutationAllowed("agent-b", broker.spaces.byId(a.id).leaseEpoch, a.id);
  assert.ok(events.length >= 2);
  assert.ok(events.every((revision, index) => index === 0 || revision > events[index - 1]!));
});

test("manual mode blocks approval and only the requesting agent may cancel", async () => {
  const broker = setup();
  const a = await broker.createTaskSpace("A", "agent-a");
  const request = broker.requestControl(a.id, "agent-b");
  await broker.setControlMode("manual");
  await assert.rejects(broker.approveControl(a.id, request.id, "desktop-user"), /manual/);
  assert.throws(() => broker.cancelControlRequest(a.id, request.id, "agent-a"));
  broker.cancelControlRequest(a.id, request.id, "agent-b");
  assert.equal(broker.controlState(a.id).requests[0]?.status, "cancelled");
});

test("optional interaction pauses the collaborative writer until explicit approval", async () => {
  const broker = setup();
  const a = await broker.createTaskSpace("A", "agent-a");
  await broker.setControlMode("agent");
  assert.equal((await broker.userInteraction(a.id)).interactionPending, false);
  await broker.setControlMode("collaborative");
  await broker.claimTaskSpace(a.id, "agent-a");
  const paused = await broker.userInteraction(a.id);
  assert.equal(paused.interactionPending, true);
  assert.equal(paused.space.agentBlocked, true);
  assert.throws(() => broker.spaces.assertMutationAllowed("agent-a", a.leaseEpoch, a.id));
  const request = broker.requestControl(a.id, "agent-b");
  const granted = await broker.approveControl(a.id, request.id, "desktop-user");
  assert.equal(granted.interactionPending, false);
  assert.equal(granted.space.agentBlocked, false);
  assert.equal(granted.controllerClientId, "agent-b");
});

test("global mode changes fence all spaces and never silently restore former writers", async () => {
  const broker = setup();
  const a = await broker.createTaskSpace("A", "agent-a");
  const b = await broker.createTaskSpace("B", "agent-b");
  await broker.setControlMode("manual");
  for (const [space, client] of [[a, "agent-a"], [b, "agent-b"]] as const) {
    assert.equal(broker.spaces.byId(space.id).controlMode, "manual");
    assert.throws(() => broker.spaces.assertMutationAllowed(client, space.leaseEpoch, space.id));
  }
  await broker.setControlMode("collaborative");
  assert.equal(broker.spaces.byId(a.id).agentBlocked, true);
  assert.throws(() => broker.spaces.assertMutationAllowed("agent-a", a.leaseEpoch, a.id));
  await broker.setControlMode("agent");
  for (const [space, client] of [[a, "agent-a"], [b, "agent-b"]] as const) {
    assert.equal(broker.controlState(space.id).controllerClientId, undefined);
    assert.throws(() => broker.spaces.assertMutationAllowed(client, space.leaseEpoch, space.id));
  }
});

test("current writer may explicitly transfer to a waiting agent", async () => {
  const broker = setup();
  const a = await broker.createTaskSpace("A", "agent-a");
  const request = broker.requestControl(a.id, "agent-b");
  const result = await broker.returnControl(a.id, "agent-a", a.leaseEpoch, request.id);
  assert.equal(result.controllerClientId, "agent-b");
  await assert.rejects(broker.returnControl(a.id, "agent-a", a.leaseEpoch));
});
