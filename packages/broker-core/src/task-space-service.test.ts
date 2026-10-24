import assert from "node:assert/strict";
import test from "node:test";

import { EgoProtocolError, type TaskSpaceRecord } from "@ego-compat/protocol";

import { TaskSpaceService } from "./task-space-service.ts";

test("create selects the task and grants a lease", () => {
  const service = new TaskSpaceService();
  const space = service.create("checkout", "agent-a");
  const lease = service.currentLease("agent-a");

  assert.equal(space.id, 1);
  assert.equal(space.ownership, "agent");
  assert.equal(lease.epoch, space.leaseEpoch);
  assert.equal(service.selected("agent-a").taskId, space.taskId);
  assert.equal(space.profileId, "default");
});

test("task spaces persist their browser profile and old records migrate to default", () => {
  let persisted: TaskSpaceRecord[] = [];
  const store = { load: () => persisted, save: (spaces: typeof persisted) => { persisted = structuredClone(spaces); } };
  const service = new TaskSpaceService({ store });
  const created = service.create("isolated", "agent-a", "Work.Profile");
  assert.equal(created.profileId, "work.profile");
  assert.equal(service.list()[0]?.profileId, "work.profile");

  const legacy = { ...persisted[0]! };
  delete (legacy as Partial<TaskSpaceRecord>).profileId;
  persisted[0] = legacy;
  assert.equal(new TaskSpaceService({ store }).list()[0]?.profileId, "default");
});

test("rename updates the persisted public task name without changing identity", () => {
  const service = new TaskSpaceService();
  const created = service.create("checkout", "agent-a");
  const renamed = service.rename(created.id, "产品调研");

  assert.equal(renamed.name, "产品调研");
  assert.equal(renamed.taskId, created.taskId);
  assert.equal(service.list()[0]?.name, "产品调研");
});

test("reorder persists the complete active task order", () => {
  let persisted: TaskSpaceRecord[] = [];
  const store = { load: () => persisted, save: (spaces: typeof persisted) => { persisted = structuredClone(spaces); } };
  const service = new TaskSpaceService({ store });
  const first = service.create("first", "agent-a");
  const second = service.create("second", "agent-b");

  service.reorder([second.id, first.id]);

  assert.deepEqual(service.list().map((space) => space.name), ["second", "first"]);
  assert.deepEqual(new TaskSpaceService({ store }).list().map((space) => space.name), ["second", "first"]);
});

test("a live lease prevents a second agent from selecting the task", () => {
  const service = new TaskSpaceService({ controlMode: "collaborative" });
  const space = service.create("checkout", "agent-a");
  const agentBTask = service.create("research", "agent-b");

  assert.throws(
    () => service.select(space.id, "agent-b"),
    (error: unknown) =>
      error instanceof EgoProtocolError &&
      error.error_code === "EGO_TASK_SPACE_UNAVAILABLE",
  );
  assert.equal(service.selected("agent-b").id, agentBTask.id);
});

test("the same agent can renew an expired lease when nobody else acquired it", () => {
  let now = 1_000;
  const service = new TaskSpaceService({ controlMode: "collaborative", leaseTtlMs: 100, clock: { now: () => now } });
  const space = service.create("long-running", "agent-a");
  const epoch = service.currentLease("agent-a").epoch;

  now += 101;
  const renewed = service.heartbeat("agent-a", epoch);

  assert.equal(renewed.epoch, epoch);
  assert.equal(renewed.expiresAt, now + 100);
  assert.equal(service.assertMutationAllowed("agent-a", space.leaseEpoch).id, space.id);
});

test("an expired agent cannot renew after another agent acquired the task", () => {
  let now = 1_000;
  const service = new TaskSpaceService({ controlMode: "collaborative", leaseTtlMs: 100, clock: { now: () => now } });
  const space = service.create("shared", "agent-a");
  const epoch = service.currentLease("agent-a").epoch;
  const revoked: unknown[] = [];
  service.onLeaseRevoked((event) => revoked.push(event));

  now += 101;
  const acquired = service.select(space.id, "agent-b");

  assert.throws(
    () => service.heartbeat("agent-a", epoch, space.id),
    (error: unknown) =>
      error instanceof EgoProtocolError &&
      error.error_code === "EGO_TASK_SPACE_UNAVAILABLE",
  );
  assert.ok(acquired.leaseEpoch > epoch);
  assert.equal(service.currentLease("agent-b").epoch, acquired.leaseEpoch);
  assert.deepEqual(revoked, [{
    taskId: space.taskId,
    clientId: "agent-a",
    leaseEpoch: acquired.leaseEpoch,
  }]);
});

