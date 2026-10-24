import test from "node:test";
import assert from "node:assert/strict";
import { summarizeEgoPending } from "../../../integrations/cos/hosted-execution.ts";

async function isolated(probe = false) {
  const before = { hosted: process.env.COS_EGO_HOSTED, probe: process.env.COS_EGO_PROBE };
  process.env.COS_EGO_HOSTED = "1";
  process.env.COS_EGO_PROBE = probe ? "1" : "0";
  try { return await import(`../../../integrations/cos/hosted-execution.ts?test=${crypto.randomUUID()}`); }
  finally {
    if (before.hosted === undefined) delete process.env.COS_EGO_HOSTED; else process.env.COS_EGO_HOSTED = before.hosted;
    if (before.probe === undefined) delete process.env.COS_EGO_PROBE; else process.env.COS_EGO_PROBE = before.probe;
  }
}

test("CoS recovery counts pending input, workers, Goal/Loop and continuation obligations", () => {
  assert.deepEqual(summarizeEgoPending({
    inputs: [{ state: "queued", dueAt: 0 }, { state: "browser" }, { state: "sent" }, { state: "cancelled" }, { state: "failed" }],
    commands: { commands: [{ id: "pending" }] }, swarm: { activeRuns: [{ runId: "worker-run" }] },
    goals: { switches: [{ enabled: true, mode: "loop" }, { enabled: false }] },
    replies: { replies: [{ state: "pending" }, { state: "handled" }] },
    continuations: { entries: [{ state: "awaiting-summary" }, { state: "committed" }, { state: "aborted" }] },
  }), { inputs: 2, commands: 1, workers: 1, goals: 1, replies: 1, continuations: 1 });
  assert.deepEqual(summarizeEgoPending({ swarm: { activeRuns: [], dormantRuns: [{}] }, inputs: [{ state: "sent" }] }), {});
  assert.deepEqual(summarizeEgoPending({}, true), { goals: 1 });
});

test("CoS startup waits for the host and activates an empty instance without a resume prompt", async () => {
  const gate = await isolated();
  assert.equal(gate.egoExecutionAllowed(), false);
  let calls = 0;
  gate.configureEgoExecution({}, async () => { calls++; });
  assert.equal(gate.egoExecutionAllowed(), false);
  assert.equal((await gate.activateEgoExecution()).mode, "running");
  await gate.activateEgoExecution();
  assert.equal(calls, 1);
});

test("CoS restart does not resume saved work without an explicit action", async () => {
  const gate = await isolated();
  let calls = 0;
  gate.configureEgoExecution({ inputs: 1 }, async () => { calls++; });
  assert.equal((await gate.activateEgoExecution()).requiresResume, true);
  assert.equal(calls, 0);
  assert.equal(gate.egoExecutionAllowed(), false);
  assert.equal((await gate.activateEgoExecution(true)).mode, "running");
  assert.equal(calls, 1);
});

test("CoS repeated resume requests share startup and failed activation remains paused", async () => {
  const gate = await isolated();
  let calls = 0, release;
  gate.configureEgoExecution({ workers: 1 }, async () => { calls++; await new Promise(resolve => { release = resolve; }); });
  const first = gate.activateEgoExecution(true);
  const second = gate.activateEgoExecution(true);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  let cleaned = false;
  gate.configureEgoExecution({}, async () => { throw new Error("failed startup"); }, async () => {
    assert.equal(gate.egoExecutionAllowed(), false);
    cleaned = true;
  });
  await assert.rejects(gate.activateEgoExecution(), /failed startup/);
  assert.equal(gate.egoExecutionAllowed(), false);
  assert.equal(cleaned, true);
});

test("CoS maintenance probe never activates services even for an explicit resume", async () => {
  const gate = await isolated(true);
  gate.configureEgoExecution({}, async () => { throw new Error("must not run"); });
  assert.equal(gate.egoIsProbe(), true);
  assert.equal(gate.egoExecutionAllowed(), false);
  await assert.rejects(gate.activateEgoExecution(true), /cannot execute/);
});
