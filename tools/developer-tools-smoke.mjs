import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tempRoot = resolve(process.env.EGO_TEST_TEMP_ROOT || join(root, ".tmp", "codex", "developer-tools-smoke"));
const tempRelative = relative(join(root, ".tmp", "codex"), tempRoot);
if (!tempRelative || tempRelative.startsWith("..") || isAbsolute(tempRelative)) throw new Error("Smoke temporary files must stay inside the project task directory");
mkdirSync(tempRoot, { recursive: true });
const work = mkdtempSync(join(tempRoot, "run-"));
const output = resolve(process.env.EGO_DEVTOOLS_SMOKE_OUTPUT || join(root, "output", "developer-tools-20260924"));
mkdirSync(output, { recursive: true });
const resultFile = join(output, "result.json");
rmSync(resultFile, { force: true });
const packagedRoot = process.env.EGO_TEST_PACKAGED_ROOT ? resolve(process.env.EGO_TEST_PACKAGED_ROOT) : null;
const executable = packagedRoot ? join(packagedRoot, "EgoLite.exe") : join(root, "node_modules/electron/dist/electron.exe");
const id = randomUUID();
const pipe = `\\\\.\\pipe\\ego-devtools-broker-${id}`;
const automationPipe = `\\\\.\\pipe\\ego-devtools-automation-${id}`;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.url.startsWith("/same") || request.url.startsWith("/cross")) {
    const name = request.url.startsWith("/same") ? "same" : "cross";
    response.end(`<style>body{margin:0;font:16px sans-serif}button{margin:8px;padding:12px}</style><button id="${name}-button">${name} frame</button>`);
    return;
  }
  if (request.url !== "/") {
    response.end("<title>Next document</title><h1 id='next'>Next document</h1>");
    return;
  }
  response.end(`<!doctype html><html><head><title>Inspector fixture</title>
    <style>body{margin:28px;font:16px system-ui;color:#202423;background:#fafbfc}h1{font-size:26px;margin:0 0 20px}
    #inspect-button{padding:12px 24px;background:rgb(25,122,100);color:white;border:0;border-radius:4px;font-size:16px}
    #shadow-host{display:block;margin:20px 0}iframe{border:0;width:300px;height:90px;margin:0 20px 16px 0}
    #private-fixture{margin-top:16px}input,textarea{display:block;margin:6px 0}</style></head><body>
    <h1 id="inspect-heading">Inspector verification</h1>
    <button id="inspect-button" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Inspect this button</button>
    <div id="shadow-host"></div><script>document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<button id="shadow-button" style="padding:12px">Shadow button</button>'</script>
    <iframe id="same-frame" src="/same"></iframe>
    <iframe id="cross-frame" src="http://frame.test:${server.address().port}/cross"></iframe>
    <div id="private-fixture"><label>Public label<input type="password" value="password-value"></label>
    <input type="hidden" value="token-value" data-token="token-value"><textarea>textarea-value</textarea>
    <div contenteditable="true">editable-value</div><script type="application/json">{"key":"script-value"}</script>
    <a href="/?access_token=query-secret">Public link</a></div></body></html>`);
});
let broker;
let electron;
const logs = [];
function launch(executable, args, overrides) {
  const child = spawn(executable, args, { cwd: root, env: { ...env, ...overrides }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => logs.push(String(data)));
  child.stderr.on("data", data => logs.push(String(data)));
  return child;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForPipe() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = await new Promise(resolve => {
      const socket = connect(pipe);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    if (broker.exitCode !== null) throw new Error("Broker exited before ready");
    await sleep(100);
  }
  throw new Error("Broker startup timeout");
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise(resolve => child.once("exit", resolve));
  child.kill();
  await Promise.race([done, sleep(5000)]);
}
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(work, "desktop-preferences.json"), JSON.stringify({
    version: 1, browserBackend: "desktop", onboardingCompleted: true,
  }));
  broker = launch(packagedRoot ? executable : process.execPath, [packagedRoot ? join(packagedRoot, "resources/runtime/broker.mjs") : join(root, "apps/broker/src/main.ts")], {
    EGO_COMPAT_PIPE: pipe, EGO_COMPAT_BACKEND: "desktop", EGO_STATE_DB: join(work, "state.db"),
    EGO_DESKTOP_AUTOMATION_PIPE: automationPipe, EGO_DESKTOP_CONTROL_TOKEN: id,
    ...(packagedRoot ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  });
  await waitForPipe();
  electron = launch(executable, [
    ...(packagedRoot ? [] : [join(root, "apps/desktop-shell")]),
    "--host-resolver-rules=MAP inspector.test 127.0.0.1,MAP frame.test 127.0.0.1",
    "--no-proxy-server", "--site-per-process",
  ], {
    EGO_DESKTOP_PIPE: pipe, EGO_DESKTOP_AUTOMATION_PIPE: automationPipe,
    EGO_DESKTOP_CONTROL_TOKEN: id, EGO_DESKTOP_STATE: join(work, "desktop-tabs.json"),
    EGO_DESKTOP_USER_DATA: join(work, "profile"), EGO_AGENT_INTEGRATION_DISABLED: "1",
    EGO_DESKTOP_ONBOARDING: "0", EGO_DEVTOOLS_SMOKE_RESULT: resultFile,
    EGO_DESKTOP_SMOKE_RESULT: resultFile,
    LOCALAPPDATA: join(work, "local"), APPDATA: join(work, "roaming"),
    EGO_DEVTOOLS_SMOKE_URL: `http://inspector.test:${server.address().port}/`,
    EGO_HOME_BAR_SHORTCUT: "CommandOrControl+Alt+Shift+F10", TEMP: work, TMP: work,
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DevTools smoke timed out")), 120000);
    electron.once("error", error => { clearTimeout(timer); reject(error); });
    electron.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(code, 0, result.error);
  assert.equal(result.passed, true);
} finally {
  await stop(electron);
  await stop(broker);
  await new Promise(resolve => server.close(resolve));
  writeFileSync(join(output, "smoke.log"), logs.join(""), "utf8");
  const rel = relative(tempRoot, resolve(work));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Refusing unsafe smoke cleanup");
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