test("an expected task id fences concurrent runtimes that share one client identity", () => {
  const service = new TaskSpaceService({ controlMode: "collaborative" });
  const first = service.create("first", "shared-agent");
  const firstEpoch = service.currentLease("shared-agent").epoch;
  service.create("second", "shared-agent");

  assert.throws(
    () => service.heartbeat("shared-agent", firstEpoch, first.id),
    (error: unknown) =>
      error instanceof EgoProtocolError &&
      error.error_code === "EGO_TASK_SPACE_UNAVAILABLE" &&
      /concurrent Agent operation/.test(error.message),
  );
});

test("handoff fences every request carrying the old epoch", () => {
  const service = new TaskSpaceService({ controlMode: "collaborative" });
  service.create("checkout", "agent-a");
  const oldEpoch = service.currentLease("agent-a").epoch;

  service.handoff("agent-a");

  assert.throws(
    () => service.assertMutationAllowed("agent-a", oldEpoch),
    (error: unknown) =>
      error instanceof EgoProtocolError &&
      error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  assert.equal(service.list()[0]?.ownership, "agentDelegatedToUser");
});

test("takeover requires explicit user consent", () => {
  const service = new TaskSpaceService({ controlMode: "collaborative" });
  const space = service.create("checkout", "agent-a");
  service.handoff("agent-a");

  assert.throws(
    () => service.takeover(space.id, "agent-a"),
    (error: unknown) =>
      error instanceof EgoProtocolError &&
      error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );

  service.authorizeTakeover(space.id);
  const taken = service.takeover(space.id, "agent-a");
  assert.equal(taken.ownership, "agent");
  assert.ok(taken.leaseEpoch > space.leaseEpoch);

  service.handoff("agent-a");
  assert.throws(
    () => service.takeover(space.id, "agent-a"),
    (error: unknown) =>
      error instanceof EgoProtocolError &&
      error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
});

test("restart invalidates leases and never resumes agent control", () => {
  let persisted: TaskSpaceRecord[] = [];
  const store = { load: () => persisted, save: (spaces: TaskSpaceRecord[]) => { persisted = structuredClone(spaces); } };
  const service = new TaskSpaceService({ store, controlMode: "collaborative" });
  const space = service.create("checkout", "agent-a");

  service.recoverAfterRestart();

  const recovered = service.list()[0]!;
  assert.equal(recovered.ownership, "user");
  assert.equal(recovered.pendingAgentReturn, undefined);
  assert.throws(
    () => service.select(space.id, "agent-a"),
    (error: unknown) =>
      error instanceof EgoProtocolError &&
      error.error_code === "EGO_TASK_SPACE_INACTIVE",
  );
});

test("delegated user control survives restart and still rejects claim and takeover", () => {
  let persisted: TaskSpaceRecord[] = [];
  const store = { load: () => persisted, save: (spaces: TaskSpaceRecord[]) => { persisted = structuredClone(spaces); } };
  const first = new TaskSpaceService({ store });
  const created = first.create("restart delegated", "agent-old");
  first.userTakeover(created.id);

  const recovered = new TaskSpaceService({ store });
  recovered.recoverAfterRestart();
  const delegated = recovered.byId(created.id);
  assert.equal(delegated.ownership, "agentDelegatedToUser");
  assert.equal(delegated.lifecycle, "active");
  assert.equal(delegated.pendingAgentReturn, undefined);
  assert.throws(
    () => recovered.claim(created.id, "agent-wrong"),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  assert.throws(
    () => recovered.takeover(created.id, "agent-wrong"),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
});

test("a pending return survives restart and remains bound to the original agent", () => {
  let persisted: TaskSpaceRecord[] = [];
  const store = { load: () => persisted, save: (spaces: TaskSpaceRecord[]) => { persisted = structuredClone(spaces); } };
  const first = new TaskSpaceService({ store });
  const created = first.create("restart pending", "agent-old");
  first.userTakeover(created.id);
  first.returnToAgent(created.id, "desktop-user");

  const recovered = new TaskSpaceService({ store });
  recovered.recoverAfterRestart();
  const pending = recovered.byId(created.id);
  assert.equal(pending.ownership, "agentDelegatedToUser");
  assert.equal(pending.lifecycle, "active");
  assert.equal(pending.pendingAgentReturn, true);
  assert.throws(
    () => recovered.takeover(created.id, "agent-wrong"),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  assert.equal(recovered.byId(created.id).pendingAgentReturn, true);

  const resumed = recovered.takeover(created.id, "agent-old");
  assert.equal(resumed.ownership, "agent");
  assert.equal(resumed.pendingAgentReturn, undefined);
});

test("a stopped task stays delegated and blocked after restart until the desktop returns it", () => {
  let persisted: TaskSpaceRecord[] = [];
  const store = { load: () => persisted, save: (spaces: TaskSpaceRecord[]) => { persisted = structuredClone(spaces); } };
  const first = new TaskSpaceService({ store });
  const created = first.create("restart blocked", "agent-old");
  first.stopAgent(created.id);

  const recovered = new TaskSpaceService({ store });
  recovered.recoverAfterRestart();
  const blocked = recovered.byId(created.id);
  assert.equal(blocked.ownership, "agentDelegatedToUser");
  assert.equal(blocked.lifecycle, "active");
  assert.equal(blocked.agentBlocked, true);
  assert.equal(blocked.pendingAgentReturn, undefined);
  assert.throws(
    () => recovered.takeover(created.id, "agent-old", true),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );

  const unlocked = recovered.returnToAgent(created.id, "desktop-user");
  assert.equal(unlocked.space.agentBlocked, false);
  assert.equal(unlocked.space.pendingAgentReturn, true);
  const resumed = recovered.takeover(created.id, "agent-old");
  assert.equal(resumed.ownership, "agent");
  assert.equal(resumed.pendingAgentReturn, undefined);
});

test("restart repairs stopped records persisted by the previous user-inactive recovery path", () => {
  const now = new Date().toISOString();
  let persisted: TaskSpaceRecord[] = [{
    id: 7,
    taskId: "legacy-stopped-task",
    name: "legacy stopped",
    profileId: "default",
    order: 0,
    createdBy: "agent-old",
    ownership: "user",
    lifecycle: "inactive",
    backend: "fake",
    generation: 4,
    leaseEpoch: 4,
    createdAt: now,
    updatedAt: now,
    lastAgentClientId: "agent-old",
    agentBlocked: true,
  }];
  const store = { load: () => persisted, save: (spaces: TaskSpaceRecord[]) => { persisted = structuredClone(spaces); } };
  const recovered = new TaskSpaceService({ store });

  recovered.recoverAfterRestart();

  const repaired = recovered.byId(7);
  assert.equal(repaired.ownership, "agentDelegatedToUser");
  assert.equal(repaired.lifecycle, "active");
  assert.equal(repaired.agentBlocked, true);
  assert.throws(
    () => recovered.takeover(7, "agent-old", true),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  const unlocked = recovered.returnToAgent(7, "desktop-user");
  assert.equal(unlocked.space.agentBlocked, false);
  assert.equal(unlocked.space.pendingAgentReturn, true);
});

test("disabling handoff keeps a desktop lease valid after opening a stopped space", () => {
  const service = new TaskSpaceService();
  const created = service.create("desktop stopped task", "agent-old");
  service.stopAgent(created.id);
  service.authorizeTakeover(created.id);
  const opened = service.takeover(created.id, "desktop-user");
  assert.equal(opened.ownership, "agent");
  assert.equal(opened.agentBlocked, true);

  service.clearControlHandoffs();

  const cleared = service.byId(created.id);
  assert.equal(cleared.ownership, "agent");
  assert.equal(cleared.lifecycle, "active");
  assert.equal(cleared.agentBlocked, undefined);
  assert.equal(service.currentLease("desktop-user").epoch, cleared.leaseEpoch);
});

test("force close revokes the live lease, fences its epoch, and clears every selection", () => {
  let now = 1_000;
  const service = new TaskSpaceService({ controlMode: "collaborative", leaseTtlMs: 100, clock: { now: () => now } });
  const created = service.create("force close", "agent-old");
  const oldEpoch = service.currentLease("agent-old").epoch;
  now += 101;
  service.select(created.id, "agent-new");
  const revoked: unknown[] = [];
  service.onLeaseRevoked((event) => revoked.push(event));

  const closed = service.forceClose(created.id);

  assert.equal(closed.ownership, "user");
  assert.equal(closed.lifecycle, "closed");
  assert.ok(closed.leaseEpoch > oldEpoch);
  assert.equal(service.leaseHolder(created.taskId), undefined);
  assert.deepEqual(service.list(), []);
  assert.deepEqual(revoked, [{
    taskId: created.taskId,
    clientId: "agent-new",
    leaseEpoch: closed.leaseEpoch,
  }]);
  for (const clientId of ["agent-old", "agent-new"]) {
    assert.throws(
      () => service.selected(clientId),
      (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_NOT_SELECTED",
    );
  }
  assert.throws(
    () => service.assertMutationAllowed("agent-new", oldEpoch),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_NOT_SELECTED",
  );
});

test("force close clears pending, blocked, and takeover authorization state", () => {
  let persisted: TaskSpaceRecord[] = [];
  const store = { load: () => persisted, save: (spaces: TaskSpaceRecord[]) => { persisted = structuredClone(spaces); } };
  const service = new TaskSpaceService({ store });
  const created = service.create("clear force-close state", "agent-old");
  service.stopAgent(created.id);
  service.returnToAgent(created.id, "desktop-user");
  service.authorizeTakeover(created.id);
  const previousEpoch = service.byId(created.id).leaseEpoch;

  const closed = service.forceClose(created.id);

  assert.ok(closed.leaseEpoch > previousEpoch);
  assert.equal(closed.pendingAgentReturn, undefined);
  assert.equal(closed.agentBlocked, undefined);
  assert.equal(persisted[0]?.ownership, "user");
  assert.equal(persisted[0]?.lifecycle, "closed");
  assert.equal(persisted[0]?.pendingAgentReturn, undefined);
  assert.equal(persisted[0]?.agentBlocked, undefined);
  assert.throws(
    () => service.forceClose(created.id),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_INACTIVE",
  );
});

test("user takeover revokes the agent lease and fences the old epoch", () => {
  const service = new TaskSpaceService();
  const space = service.create("controlled", "agent-a");
  const oldEpoch = service.currentLease("agent-a").epoch;
  const revoked: unknown[] = [];
  service.onLeaseRevoked((event) => revoked.push(event));
  const taken = service.userTakeover(space.id);
  assert.equal(taken.ownership, "agentDelegatedToUser");
  assert.equal(taken.lastAgentClientId, "agent-a");
  assert.ok(taken.leaseEpoch > oldEpoch);
  assert.equal(service.leaseHolder(space.taskId), undefined);
  assert.deepEqual(revoked, [{ taskId: space.taskId, clientId: "agent-a", leaseEpoch: taken.leaseEpoch }]);
  assert.throws(
    () => service.assertMutationAllowed("agent-a", oldEpoch),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
});

test("stopping a space preserves tabs while blocking agent re-claim", () => {
  const service = new TaskSpaceService();
  const space = service.create("stoppable", "agent-a");
  service.userTakeover(space.id);
  service.returnToAgent(space.id, "desktop-user");
  const stopped = service.stopAgent(space.id);
  assert.equal(stopped.agentBlocked, true);
  assert.equal(stopped.pendingAgentReturn, undefined);
  assert.equal(stopped.ownership, "agentDelegatedToUser");
  assert.throws(
    () => service.takeover(space.id, "agent-b", true),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  const userClaim = service.claim(space.id, "desktop-user");
  assert.equal(userClaim.agentBlocked, true);
});

test("returning a user-held space clears the stop and restores the agent lease", () => {
  const service = new TaskSpaceService();
  const space = service.create("returnable", "agent-a");
  service.stopAgent(space.id);
  const returned = service.returnToAgent(space.id, "desktop-user", "agent-a");
  assert.equal(returned.agentClientId, "agent-a");
  assert.equal(returned.space.ownership, "agent");
  assert.equal(returned.space.agentBlocked, false);
  assert.equal(returned.space.pendingAgentReturn, undefined);
  assert.equal(service.leaseHolder(space.taskId)?.clientId, "agent-a");
});

test("a pending return is bound to the last agent by default", () => {
  const service = new TaskSpaceService();
  const space = service.create("pending", "agent-old");
  service.userTakeover(space.id);

  const pending = service.returnToAgent(space.id, "desktop-user");
  assert.equal(pending.agentClientId, undefined);
  assert.equal(pending.space.ownership, "agentDelegatedToUser");
  assert.equal(pending.space.pendingAgentReturn, true);
  assert.equal(service.leaseHolder(space.taskId), undefined);

  assert.throws(
    () => service.takeover(space.id, "agent-wrong"),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  assert.equal(service.byId(space.id).pendingAgentReturn, true);

  const resumed = service.takeover(space.id, "agent-old");
  assert.equal(resumed.ownership, "agent");
  assert.equal(resumed.pendingAgentReturn, undefined);
  assert.equal(resumed.lastAgentClientId, "agent-old");
  assert.equal(service.leaseHolder(space.taskId)?.clientId, "agent-old");
});

test("taking user control again cancels a pending agent return", () => {
  const service = new TaskSpaceService();
  const space = service.create("cancel pending", "agent-a");
  service.userTakeover(space.id);
  service.returnToAgent(space.id, "desktop-user");
  service.authorizeTakeover(space.id);

  const taken = service.userTakeover(space.id);
  assert.equal(taken.ownership, "agentDelegatedToUser");
  assert.equal(taken.pendingAgentReturn, undefined);
  assert.throws(
    () => service.takeover(space.id, "agent-b"),
    (error: unknown) => error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
});
