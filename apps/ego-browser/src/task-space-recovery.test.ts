import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The vendored runtime is JavaScript and intentionally has no helper declarations.
import { useOrCreateTaskSpace, takeOverTaskSpace, waitForAgentControl, helperContext } from "../../../vendor/ego-browser/src/helpers.js";

const delegatedSpace = {
  id: 9,
  taskId: "task-9",
  name: "delegated",
  ownership: "agentDelegatedToUser",
};

test("useOrCreate makes one automatic takeover attempt for a delegated space", async (t) => {
  const calls: string[] = [];
  installFakeEgo(t, {
    async useOrCreateTaskSpace(name: string) {
      calls.push("atomic:" + name);
      return { ...delegatedSpace, ownership: "agent" };
    },
    async useTaskSpace(id: number) {
      calls.push("select:" + id);
      throw userControlError();
    },
    async takeOverTaskSpace() {
      calls.push("takeover");
    },
  });

  const resumed = await useOrCreateTaskSpace("delegated");

  assert.equal(resumed.ownership, "agent");
  assert.deepEqual(calls, ["atomic:delegated"]);
});

test("useOrCreate stops when takeover still requires authorization", async (t) => {
  const calls: string[] = [];
  installFakeEgo(t, {
    async useOrCreateTaskSpace(name: string) {
      calls.push("atomic:" + name);
      throw userControlError("User consent is required");
    },
    async useTaskSpace(id: number) {
      calls.push("select:" + id);
      throw userControlError();
    },
    async takeOverTaskSpace() {
      calls.push("takeover");
      throw userControlError("User consent is required");
    },
  });

  await assert.rejects(
    useOrCreateTaskSpace("delegated"),
    (error: unknown) =>
      (error as { error_code?: unknown }).error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  assert.deepEqual(calls, ["atomic:delegated"]);
});

function installFakeEgo(t: test.TestContext, ego: Record<string, unknown>): void {
  const target = globalThis as unknown as Record<string, unknown>;
  const hadPreviousEgo = Object.hasOwn(target, "ego");
  const previousEgo = target.ego;
  target.ego = ego;
  t.after(() => {
    if (hadPreviousEgo) target.ego = previousEgo;
    else delete target.ego;
  });
}

test("named takeover and wait resolve IDs without changing selection first", async (t) => {
  const calls: unknown[] = [];
  installFakeEgo(t, {
    async listTaskSpaces() { return { taskSpaces: [delegatedSpace] }; },
    async useTaskSpace() { throw new Error("Must not select a user-controlled space"); },
    async takeOverTaskSpace(id: number) { calls.push(["takeover", id]); },
    async waitForAgentControl(id: number, options: unknown) { calls.push(["wait", id, options]); },
  });
  await takeOverTaskSpace("delegated");
  const signal = new AbortController().signal;
  await waitForAgentControl("delegated", { timeout: 2, signal });
  assert.deepEqual(calls, [["takeover", 9], ["wait", 9, { timeout: 2000, signal }]]);
});

test("named control operations reject legacy duplicate names", async (t) => {
  installFakeEgo(t, {
    async listTaskSpaces() { return { taskSpaces: [delegatedSpace, { ...delegatedSpace, id: 10, taskId: "task-10" }] }; },
    async takeOverTaskSpace() { throw new Error("Must not take over an ambiguous space"); },
  });
  await assert.rejects(takeOverTaskSpace("delegated"), /Ambiguous/);
  await assert.rejects(waitForAgentControl("delegated"), /Ambiguous/);
});

test("SDK exposes the read-only and explicit control facade", async (t) => {
  installFakeEgo(t, {
    async listTaskSpaces() { return { taskSpaces: [delegatedSpace] }; },
    async observeTaskSpace(id: number, targetId: string) { return { id, targetId }; },
    async requestControl(id: number) { return { id }; },
    async returnControl(id: number, requestId: string) { return { id, requestId }; },
  });
  const facade = helperContext().taskSpaces;
  assert.deepEqual(await facade.observe("delegated", "tab-1"), { id: 9, targetId: "tab-1" });
  assert.deepEqual(await facade.requestControl("delegated"), { id: 9 });
  assert.deepEqual(await facade.returnControl("delegated", "request-1"), { id: 9, requestId: "request-1" });
});

function userControlError(message = "User took control"): Error {
  return Object.assign(new Error(message), {
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
}
