import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const tempRoot = process.env.EGO_TEST_TEMP_ROOT || join(root, ".tmp", "codex", "control-collaboration");
mkdirSync(tempRoot, { recursive: true });
const work = mkdtempSync(join(tempRoot, "focused-"));
const suffix = randomUUID();
const pipe = `\\\\.\\pipe\\ego-focused-control-${suffix}`;
const automation = `\\\\.\\pipe\\ego-focused-desktop-${suffix}`;
const token = randomBytes(32).toString("hex");
const result = join(work, "result.json");
const interaction = process.argv.includes('--interaction');
writeFileSync(join(work, "desktop-preferences.json"), JSON.stringify({
  version: 1, onboardingCompleted: true, browserBackend: "desktop",
  controlConsentPolicyVersion: 3, controlMode: "collaborative",
  controlHandoffEnabled: true, controlConsentEnabled: true, controlConsentLevel: "strict",
}));
const env = {
  ...process.env, TEMP: work, TMP: work,
  LOCALAPPDATA: join(work, 'local'), APPDATA: join(work, 'roaming'),
  EGO_COMPAT_PIPE: pipe, EGO_COMPAT_BACKEND: "desktop", EGO_STATE_DB: join(work, "state.db"),
  EGO_DESKTOP_PIPE: pipe, EGO_DESKTOP_AUTOMATION_PIPE: automation,
  EGO_DESKTOP_CONTROL_TOKEN: token, EGO_DESKTOP_STATE: join(work, "desktop-tabs.json"),
  EGO_DESKTOP_USER_DATA: join(work, "user-data"), EGO_AGENT_INTEGRATION_DISABLED: "1",
  EGO_DESKTOP_ONBOARDING: "0", EGO_DESKTOP_CONTROL_SMOKE_RESULT: result,
};
if (interaction) {
  delete env.EGO_DESKTOP_CONTROL_SMOKE_RESULT;
  env.EGO_DESKTOP_INTERACTION_SMOKE_RESULT = result;
}
let logs = "";
const start = (program, args, childEnv = env) => {
  const child = spawn(program, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  return child;
};
const packagedRoot = process.env.EGO_TEST_PACKAGED_ROOT;
const executable = packagedRoot ? join(packagedRoot, "EgoLite.exe") : join(root, "node_modules/electron/dist/electron.exe");
const broker = packagedRoot
  ? start(executable, [join(packagedRoot, "resources/runtime/broker.mjs")], { ...env, ELECTRON_RUN_AS_NODE: "1" })
  : start(process.execPath, ["apps/broker/src/main.ts"]);
let electron;
const run = async () => {
  electron = start(executable, packagedRoot ? [] : ["apps/desktop-shell"]);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Focused Electron control regression timed out")), 60_000);
    electron.once("error", reject);
    electron.once("exit", (value) => { clearTimeout(timer); resolve(value); });
  });
  const value = existsSync(result) ? JSON.parse(readFileSync(result, "utf8")) : {};
  if (code !== 0 || value.passed !== true) throw new Error(JSON.stringify(value) + "\n" + logs);
  return value;
};
try {
  const initial = await run();
  if (!interaction) env.EGO_DESKTOP_CONTROL_SMOKE_RESTORE = "1";
  const restore = interaction ? {} : await run();
  if (process.env.EGO_TEST_REPORT) writeFileSync(process.env.EGO_TEST_REPORT, JSON.stringify({ ...initial, ...restore }, null, 2));
  console.log(JSON.stringify({ ...initial, ...restore }, null, 2));
} finally {
  const stop = async (child) => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  };
  if (electron) await stop(electron);
  await stop(broker);
  rmSync(work, { recursive: true, force: true });
}
