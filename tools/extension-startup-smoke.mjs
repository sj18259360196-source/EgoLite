import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createServer } from "node:http";
import { connect } from "node:net";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const parent = join(root, ".tmp/codex/extension-cold-start");
mkdirSync(parent, { recursive: true });
const work = mkdtempSync(join(parent, "run-"));
const output = join(root, process.env.EGO_EXTENSION_TEST_EXECUTABLE ? "output/extension-cold-start-package" : "output/extension-cold-start");
mkdirSync(output, { recursive: true });
const source = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, "EgoCompat/desktop-preferences.json"), "utf8"));
const records = source.browserExtensions.filter(r => r.enabled && /Violentmonkey|OpenJobAutofill/i.test(r.name)
  && (!process.env.EGO_EXTENSION_ONLY || r.name.includes(process.env.EGO_EXTENSION_ONLY)));
assert.ok(records.length, "No supported installed extension sources found");
writeFileSync(join(work, "desktop-preferences.json"), JSON.stringify({ version: 1, browserBackend: "desktop", onboardingCompleted: true, browserExtensions: records }));
const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<html><body><h1>Extension startup fixture</h1><form><label>姓名<input name="fullName" autocomplete="name"></label><label>邮箱<input name="email" type="email"></label></form></body></html>'); });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const children = [];
const logs = [];
function launch(exe, args, overrides) {
  const child = spawn(exe, args, { cwd: root, env: { ...env, ...overrides }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", d => logs.push(String(d)));
  child.stderr.on("data", d => logs.push(String(d)));
  children.push(child);
  return child;
}
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  for (const boot of [1, 2]) {
    const id = randomUUID();
    const pipe = `\\\\.\\pipe\\ego-extension-boot-${id}`;
    const automation = `${pipe}-ui`;
    const broker = launch(process.execPath, [join(root, "apps/broker/src/main.ts")], {
      EGO_COMPAT_PIPE: pipe, EGO_COMPAT_BACKEND: "desktop", EGO_STATE_DB: join(work, `broker-${boot}.db`),
      EGO_DESKTOP_AUTOMATION_PIPE: automation, EGO_DESKTOP_CONTROL_TOKEN: id,
    });
    const end = Date.now() + 20000;
    while (!(await new Promise(resolve => {
      const socket = connect(pipe);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    }))) {
      if (Date.now() > end || broker.exitCode !== null) throw Error("Broker startup failed");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const resultFile = join(output, `boot-${boot}.json`);
    const child = launch(process.env.EGO_EXTENSION_TEST_EXECUTABLE || join(root, "node_modules/electron/dist/electron.exe"),
      process.env.EGO_EXTENSION_TEST_EXECUTABLE ? [] : [join(root, "apps/desktop-shell")], {
      EGO_DESKTOP_PIPE: pipe, EGO_DESKTOP_AUTOMATION_PIPE: automation, EGO_DESKTOP_CONTROL_TOKEN: id,
      EGO_DESKTOP_STATE: join(work, `desktop-tabs-${boot}.json`), EGO_DESKTOP_USER_DATA: join(work, "profile"),
      EGO_DESKTOP_SMOKE_RESULT: resultFile, EGO_EXTENSION_STARTUP_SMOKE_RESULT: resultFile,
      EGO_EXTENSION_BOOT: String(boot), EGO_EXTENSION_FIXTURE: `http://127.0.0.1:${server.address().port}/`,
      EGO_AGENT_INTEGRATION_DISABLED: "1", EGO_DESKTOP_ONBOARDING: "0",
      LOCALAPPDATA: join(work, "local"), APPDATA: join(work, "roaming"), TEMP: work, TMP: work,
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error("Cold-start smoke timed out")); }, 90000);
      child.once("error", reject);
      child.once("exit", code => { clearTimeout(timer); resolve(code); });
    });
    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    console.log(JSON.stringify(result, null, 2));
    if (broker.exitCode === null && broker.signalCode === null) {
      const stopped = new Promise(resolve => broker.once("exit", resolve));
      broker.kill();
      await stopped;
    }
    assert.equal(code, 0, result.error);
    assert.equal(result.passed, true);
  }
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await closed;
    }
  }
  server.close();
  writeFileSync(join(output, "smoke.log"), logs.join(""));
  const rel = relative(parent, resolve(work));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("Unsafe cleanup");
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
