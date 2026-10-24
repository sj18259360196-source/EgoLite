import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { resolve, join, relative, isAbsolute } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scratch = join(root, ".tmp/codex/page-translation");
mkdirSync(scratch, { recursive: true });
const work = mkdtempSync(join(scratch, "electron-"));
const output = join(root, process.env.EGO_TRANSLATION_EXECUTABLE ? "output/translation-package-validation" : "output/translation-validation");
mkdirSync(output, { recursive: true });
const resultFile = join(output, "result.json");
const id = randomUUID();
const pipe = `\\\\.\\pipe\\ego-translate-broker-${id}`;
const automationPipe = `\\\\.\\pipe\\ego-translate-automation-${id}`;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="en"><head><title>Translation verification</title>
    <style>body{font:18px system-ui;padding:32px;color:#25282b;background:white}p{line-height:1.7}input,textarea{display:block;margin:12px 0;padding:10px}</style></head>
    <body><h1>Page translation</h1><p id="hello">Hello <a id="link" href="#section">World</a></p>
    <p id="changed">Hello again</p><input value="PRIVATE INPUT"><textarea>PRIVATE TEXTAREA</textarea>
    <div contenteditable="true">PRIVATE EDITABLE</div><p translate="no">DO_NOT_TRANSLATE</p>
    <pre>const secret = "PRIVATE CODE"</pre><script>window.originalLink=document.querySelector("#link")</script></body></html>`);
});
const children = [];
const logs = [];
function launch(executable, args, overrides) {
  const child = spawn(executable, args, { cwd: root, env: { ...env, ...overrides }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", value => logs.push(String(value)));
  child.stderr.on("data", value => logs.push(String(value)));
  children.push(child);
  return child;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(work, "desktop-preferences.json"), JSON.stringify({ version: 1, browserBackend: "desktop", onboardingCompleted: true }), "utf8");
  const broker = launch(process.execPath, [join(root, "apps/broker/src/main.ts")], {
    EGO_COMPAT_PIPE: pipe, EGO_COMPAT_BACKEND: "desktop", EGO_STATE_DB: join(work, "state.db"),
    EGO_DESKTOP_AUTOMATION_PIPE: automationPipe, EGO_DESKTOP_CONTROL_TOKEN: id,
  });
  const deadline = Date.now() + 15000;
  while (true) {
    const ready = await new Promise(resolve => {
      const socket = connect(pipe);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (ready) break;
    if (broker.exitCode !== null || Date.now() > deadline) throw new Error("Broker not ready");
    await sleep(100);
  }
  const electron = launch(process.env.EGO_TRANSLATION_EXECUTABLE || join(root, "node_modules/electron/dist/electron.exe"),
    process.env.EGO_TRANSLATION_EXECUTABLE ? ["--no-proxy-server"] : [join(root, "apps/desktop-shell"), "--no-proxy-server"], {
    EGO_DESKTOP_PIPE: pipe, EGO_DESKTOP_AUTOMATION_PIPE: automationPipe, EGO_DESKTOP_CONTROL_TOKEN: id,
    EGO_DESKTOP_STATE: join(work, "desktop-tabs.json"), EGO_DESKTOP_USER_DATA: join(work, "profile"),
    EGO_AGENT_INTEGRATION_DISABLED: "1", EGO_DESKTOP_ONBOARDING: "0", EGO_DESKTOP_SMOKE_RESULT: resultFile,
    EGO_TRANSLATION_SMOKE_RESULT: resultFile, EGO_TRANSLATION_SMOKE_URL: `http://127.0.0.1:${server.address().port}/`,
    LOCALAPPDATA: join(work, "local"), APPDATA: join(work, "roaming"), TEMP: work, TMP: work,
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Translation smoke timed out")), 120000);
    electron.once("error", error => { clearTimeout(timer); reject(error); });
    electron.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(code, 0, result.error);
  assert.equal(result.passed, true);
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, sleep(5000)]);
    if (child.exitCode === null) throw new Error(`Child ${child.pid} did not exit`);
  }
  await new Promise(resolve => server.close(resolve));
  writeFileSync(join(output, "smoke.log"), logs.join(""), "utf8");
  const rel = relative(scratch, resolve(work));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe cleanup path");
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
