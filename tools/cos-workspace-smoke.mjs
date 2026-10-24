import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";

const root = resolve(import.meta.dirname, "..");
const suffix = randomUUID();
const work = join(root, ".tmp/codex/cos-integration", `ui-${suffix}`);
const evidence = join(root, "docs/cos-workspace-pack/evidence");
await mkdir(work, { recursive: true });
await mkdir(evidence, { recursive: true });
const pipe = `\\\\.\\pipe\\ego-cos-${suffix}`;
const automationPipe = `${pipe}-automation`;
const resultPath = join(work, "result.json");
if (process.env.EGO_COS_SMOKE_BUILTIN_UPGRADE === '1') {
  const registryRoot = join(work, 'workspace-packs/cos');
  await mkdir(join(registryRoot, 'state'), { recursive: true });
  await writeFile(join(registryRoot, 'state/upgrade-marker.txt'), 'preserve-existing-state');
  await writeFile(join(registryRoot, 'registry.json'), JSON.stringify({ enabled: false, source: 'builtin',
    packVersion: '2.1.20-ego.0.1.0-58bac857c5f5-b55fe52e', workspace: null }));
}
if (process.env.EGO_COS_SMOKE_LEGACY === "1") {
  const builtin = JSON.parse(await readFile(join(root, "integrations/cos/builtin.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, builtin.directory, "manifest.json"), "utf8"));
  const registry = join(work, "workspace-packs/cos/registry.json");
  await mkdir(join(registry, ".."), { recursive: true });
  await writeFile(registry, JSON.stringify({ enabled: false, directory: join(work, "removed-install/packs/cos"), packVersion: manifest.packVersion, workspace: null }));
}
const fixture = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.url === "/frames") {
    response.end(`<!doctype html><title>Frames</title><iframe src="/child"></iframe><iframe src="http://localhost:${fixture.address().port}/child"></iframe>`);
    return;
  }
  if (request.url.startsWith("/child")) {
    response.setHeader("Content-Security-Policy", "style-src 'none'");
    response.end('<!doctype html><title>Child</title><input id="child"><script>window.mainMarker="main-only"</script>');
    return;
  }
  response.end("<!doctype html><title>CoS native browser fixture</title><h1>Native browser transport</h1><input id='message'><button id='send' onclick=\"document.querySelector('output').textContent=document.querySelector('input').value\">Send</button><output></output>");
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const common = {
  ...process.env,
  LOCALAPPDATA: join(work, "local"),
  APPDATA: join(work, "roaming"),
  EGO_COMPAT_PIPE: pipe,
  EGO_DESKTOP_PIPE: pipe,
  EGO_COMPAT_BACKEND: "desktop",
  EGO_DESKTOP_CONTROL_TOKEN: randomBytes(32).toString("hex"),
  EGO_DESKTOP_AUTOMATION_PIPE: automationPipe,
  EGO_STATE_DB: join(work, "broker.db"),
  EGO_DESKTOP_STATE: join(work, "desktop-tabs.json"),
  EGO_DESKTOP_USER_DATA: join(work, "electron-user-data"),
  EGO_DESKTOP_ONBOARDING: "0",
  EGO_AGENT_INTEGRATION_DISABLED: "1",
  EGO_HOME_BAR_SHORTCUT: "CommandOrControl+Alt+Shift+F11",
  EGO_COS_SMOKE_RESULT: resultPath,
  EGO_COS_SMOKE_PAGE: `http://127.0.0.1:${fixture.address().port}/`,
  EGO_COS_SMOKE_NODE: process.execPath,
};
if (process.argv[2] && process.argv[2] !== "--builtin") common.EGO_COS_PACK = resolve(process.argv[2]);
else delete common.EGO_COS_PACK;
if (process.argv[3]) common.EGO_COS_PACKAGED_SMOKE = "1";
delete common.ELECTRON_RUN_AS_NODE;
const logs = [];
function launch(executable, args) {
  const child = spawn(executable, args, { cwd: root, env: common, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => logs.push(String(chunk)));
  child.stderr.on("data", chunk => {
    const text = String(chunk);
    logs.push(text);
    if (text.includes("[CoS smoke]")) process.stderr.write(text);
  });
  child.on("error", error => logs.push(error.stack));
  return child;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ok = await new Promise(resolve => {
      const socket = connect(pipe);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
    });
    if (ok) return;
    await delay(100);
  }
  throw new Error("Isolated broker did not start");
}
const broker = launch(process.execPath, [join(root, "apps/broker/src/main.ts")]);
let electron;
let result = { checkedAt: new Date().toISOString(), passed: false };
try {
  await ready();
  electron = process.argv[3] ? launch(resolve(process.argv[3]), [])
    : launch(join(root, "node_modules/electron/dist/electron.exe"), [join(root, "apps/desktop-shell")]);
  const [code] = await once(electron, "exit");
  result = JSON.parse(await readFile(resultPath, "utf8"));
  if (process.env.EGO_COS_SMOKE_BUILTIN_UPGRADE === '1') {
    const registryRoot = join(work, 'workspace-packs/cos');
    const config = JSON.parse(await readFile(join(registryRoot, 'registry.json'), 'utf8'));
    const snapshot = await readFile(join(config.builtinCheckpoint.backupDirectory, 'before-data/upgrade-marker.txt'), 'utf8');
    if (snapshot !== 'preserve-existing-state') throw new Error('Builtin upgrade checkpoint lost the original data');
    if (await readFile(join(registryRoot, 'state/upgrade-marker.txt'), 'utf8') !== snapshot) throw new Error('Builtin upgrade changed existing data');
    result.builtinUpgradeCheckpointsAndPreservesExistingState = true;
  }
  if (process.env.EGO_COS_SMOKE_LEGACY === "1") {
    const registry = JSON.parse(await readFile(join(work, "workspace-packs/cos/registry.json"), "utf8"));
    if (registry.source !== "builtin" || !registry.migration?.backup) throw new Error("Legacy registration was not migrated");
    const previous = JSON.parse(await readFile(registry.migration.backup, "utf8"));
    if (previous.directory !== registry.migration.from) throw new Error("Legacy registration backup mismatch");
    result.legacyMissingDirectoryMigratedWithBackup = true;
  }
  for (const name of ["cos-original-ui.png", "cos-ego-shell.png", "cos-pack-settings.png"]) {
    try { await copyFile(join(work, name), join(evidence, name)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  result.artifactsDirectory = evidence;
  result.testDataDirectory = work;
  result.brokerExitCodeAtHostExit = broker.exitCode;
  if (logs.some(text => text.includes("EPIPE"))) {
    result.cleanupWarning = "Broker reported EPIPE during host shutdown; lifecycle regression remains to investigate.";
  }
  if (code !== 0 || !result.passed) process.exitCode = 1;
} catch (error) {
  result.error = error.stack;
  result.passed = false;
  console.error(error);
  process.exitCode = 1;
} finally {
  if (electron?.exitCode === null) {
    electron.kill();
    await once(electron, "exit");
  }
  if (broker.exitCode === null) {
    broker.kill();
    await once(broker, "exit");
  }
  await writeFile(join(evidence, "cos-workspace-process.log"), logs.join(""));
  await new Promise(resolve => fixture.close(resolve));
  await rm(work, { recursive: true, force: true });
  result.testDataDirectoryRemoved = true;
  await writeFile(join(evidence, "cos-workspace-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
