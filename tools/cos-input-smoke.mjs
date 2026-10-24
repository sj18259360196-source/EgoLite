import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CosRuntime } from "../apps/desktop-shell/workspace-packs/cos-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const work = join(root, ".tmp/codex/cos-integration", `input-${randomUUID()}`);
await mkdir(work, { recursive: true });
const runtime = new CosRuntime({
  directory: join(root, "packs/cos/versions/2.1.20-ego.1"), dataDirectory: join(work, "state"),
});
const result = { checkedAt: new Date().toISOString(), passed: false, testDataDirectory: work };
const logs = [];
runtime.on("log", text => logs.push(text));
runtime.on("runtime-error", error => logs.push(`${error.stack}\n${error.cause?.stack || ""}\n`));
const call = async (channel, payload) => {
  const response = await runtime.invoke(channel, payload);
  assert.equal(response.ok, true, response.error);
  return response.data;
};
try {
  await runtime.start();
  const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
  const staged = await call("sessions:dropFiles", { files: [{ name: "binary-fixture.bin", bytes }] });
  assert.equal(staged.length, 1);
  assert.equal(staged[0].size, bytes.length);
  assert.deepEqual(new Uint8Array(await readFile(join(work, "state/input-attachments", staged[0].id))), bytes);
  result.binaryAttachmentAccepted = true;
  await call("roots:addPath", { path: work });
  const id = randomUUID();
  const queued = await call("sessions:send", {
    id, sessionId: null, text: "CoS isolated persistence fixture", mode: "auto",
    dueAt: 0, model: null, reasoningEffort: null, automation: "off", attachments: staged,
  });
  assert.equal(queued.id, id);
  assert.equal(queued.state, "queued");
  result.originalInputAdmission = true;
  let outbox;
  for (let attempt = 0; attempt < 50; attempt++) {
    outbox = await call("sessions:outbox");
    if (outbox.find(row => row.id === id)?.error) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const row = outbox.find(row => row.id === id);
  assert.ok(row?.error, "Unconfigured connector should report a setup failure");
  assert.match(row.error, /Enter a tunnel ID/, "Bundled tunnel must be found before asking for account setup");
  assert.equal(row.state, "queued");
  result.unconfiguredConnectorPreservesQueuedInput = true;
  result.setupFailure = row.error;
  const sessions = await call("sessions:list", {});
  assert.ok(sessions.sessions.some(session => session.id === row.sessionId));
  result.nonemptySessionRead = true;
  await runtime.stop();
  await runtime.start();
  const restored = (await call("sessions:outbox")).find(entry => entry.id === id);
  assert.equal(restored.text, row.text);
  assert.equal(restored.state, "queued");
  assert.deepEqual(restored.attachments, staged);
  assert.deepEqual(new Uint8Array(await readFile(join(work, "state/input-attachments", staged[0].id))), bytes);
  assert.ok((await call("sessions:list", {})).sessions.some(session => session.id === row.sessionId));
  result.sessionAndOutboxRestored = true;
  await call("sessions:cancelInput", { id });
  assert.equal((await call("sessions:outbox")).find(entry => entry.id === id).state, "cancelled");
  result.cancelPersistedInput = true;
  result.passed = true;
} catch (error) {
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  await runtime.stop();
  result.runtimeStopped = runtime.state === "stopped";
  await writeFile(join(work, "runtime.log"), logs.join(""));
  const evidence = join(root, "docs/cos-workspace-pack/evidence");
  await writeFile(join(evidence, "cos-input-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
