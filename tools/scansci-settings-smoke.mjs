import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "..");
const parent = join(root, ".tmp/codex/scansci-settings-smoke");
await mkdir(parent, { recursive: true });
const work = await mkdtemp(join(parent, "run-"));
const executable = resolve(process.argv[2] || join(root, "release/win-unpacked/EgoLite.exe"));
const id = randomUUID();
const portProbe = createServer();
await new Promise(resolveListen => portProbe.listen(0, "127.0.0.1", resolveListen));
const port = portProbe.address().port;
await new Promise(resolveClose => portProbe.close(resolveClose));
const resultPath = join(work, "settings.json");
const capture = join(work, "settings.png");
const guestCapture = join(work, "page.png");
await writeFile(join(work, "desktop-preferences.json"), JSON.stringify({ onboardingCompleted: true, controlMode: "agent" }));
const env = {
  ...process.env, LOCALAPPDATA: join(work, "local"), APPDATA: join(work, "roaming"),
  EGO_DESKTOP_USER_DATA: join(work, "user"), EGO_DESKTOP_STATE: join(work, "state.json"),
  EGO_DESKTOP_PIPE: `\\\\.\\pipe\\settings-${id}`, EGO_COMPAT_PIPE: `\\\\.\\pipe\\settings-${id}`,
  EGO_DESKTOP_AUTOMATION_PIPE: `\\\\.\\pipe\\settings-ui-${id}`,
  EGO_AGENT_INTEGRATION_DISABLED: "1", SCANSCI_PORT: String(port),
  EGO_DESKTOP_CAPTURE_SCANSCI_SETTINGS: "1", EGO_DESKTOP_CAPTURE_SCANSCI_RESULT: resultPath,
  EGO_DESKTOP_CAPTURE: capture, TEMP: work, TMP: work,
  EGO_DESKTOP_CAPTURE_SCANSCI_PAGE: guestCapture,
};
for (const name of ["ELECTRON_RUN_AS_NODE", "PYTHONHOME", "PYTHONPATH", "SCANSCI_PROJECT_DIR", "SCANSCI_PYTHON"]) delete env[name];
const app = spawn(executable, [], { cwd: work, env, windowsHide: true, stdio: "ignore" });
let output;
let state;
try {
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    try { state = JSON.parse(await readFile(resultPath, "utf8")); if ((await readFile(capture)).length > 1000) break; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  assert.ok(state, "Settings capture did not complete");
  assert.equal(state.renderer.active, true);
  assert.match(state.renderer.service, /运行中/);
  assert.equal(state.renderer.error, "");
  assert.equal(state.service.identity.version, "1.19.0");
  assert.ok(state.page.bodyLength > 100 && state.page.fields > 0, "Embedded settings page is blank or not initialized");
  const evidence = join(root, "docs/scansci-integration/evidence");
  await mkdir(evidence, { recursive: true });
  await copyFile(capture, join(evidence, "settings.png"));
  await copyFile(guestCapture, join(evidence, "settings-page.png"));
  output = { passed: true, checkedAt: new Date().toISOString(), renderer: state.renderer, page: state.page, version: state.service.identity.version };
} catch (error) {
  output = { passed: false, checkedAt: new Date().toISOString(), error: error.stack, renderer: state?.renderer };
  await mkdir(join(root, "docs/scansci-integration/evidence"), { recursive: true });
  await copyFile(capture, join(root, "docs/scansci-integration/evidence/settings-failed.png")).catch(() => {});
  process.exitCode = 1;
} finally {
  await promisify(execFile)("taskkill.exe", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
await mkdir(join(root, "docs/scansci-integration/evidence"), { recursive: true });
await writeFile(join(root, "docs/scansci-integration/evidence/settings.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
