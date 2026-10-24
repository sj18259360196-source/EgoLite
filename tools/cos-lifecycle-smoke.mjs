import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { candidate: { type: "string" } } });
const root = resolve(import.meta.dirname, "..");
const work = join(root, ".tmp/codex/cos-integration", `lifecycle-${randomUUID()}`);
const evidence = join(root, "docs/cos-workspace-pack/evidence");
await mkdir(work, { recursive: true });
const pipe = `\\\\.\\pipe\\ego-cos-lifecycle-${randomUUID()}`;
const fixture = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<!doctype html><title>CoS lifecycle fixture</title><h1>Restored page</h1>");
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env, LOCALAPPDATA: join(work, "local"), APPDATA: join(work, "roaming"),
  EGO_COMPAT_PIPE: pipe, EGO_DESKTOP_PIPE: pipe, EGO_COMPAT_BACKEND: "desktop",
  EGO_DESKTOP_CONTROL_TOKEN: randomBytes(32).toString("hex"),
  EGO_DESKTOP_AUTOMATION_PIPE: `${pipe}-automation`, EGO_STATE_DB: join(work, "broker.db"),
  EGO_DESKTOP_STATE: join(work, "desktop-tabs.json"), EGO_DESKTOP_USER_DATA: join(work, "electron-user-data"),
  EGO_DESKTOP_ONBOARDING: "0", EGO_AGENT_INTEGRATION_DISABLED: "1",
  EGO_NODE_PATH: process.execPath,
  EGO_HOME_BAR_SHORTCUT: "CommandOrControl+Alt+Shift+F12",
  EGO_COS_PACK: values.candidate ? resolve(values.candidate) : join(root, "packs/cos/versions/2.1.20-ego.1"),
  EGO_COS_LIFECYCLE_PAGE: `http://127.0.0.1:${fixture.address().port}/`,
};
delete env.ELECTRON_RUN_AS_NODE;
const result = { checkedAt: new Date().toISOString(), passed: false, phases: [], testDataDirectory: work };
const logs = [];
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
try {
  for (const phase of ["seed", "restored", "disabled"]) {
    const output = join(work, `${phase}.json`);
    const child = spawn(join(root, "node_modules/electron/dist/electron.exe"), [join(root, "apps/desktop-shell")], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, EGO_COS_LIFECYCLE_PHASE: phase, EGO_COS_LIFECYCLE_RESULT: output },
    });
    child.stdout.on("data", chunk => logs.push(String(chunk)));
    child.stderr.on("data", chunk => logs.push(String(chunk)));
    const timeout = setTimeout(() => child.kill(), 60000);
    let code;
    try { [code] = await once(child, "exit"); } finally { clearTimeout(timeout); }
    const observed = JSON.parse(await readFile(output, "utf8"));
    result.phases.push(observed);
    assert.equal(code, 0, `${phase} host exit code`);
    assert.equal(observed.passed, true, observed.error);
    for (const pid of [observed.runtimePid, observed.brokerPid].filter(Boolean)) {
      for (let n = 0; n < 30 && alive(pid); n++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(alive(pid), false, `Child ${pid} survived ${phase} host exit`);
    }
    observed.ownedProcessesExited = true;
    await assert.rejects(readFile(join(work, "workspace-packs/cos/status-endpoint.json")), { code: "ENOENT" });
    observed.statusEndpointRemoved = true;
    console.log(`CoS lifecycle ${phase} passed`);
  }
  result.passed = true;
} catch (error) {
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  await new Promise(resolve => fixture.close(resolve));
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, "cos-lifecycle-host.txt"), logs.join(""));
  await rm(work, { recursive: true, force: true });
  result.testDataDirectoryRemoved = true;
  await writeFile(join(evidence, "cos-lifecycle-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
