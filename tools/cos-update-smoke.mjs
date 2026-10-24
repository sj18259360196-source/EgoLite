import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { candidate: { type: "string" }, old: { type: "string" } } });
if (!values.candidate) throw new Error("--candidate <prepared pack> is required");
const root = resolve(import.meta.dirname, "..");
const work = join(root, ".tmp/codex/cos-integration", `update-smoke-${randomUUID()}`);
const evidence = join(root, "docs/cos-workspace-pack/evidence");
const oldPack = resolve(values.old || join(root, "packs/cos/versions/2.1.20-ego.1"));
const broken = join(work, "broken");
await mkdir(join(broken, "source"), { recursive: true });
const manifest = JSON.parse(await readFile(join(oldPack, "manifest.json"), "utf8"));
manifest.packVersion = "broken-update-fixture";
manifest.entries = { main: "source/main.js", renderer: "source/ui.html", preload: "source/preload.js",
  companion: "source/worker.mjs", electron: "runtime/electron.exe" };
await cp(join(oldPack, "source/node_modules/electron/dist"), join(broken, "runtime"), { recursive: true });
await writeFile(join(broken, "manifest.json"), JSON.stringify(manifest));
await writeFile(join(broken, "source/package.json"), JSON.stringify({ name: "chat-on-steroids", version: "2.1.20", main: "main.js" }));
await writeFile(join(broken, "source/main.js"), 'require("node:fs").writeFileSync(require("node:path").join(process.env.COS_EGO_DATA,"update-smoke.txt"),"broken-migration"); process.exit(77);');
for (const file of ["ui.html", "preload.js", "worker.mjs"]) await writeFile(join(broken, "source", file), "");
const pipe = `\\\\.\\pipe\\ego-cos-update-${randomUUID()}`;
const output = join(work, "result.json");
const env = {
  ...process.env, LOCALAPPDATA: join(work, "local"), APPDATA: join(work, "roaming"),
  EGO_COMPAT_PIPE: pipe, EGO_DESKTOP_PIPE: pipe, EGO_COMPAT_BACKEND: "desktop",
  EGO_DESKTOP_CONTROL_TOKEN: randomBytes(32).toString("hex"), EGO_DESKTOP_AUTOMATION_PIPE: `${pipe}-automation`,
  EGO_STATE_DB: join(work, "broker.db"), EGO_DESKTOP_STATE: join(work, "desktop-tabs.json"),
  EGO_DESKTOP_USER_DATA: join(work, "electron-user-data"), EGO_DESKTOP_ONBOARDING: "0",
  EGO_AGENT_INTEGRATION_DISABLED: "1", EGO_NODE_PATH: process.execPath,
  EGO_HOME_BAR_SHORTCUT: "CommandOrControl+Alt+Shift+F12",
  EGO_COS_PACK: oldPack, EGO_COS_UPDATE_RESULT: output,
  EGO_COS_UPDATE_CANDIDATE: resolve(values.candidate), EGO_COS_UPDATE_BROKEN: broken,
};
delete env.ELECTRON_RUN_AS_NODE;
let result = { checkedAt: new Date().toISOString(), passed: false };
const logs = [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
try {
  const child = spawn(join(root, "node_modules/electron/dist/electron.exe"), [join(root, "apps/desktop-shell")], {
    cwd: root, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => logs.push(String(chunk)));
  child.stderr.on("data", chunk => logs.push(String(chunk)));
  const timer = setTimeout(() => child.kill(), 180000);
  let code;
  try { [code] = await once(child, "exit"); } finally { clearTimeout(timer); }
  result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(code, 0, "Host exit code");
  assert.equal(result.passed, true, result.error);
  for (const pid of [result.brokerPid, ...result.runtimePids].filter(Boolean)) {
    for (let n = 0; n < 30 && alive(pid); n++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(alive(pid), false, `Child ${pid} survived host exit`);
  }
  result.ownedProcessesExited = true;
} catch (error) {
  result.passed = false;
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, "cos-update-host.txt"), logs.join(""));
  await rm(work, { recursive: true, force: true });
  result.testDataDirectoryRemoved = true;
  await writeFile(join(evidence, "cos-update-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
