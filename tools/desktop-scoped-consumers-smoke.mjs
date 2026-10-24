import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EgoMcpSession } from "../apps/ego-mcp-server/src/ego-session.ts";
import { createServer as createEgoMcpServer } from "../apps/ego-mcp-server/src/server.ts";
import { browserRefMap } from "../vendor/ego-browser/src/ref-state.js";

const root = resolve(import.meta.dirname, "..");
const nativeFetch = globalThis.fetch;
const taskTempRoot = join(root, ".tmp", "codex", "p1-implementation-20260916", "consumers-smoke");
const run = join(taskTempRoot, `run-${process.pid}-${randomUUID()}`);
const output = join(root, "output", "p1-implementation-20260916");
const suffix = randomUUID().replaceAll("-", "");
const brokerPipe = `\\\\.\\pipe\\ego-consumers-broker-${suffix}`;
const desktopPipe = `\\\\.\\pipe\\ego-consumers-desktop-${suffix}`;
const logs = [];
const checks = {};
const workspaceDirectories = [
  "apps/broker", "apps/desktop-shell", "apps/ego-browser", "apps/ego-mcp-server", "apps/desktop-mcp-server",
  ...readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => `packages/${entry.name}`),
];
const sourceDirectories = [
  ...workspaceDirectories.map((directory) => directory === "apps/desktop-shell" ? directory : `${directory}/src`),
  "vendor/ego-browser/src",
];
const hashes = () => {
  const files = new Set(["tools/desktop-scoped-consumers-smoke.mjs", "package.json", "package-lock.json",
    ...workspaceDirectories.map((directory) => `${directory}/package.json`)]);
  const scan = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !["node_modules", "dist", ".tmp", "output"].includes(entry.name)) scan(path);
      else if (entry.isFile() && /\.(?:mjs|cjs|js|ts|tsx|json|css|html)$/.test(entry.name)
        && !/\.(?:test|spec)\.[^.]+$/.test(entry.name)) files.add(path);
    }
  };
  sourceDirectories.forEach(scan);
  return Object.fromEntries([...files].sort().map((path) => [
    path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex"),
  ]));
};
const evidence = { startedAt: new Date().toISOString(), checks, sourceHashes: hashes() };
const ownEnvKeys = ["EGO_BROWSER_AGENT_ID", "EGO_COMPAT_PIPE", "EGO_DESKTOP_AUTOMATION_PIPE", "TEMP", "TMP"];
const previousEnv = Object.fromEntries(ownEnvKeys.map((key) => [key, process.env[key]]));
let fixture;
let broker;
let electron;
let session;
let mcpServer;
let mcp;
let direct;
mkdirSync(run, { recursive: true });
mkdirSync(output, { recursive: true });
const uploadPath = join(run, "consumer-upload.txt");
writeFileSync(uploadPath, "consumer upload fixture\n", "utf8");
const env = {
  ...process.env, TEMP: run, TMP: run, LOCALAPPDATA: join(run, "localappdata"),
  EGO_COMPAT_PIPE: brokerPipe, EGO_COMPAT_BACKEND: "desktop", EGO_STATE_DB: join(run, "state.db"),
  EGO_DESKTOP_PIPE: brokerPipe, EGO_DESKTOP_AUTOMATION_PIPE: desktopPipe,
  EGO_DESKTOP_CONTROL_TOKEN: randomBytes(32).toString("base64url"),
  EGO_DESKTOP_STATE: join(run, "desktop-tabs.json"), EGO_DESKTOP_USER_DATA: join(run, "user-data"),
  EGO_DESKTOP_DOWNLOADS: join(run, "desktop-downloads.json"),
  EGO_DESKTOP_ONBOARDING: "0", EGO_AGENT_INTEGRATION_DISABLED: "1", EGO_SCOPED_REFS: "1",
  EGO_REFERENCE_ACTION_MAX_MS: "300000", EGO_BROWSER_AGENT_ID: `consumers-sdk-${suffix}`,
};

