import assert from "node:assert/strict";

import { createEgoRuntime, PipeRuntimeTransport } from "@ego-compat/runtime-adapter";

const pipeName = process.env.EGO_COMPAT_PIPE || "\\\\.\\pipe\\ego-compat-codex";
const url = process.env.EGO_COMPANION_SMOKE_URL || "https://example.com/";
const timeout = Number(process.env.EGO_COMPANION_READY_TIMEOUT || 120_000);
const transport = await PipeRuntimeTransport.connect(pipeName);
const runtime = createEgoRuntime(transport, { clientId: `companion-profile-smoke-${process.pid}` });

try {
  const backend = await waitForReady(transport, timeout);
  assert.equal(backend.kind, "companion");
  const task = await runtime.createTaskSpace(`Companion profile smoke ${new Date().toISOString()}`);
  const tab = await runtime.createTab(url);
  const snapshot = await runtime.snapshot({ includeActionMarks: true, scope: "viewport" });
  assert.equal(tab.url.startsWith(new URL(url).origin), true);
  assert.ok(snapshot.content.length > 0);
  await runtime.handOffTaskSpace();
  console.log(JSON.stringify({
    ok: true,
    backend,
    taskId: task.taskId,
    targetId: tab.targetId,
    title: tab.title,
    url: tab.url,
    snapshotCharacters: snapshot.content.length,
    handedToUser: true,
  }, null, 2));
} finally {
  await transport.close();
}

async function waitForReady(transport, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = await transport.request("backend.status", { clientId: "companion-profile-smoke" });
    if (status.ready) return status;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(status?.message || "Timed out waiting for the Companion extension");
}
