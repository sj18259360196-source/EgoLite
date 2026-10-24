import { app, BrowserWindow, dialog } from "electron";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { CosDialogs } from "../apps/desktop-shell/workspace-packs/cos-dialogs.mjs";
import { CosRuntime } from "../apps/desktop-shell/workspace-packs/cos-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const parent = join(root, ".tmp/codex/cos-dialog-smoke");
mkdirSync(parent, { recursive: true });
const work = mkdtempSync(join(parent, "run-"));
app.setPath("userData", join(work, "host"));
app.whenReady().then(async () => {
console.error("[CoS dialogs] ready");
app.removeAllListeners("window-all-closed");
app.on("window-all-closed", () => {});
const window = new BrowserWindow({ width: 800, height: 600, title: "Ego CoS dialog fixture", show: true });
await window.loadURL("data:text/html,<h1>Ego CoS dialog fixture</h1>");
console.error("[CoS dialogs] window loaded");
const service = new CosDialogs({ dialog, getParent: () => window, enabled: () => true });
const requests = [];
const runtime = new CosRuntime({ directory: resolve(process.argv[2]), dataDirectory: join(work, "cos"),
  onHostRequest: (method, options) => { requests.push({ method, options }); return service.show(method, options); } });
const result = { passed: false, checkedAt: new Date().toISOString(), checks: [] };
const run = promisify(execFile);
try {
  await runtime.start();
  console.error("[CoS dialogs] runtime ready");
  for (const [name, operation] of [
    ["original-roots-add", () => runtime.invoke("roots:add")],
    ["original-attachment-picker", () => runtime.invoke("sessions:files")],
    ["native-save", () => service.show("dialog.save", { title: "CoS save fixture", defaultPath: join(work, "report.md") })],
  ]) {
    console.error(`[CoS dialogs] ${name}`);
    const handle = window.getNativeWindowHandle().readBigUInt64LE().toString();
    const inspection = run("pwsh.exe", ["-NoProfile", "-File", join(root, "tools/cos-dialog-window-check.ps1"),
      "-OwnerHandle", handle, "-ExpectedProcessId", String(process.pid)], { windowsHide: true, timeout: 30000 });
    inspection.then(value => console.error("[CoS dialogs] native", value.stdout), error => console.error("[CoS dialogs] inspection failed", error.message));
    const [selected, observed] = await Promise.all([operation(), inspection]);
    const check = JSON.parse(observed.stdout.trim());
    assert.equal(check.ownerMatched, true, name);
    assert.equal(check.foreground, true, name);
    if (name === "native-save") assert.equal(selected.canceled, true);
    result.checks.push({ name, ...check });
  }
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.method === "dialog.open"));
  result.originalHostedIpc = true;
  result.passed = true;
} catch (error) { result.error = error.stack; console.error(error); }
finally {
  console.error("[CoS dialogs] stopping");
  service.stop();
  await runtime.stop();
  console.error("[CoS dialogs] stopped");
  result.testDataDirectory = work;
  await writeFile(join(root, "docs/cos-workspace-pack/evidence/cos-native-dialogs.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  app.exit(result.passed ? 0 : 1);
}
}).catch(error => { console.error(error); app.exit(1); });
