import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, rmdirSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve, relative, isAbsolute } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tempRoot = join(root, ".tmp", "codex", "bookmark-library-smoke");
const existed = existsSync(tempRoot);
mkdirSync(tempRoot, { recursive: true });
const work = mkdtempSync(join(tempRoot, "run-"));
const outputRoot = join(root, "output", "bookmark-library");
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(join(outputRoot, "run-"));
const resultFile = join(output, "result.json");
const id = randomUUID();
const pipe = `\\\\.\\pipe\\ego-bookmarks-${id}`;
const automationPipe = `\\\\.\\pipe\\ego-bookmarks-desktop-${id}`;
const env = { ...process.env, TEMP: work, TMP: work };
delete env.ELECTRON_RUN_AS_NODE;
const logs = [];
let broker;
let electron;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function launch(command, args, overrides) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => logs.push(String(data)));
  child.stderr.on("data", data => logs.push(String(data)));
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise(resolve => child.once("exit", resolve));
  child.kill();
  await Promise.race([done, sleep(5000)]);
}
try {
  writeFileSync(join(work, "desktop-preferences.json"), JSON.stringify({ version: 1, browserBackend: "desktop", onboardingCompleted: true }), "utf8");
  broker = launch(process.execPath, [join(root, "apps/broker/src/main.ts")], {
    EGO_COMPAT_PIPE: pipe, EGO_COMPAT_BACKEND: "desktop", EGO_STATE_DB: join(work, "state.db"),
    EGO_DESKTOP_AUTOMATION_PIPE: automationPipe, EGO_DESKTOP_CONTROL_TOKEN: id,
  });
  for (const deadline = Date.now() + 15000;;) {
    const ready = await new Promise(resolve => {
      const socket = connect(pipe);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (ready) break;
    if (Date.now() > deadline || broker.exitCode !== null) throw new Error("Broker unavailable");
    await sleep(100);
  }
  electron = launch(join(root, "node_modules/electron/dist/electron.exe"), [join(root, "apps/desktop-shell"), "--disable-features=CalculateNativeWinOcclusion", "--disable-gpu"], {
    EGO_DESKTOP_PIPE: pipe, EGO_DESKTOP_AUTOMATION_PIPE: automationPipe, EGO_DESKTOP_CONTROL_TOKEN: id,
    EGO_DESKTOP_STATE: join(work, "desktop-tabs.json"), EGO_DESKTOP_USER_DATA: join(work, "profile"),
    EGO_AGENT_INTEGRATION_DISABLED: "1", EGO_DESKTOP_ONBOARDING: "0",
    EGO_BOOKMARK_SMOKE_RESULT: resultFile, EGO_DESKTOP_SMOKE_RESULT: resultFile,
    LOCALAPPDATA: join(work, "local"), APPDATA: join(work, "roaming"),
    EGO_HOME_BAR_SHORTCUT: "CommandOrControl+Alt+Shift+F10",
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bookmark smoke timeout")), 120000);
    electron.once("error", error => { clearTimeout(timer); reject(error); });
    electron.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  console.log(JSON.stringify({ output, ...result }, null, 2));
  assert.equal(code, 0, result.error);
  assert.equal(result.passed, true);
} finally {
  await stop(electron);
  await stop(broker);
  writeFileSync(join(output, "smoke.log"), logs.join(""), "utf8");
  const rel = relative(tempRoot, resolve(work));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe cleanup target");
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  if (!existed && readdirSync(tempRoot).length === 0) rmdirSync(tempRoot);
}
