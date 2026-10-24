import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { CosRuntime } from "../apps/desktop-shell/workspace-packs/cos-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const work = join(root, ".tmp/codex/cos-integration", `local-tools-${randomUUID()}`);
await mkdir(work, { recursive: true });
const runtime = new CosRuntime({
  directory: resolve(process.argv[2] || join(root, "packs/cos/versions/2.1.20-ego.1")), dataDirectory: join(work, "state"),
});
const result = { checkedAt: new Date().toISOString(), passed: false, testDataDirectory: work };
const terminalId = randomUUID();
let output = "";
const terminal = async payload => {
  const response = await runtime.invoke("workspaceTerminal:request", { id: terminalId, ...payload });
  assert.equal(response.ok, true, response.error);
  return response.data;
};
runtime.on("event", (channel, args) => {
  const event = args?.[0];
  if (channel === "workspaceTerminal:event" && event.id === terminalId && event.data) {
    output += event.data;
    void terminal({ action: "ack", count: event.data.length }).catch(() => {});
  }
});
try {
  await runtime.start();
  const initial = await runtime.invoke("state:get");
  assert.equal(initial.ok, true, initial.error);
  result.originalCapabilities = initial.data.config.capabilities;
  const fields = ["capabilities", "readOnly", "commandAllowlist", "tunnel", "ui", "sessions", "compaction", "multiAgent", "goal", "mcp", "controlApi"];
  const base = Object.fromEntries(fields.filter(key => initial.data.config[key] !== undefined).map(key => [key, initial.data.config[key]]));
  const configured = await runtime.invoke("settings:save", {
    base, patch: { ...base, readOnly: false, capabilities: { ...base.capabilities, command: true } },
  });
  assert.equal(configured.ok, true, configured.error);
  const approved = await runtime.invoke("roots:addPath", { path: work });
  assert.equal(approved.ok, true, approved.error);
  result.approvedIsolatedFolder = true;
  const created = await terminal({ action: "create", projectId: null, cols: 100, rows: 30 });
  assert.equal(created.shell, "powershell");
  result.nativeTerminalCreated = true;
  const path = join(work, "terminal-result.txt");
  const quoted = path.replaceAll("'", "''");
  await terminal({
    action: "write",
    data: `[System.IO.File]::WriteAllText('${quoted}', 'cos-terminal-ok'); [Console]::WriteLine('COS_NATIVE_' + 'TERMINAL_DONE')\r`,
  });
  const deadline = Date.now() + 20000;
  while (!output.includes("COS_NATIVE_TERMINAL_DONE") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(output.includes("COS_NATIVE_TERMINAL_DONE"), "Native shell output did not return");
  assert.equal(await readFile(path, "utf8"), "cos-terminal-ok");
  result.nativeCommandAndFileWrite = true;
  result.terminalOutputReturned = true;
  await terminal({ action: "resize", cols: 120, rows: 40 });
  await terminal({ action: "close" });
  result.terminalClosed = true;
  result.passed = true;
} catch (error) {
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  await runtime.stop();
  result.runtimeStopped = runtime.state === "stopped";
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  result.testDataDirectoryRemoved = true;
  const evidence = join(root, "docs/cos-workspace-pack/evidence");
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, "cos-local-tools-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
