import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readCosPack } from "../apps/desktop-shell/workspace-packs/cos-archive.mjs";

const { values } = parseArgs({ options: { pack: { type: "string" }, "data-root": { type: "string" } } });
if (!values.pack || !values["data-root"]) throw new Error("--pack and --data-root are required");
const root = resolve(import.meta.dirname, ".."), directory = resolve(values.pack);
const data = resolve(values["data-root"]);
const manifest = await readCosPack(directory);
const registryPath = join(data, "workspace-packs/cos/registry.json");
await mkdir(dirname(registryPath), { recursive: true });
try {
  await writeFile(registryPath, JSON.stringify({
    enabled: true, directory, packVersion: manifest.packVersion, workspace: null,
  }, null, 2) + "\n", { flag: "wx" });
} catch (error) { if (error.code !== "EEXIST") throw error; }
const registered = JSON.parse(await readFile(registryPath, "utf8"));
if (resolve(registered.directory) !== directory) throw new Error("This test profile uses another pack. Use Ego's update flow instead of replacing its registration.");

const id = createHash("sha256").update(data.toLowerCase()).digest("hex").slice(0, 16);
const pipe = `\\\\.\\pipe\\ego-cos-test-${id}`;
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(EGO_|COS_EGO_)/.test(key) || ["ELECTRON_RUN_AS_NODE", "OPENAI_API_KEY"].includes(key)) delete env[key];
}
Object.assign(env, {
  LOCALAPPDATA: join(data, "local"), APPDATA: join(data, "roaming"),
  EGO_COMPAT_PIPE: pipe, EGO_DESKTOP_PIPE: pipe, EGO_COMPAT_BACKEND: "desktop",
  EGO_DESKTOP_AUTOMATION_PIPE: `${pipe}-automation`,
  EGO_DESKTOP_CONTROL_TOKEN: randomBytes(32).toString("hex"),
  EGO_STATE_DB: join(data, "broker.db"), EGO_DESKTOP_STATE: join(data, "desktop-tabs.json"),
  EGO_DESKTOP_USER_DATA: join(data, "electron-user-data"), EGO_DESKTOP_ONBOARDING: "0",
  EGO_AGENT_INTEGRATION_DISABLED: "1", EGO_NODE_PATH: process.execPath,
  EGO_HOME_BAR_SHORTCUT: "CommandOrControl+Alt+Shift+F12", EGO_COS_PACK: directory,
});
const child = spawn(join(root, "node_modules/electron/dist/electron.exe"), [join(root, "apps/desktop-shell")], {
  cwd: root, env, windowsHide: true, detached: true, stdio: "ignore",
});
await new Promise((resolveSpawn, reject) => { child.once("spawn", resolveSpawn); child.once("error", reject); });
child.unref();

const result = { startedAt: new Date().toISOString(), launcherPid: child.pid, dataDirectory: data,
  packDirectory: directory, packVersion: manifest.packVersion, ready: false, enabled: registered.enabled === true };
for (let n = 0; n < 150; n++) {
  try {
    const maintenance = JSON.parse(await readFile(join(dirname(registryPath), "maintenance-endpoint.json"), "utf8"));
    process.kill(maintenance.pid, 0);
    if (maintenance.pipe !== `${pipe}-automation`) throw new Error("Unexpected test instance");
    result.hostPid = maintenance.pid;
    if (!result.enabled) { result.ready = true; break; }
    const endpoint = JSON.parse(await readFile(join(dirname(registryPath), "status-endpoint.json"), "utf8"));
    if (endpoint.pid !== maintenance.pid) throw new Error("Stale CoS status");
    const url = new URL(endpoint.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Unexpected CoS status address");
    const response = await fetch(`${url.origin}/v1/packages/cos/instances/default/status`, {
      headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`CoS status returned ${response.status}`);
    const state = await response.json();
    if (state.package?.state !== "ready") throw new Error("CoS is not ready");
    result.ready = true;
    break;
  } catch (error) {
    result.lastError = error.message;
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
}
if (result.ready) delete result.lastError;
await writeFile(join(data, "test-instance.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
if (!result.ready) {
  console.error("Ego was started but readiness was not confirmed. Inspect that instance before launching again.");
  process.exitCode = 1;
}
