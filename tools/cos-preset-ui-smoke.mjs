import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const work = join(root, ".tmp/codex/cos-integration", `preset-ui-${randomUUID()}`);
const evidence = join(root, "docs/cos-workspace-pack/evidence");
await mkdir(work, { recursive: true });
const pipe = `\\\\.\\pipe\\ego-cos-preset-${randomUUID()}`, output = join(work, "result.json");
const env = {
  ...process.env, LOCALAPPDATA: join(work, "local"), APPDATA: join(work, "roaming"),
  EGO_COMPAT_PIPE: pipe, EGO_DESKTOP_PIPE: pipe, EGO_COMPAT_BACKEND: "desktop",
  EGO_DESKTOP_CONTROL_TOKEN: randomBytes(32).toString("hex"), EGO_DESKTOP_AUTOMATION_PIPE: `${pipe}-automation`,
  EGO_STATE_DB: join(work, "broker.db"), EGO_DESKTOP_STATE: join(work, "desktop-tabs.json"),
  EGO_DESKTOP_USER_DATA: join(work, "electron-user-data"), EGO_DESKTOP_ONBOARDING: "0",
  EGO_AGENT_INTEGRATION_DISABLED: "1", EGO_NODE_PATH: process.execPath,
  EGO_HOME_BAR_SHORTCUT: "CommandOrControl+Alt+Shift+F12",
  EGO_COS_PACK: join(work, "not-installed"), EGO_COS_PRESET_UI_RESULT: output,
};
delete env.ELECTRON_RUN_AS_NODE;
let result = { checkedAt: new Date().toISOString(), passed: false };
const logs = [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
try {
  const child = spawn(join(root, "node_modules/electron/dist/electron.exe"), [join(root, "apps/desktop-shell")], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => logs.push(String(chunk)));
  child.stderr.on("data", chunk => logs.push(String(chunk)));
  const timer = setTimeout(() => child.kill(), 180000);
  let code;
  try { [code] = await once(child, "exit"); } finally { clearTimeout(timer); }
  result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(code, 0);
  assert.equal(result.passed, true, result.error);
  for (const pid of [result.runtimePid, result.brokerPid].filter(Boolean)) {
    for (let n = 0; n < 30 && alive(pid); n++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(alive(pid), false, `Child ${pid} survived the preset UI test`);
  }
  result.ownedProcessesExited = true;
} catch (error) {
  result.passed = false;
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, "cos-preset-ui-host.txt"), logs.join(""));
  await rm(work, { recursive: true, force: true });
  result.testDirectoryRemoved = true;
  await writeFile(join(evidence, "cos-preset-ui-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
