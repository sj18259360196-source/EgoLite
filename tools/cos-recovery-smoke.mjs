import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CosRuntime } from "../apps/desktop-shell/workspace-packs/cos-runtime.mjs";

const { values } = parseArgs({ options: { candidate: { type: "string" } } });
if (!values.candidate) throw new Error("--candidate <prepared pack> is required");
const root = resolve(import.meta.dirname, "..");
const work = join(root, ".tmp/codex/cos-integration", `recovery-${randomUUID()}`);
const data = join(work, "data");
const evidence = join(root, "docs/cos-workspace-pack/evidence");
await mkdir(work, { recursive: true });
const logs = [], hostRequests = [], pids = [];
let runtime;
const result = { checkedAt: new Date().toISOString(), candidate: resolve(values.candidate), passed: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const saveJson = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const call = async (channel, payload) => {
  const reply = await runtime.invoke(channel, payload);
  assert.equal(reply.ok, true, reply.error);
  return reply.data;
};
async function launch(probeOnly = false) {
  runtime = new CosRuntime({
    directory: resolve(values.candidate), dataDirectory: data, probeOnly,
    onHostRequest: async (method, payload) => {
      hostRequests.push({ method, payload });
      throw new Error("Recovery fixture does not open external websites");
    },
  });
  runtime.on("log", text => logs.push(text));
  runtime.on("runtime-error", error => logs.push(String(error.stack)));
  await runtime.start();
  pids.push(runtime.pid);
}
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
try {
  await launch();
  assert.equal((await runtime.invoke("ego:execution-status")).mode, "waiting");
  assert.equal((await runtime.invoke("ego:execution-activate")).mode, "running");
  await call("roots:addPath", { path: work });
  const id = randomUUID();
  await call("sessions:send", {
    id, sessionId: null, text: "Saved due input recovery fixture", mode: "auto",
    dueAt: 0, model: null, reasoningEffort: null, automation: "off",
  });
  let input;
  for (let n = 0; n < 100; n++) {
    input = (await call("sessions:outbox")).find(row => row.id === id);
    if (input?.error) break;
    await delay(100);
  }
  assert.equal(input?.state, "queued");
  assert.match(input.error, /Enter a tunnel ID/);
  await runtime.stop();
  const configPath = join(data, "config.json");
  const config = await readJson(configPath);
  config.ui.autoConnect = true;
  config.controlApi.enabled = true;
  config.multiAgent.enabled = true;
  config.goal.enabled = true;
  await saveJson(configPath, config);
  const now = Date.now(), runId = randomUUID(), conversationId = "c-prime-recovery";
  const agent = (id, role, state, conversationId) => ({
    info: {
      runId, primeConversationId: "c-prime-recovery", id, role, state, conversationId,
      label: id, task: "Recovery fixture", model: null, reasoningEffort: null,
      createdAt: now, activatedAt: null, finishedAt: null, result: null,
      pending: 0, awaitingAck: 0, delivered: 0, detachedAt: null, lastSeenAt: null,
      revivable: false, contextTokens: 0,
    }, queue: [],
  });
  await saveJson(join(data, "state/swarm.json"), {
    version: 7, savedAt: now, runId: null, primeConversationId: null, startedAt: null, agents: [],
    activeRuns: [{
      runId, primeConversationId: conversationId, startedAt: now,
      agents: [agent("prime", "prime", "active", conversationId), agent("worker-recovery", "worker", "invited", null)],
    }], dormantRuns: [],
  });
  await saveJson(join(data, "state/goal-switches.json"), {
    version: 1, savedAt: now, switches: [{ conversationId, enabled: true, mode: "loop", at: now }],
  });
  await saveJson(join(data, "state/goal-replies.json"), {
    version: 1, savedAt: now, replies: [{
      conversationId, sessionId: input.sessionId, replyId: randomUUID(), turnId: randomUUID(),
      eventSeq: 1, acceptedAt: now, state: "pending",
    }],
  });
  await saveJson(join(data, "state/continuations.json"), {
    version: 1, savedAt: now, entries: [{
      token: randomUUID().replaceAll("-", ""), sessionId: input.sessionId, from: conversationId,
      to: null, openedAt: now, touchedAt: now, state: "awaiting-summary",
      automatic: true, summary: "", sourceProgress: 0, requestedModel: null,
    }],
  });
  const pluginId = randomUUID(), pluginDirectory = join(data, "plugins", pluginId, "source");
  const pluginMarker = join(work, "plugin-started.json");
  await mkdir(pluginDirectory, { recursive: true });
  await saveJson(join(data, "state/plugins.json"), [{
    id: pluginId, name: "Recovery process fixture", directory: pluginDirectory, enabled: true,
    source: { kind: "command" }, config: {}, credentialKeys: [], disabledTools: [], catalog: [],
    launch: {
      command: process.execPath,
      args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(pluginMarker)}, JSON.stringify({pid:process.pid})+'\\n')`],
    },
  }]);
  const watched = ["config.json", "state/session-input.json", "state/swarm.json",
    "state/goal-switches.json", "state/goal-replies.json", "state/continuations.json", "state/plugins.json"];
  const before = await Promise.all(watched.map(file => readFile(join(data, file), "utf8")));
  hostRequests.length = 0;
  await launch(true);
  assert.equal((await runtime.invoke("ego:execution-status")).mode, "probe");
  assert.equal((await call("state:get")).bridge.running, false);
  for (const channel of ["ego:execution-activate", "connection:connect", "sessions:send", "workspaceTerminal:request"]) {
    await assert.rejects(runtime.invoke(channel, { resume: true }), /probe only accepts state reads/);
  }
  await delay(1500);
  assert.equal(hostRequests.length, 0);
  await assert.rejects(readFile(pluginMarker), { code: "ENOENT" });
  await runtime.stop();
  assert.deepEqual(await Promise.all(watched.map(file => readFile(join(data, file), "utf8"))), before);
  result.probeDoesNotExecuteOrRewriteSavedWork = true;

  await launch();
  const paused = await runtime.invoke("ego:execution-activate");
  assert.equal(paused.mode, "paused");
  for (const key of ["inputs", "workers", "goals", "replies", "continuations"]) assert.ok(paused.pending[key] > 0, key);
  result.pending = paused.pending;
  assert.equal((await call("state:get")).bridge.running, false);
  assert.equal((await call("sessions:outbox")).find(row => row.id === id).state, "queued");
  const swarm = await call("swarm:get");
  result.restoredSwarm = swarm;
  assert.equal(swarm.agents.find(row => row.id === "worker-recovery")?.state, "invited",
    "Worker must survive upstream deserialization");
  assert.ok((await call("plugins:snapshot")).plugins.some(row => row.id === pluginId));
  await assert.rejects(runtime.invoke("sessions:send", { text: "Must not execute" }), /tasks are paused/);
  await assert.rejects(runtime.invoke("connection:connect"), /tasks are paused/);
  await delay(1500);
  assert.equal(hostRequests.length, 0);
  await assert.rejects(readFile(pluginMarker), { code: "ENOENT" });
  result.savedWorkWaitsForExplicitResume = true;
  assert.equal((await runtime.invoke("ego:execution-activate", { resume: true })).mode, "running");
  const active = await call("state:get");
  assert.equal(active.bridge.running, true);
  await runtime.invoke("ego:execution-activate", { resume: true });
  let launches;
  for (let n = 0; n < 100; n++) {
    try { launches = (await readFile(pluginMarker, "utf8")).trim().split("\n").map(JSON.parse); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; await delay(100); }
  }
  assert.equal(launches?.length, 1, "Enabled plugin must start exactly once after explicit resume");
  pids.push(launches[0].pid);
  result.enabledPluginStartsOnlyAfterResume = true;
  let commandSnapshot;
  for (let n = 0; n < 100; n++) {
    try {
      commandSnapshot = await readJson(join(data, "state/bridge-commands.json"));
      if (JSON.stringify(commandSnapshot).includes("worker-recovery")) break;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(100);
  }
  assert.ok(JSON.stringify(commandSnapshot).includes("worker-recovery"), "Resume must requeue the original worker bootstrap");
  result.originalWorkerBootstrapRestored = true;
  result.explicitResumeStartsOriginalBridge = true;
  await call("sessions:cancelInput", { id });
  assert.equal((await call("sessions:outbox")).find(row => row.id === id).state, "cancelled");
  result.originalCancellationStillWorks = true;
  result.passed = true;
} catch (error) {
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  await runtime?.stop();
  for (const pid of pids) {
    for (let n = 0; n < 30 && alive(pid); n++) await delay(100);
    if (alive(pid)) { result.passed = false; result.processStillAlive = pid; process.exitCode = 1; }
  }
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, "cos-recovery-host.txt"), logs.join(""));
  await rm(work, { recursive: true, force: true });
  result.testDataDirectoryRemoved = true;
  await saveJson(join(evidence, "cos-recovery-smoke.json"), result);
  console.log(JSON.stringify(result, null, 2));
}