try {
  fixture = await startFixture();
  broker = start(process.execPath, [join(root, "apps", "broker", "src", "main.ts")]);
  await waitForPipe(brokerPipe, 10_000);
  electron = start(join(root, "node_modules", "electron", "dist", "electron.exe"), [join(root, "apps", "desktop-shell"), "--remote-debugging-port=0"]);
  await waitForPipe(desktopPipe, 20_000);
  for (const key of ownEnvKeys) process.env[key] = env[key];
  session = await EgoMcpSession.connect(brokerPipe);
  assert.ok((await session.status()).capabilities?.includes("scoped-refs-v1"));
  const sdk = session.sdk;
  const task = await sdk.taskSpaces.useOrCreate("Scoped consumers smoke");
  const taskId = task.id;
  assert.ok(Number.isSafeInteger(taskId) && taskId > 0, "Created task must expose its numeric id");
  const opened = await sdk.browser.openOrReuseTab(fixture.url, { wait: true });
  assert.equal(typeof opened.targetId, "string");
  evidence.pageId = opened.targetId;
  mcpServer = createEgoMcpServer(session);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  mcp = new Client({ name: "scoped-consumers-sdk", version: "0.1.0" });
  await mcp.connect(clientTransport);
  const snapshot = await poll(async () => {
    const value = await sdk.page.snapshot({ scope: "full_page", includeActionMarks: true });
    return value.includes('button "Drop Target"') ? value : null;
  }, 10_000);
  evidence.initialSnapshot = snapshot;
  const refs = Object.fromEntries([
    ["name", "Name"], ["next", "Next"], ["check", "Choice"], ["select", "Color"],
    ["upload", "Upload"], ["wait", "Wait Target"], ["source", "Drag Source"],
    ["target", "Drop Target"], ["apply", "Apply"],
  ].map(([key, label]) => [key, refFor(snapshot, label)]));
  evidence.refs = refs;
  assert.equal(browserRefMap.isScopedMode(), true, "The SDK must consume the negotiated scoped snapshot format");
  for (const ref of Object.values(refs)) {
    const entry = browserRefMap.get(ref.slice(1));
    assert.equal(entry?.refFormat, "scoped-v1");
    assert.equal(entry.pageId, opened.targetId);
  }

  await verify("keyboardAndTab", async () => {
    await sdk.page.locator(refs.name).fill("");
    await sdk.page.evaluate("consumerEvents.length=0");
    await sdk.page.locator(refs.name).pressSequentially("Cadence", { delay: 15 });
    assert.equal(await sdk.page.locator(refs.name).inputValue(), "Cadence");
    await sdk.page.locator(refs.name).press("Tab");
    const value = await sdk.page.evaluate("({active:document.activeElement.id, keys:window.consumerEvents.filter(e=>e.type==='keydown'), inputs:window.consumerEvents.filter(e=>e.type==='input'&&e.id==='name')})");
    assert.equal(value.active, "next");
    assert.ok(value.keys.some((event) => event.key === "Tab" && event.trusted && event.id === "name"));
    assert.ok(value.inputs.length > 0 && value.inputs.every((event) => event.trusted));
    return value;
  });
  await verify("checkAndSelect", async () => {
    await sdk.page.locator(refs.check).check();
    assert.equal(await sdk.page.locator(refs.check).isChecked(), true);
    await sdk.page.locator(refs.check).uncheck();
    assert.equal(await sdk.page.locator(refs.check).isChecked(), false);
    await sdk.page.locator(refs.select).selectOption("green");
    const value = await sdk.page.evaluate("({checked:document.querySelector('#choice').checked,color:document.querySelector('#color').value,events:consumerEvents.filter(e=>['choice','color'].includes(e.id)&&e.type==='change')})");
    assert.equal(value.checked, false);
    assert.equal(value.color, "green");
    assert.ok(value.events.filter((event) => event.id === "choice").length >= 2);
    assert.ok(value.events.some((event) => event.id === "color"));
    return value;
  });
  await verify("uploadFileList", async () => {
    await sdk.page.locator(refs.upload).setInputFiles(uploadPath);
    const value = await sdk.page.evaluate("({files:Array.from(document.querySelector('#upload').files,f=>({name:f.name,size:f.size})),change:consumerEvents.filter(e=>e.id==='upload'&&e.type==='change')})");
    assert.deepEqual(value.files, [{ name: "consumer-upload.txt", size: Buffer.byteLength("consumer upload fixture\n") }]);
    assert.ok(value.change.length > 0 && value.change.every((event) => event.trusted));
    return value;
  });
  await verify("inspectActualMcpHandler", async () => {
    const value = jsonOf(await call(mcp, "ego_inspect", { target: refs.name, attributes: ["id", "aria-label"] }));
    assert.equal(value.inputValue, "Cadence");
    assert.equal(value.visible, true);
    assert.equal(value.editable, true);
    assert.deepEqual(value.attributes, { id: "name", "aria-label": "Name" });
    return value;
  });
  await verify("waitCurrentRefHidden", async () => {
    await sdk.page.evaluate("(() => {setTimeout(()=>document.querySelector('#wait-target').hidden=true,150);return true})()");
    await sdk.page.locator(refs.wait).waitFor({ state: "hidden", timeout: 3_000 });
    assert.equal(await sdk.page.evaluate("document.querySelector('#wait-target').hidden"), true);
    return { hidden: true };
  });
  await verify("rootElementScreenshotDimensions", async () => {
    const metrics = await sdk.page.evaluate("(() => {const r=document.querySelector('#apply').getBoundingClientRect();return {width:r.width,height:r.height,dpr:devicePixelRatio}})()");
    const path = await sdk.page.locator(refs.apply).screenshot({ path: join(run, "root-element.png") });
    const dimensions = pngDimensions(readFileSync(path));
    const x = dimensions.width / metrics.width;
    const y = dimensions.height / metrics.height;
    assert.ok(x >= 0.5 && x <= 4 && Math.abs(x - y) <= 0.08, JSON.stringify({ dimensions, metrics }));
    assert.ok(Math.abs(x - metrics.dpr) <= 0.15, "Element screenshot must match the native pixel scale");
    return { dimensions, metrics };
  });
  await verify("sameFrameDragTrustedBusinessResult", async () => {
    await sdk.page.locator(refs.source).dragTo(sdk.page.locator(refs.target), { delay: 30 });
    const value = await sdk.page.evaluate("({result:document.querySelector('#drag-result').textContent,events:consumerEvents.filter(e=>e.type==='mousedown'||e.type==='mouseup')})");
    assert.equal(value.result, "drag-complete");
    assert.ok(value.events.some((event) => event.id === "drag-source" && event.type === "mousedown" && event.trusted));
    assert.ok(value.events.some((event) => event.id === "drop-target" && event.type === "mouseup" && event.trusted));
    return value;
  });
  await verify("scopedDownloadBytesAndCenter", async () => {
    const downloadRef = refFor(snapshot, "Download");
    const path = join(run, "downloaded-fixture.txt");
    const value = jsonOf(await call(mcp, "ego_download", { target: downloadRef, saveAs: path, timeout: 5_000 }));
    assert.equal(readFileSync(path, "utf8"), fixture.downloadText);
    assert.equal(value.suggestedFilename, "consumer-download.txt");
    const state = JSON.parse(readFileSync(env.EGO_DESKTOP_DOWNLOADS, "utf8"));
    const record = state.downloads.find((item) => item.savePath === path);
    assert.equal(record?.state, "completed");
    return { value, record };
  });

  await verify("directExactVisibleThreeRefEntrances", async () => {
    await sdk.browser.switchTab(opened.targetId);
    await showFixtureInDesktop(opened.targetId);
    const directEnv = { ...env, EGO_BROWSER_AGENT_ID: `consumers-direct-${suffix}` };
    direct = new Client({ name: "scoped-consumers-direct", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [join(root, "apps", "desktop-mcp-server", "src", "main.ts")],
      cwd: root, env: directEnv, stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => logs.push(`direct stderr ${chunk}`));
    await direct.connect(transport);
    const status = jsonOf(await call(direct, "ego_desktop_status"));
    assert.ok(status.capabilities?.includes("scoped-refs-v1"));
    const visible = status.visible;
    assert.equal(visible?.taskSpaceId, taskId);
    assert.equal(visible.targetId, opened.targetId);
    const request = jsonOf(await call(direct, "ego_desktop_request_control"));
    assert.ok(request.id, "Direct consumer must request control before the current writer approves it");
    const granted = await sdk.taskSpaces.returnControl(taskId, request.id);
    assert.equal(granted.controllerClientId, directEnv.EGO_BROWSER_AGENT_ID);
    await call(direct, "ego_desktop_evaluate", { expression: "consumerEvents.length=0" });
    const full = textOf(await call(direct, "ego_desktop_snapshot", { scope: "full_page", stableLocators: true, actionMarks: true }));
    const nameRef = refFor(full, "Name");
    const applyRef = refFor(full, "Apply");
    await call(direct, "ego_desktop_snapshot", { scope: "viewport", stableLocators: false, actionMarks: false, maxResultLength: 96 });
    await call(direct, "ego_desktop_fill", { target: nameRef, value: "Direct actual" });
    await call(direct, "ego_desktop_hover", { target: applyRef });
    await call(direct, "ego_desktop_click", { target: applyRef });
    const value = jsonOf(await call(direct, "ego_desktop_evaluate", { expression: "({name:document.querySelector('#name').value,heading:document.querySelector('h1').textContent,hover:consumerEvents.some(e=>e.id==='apply'&&e.type==='mouseover'&&e.trusted),click:consumerEvents.some(e=>e.id==='apply'&&e.type==='click'&&e.trusted),input:consumerEvents.some(e=>e.id==='name'&&e.type==='input'&&e.trusted)})" }));
    assert.equal(value.name, "Direct actual");
    assert.equal(value.heading, "Direct actual");
    assert.equal(value.hover, true);
    assert.equal(value.click, true);
    assert.equal(value.input, true);
    return { pageId: visible.targetId, nameRef, applyRef, value };
  });
  evidence.sourceHashesAfter = hashes();
  evidence.sourceUnchanged = JSON.stringify(evidence.sourceHashesAfter) === JSON.stringify(evidence.sourceHashes);
  assert.deepEqual(evidence.sourceHashesAfter, evidence.sourceHashes, "Source changed during verification");
  assert.equal(Object.keys(checks).length, 9);
  assert.ok(Object.values(checks).every((check) => check.passed), JSON.stringify(checks));
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = error?.stack || String(error);
  process.exitCode = 1;
} finally {
  const cleanup = [];
  for (const [name, close] of [
    ["direct", () => direct?.close()], ["MCP", () => mcp?.close()],
    ["MCP server", () => mcpServer?.close()], ["SDK session", () => session?.close()],
    ["Electron", () => stop(electron)], ["Broker", () => stop(broker)],
    ["fixture", () => fixture?.close()],
  ]) {
    try { await close(); } catch (error) { cleanup.push(`${name}: ${error.message}`); }
  }
  for (const key of ownEnvKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  try {
    const absolute = resolve(run);
    assert.ok(absolute.startsWith(resolve(taskTempRoot) + sep), "Cleanup target must stay in this task temp directory");
    rmSync(absolute, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    try { rmdirSync(taskTempRoot); } catch (error) { if (error.code !== "ENOTEMPTY") throw error; }
  } catch (error) { cleanup.push(`temp: ${error.message}`); }
  evidence.cleanup = { passed: cleanup.length === 0, errors: cleanup };
  if (cleanup.length) { evidence.passed = false; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(join(output, "desktop-scoped-consumers-smoke.json"), JSON.stringify(evidence, null, 2), "utf8");
  writeFileSync(join(output, "desktop-scoped-consumers-smoke.log"), logs.join(""), "utf8");
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

function start(program, args) {
  const child = spawn(program, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
  child.stdout.on("data", (chunk) => logs.push(`${program} stdout ${chunk}`));
  child.stderr.on("data", (chunk) => logs.push(`${program} stderr ${chunk}`));
  child.on("error", (error) => logs.push(`${program} error ${error.stack}\n`));
  return child;
}
async function showFixtureInDesktop(targetId) {
  const port = Number(readFileSync(join(env.EGO_DESKTOP_USER_DATA, "DevToolsActivePort"), "utf8").split("\n")[0]);
  const pages = await (await nativeFetch(`http://127.0.0.1:${port}/json/list`)).json();
  const shell = pages.find((page) => page.type === "page" && page.url.startsWith("file:") && page.url.endsWith("/index.html"));
  assert.ok(shell?.webSocketDebuggerUrl, "Isolated desktop UI debugger is available");
  const socket = new WebSocket(shell.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Desktop visual tab activation timed out")), 10_000);
      socket.addEventListener("message", (event) => {
        const response = JSON.parse(String(event.data));
        if (response.id !== 1) return;
        clearTimeout(timeout);
        if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response)));
        else resolve(response.result);
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
        expression: `window.egoDesktop.invoke("tab.activate", {targetId:${JSON.stringify(targetId)},visual:true})`,
        awaitPromise: true, returnByValue: true,
      } }));
    });
  } finally { socket.close(); }
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((done) => child.once("exit", done));
  child.kill();
  let timer;
  try {
    await Promise.race([ended, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Process ${child.pid} did not exit after termination`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function verify(name, operation) {
  try { checks[name] = { passed: true, evidence: await operation() }; }
  catch (error) { checks[name] = { passed: false, error: error.stack || String(error) }; }
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 20_000 });
  textOf(result);
  return result;
}
function textOf(result) {
  const value = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "";
  if (result.isError) throw new Error(value || "MCP call failed");
  return value;
}
function jsonOf(result) { return JSON.parse(textOf(result)); }
function refFor(snapshot, label) {
  const line = snapshot.split(/\r?\n/).find((value) => value.includes(`"${label}"`) && /@\d+/.test(value));
  const ref = line?.match(/@\d+/)?.[0];
  assert.ok(ref, `Missing scoped snapshot ref for ${label}: ${snapshot}`);
  return ref;
}
function pngDimensions(bytes) {
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  assert.ok(size.width > 0 && size.height > 0);
  return size;
}
async function poll(read, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 75));
  }
  throw new Error("Timed out waiting for fixture snapshot");
}
async function waitForPipe(pipe, timeout) {
  await poll(() => new Promise((done) => {
    const socket = connect(pipe);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => { socket.destroy(); done(false); });
  }), timeout);
}
async function startFixture() {
  const downloadText = "consumer download fixture\n";
  const server = createServer((request, response) => {
    if (request.url === "/download") {
      response.setHeader("content-type", "text/plain");
      response.setHeader("content-disposition", 'attachment; filename="consumer-download.txt"');
      response.end(downloadText);
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>Scoped consumers</title><style>
      body{margin:24px;font:16px Arial}input,select,button{margin:8px;padding:8px}
      #drag-source,#drop-target{width:150px;height:60px}#apply{width:120px;height:48px}
      </style><input id="name" aria-label="Name"><input id="next" aria-label="Next">
      <label><input id="choice" type="checkbox">Choice</label>
      <select id="color" aria-label="Color"><option value="red">Red</option><option value="green">Green</option></select>
      <input id="upload" type="file" aria-label="Upload"><button id="wait-target">Wait Target</button>
      <div><button id="drag-source">Drag Source</button><button id="drop-target">Drop Target</button></div>
      <p id="drag-result">pending</p><button id="apply">Apply</button><h1>Ready</h1>
      <a href="/download" download="consumer-download.txt">Download</a><div style="height:1500px"></div>
      <script>window.consumerEvents=[];let pressed=false;
      ['keydown','keyup','input','change','mousedown','mouseup','mouseover','click'].forEach(type=>document.addEventListener(type,e=>{
        consumerEvents.push({type,id:e.target.id,key:e.key||'',trusted:e.isTrusted});
        if(type==='mousedown'&&e.target.id==='drag-source'&&e.isTrusted)pressed=true;
        if(type==='mouseup'&&e.target.id==='drop-target'&&e.isTrusted&&pressed){document.querySelector('#drag-result').textContent='drag-complete';pressed=false}
      },true));document.querySelector('#apply').addEventListener('click',()=>document.querySelector('h1').textContent=document.querySelector('#name').value)</script>`);
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return {
    url: `http://127.0.0.1:${server.address().port}/`, downloadText,
    close: () => new Promise((done, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : done()); }),
  };
}
