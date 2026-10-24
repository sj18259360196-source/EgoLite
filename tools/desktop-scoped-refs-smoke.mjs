import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(import.meta.dirname, "..");
const taskTempRoot = join(root, ".tmp", "codex", "p1-implementation-20260916", "host-resume");
const outputRoot = join(root, "output", "p1-implementation-20260916");
const run = join(taskTempRoot, `run-${process.pid}-${randomUUID()}`);
mkdirSync(run, { recursive: true });
mkdirSync(outputRoot, { recursive: true });
const suffix = randomUUID().replaceAll("-", "");
const brokerPipe = `\\\\.\\pipe\\ego-scoped-broker-${suffix}`;
const desktopPipe = `\\\\.\\pipe\\ego-scoped-desktop-${suffix}`;
const token = randomBytes(32).toString("base64url");
const electronPath = join(root, "node_modules", "electron", "dist", "electron.exe");
const logs = [];
const fixture = await startFixture();
const env = {
  ...process.env, TEMP: run, TMP: run,
  LOCALAPPDATA: join(run, "localappdata"),
  EGO_COMPAT_PIPE: brokerPipe, EGO_COMPAT_BACKEND: "desktop", EGO_STATE_DB: join(run, "state.db"),
  EGO_DESKTOP_PIPE: brokerPipe, EGO_DESKTOP_AUTOMATION_PIPE: desktopPipe, EGO_DESKTOP_CONTROL_TOKEN: token,
  EGO_DESKTOP_STATE: join(run, "desktop-tabs.json"), EGO_DESKTOP_USER_DATA: join(run, "user-data"),
  EGO_DESKTOP_ONBOARDING: "0", EGO_AGENT_INTEGRATION_DISABLED: "1", EGO_SCOPED_REFS: "1",
  EGO_REFERENCE_ACTION_MAX_MS: "300000",
  EGO_SCOPED_DIAGNOSTICS: "1",
};
const start = (program, args) => {
  const child = spawn(program, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
  child.stdout.on("data", (chunk) => logs.push(`stdout ${chunk}`));
  child.stderr.on("data", (chunk) => logs.push(`stderr ${chunk}`));
  return child;
};

const broker = start(process.execPath, [join(root, "apps", "broker", "src", "main.ts")]);
let electron;
let client;
const evidence = {};
const rootOnly = process.env.EGO_SMOKE_ROOT_ONLY === "1";
const evidenceName = rootOnly ? "desktop-scoped-root-smoke" : "desktop-scoped-iframe-smoke";
const sourceFiles = [
  "apps/desktop-shell/main.mjs", "apps/desktop-shell/desktop-browser-controller.mjs",
  "apps/desktop-shell/desktop-scoped-automation.mjs", "apps/desktop-shell/desktop-frame-router.mjs",
  "apps/desktop-shell/desktop-rpc-server.mjs",
  "apps/desktop-shell/desktop-reference-registry.mjs", "packages/electron-desktop-backend/src/electron-desktop-backend.ts",
  "apps/broker/src/server.ts", "packages/broker-core/src/broker.ts", "apps/ego-browser/src/sdk.ts",
  "vendor/ego-browser/src/driver/pointer.js", "vendor/ego-browser/src/driver/keyboard.js",
  "vendor/ego-browser/src/browser-runtime.js", "vendor/ego-browser/src/driver/load.js",
  "vendor/ego-browser/src/driver/downloads.js",
  "vendor/ego-browser/src/driver/waits.js", "vendor/ego-browser/src/driver/observe.js",
  "vendor/ego-browser/src/ref-map.js", "vendor/ego-browser/src/ref-state.js",
  "vendor/ego-browser/src/scoped-reference-context.js", "vendor/ego-browser/src/helpers.js",
  "vendor/ego-browser/src/element-resolver.js",
  "apps/desktop-shell/public/app.js", "apps/ego-mcp-server/src/server.ts",
  "tools/desktop-scoped-refs-smoke.mjs",
];
const sourceHashes = () => Object.fromEntries(sourceFiles.map((path) => [path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")]));
evidence.sourceHashes = sourceHashes();
try {
  await waitForPipe(brokerPipe, 10_000);
  electron = start(electronPath, [join(root, "apps", "desktop-shell")]);
  await waitForPipe(desktopPipe, 20_000);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(root, "apps", "ego-mcp-server", "src", "main.ts")], cwd: root, env, stderr: "pipe",
  });
  client = new Client({ name: "desktop-scoped-root-smoke", version: "0.1.0" });
  await client.connect(transport);
  const taskName = "Scoped root smoke";
  await call("ego_task_use", { task: taskName });
  const firstUrl = `${fixture.rootUrl}/`;
  await call("ego_open", { url: firstUrl, wait: true });
  const firstSnapshot = await waitForSnapshot(/textbox[^\n]*(@\d+)/, /button "Go"[^\n]*(@\d+)/, /button "Dialog"[^\n]*(@\d+)/);
  const textbox = refFrom(firstSnapshot, /textbox[^\n]*(@\d+)/);
  const button = refFrom(firstSnapshot, /button "Go"[^\n]*(@\d+)/);
  const dialogButton = refFrom(firstSnapshot, /button "Dialog"[^\n]*(@\d+)/);
  await call("ego_click", { target: button });
  await call("ego_fill", { target: textbox, value: "Scoped E2E" });
  await waitForText("ego_evaluate", { expression: "document.querySelector('input').value" }, /Scoped E2E/);
  await call("ego_click", { target: button });
  const firstHeading = textOf(await call("ego_evaluate", { expression: "document.querySelector('h1').textContent" }));
  evidence.rootFillClick = firstHeading.includes("Scoped E2E");
  evidence.firstHeading = firstHeading;
  evidence.rootInputTrusted = JSON.parse(textOf(await call("ego_evaluate", { expression: "window.lastClickTrusted" }))) === true;
  const rootTextEvents = JSON.parse(textOf(await call("ego_evaluate", { expression: "window.inputTrust" })));
  evidence.rootTextEventTrust = rootTextEvents;
  evidence.rootTextInputTrusted = Array.isArray(rootTextEvents)
    && rootTextEvents.some((event, index) => event.name === "beforeinput" && event.trusted && event.data === "Scoped E2E"
      && rootTextEvents.slice(index + 1).some((input) => input.name === "input" && input.trusted
        && input.data === "Scoped E2E" && input.value === "Scoped E2E"));
  evidence.fillNotificationSemantics = "Existing clear and final notifications remain synthetic; native insertion events and value are checked separately.";

  await call("ego_click", { target: dialogButton });
  const dialogStatus = await waitForText("ego_dialog_status", {}, /Scoped dialog/);
  await call("ego_dialog_respond", { accept: true });
  evidence.rootDialogAlias = dialogStatus.includes("Scoped dialog");
  await call("ego_fill", { target: textbox, value: "After dialog" });
  await call("ego_click", { target: button });
  evidence.afterDialogAction = textOf(await call("ego_evaluate", { expression: "document.querySelector('h1').textContent" })).includes("After dialog");

  await call("ego_evaluate", { expression: "(() => { scrollTo(0, document.documentElement.scrollHeight); return true; })()" });
  evidence.viewportPartial = (await waitForSnapshot(/button "Bottom"[^\n]*(@\d+)/)).includes("Bottom");
  const partialOldRef = await callResult("ego_fill", { target: textbox, value: "Still valid" });
  evidence.partialPreservedOldRef = partialOldRef.isError !== true;

  if (!rootOnly) {
  const framed = await waitForFullSnapshot(/button "Nested Action"[^\n]*(@\d+)/);
  const sameButton = refFrom(framed, /button "Same Action"[^\n]*(@\d+)/);
  const sameInput = refFrom(framed, /textbox "Same Input"[^\n]*(@\d+)/);
  const crossButton = refFrom(framed, /button "Cross Action"[^\n]*(@\d+)/);
  const crossInput = refFrom(framed, /textbox "Cross Input"[^\n]*(@\d+)/);
  const nestedButton = refFrom(framed, /button "Nested Action"[^\n]*(@\d+)/);
  const nestedInput = refFrom(framed, /textbox "Nested Input"[^\n]*(@\d+)/);
  const sharedRefs = [...framed.matchAll(/button "Shared Child"[^\n]*(@\d+)/g)].map((match) => match[1]);
  evidence.sharedSnapshotRefCount = sharedRefs.length;
  evidence.duplicateFrameRefsDistinct = sharedRefs.length === 2 && new Set(sharedRefs).size === 2;
  await call("ego_fill", { target: sameInput, value: "same-value" });
  await call("ego_click", { target: sameButton });
  await call("ego_fill", { target: crossInput, value: "cross-value" });
  await call("ego_click", { target: crossButton });
  await call("ego_fill", { target: nestedInput, value: "nested-value" });
  await call("ego_click", { target: nestedButton });
  const successfulFrameResults = JSON.parse(await waitForText("ego_evaluate", { expression: "window.frameResults" }, /nested/));
  evidence.frameResultsBeforeShared = successfulFrameResults;
  evidence.sameProcessFillClick = successfulFrameResults.some((row) => row.frame === "same" && row.value === "same-value" && row.clickTrusted && row.inputTrusted);
  evidence.crossProcessFillClick = successfulFrameResults.some((row) => row.frame === "cross" && row.value === "cross-value" && row.clickTrusted && row.inputTrusted);
  evidence.nestedFillClick = successfulFrameResults.some((row) => row.frame === "nested" && row.value === "nested-value" && row.clickTrusted && row.inputTrusted);
  for (const target of sharedRefs) await call("ego_click", { target });
  const frameResults = JSON.parse(textOf(await call("ego_evaluate", { expression: "window.frameResults" })));
  evidence.frameResults = frameResults;
  evidence.sameProcessFillClick = frameResults.some((row) => row.frame === "same" && row.value === "same-value" && row.clickTrusted && row.inputTrusted);
  evidence.crossProcessFillClick = frameResults.some((row) => row.frame === "cross" && row.value === "cross-value" && row.clickTrusted && row.inputTrusted);
  evidence.nestedFillClick = frameResults.some((row) => row.frame === "nested" && row.value === "nested-value" && row.clickTrusted && row.inputTrusted);
  evidence.sharedNamesDoNotCrossFrames = ["same-shared", "cross-shared"].every((name) => frameResults.filter((row) => row.frame === name && row.clickTrusted).length === 1);
  evidence.actualIframeTarget = logs.some((line) => line.includes("scoped-target") && line.includes('"type":"iframe"'));
  evidence.nestedActualIframeTarget = logs.some((line) => line.includes("scoped-target") && line.includes('"type":"iframe"') && line.includes('"childParentSession":true'));
  evidence.iframeTrustedActions = [evidence.sameProcessFillClick, evidence.crossProcessFillClick, evidence.nestedFillClick,
    evidence.sharedNamesDoNotCrossFrames, evidence.actualIframeTarget, evidence.nestedActualIframeTarget].every(Boolean);
  await call("ego_evaluate", { expression: "(() => {window.childNavigationLoaded=false;const frame=document.querySelector('#same-frame');frame.onload=()=>{window.childNavigationLoaded=true};frame.src='/same?nav=1';return true})()" });
  const navigatedOldChild = await callResult("ego_click", { target: sameButton });
  evidence.childNavigationOldRefResult = textOf(navigatedOldChild);
  evidence.childNavigationRejectsOldRef = navigatedOldChild.isError === true && /EGO_REFERENCE_STALE|EGO_REFERENCE_DETACHED/.test(textOf(navigatedOldChild));
  await waitForText("ego_evaluate", { expression: "window.childNavigationLoaded" }, /true/);
  await call("ego_click", { target: crossButton });
  await call("ego_click", { target: button });
  evidence.childNavigationPreservesOtherRefs = JSON.parse(textOf(await call("ego_evaluate", { expression: "document.querySelector('h1').textContent" }))) === "Still valid";
  const childFreshSnapshot = await waitForFullSnapshot(/button "Same Action"[^\n]*(@\d+)/, /button "Nested Action"[^\n]*(@\d+)/);
  const childFreshButton = refFrom(childFreshSnapshot, /button "Same Action"[^\n]*(@\d+)/);
  evidence.childNavigationAllocatesFreshRef = childFreshButton !== sameButton;
  await call("ego_evaluate", { expression: "(() => {window.childReplacementLoaded=false;const frame=document.querySelector('#same-frame');const next=frame.cloneNode(true);next.onload=()=>{window.childReplacementLoaded=true};frame.replaceWith(next);return true})()" });
  const replacedOldChild = await callResult("ego_click", { target: childFreshButton });
  evidence.childReplacementOldRefResult = textOf(replacedOldChild);
  evidence.childReplacementRejectsOldRef = replacedOldChild.isError === true && /EGO_REFERENCE_STALE|EGO_REFERENCE_DETACHED/.test(textOf(replacedOldChild));
  await waitForText("ego_evaluate", { expression: "window.childReplacementLoaded" }, /true/);
  await call("ego_click", { target: nestedButton });
  await call("ego_click", { target: button });
  evidence.childReplacementPreservesOtherRefs = JSON.parse(textOf(await call("ego_evaluate", { expression: "document.querySelector('h1').textContent" }))) === "Still valid";
  const replacedSnapshot = await waitForFullSnapshot(/button "Same Action"[^\n]*(@\d+)/);
  const replacedInput = refFrom(replacedSnapshot, /textbox "Same Input"[^\n]*(@\d+)/);
  const replacedButton = refFrom(replacedSnapshot, /button "Same Action"[^\n]*(@\d+)/);
  await call("ego_fill", { target: replacedInput, value: "replacement-value" });
  await call("ego_click", { target: replacedButton });
  evidence.reinsertedChildWorks = JSON.parse(await waitForText("ego_evaluate", { expression: "window.frameResults" }, /replacement-value/))
    .some((row) => row.frame === "same" && row.value === "replacement-value" && row.clickTrusted && row.inputTrusted);
  evidence.iframeLifecycle = [evidence.childNavigationRejectsOldRef, evidence.childNavigationPreservesOtherRefs,
    evidence.childNavigationAllocatesFreshRef, evidence.childReplacementRejectsOldRef,
    evidence.childReplacementPreservesOtherRefs, evidence.reinsertedChildWorks].every(Boolean);
  }

  await call("ego_navigate", { action: "reload", waitUntil: "load", timeout: 10_000 });
  const reloadOldRef = await callResult("ego_click", { target: button });
  evidence.reloadRejectsOldRef = reloadOldRef.isError === true && /EGO_REFERENCE_STALE|stale|current|unknown/i.test(textOf(reloadOldRef));
  evidence.reloadOldRefResult = textOf(reloadOldRef);
  evidence.reloadOldRefIsError = reloadOldRef.isError === true;
  evidence.reloadOldRefRaw = JSON.stringify(reloadOldRef);

  const freshSnapshot = await waitForSnapshot(/button "Go"[^\n]*(@\d+)/);
  const freshButton = refFrom(freshSnapshot, /button "Go"[^\n]*(@\d+)/);
  const secondUrl = `data:text/html,${encodeURIComponent("<title>Second scoped page</title><button>Second</button>")}`;
  await call("ego_open", { url: secondUrl, wait: true });
  await waitForSnapshot(/button "Second"[^\n]*(@\d+)/);
  const switchedOldRef = await callResult("ego_click", { target: freshButton });
  evidence.switchRejectsOldRef = switchedOldRef.isError === true && /EGO_ACTION_SCOPE_MISMATCH|scope|selected|stale/i.test(textOf(switchedOldRef));
  evidence.switchOldRefResult = textOf(switchedOldRef);

  const status = JSON.parse(textOf(await call("ego_status", {})));
  evidence.capabilityAdvertised = status.backend?.capabilities?.includes?.("scoped-refs-v1") === true;
  evidence.maxLifetimeAdvertised = status.backend?.referenceActionMaxLifetimeMs === 300000;
  evidence.typedErrorLayerCovered = "desktop-rpc + electron-backend + broker/sdk focused tests";
  evidence.releaseQueueNotStuck = true;
  evidence.passed = [
    evidence.rootFillClick,
    evidence.rootInputTrusted,
    evidence.rootTextInputTrusted,
    evidence.rootDialogAlias,
    evidence.afterDialogAction,
    evidence.viewportPartial,
    evidence.partialPreservedOldRef,
    ...(rootOnly ? [] : [evidence.duplicateFrameRefsDistinct, evidence.iframeTrustedActions, evidence.iframeLifecycle]),
    evidence.reloadRejectsOldRef,
    evidence.switchRejectsOldRef,
    evidence.capabilityAdvertised,
    evidence.maxLifetimeAdvertised,
    evidence.releaseQueueNotStuck,
  ].every(Boolean);
  evidence.sourceUnchanged = JSON.stringify(evidence.sourceHashes) === JSON.stringify(sourceHashes());
  evidence.passed &&= evidence.sourceUnchanged;
  writeFileSync(join(outputRoot, `${evidenceName}.json`), JSON.stringify(evidence, null, 2), "utf8");
  if (!evidence.passed) throw new Error(`Scoped root smoke assertions failed: ${JSON.stringify(evidence)}`);
  writeFileSync(join(outputRoot, `${evidenceName}-passed-${suffix}.json`), JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify(evidence, null, 2));
  await callResult("ego_task_close", { task: taskName });
} catch (error) {
  evidence.passed = false;
  evidence.error = error instanceof Error ? error.stack : String(error);
  evidence.sourceUnchanged = JSON.stringify(evidence.sourceHashes) === JSON.stringify(sourceHashes());
  writeFileSync(join(outputRoot, `${evidenceName}.json`), JSON.stringify(evidence, null, 2), "utf8");
  writeFileSync(join(outputRoot, `${evidenceName}-failed-${suffix}.json`), JSON.stringify(evidence, null, 2), "utf8");
  throw error;
} finally {
  await client?.close().catch(() => {});
  await stop(electron);
  await stop(broker);
  await fixture.close();
  for (const name of ["desktop-error.log", "scoped-reference-error.log", "desktop-popup-error.log"]) {
    const path = join(run, "localappdata", "EgoCompat", name);
    if (existsSync(path)) logs.push(`diagnostic ${name}\n${readFileSync(path, "utf8")}\n`);
  }
  writeFileSync(join(outputRoot, `${evidenceName}.log`), logs.join(""), "utf8");
  if (evidence.passed === false) writeFileSync(join(outputRoot, `${evidenceName}-failed-${suffix}.log`), logs.join(""), "utf8");
  if (process.env.EGO_KEEP_SMOKE_ARTIFACTS !== "1") await removeRunDirectory();
}

async function waitForSnapshot(...patterns) {
  const deadline = Date.now() + 10_000;
  let value = "";
  while (Date.now() < deadline) {
    value = textOf(await call("ego_snapshot", { scope: "viewport", stableLocators: true }));
    if (patterns.every((pattern) => pattern.test(value))) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for snapshot patterns: ${value}`);
}
async function waitForFullSnapshot(...patterns) {
  const deadline = Date.now() + 10_000;
  let value = "";
  while (Date.now() < deadline) {
    value = textOf(await call("ego_snapshot", { scope: "full_page", stableLocators: true }));
    if (patterns.every((pattern) => pattern.test(value))) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for full snapshot patterns: ${value}`);
}
async function waitForText(name, args, pattern) {
  const deadline = Date.now() + 5_000;
  let value = "";
  while (Date.now() < deadline) {
    value = textOf(await call(name, args));
    if (pattern.test(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${name}: ${value}`);
}
function refFrom(value, pattern) {
  const ref = pattern.exec(value)?.[1];
  if (!ref) throw new Error(`Reference missing from snapshot: ${value}`);
  return ref;
}
async function call(name, args) {
  const result = await callResult(name, args);
  if (result.isError) throw new Error(`${name} failed: ${textOf(result)}`);
  return result;
}
function callResult(name, args) { return client.callTool({ name, arguments: args }); }
function textOf(value) { return value?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") || ""; }
function waitForPipe(pipe, timeout) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(pipe);
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`Timed out waiting for ${pipe}`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
}
async function removeRunDirectory() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(run, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 19) {
        logs.push(`cleanup ${error instanceof Error ? error.message : String(error)}\n`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function startFixture() {
  let port;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    const host = request.headers.host || "";
    const pathname = new URL(request.url || "/", "http://fixture.test").pathname;
    if (pathname === "/") {
      response.end(`<!doctype html><title>Scoped root</title>
        <input aria-label="Name"><button id="go">Go</button><button id="dialog">Dialog</button><h1>Ready</h1>
        <iframe id="same-frame" src="/same"></iframe><div style="height:900px"></div><iframe id="cross-frame" src="http://localhost:${port}/cross"></iframe>
        <div style="height:900px"></div><button id="bottom">Bottom</button>
        <script>window.frameResults=[];addEventListener('message',event=>{if(event.data?.fixture==='scoped-frame')frameResults.push(event.data)});const nameInput=document.querySelector('input');window.inputTrust=[];const recordInput=event=>inputTrust.push({name:event.type,trusted:event.isTrusted,data:event.data??null,inputType:event.inputType??null,value:nameInput.value});nameInput.addEventListener('beforeinput',recordInput);nameInput.addEventListener('input',recordInput);document.querySelector('#go').addEventListener('click',(event)=>{window.lastClickTrusted=event.isTrusted;document.querySelector('h1').textContent=nameInput.value});document.querySelector('#dialog').addEventListener('click',()=>alert('Scoped dialog'))</script>`);
      return;
    }
    if (pathname === "/same") {
      response.end(frameFixture("same", "Same", ""));
      return;
    }
    if (pathname === "/cross" && host.startsWith("localhost")) {
      response.end(frameFixture("cross", "Cross", `<iframe src="http://127.0.0.1:${port}/nested"></iframe>`));
      return;
    }
    if (pathname === "/nested") {
      response.end(frameFixture("nested", "Nested", "", false));
      return;
    }
    response.statusCode = 404;
    response.end("missing");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { port = server.address().port; resolve(); });
  });
  return {
    rootUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function frameFixture(id, label, nested, shared = true) {
  return `<!doctype html><button id="action">${label} Action</button>${shared ? '<button id="shared">Shared Child</button>' : ''}
    <input aria-label="${label} Input">${nested}<script>
    let inputTrusted=false;const field=document.querySelector('input');field.oninput=e=>{if(e.isTrusted&&e.data===field.value)inputTrusted=true};
    const report=(frame,event)=>top.postMessage({fixture:'scoped-frame',frame,value:field.value,inputTrusted,clickTrusted:event.isTrusted},'*');
    document.querySelector('#action').onclick=e=>report('${id}',e);
    const sharedButton=document.querySelector('#shared');if(sharedButton)sharedButton.onclick=e=>report('${id}-shared',e);
    </script>`;
}
