import assert from "node:assert/strict";
import test from "node:test";
import { MutationGate } from "./mutation-gate.mjs";

test("queued continuations and captured targets retain their original lease", async () => {
  let epoch = 1;
  let writes = 0;
  const gate = new MutationGate((context, taskId) => {
    assert.equal(context.taskId, taskId);
    if (context.leaseEpoch !== epoch) throw new Error("revoked");
  });
  const target = { debugger: { async sendCommand() { writes++; } }, async executeJavaScript() { writes++; }, sendInputEvent() { writes++; } };
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const pending = gate.run({ taskId: "task", leaseEpoch: 1 }, async () => {
    const guarded = gate.guardTarget(target, "task");
    await blocked;
    await assert.rejects(guarded.executeJavaScript("ignored"), /revoked/);
    await assert.rejects(guarded.debugger.sendCommand("Runtime.evaluate"), /revoked/);
    assert.throws(() => guarded.sendInputEvent({}), /revoked/);
    assert.throws(() => gate.assertMutationAllowed("task"), /revoked/);
  });
  epoch = 2;
  release();
  await pending;
  assert.equal(writes, 0);
});

test("the final backend authorization check rejects a revocation during lookup", async () => {
  let allowed = true, writes = 0;
  const gate = new MutationGate(() => { if (!allowed) throw new Error("revoked"); }, async () => { allowed = false; });
  await gate.run({ taskId: "one" }, async () => {
    const target = gate.guardTarget({ debugger: {}, async executeJavaScript() { writes++; } }, "one");
    await assert.rejects(target.executeJavaScript("ignored"), /revoked/);
  });
  assert.equal(writes, 0);
});

test("native read-only debugger and navigationHistory properties remain guardable", async () => {
  let allowed = true, writes = 0;
  const gate = new MutationGate(() => { if (!allowed) throw new Error("revoked"); });
  const target = { id: 42, isDestroyed() { return this.id !== 42; } };
  Object.defineProperty(target, "debugger", { value: { attach() { writes++; }, async sendCommand() { writes++; } } });
  Object.defineProperty(target, "navigationHistory", { value: { goBack() { writes++; } } });
  await gate.run({ taskId: "cos" }, async () => {
    const guarded = gate.guardTarget(target, "cos");
    assert.equal(guarded.isDestroyed(), false);
    guarded.debugger.attach();
    guarded.navigationHistory.goBack();
    const guardedAgain = gate.guardTarget(guarded, "cos");
    await guardedAgain.debugger.sendCommand("Runtime.evaluate");
    allowed = false;
    assert.throws(() => guarded.debugger.attach(), /revoked/);
    assert.throws(() => guardedAgain.navigationHistory.goBack(), /revoked/);
    await assert.rejects(guarded.debugger.sendCommand("Runtime.evaluate"), /revoked/);
  });
  assert.equal(writes, 3);
});
