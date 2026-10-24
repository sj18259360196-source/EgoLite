import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { resolve, join, relative, isAbsolute } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AtomicJsonStateWriter } from "../apps/desktop-shell/atomic-json-state-writer.mjs";
import { relevancePage, probeRelevance } from "./automation-relevance-smoke.mjs";

const root = resolve(import.meta.dirname, "..");
const packagedExecutable = process.env.EGO_AUTOMATION_PACKAGE_EXE;
const packagedRuntime = packagedExecutable ? join(packagedExecutable, "..", "resources", "runtime") : undefined;
const bundled = process.argv.includes("--bundled");
const live = process.argv.includes("--live");
const benchmark = process.argv.includes("--benchmark");
const codexRepairPilot = process.argv.includes("--codex-repair-pilot");
const codexPilot = process.argv.includes("--codex-pilot") || codexRepairPilot;
const codexCorpus = process.argv.includes("--codex-corpus");
const codexBenchmark = codexPilot || codexCorpus;
const sdkAutomation = process.argv.includes("--sdk-automation");
const repairBenchmark = process.argv.includes("--repair");
const relevanceBenchmark = process.argv.includes("--relevance");
if (relevanceBenchmark && (!live || repairBenchmark || sdkAutomation || codexBenchmark || process.argv.includes("--corpus"))) throw new Error("Relevance test requires live mode and its own run");
if (repairBenchmark && (!live || sdkAutomation || codexBenchmark || process.argv.includes("--corpus"))) throw new Error("Repair benchmark requires live mode and its own run");
if (codexPilot && codexCorpus) throw new Error("Choose Codex pilot or corpus");
const corpus = process.argv.includes("--corpus") || codexBenchmark || sdkAutomation || repairBenchmark || relevanceBenchmark;
const corpusFilter = process.argv.find(arg => arg.startsWith("--corpus-filter="))?.split("=")[1] || "";
if (corpusFilter && (!corpus || !/^[a-z0-9-]{1,80}$/.test(corpusFilter))) throw new Error("Invalid corpus filter");
const blurred = process.argv.includes("--blurred");
const pointerProbe = process.argv.includes("--pointer-probe");
if (pointerProbe && (corpus || live)) throw new Error("Pointer probe uses no model API and cannot be combined with corpus.");
const liveKey = live ? process.env.TYPESAFE_API_KEY : undefined;
if (live && !liveKey) throw new Error("Live verification needs TYPESAFE_API_KEY. Use tools/test-jev-live.ps1.");
const scratch = join(root, ".tmp/codex/jev-automation");
mkdirSync(scratch, { recursive: true });
const work = mkdtempSync(join(scratch, "electron-"));
const output = join(root, `output/jev-automation-validation${live ? "-live" : bundled ? "-bundled" : ""}${relevanceBenchmark ? "-relevance" : repairBenchmark ? "-repair" : sdkAutomation ? "-sdk" : codexBenchmark ? codexRepairPilot ? "-codex-repair-pilot" : codexPilot ? "-codex-pilot" : "-codex-corpus" : corpus ? "-corpus" : ""}${corpusFilter ? `-${corpusFilter}` : ""}${blurred ? "-blurred" : ""}${pointerProbe ? "-pointer" : ""}`);
mkdirSync(output, { recursive: true });
const resultFile = join(work, "desktop-result.json");
const ready = join(work, "ready.json");
const finish = join(work, "finish.json");
const control = join(work, "window-control.json");
const controlled = join(work, "window-controlled.json");
const id = randomUUID();
const pipe = `\\\\.\\pipe\\ego-automation-broker-${id}`;
const automationPipe = `\\\\.\\pipe\\ego-automation-desktop-${id}`;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TYPESAFE_API_KEY;
const server = createServer((request, response) => {
  if (relevanceBenchmark && request.url?.startsWith("/relevance/")) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(relevancePage(new URL(request.url, "http://localhost").pathname));
    return;
  }
  if ((corpus || pointerProbe) && request.url?.startsWith("/corpus/")) {
    void import("./automation-corpus.mjs").then(({ corpusPage }) => {
      const html = corpusPage(new URL(request.url, "http://localhost").pathname);
      response.writeHead(html ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html || "Unknown fixture");
    }).catch(() => { response.writeHead(500); response.end("Fixture failed"); });
    return;
  }
  const chinese = request.url?.startsWith("/zh");
  const queryLabel = chinese ? "\u67e5\u8be2" : "Query";
  const continueLabel = chinese ? "\u7ee7\u7eed" : "Continue";
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html><head><title>Automation fixture</title></head><body>
    <label>${queryLabel}<input id="query" aria-label="${queryLabel}"></label>
    <button id="continue" onclick="document.querySelector('#done').hidden=false">${continueLabel}</button>
    <div id="done" hidden>Completed</div>
    <table><tbody id="rows"><tr><td>Alpha</td></tr><tr><td>Beta</td></tr></tbody></table>
    <button id="next" onclick="document.querySelector('#rows').innerHTML='<tr><td>Gamma</td></tr>';this.disabled=true">Next</button>
    <script>window.events=[];for(const type of ["focusin","beforeinput","input","change","mousedown","mouseup","click"])document.addEventListener(type,event=>events.push({type,trusted:event.isTrusted,target:event.target.id,value:event.target.value,active:document.activeElement.id}));</script>
    </body></html>`);
});
const children = [];
const logs = [];
const checks = {};
const results = {};
const scenarioFailures = [];
function verifyModelRun(name, result, minDecisions = 1) {
  const passed = result.status === "done" && result.verified === true && result.metrics.decisions >= minDecisions;
  checks[name] = passed;
  if (!passed) scenarioFailures.push({ name, status: result.status, reason: result.reason });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function launch(executable, args, overrides) {
  const child = spawn(executable, args, { cwd: root, env: { ...env, ...overrides }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", value => logs.push(String(value)));
  child.stderr.on("data", value => logs.push(String(value)));
  child.on("exit", (code, signal) => logs.push(`child-exit ${JSON.stringify({ pid: child.pid, code, signal })}\n`));
  children.push(child);
  return child;
}
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(label);
}
let client;
let failure;
try {
  let brokerEntry = packagedRuntime ? join(packagedRuntime, "broker.mjs") : join(root, "apps/broker/src/main.ts");
  let mcpEntry = packagedRuntime ? join(packagedRuntime, "ego-mcp.mjs") : join(root, "apps/ego-mcp-server/src/main.ts");
  if (bundled && !packagedRuntime) {
    const { build } = await import("esbuild");
    const bundle = async (entry, name) => {
      const outfile = join(work, name);
      await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", target: "node24", format: "esm", external: ["@openai/codex-sdk"] });
      return outfile;
    };
    brokerEntry = await bundle(brokerEntry, "broker.mjs");
    mcpEntry = await bundle(mcpEntry, "ego-mcp.mjs");
  }
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  writeFileSync(join(work, "desktop-preferences.json"), JSON.stringify({ version: 1, browserBackend: "desktop", onboardingCompleted: true }));
  launch(process.execPath, [brokerEntry], {
    EGO_COMPAT_PIPE: pipe, EGO_COMPAT_BACKEND: "desktop", EGO_STATE_DB: join(work, "state.db"),
    EGO_DESKTOP_AUTOMATION_PIPE: automationPipe, EGO_DESKTOP_CONTROL_TOKEN: id,
  });
  await until(() => new Promise(resolve => {
    const socket = connect(pipe);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  }), "Broker not ready");
  const electron = launch(packagedExecutable || join(root, "node_modules/electron/dist/electron.exe"), [...(packagedExecutable ? [] : [join(root, "apps/desktop-shell")]), "--no-proxy-server"], {
    EGO_DESKTOP_PIPE: pipe, EGO_DESKTOP_AUTOMATION_PIPE: automationPipe, EGO_DESKTOP_CONTROL_TOKEN: id,
    EGO_DESKTOP_STATE: join(work, "desktop-tabs.json"), EGO_DESKTOP_USER_DATA: join(work, "profile"),
    EGO_AGENT_INTEGRATION_DISABLED: "1", EGO_DESKTOP_ONBOARDING: "0", EGO_DESKTOP_SMOKE_RESULT: resultFile,
    EGO_SCOPED_REFS: "1", EGO_SCOPED_DIAGNOSTICS: "1",
    EGO_AUTOMATION_SMOKE_RESULT: resultFile, EGO_AUTOMATION_SMOKE_READY: ready, EGO_AUTOMATION_SMOKE_FINISH: finish,
    ...(corpus ? { EGO_AUTOMATION_SMOKE_CORPUS: "1" } : {}),
    ...(blurred ? { EGO_AUTOMATION_SMOKE_BLURRED: "1" } : {}),
    ...(pointerProbe ? { EGO_AUTOMATION_SMOKE_CONTROL: control, EGO_AUTOMATION_SMOKE_CONTROLLED: controlled } : {}),
    ...(live ? { EGO_AUTOMATION_SMOKE_LIVE: "1", TYPESAFE_API_KEY: liveKey } : {}),
    LOCALAPPDATA: join(work, "local"), APPDATA: join(work, "roaming"), TEMP: work, TMP: work,
  });
  await until(() => {
    if (electron.exitCode !== null) throw new Error(existsSync(resultFile) ? readFileSync(resultFile, "utf8") : "Desktop exited");
    return existsSync(ready);
  }, "Desktop settings smoke not ready", 60000);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [mcpEntry], cwd: root,
    env: { ...env, EGO_COMPAT_PIPE: pipe, EGO_AGENT_INTEGRATION_DISABLED: "1", TEMP: work, TMP: work }, stderr: "pipe",
  });
  client = new Client({ name: "automation-smoke", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  transport.stderr?.on("data", value => logs.push(String(value)));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    const text = response.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    if (response.isError) throw new Error(`${name}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  const tools = await client.listTools();
  assert.ok(["ego_run", "ego_extract", "ego_automation_cancel"].every(name => tools.tools.some(tool => tool.name === name)));
  checks.discovery = true;
  if (pointerProbe) {
    await call("ego_task_use", { task: "Pointer verification" });
    await call("ego_open", { url });
    results.pointer = [];
    for (const action of ["focus", "blur", "hide", "focus"]) {
      for (const route of ["css", "scoped"]) {
        await call("ego_navigate", { action: "reload" });
        const requestId = randomUUID();
        await new Promise((resolve, reject) => new AtomicJsonStateWriter(control,
          { onCommit: resolve, onFailure: reject }).write({ id: requestId, action }));
        await until(() => existsSync(controlled) && JSON.parse(readFileSync(controlled, "utf8")).id === requestId, "Window state command failed");
        const nativeWindow = JSON.parse(readFileSync(controlled, "utf8"));
        const run = await call("ego_run", {
          goal: "Click Continue", mode: "direct", success: { all: [{ kind: "visible", target: "#done" }] },
          steps: route === "css" ? [{ action: "click", target: "#continue" }] : [],
          budget: { maxActions: 1, timeoutMs: 15000 },
        });
        const browser = await call("ego_evaluate", { expression: '({focused:document.hasFocus(),visibility:document.visibilityState,events:window.events,done:!document.querySelector("#done").hidden})' });
        results.pointer.push({ action, route, nativeWindow, run, browser });
      }
    }
    checks.pointerProbe = results.pointer.every(item => item.run.verified && item.browser.done);
    if (!checks.pointerProbe) scenarioFailures.push({ name: "pointerProbe" });
  }
  if (!corpus && !pointerProbe) {
  await call("ego_task_use", { task: "Automation verification" });
  await call("ego_open", { url });
  const success = { all: [{ kind: "visible", target: "#done" }] };
  results.direct = await call("ego_run", {
    goal: "Fill and continue", values: { query: "PRIVATE_FORM_VALUE" },
    steps: [{ action: "fill", target: "#query", valueKey: "query" }, { action: "click", target: "#continue" }],
    mode: "direct", success: { all: [...success.all, { kind: "value_equals", target: "#query", value: "PRIVATE_FORM_VALUE" }] },
  });
  results.inputDiagnostic = await call("ego_evaluate", { expression: '({events:window.events,focused:document.hasFocus(),active:document.activeElement.id})' });
  assert.equal(results.direct.status, "done", JSON.stringify(results.direct));
  assert.equal(results.direct.verified, true);
  assert.equal(results.direct.metrics.decisions, 0);
  assert.equal(await call("ego_evaluate", { expression: 'document.querySelector("#query").value' }), "PRIVATE_FORM_VALUE");
  checks.realMcpDirectBatch = true;
  await call("ego_navigate", { action: "reload" });
  results.model = await call("ego_run", { goal: "Proceed to the completed screen", success });
  verifyModelRun(live ? "realScopedRefActionWithLiveDecision" : "realScopedRefActionWithMockDecision", results.model);
  await call("ego_navigate", { action: "reload" });
  results.modelForm = await call("ego_run", {
    goal: "Fill supplied query and continue", values: { query: "PRIVATE_FORM_VALUE" },
    success: { all: [...success.all, { kind: "value_equals", target: "#query", value: "PRIVATE_FORM_VALUE" }] },
  });
  verifyModelRun("liveFormStateAndScopedFill", results.modelForm, 2);
  await call("ego_navigate", { action: "reload" });
  results.extract = await call("ego_extract", { selector: "tbody tr", fields: { name: { selector: "td", attribute: "text" } }, next: "#next", maxPages: 3 });
  assert.deepEqual(results.extract.rows, [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }]);
  assert.equal(results.extract.complete, true);
  checks.realPagination = true;
  await call("ego_open", { url: `${url}zh` });
  results.chineseNavigation = await call("ego_run", { goal: "\u8fdb\u5165\u5b8c\u6210\u9875\u9762", success });
  verifyModelRun("chineseNavigation", results.chineseNavigation);
  await call("ego_navigate", { action: "reload" });
  results.chineseForm = await call("ego_run", {
    goal: "\u586b\u5165\u63d0\u4f9b\u7684\u67e5\u8be2\u5185\u5bb9\u5e76\u7ee7\u7eed", values: { query: "PRIVATE_FORM_VALUE" },
    success: { all: [...success.all, { kind: "value_equals", target: "#query", value: "PRIVATE_FORM_VALUE" }] },
  });
  verifyModelRun("chineseForm", results.chineseForm, 2);
  checks.chineseBrowserTasks = checks.chineseNavigation && checks.chineseForm;
  await call("ego_open", { url });
  if (!live) {
  await call("ego_navigate", { action: "reload" });
  const pending = call("ego_run", { goal: "Use delayed decision to continue", success });
  await sleep(800);
  results.cancel = await call("ego_automation_cancel");
  results.cancelledRun = await pending;
  assert.equal(results.cancelledRun.status, "cancelled", JSON.stringify(results.cancelledRun));
  assert.equal(await call("ego_evaluate", { expression: 'document.querySelector("#done").hidden' }), true);
  checks.cancelPreventsLateAction = true;
  results.uiStopped = await call("ego_run", { goal: "Use delayed decision with UI stop", success });
  assert.equal(results.uiStopped.status, "cancelled", JSON.stringify(results.uiStopped));
  assert.equal(await call("ego_evaluate", { expression: 'document.querySelector("#done").hidden' }), true);
  checks.nativeStopButton = true;
  await call("ego_navigate", { action: "reload" });
  const handoffPending = call("ego_run", { goal: "Use delayed decision to continue", success });
  await sleep(300);
  await call("ego_task_handoff");
  results.handoff = await handoffPending;
  assert.equal(results.handoff.status, "cancelled");
  checks.handoffCancelsRun = true;
  }
  }
  if (repairBenchmark) {
    const { automationCorpus } = await import("./automation-corpus.mjs");
    const task = automationCorpus().find(item => item.id === "en-form-1");
    await call("ego_task_use", { task: "MCP repair verification" });
    await call("ego_open", { url: new URL("/corpus/en-form-1", url).href });
    await call("ego_evaluate", { expression: '(document.querySelector("#continue").id = "continue-v2", true)' });
    results.mcpRepair = await call("ego_run", {
      goal: task.goal, values: task.values, success: task.success, mode: "repair",
      steps: task.steps.map(step => step.action === "click"
        ? { ...step, targetHint: "Advance to the next step after filling the form" } : step),
    });
    assert.equal(results.mcpRepair.verified, true);
    assert.equal(results.mcpRepair.metrics.decisions, 1);
    assert.equal(results.mcpRepair.metrics.repairedActions, 1);
    assert.deepEqual(await call("ego_evaluate", { expression: task.inspect }), task.expected);
    checks.mcpRepair = true;
  }
  if (!relevanceBenchmark) {
    await client.close();
    client = undefined;
  }
  if (pointerProbe) {
    const { probeScopedClicks } = await import("./automation-click-stress.mjs");
    results.pointerSequence = await probeScopedClicks(pipe, url, {
      setWindow: async action => {
        const requestId = randomUUID();
        await new Promise((resolve, reject) => new AtomicJsonStateWriter(control,
          { onCommit: resolve, onFailure: reject }).write({ id: requestId, action }));
        await until(() => existsSync(controlled) && JSON.parse(readFileSync(controlled, "utf8")).id === requestId, "Window state command failed");
      },
      checkpoint: samples => writeFileSync(join(output, "pointer-progress.json"), JSON.stringify(samples, null, 2), "utf8"),
    });
    checks.pointerSequence = results.pointerSequence.passed;
    if (!checks.pointerSequence) scenarioFailures.push({ name: "pointerSequence" });
  }
  if (benchmark) {
    const { benchmarkAutomation } = await import("./automation-benchmark.mjs");
    results.overheadBenchmark = await benchmarkAutomation(pipe, url);
    checks.deterministicOverheadBenchmark = true;
  }
  if (relevanceBenchmark) {
    results.relevance = await probeRelevance(call, url, { pipe,
      checkpoint: report => {
        results.relevance = report;
        writeFileSync(join(output, "relevance-progress.json"), JSON.stringify(report, null, 2), "utf8");
      } });
    checks.relevance = results.relevance.passed;
    await client.close();
    client = undefined;
  } else if (repairBenchmark) {
    const { benchmarkRepair } = await import("./automation-repair-benchmark.mjs");
    results.repair = await benchmarkRepair(pipe, url, {
      checkpoint: report => writeFileSync(join(output, "repair-progress.json"), JSON.stringify(report, null, 2), "utf8"),
    });
    checks.repair = results.repair.passed;
    if (!results.repair.passed) scenarioFailures.push({ name: "repair", reason: "See repair-progress.json" });
  } else if (sdkAutomation) {
    const { probeAutomationSdk } = await import("./automation-sdk-smoke.mjs");
    results.sdk = await probeAutomationSdk(pipe, url, { live, mcpEntry });
    checks.sdk = results.sdk.passed;
  } else if (codexBenchmark) {
    const { benchmarkCodex } = await import("./automation-codex-benchmark.mjs");
    results.codex = await benchmarkCodex(pipe, url, {
      work, mcpEntry, pilot: codexPilot, includeRepair: codexRepairPilot, taskFilter: corpusFilter,
      checkpoint: report => writeFileSync(join(output, "codex-progress.json"), JSON.stringify(report, null, 2), "utf8"),
    });
    checks.codex = results.codex.passed;
    if (!results.codex.passed) scenarioFailures.push({ name: "codex", reason: "See codex-progress.json" });
  } else if (corpus) {
    const { benchmarkCorpus } = await import("./automation-corpus.mjs");
    results.corpus = await benchmarkCorpus(pipe, url, {
      live, taskFilter: corpusFilter, checkpoint: report => writeFileSync(join(output, "corpus-progress.json"), JSON.stringify(report, null, 2), "utf8"),
    });
    checks.corpus = results.corpus.passed;
    if (!results.corpus.passed) scenarioFailures.push({ name: "corpus", reason: "See corpus-progress.json" });
  }
  writeFileSync(finish, "{}");
  await until(() => electron.exitCode !== null, "Desktop did not exit");
  const desktop = JSON.parse(readFileSync(resultFile, "utf8"));
  assert.equal(desktop.passed, true, JSON.stringify(desktop));
  results.desktop = desktop;
  assert.equal(scenarioFailures.length, 0, JSON.stringify(scenarioFailures));
} catch (error) { failure = error; }
finally {
  await client?.close().catch(() => {});
  writeFileSync(finish, "{}");
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, sleep(5000)]);
    if (child.exitCode === null && child.signalCode === null) failure ||= new Error(`Child ${child.pid} did not exit`);
  }
  await new Promise(resolve => server.close(resolve));
  for (const name of ["settings-desktop.png", "settings-compact.png", "settings-failure.png"]) {
    if (existsSync(join(work, name))) writeFileSync(join(output, name), readFileSync(join(work, name)));
  }
  if (!results.desktop && existsSync(resultFile)) {
    try { results.desktop = JSON.parse(readFileSync(resultFile, "utf8")); } catch {}
  }
  writeFileSync(join(output, "smoke.log"), logs.join(""), "utf8");
  const report = { passed: !failure, checks, results, bundled, ...(packagedExecutable ? { packagedExecutable, packagedRuntime } : {}), provider: live ? "TypeSafe live API" : "fixture only", ...(failure ? { error: failure.stack } : {}) };
  const history = join(output, "history");
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, `${new Date().toISOString().replaceAll(":", "-")}-${id}.json`), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  const rel = relative(scratch, resolve(work));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe cleanup path");
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
if (failure) process.exitCode = 1;
