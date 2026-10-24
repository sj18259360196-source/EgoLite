import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "ego-desktop-smoke-"));
const suffix = randomUUID().replaceAll("-", "");
const pipe = `\\\\.\\pipe\\ego-desktop-smoke-${suffix}`;
const automationPipe = `\\\\.\\pipe\\ego-desktop-automation-smoke-${suffix}`;
const desktopControlToken = randomBytes(32).toString("base64url");
const resultPath = join(work, "result.json");
const restoreResultPath = join(work, "restore-result.json");
const capturePath = process.env.EGO_DESKTOP_CAPTURE_OUTPUT || join(work, "desktop.png");
const textAttachmentPath = join(work, "smoke-notes.md");
const desktopPreferencesPath = join(work, "desktop-preferences.json");
const browserImportRoot = join(work, "browser-local");
const electronPath = join(root, "node_modules", "electron", "dist", "electron.exe");
const brokerBackend = process.argv.includes("--desktop-backend") ? "desktop" : "fake";
const rendererSmokeTimeout = Number(process.env.EGO_DESKTOP_SMOKE_TIMEOUT_MS || (brokerBackend === "desktop" ? 60_000 : 45_000));
const fixture = await startFixture();
writeFileSync(textAttachmentPath, "Smoke text attachment body", "utf8");
writeFileSync(desktopPreferencesPath, JSON.stringify({
  version: 1,
  browserBackend: "desktop",
  permissions: {},
  controlConsentPolicyVersion: 2,
  controlHandoffEnabled: true,
  controlConsentEnabled: true,
  controlConsentLevel: "strict",
}, null, 2), "utf8");
createBrowserImportFixture(browserImportRoot);
const browserExtensionZip = join(work, "browser-extension.zip");
await createBrowserExtensionZip(join(root, "fixtures", "browser-extension"), browserExtensionZip);

if (!existsSync(electronPath)) throw new Error("Electron is not installed; run npm install first");

const broker = spawn(process.execPath, [join(root, "apps", "broker", "src", "main.ts")], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    EGO_COMPAT_PIPE: pipe,
    EGO_COMPAT_BACKEND: brokerBackend,
    EGO_DESKTOP_CONTROL_TOKEN: desktopControlToken,
    EGO_DESKTOP_AUTOMATION_PIPE: automationPipe,
    EGO_STATE_DB: join(work, "state.db"),
    OPENAI_BASE_URL: fixture.url,
    OPENAI_API_KEY: "desktop-smoke-key",
    EGO_CHAT_MODEL: "desktop-smoke-model",
  },
});

let brokerOutput = "";
let electronOutput = "";
let electron;
broker.stdout.on("data", (chunk) => { brokerOutput += chunk; });
broker.stderr.on("data", (chunk) => { brokerOutput += chunk; });

try {
  await waitForPipe(pipe, 10_000);
  electron = spawn(electronPath, [join(root, "apps", "desktop-shell")], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      EGO_DESKTOP_PIPE: pipe,
      EGO_DESKTOP_CONTROL_TOKEN: desktopControlToken,
      EGO_DESKTOP_AUTOMATION_PIPE: automationPipe,
      EGO_DESKTOP_STATE: join(work, "desktop-tabs.json"),
      EGO_DESKTOP_AGENT_DOWNLOADS: join(work, "agent-downloads"),
      EGO_DESKTOP_USER_DATA: join(work, "electron-user-data"),
      EGO_DESKTOP_SMOKE_RESULT: resultPath,
      EGO_DESKTOP_CAPTURE: capturePath,
      EGO_DESKTOP_SMOKE_ATTACHMENT: textAttachmentPath,
      EGO_DESKTOP_HISTORY_FIXTURE_URL: fixture.url,
      EGO_DESKTOP_EXTENSION_FIXTURE: browserExtensionZip,
      EGO_HOME_BAR_SHORTCUT: "CommandOrControl+Shift+F11",
      EGO_DESKTOP_ONBOARDING: "0",
      EGO_BROWSER_IMPORT_LOCALAPPDATA: browserImportRoot,
      EGO_AGENT_INTEGRATION_DISABLED: "1",
      EGO_SCOPED_REFS: "0",
      ...(brokerBackend === "desktop" ? { EGO_DESKTOP_SMOKE_HOLD_MS: "90000" } : {}),
    },
  });
  electron.stdout.on("data", (chunk) => { electronOutput += chunk; });
  electron.stderr.on("data", (chunk) => { electronOutput += chunk; });
  const desktopStatusPromise = waitForDesktopReady(automationPipe, 30_000);
  const rendererResult = await waitForJsonFile(resultPath, rendererSmokeTimeout);
  if (brokerBackend === "desktop") {
    console.log(JSON.stringify({ rendererComplete: true, rendererError: rendererResult.error, electronExitCode: electron.exitCode }));
  }
  if (rendererResult.error) throw new Error(`Desktop renderer smoke failed: ${rendererResult.error}`);
  const contextPayload = {
    noBrowserChatRequests: fixture.chatRequests.length === 0,
  };
  const sessionLifecycle = brokerBackend === "desktop" ? await runDesktopSessionLifecycle(automationPipe, pipe) : true;
  const fullMcp = brokerBackend === "desktop" ? await runFullDesktopMcp(pipe) : true;
  const exitCode = await waitForExit(electron, 120_000);
  const desktopStatus = await desktopStatusPromise;
  if (!existsSync(resultPath)) throw new Error(`Desktop smoke produced no result (exit ${exitCode})`);
  const result = { ...rendererResult, ...contextPayload };
  if (exitCode !== 0 || result.error || !Object.values(result).every(Boolean)) {
    throw new Error(`Desktop smoke failed: ${JSON.stringify(result)}`);
  }
  if (typeof fullMcp === "object" && !fullMcp.passed) {
    throw new Error(`Desktop full MCP smoke failed: ${JSON.stringify(fullMcp)}`);
  }
  if (typeof sessionLifecycle === "object" && !sessionLifecycle.passed) {
    throw new Error(`Desktop session lifecycle failed: ${JSON.stringify(sessionLifecycle)}`);
  }
  const restore = brokerBackend === "desktop"
    ? await runDesktopRestoreSmoke(rendererResult.firstTarget, rendererResult.smokeTaskId)
    : true;
  if (typeof restore === "object" && !Object.values(restore).every(Boolean)) {
    throw new Error(`Desktop restore smoke failed: ${JSON.stringify(restore)}`);
  }
  console.log(JSON.stringify({ ...result, brokerBackend, directPipe: desktopStatus.ready, sessionLifecycle, fullMcp, restore, capture: capturePath }, null, 2));
} catch (error) {
  if (brokerOutput.trim()) console.error(brokerOutput.trim());
  if (electronOutput.trim()) console.error(electronOutput.trim());
  throw error;
} finally {
  if (electron && electron.exitCode === null) {
    electron.kill();
    await waitForExit(electron, 5_000).catch(() => {});
  }
  broker.kill();
  await waitForExit(broker, 2_000).catch(() => {});
  await fixture.close();
  if (process.env.EGO_KEEP_SMOKE_ARTIFACTS !== "1") await removeSmokeDirectory(work);
}

async function removeSmokeDirectory(path) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 19) {
        console.warn(`Desktop smoke cleanup deferred: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function createBrowserImportFixture(localAppData) {
  const userData = join(localAppData, "Google", "Chrome", "User Data");
  const profile = join(userData, "Default");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(userData, "Local State"), JSON.stringify({
    profile: { info_cache: { Default: { name: "Smoke Profile" } } },
  }));
  writeFileSync(join(profile, "Bookmarks"), JSON.stringify({
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "Bookmarks bar",
        children: [{ type: "url", name: "Imported smoke bookmark", url: "https://import.example/bookmark", date_added: "13380163200000000" }],
      },
    },
  }));
  const history = new DatabaseSync(join(profile, "History"));
  history.exec("CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER)");
  history.prepare("INSERT INTO urls VALUES (?, ?, ?, ?)").run("https://import.example/history", "Imported smoke history", 3, 13_380_163_200_000_000);
  history.close();

  const braveUserData = join(localAppData, "BraveSoftware", "Brave-Browser", "User Data");
  const braveProfile = join(braveUserData, "Profile 1");
  mkdirSync(braveProfile, { recursive: true });
  writeFileSync(join(braveUserData, "Local State"), JSON.stringify({
    profile: { info_cache: { "Profile 1": { name: "Brave Smoke" } } },
  }));
  writeFileSync(join(braveProfile, "Bookmarks"), JSON.stringify({
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "Bookmarks bar",
        children: [{ type: "url", name: "Imported Brave bookmark", url: "https://brave.example/bookmark", date_added: "13380163200000000" }],
      },
    },
  }));
  const braveHistory = new DatabaseSync(join(braveProfile, "History"));
  braveHistory.exec("CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER)");
  braveHistory.prepare("INSERT INTO urls VALUES (?, ?, ?, ?)").run("https://brave.example/history", "Imported Brave history", 2, 13_380_163_200_000_000);
  braveHistory.close();
}

async function createBrowserExtensionZip(sourceDirectory, destination) {
  const source = sourceDirectory.replaceAll("'", "''");
  const target = destination.replaceAll("'", "''");
  const script = "Compress-Archive -Path '" + source + "\\*' -DestinationPath '" + target + "' -Force";
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || "Failed to create extension ZIP: " + code)));
  });
}

async function runDesktopRestoreSmoke(previousTargetId, taskId) {
  const electron = spawn(electronPath, [join(root, "apps", "desktop-shell")], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      EGO_DESKTOP_PIPE: pipe,
      EGO_DESKTOP_CONTROL_TOKEN: desktopControlToken,
      EGO_DESKTOP_AUTOMATION_PIPE: automationPipe,
      EGO_DESKTOP_STATE: join(work, "desktop-tabs.json"),
      EGO_DESKTOP_AGENT_DOWNLOADS: join(work, "agent-downloads"),
      EGO_DESKTOP_USER_DATA: join(work, "electron-user-data"),
      EGO_DESKTOP_RESTORE_RESULT: restoreResultPath,
      EGO_DESKTOP_RESTORE_EXPECTED_TARGET: previousTargetId || "",
      EGO_DESKTOP_RESTORE_EXPECTED_TASK: taskId || "",
      EGO_HOME_BAR_SHORTCUT: "CommandOrControl+Shift+F11",
      EGO_DESKTOP_ONBOARDING: "0",
      EGO_BROWSER_IMPORT_LOCALAPPDATA: browserImportRoot,
      EGO_AGENT_INTEGRATION_DISABLED: "1",
    },
  });
  const result = await waitForJsonFile(restoreResultPath, 30_000);
  const exitCode = await waitForExit(electron, 10_000);
  if (exitCode !== 0 || result.error) throw new Error(`Desktop restore process failed: ${JSON.stringify(result)}`);
  return result;
}

function startFixture() {
  return new Promise((resolve, reject) => {
    const chatRequests = [];
    const server = createServer((request, response) => {
      if (request.url === "/chat/completions" && request.method === "POST") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          let parsed;
          try { parsed = JSON.parse(body); chatRequests.push(parsed); } catch {}
          const userContent = parsed?.messages?.find((message) => message.role === "user")?.content || "";
          if (parsed?.stream) {
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
            const chunks = String(userContent).includes("Desktop stop smoke prompt")
              ? ["Partial streamed response", " that should not finish"]
              : ["Smoke **grounded** ", "answer\n\n```js\nconst streamed = true;\n```"];
            response.write(`data: ${JSON.stringify({ model: "desktop-smoke-model", choices: [{ delta: { content: chunks[0] } }] })}\n\n`);
            const timer = setTimeout(() => {
              if (response.destroyed) return;
              response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[1] } }] })}\n\n`);
              response.end("data: [DONE]\n\n");
            }, String(userContent).includes("Desktop stop smoke prompt") ? 1200 : 35);
            response.once("close", () => clearTimeout(timer));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ model: "desktop-smoke-model", choices: [{ message: { content: "Smoke grounded answer" } }] }));
        });
        return;
      }
      if (request.url === "/api") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          response.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          });
          response.end(JSON.stringify({ ok: true, received: body }));
        });
        return;
      }
      if (request.url === "/login") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(readFileSync(join(root, "fixtures", "browser", "login.html"), "utf8"));
        return;
      }
      if (request.url === "/vm-test") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Violentmonkey smoke</title><h1>Userscript target</h1>");
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        chatRequests,
        close: () => new Promise((closeResolve, closeReject) => server.close((error) => error ? closeReject(error) : closeResolve())),
      });
    });
  });
}

function waitForPipe(pipeName, timeout) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(pipeName);
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error("Timed out waiting for desktop smoke Broker"));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function waitForExit(child, timeout) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Process timed out after ${timeout} ms`));
    }, timeout);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForDesktopReady(pipeName, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const status = await rpcRequest(pipeName, "desktop.status");
      if (status?.ready) return status;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Ego desktop automation pipe");
}

function rpcRequest(pipeName, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(pipeName);
    const id = randomUUID();
    let buffer = "";
    socket.setEncoding("utf8");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Desktop RPC timed out: ${method}`));
    }, 15_000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const response = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (response.id !== id) continue;
        clearTimeout(timer);
        socket.destroy();
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
        return;
      }
    });
  });
}

async function runDesktopSessionLifecycle(pipeName, brokerPipeName) {
  const rpc = await openRpcClient(pipeName);
  const brokerRpc = await openRpcClient(brokerPipeName);
  const agentId = `session-smoke-${suffix}`;
  const space = await brokerRpc.request("space.create", { clientId: agentId, name: "Desktop session smoke" });
  const taskId = space.taskId;
  const send = async (id, method, params = {}, sessionId) => {
    try {
      return JSON.parse(await rpc.request("cdp.send", {
        taskId,
        __egoBridgeToken: desktopControlToken,
        __egoMutation: { clientId: agentId, taskSpaceId: space.id, leaseEpoch: space.leaseEpoch },
        payload: JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      }));
    } catch (error) {
      throw new Error(`Desktop session ${method} #${id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  try {
    const tab = await brokerRpc.request("tab.create", { clientId: agentId, taskSpaceId: space.id, leaseEpoch: space.leaseEpoch, url: "about:blank" });
    const attachedA = await send(1, "Target.attachToTarget", { targetId: tab.targetId, flatten: true });
    const sessionA = attachedA.result?.sessionId;
    const first = await send(2, "Runtime.evaluate", { expression: "21 * 2", returnByValue: true }, sessionA);
    await send(3, "Target.detachFromTarget", { sessionId: sessionA });
    const stale = await send(4, "Runtime.evaluate", { expression: "1", returnByValue: true }, sessionA);
    const attachedB = await send(5, "Target.attachToTarget", { targetId: tab.targetId, flatten: true });
    const sessionB = attachedB.result?.sessionId;
    const second = await send(6, "Runtime.evaluate", { expression: "6 * 7", returnByValue: true }, sessionB);
    const checks = {
      firstSessionWorks: first.result?.result?.value === 42,
      detachedSessionRejected: /Unknown desktop session/.test(stale.error?.message || ""),
      reattachRotatesSession: typeof sessionA === "string" && typeof sessionB === "string" && sessionA !== sessionB,
      secondSessionWorks: second.result?.result?.value === 42,
    };
    return { passed: Object.values(checks).every(Boolean), ...checks };
  } finally {
    rpc.close();
    brokerRpc.close();
  }
}

function openRpcClient(pipeName) {
  return new Promise((resolve, reject) => {
    const socket = connect(pipeName);
    let buffer = "";
    const pending = new Map();
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const response = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (!response.id) continue;
          const entry = pending.get(response.id);
          if (!entry) continue;
          pending.delete(response.id);
          clearTimeout(entry.timer);
          if (response.error) entry.reject(new Error(response.error.message));
          else entry.resolve(response.result);
        }
      });
      resolve({
        request(method, params = {}) {
          const id = randomUUID();
          return new Promise((requestResolve, requestReject) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              requestReject(new Error(`Desktop RPC timed out: ${method}`));
            }, 15_000);
            pending.set(id, { resolve: requestResolve, reject: requestReject, timer });
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
          });
        },
        close() { socket.destroy(); },
      });
    });
  });
}

async function waitForJsonFile(path, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try { return JSON.parse(readFileSync(path, "utf8")); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for desktop renderer smoke result");
}

async function runFullDesktopMcp(pipeName) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
  env.EGO_COMPAT_PIPE = pipeName;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "apps", "ego-mcp-server", "src", "main.ts")],
    cwd: root,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "desktop-backend-smoke", version: "0.1.0" });
  const textOf = (value) => value.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "";
  const taskName = "Desktop backend MCP smoke";
  let taskCreated = false;
  try {
    await client.connect(transport);
    const selected = JSON.parse(textOf(await client.callTool({ name: "ego_task_use", arguments: { task: taskName } })));
    taskCreated = true;
    const status = JSON.parse(textOf(await client.callTool({ name: "ego_status", arguments: {} })));
    const observed = JSON.parse(textOf(await client.callTool({ name: "ego_task_observe", arguments: { task: taskName } })));
    if (observed.space?.id !== selected.id || !Array.isArray(observed.tabs)) throw new Error("MCP read-only observation did not resolve the workspace");
    const html = `<title>MCP smoke</title><input aria-label="Name"><input id="upload" type="file" aria-label="Upload"><span id="upload-result"></span><button id="go">Go</button><button id="alert-button">Alert</button><button id="network-button">Network</button><button id="popup-button">Popup</button><a id="silent-download" download="agent-silent-fixture.txt" href="data:text/plain,agent%20silent%20download">Silent Download</a><a id="download" download="desktop-fixture.txt" href="data:text/plain,desktop%20download%20fixture">Download</a><h1>Ready</h1><script>go.onclick=()=>document.querySelector("h1").textContent=document.querySelector("input").value;document.querySelector("#upload").onchange=(event)=>document.querySelector("#upload-result").textContent=event.target.files[0]?.name||"";document.querySelector("#alert-button").onclick=()=>{window.dialogState="open";window.alert("Desktop dialog");window.dialogState="closed"};document.querySelector("#network-button").onclick=()=>fetch("${fixture.url}/api",{method:"POST",body:"desktop-network"});document.querySelector("#popup-button").onclick=()=>window.open("about:blank")<\/script>`;
    const openedPage = await client.callTool({ name: "ego_open", arguments: { url: `data:text/html,${encodeURIComponent(html)}`, wait: true } });
    if (openedPage.isError) throw new Error(`Desktop fixture navigation failed: ${textOf(openedPage)}`);
    let snapshot = "";
    const snapshotDeadline = Date.now() + 5000;
    while (Date.now() < snapshotDeadline) {
      snapshot = textOf(await client.callTool({ name: "ego_snapshot", arguments: { scope: "viewport", stableLocators: true } }));
      if (/textbox[^\n]*\[@\d+\]/.test(snapshot) && /button "Go" \[@\d+\]/.test(snapshot)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const textbox = snapshot.match(/textbox[^\n]*\[(@\d+)\]/)?.[1];
    const button = snapshot.match(/button "Go" \[(@\d+)\]/)?.[1];
    if (!textbox || !button) throw new Error(`Desktop full MCP refs missing: ${snapshot}`);
    await client.callTool({ name: "ego_fill", arguments: { target: textbox, value: "Full MCP" } });
    await client.callTool({ name: "ego_click", arguments: { target: button, button: "left", clickCount: 1 } });
    const heading = textOf(await client.callTool({ name: "ego_evaluate", arguments: { expression: 'document.querySelector("h1").textContent' } }));
    const pageInfo = JSON.parse(textOf(await client.callTool({ name: "ego_page_info", arguments: {} })));
    const screenshotResult = await client.callTool({ name: "ego_screenshot", arguments: { fullPage: false } });
    const screenshotImage = screenshotResult.content?.find((item) => item.type === "image");
    const screenshotSize = screenshotImage?.data ? pngDimensions(Buffer.from(screenshotImage.data, "base64")) : null;
    const screenshotScale = screenshotSize && pageInfo.w && pageInfo.h
      ? { x: screenshotSize.width / pageInfo.w, y: screenshotSize.height / pageInfo.h }
      : null;
    await client.callTool({
      name: "ego_navigate",
      arguments: { action: "reload", waitUntil: "load", timeout: 10_000 },
    });
    const reloadedTitle = textOf(await client.callTool({ name: "ego_evaluate", arguments: { expression: "document.title" } }));

    const restoredSnapshotDeadline = Date.now() + 5000;
    do {
      snapshot = textOf(await client.callTool({ name: "ego_snapshot", arguments: { scope: "viewport", stableLocators: true } }));
      if (snapshot.includes('button "Alert"')) break;
      if (!/EGO_FRAME_UNAVAILABLE|EGO_REFERENCE_STALE/.test(snapshot)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < restoredSnapshotDeadline);
    const alertButton = snapshot.match(/button "Alert"[^\n]*?(@\d+)/)?.[1];
    if (!alertButton) throw new Error(`Desktop dialog ref missing: ${snapshot}`);
    const alertClickResult = await client.callTool({ name: "ego_click", arguments: { target: alertButton, button: "left", clickCount: 1 } });
    if (alertClickResult.isError) throw new Error(`Desktop alert click failed: ${textOf(alertClickResult)}`);
    let dialog = "";
    const dialogDeadline = Date.now() + 5000;
    while (Date.now() < dialogDeadline) {
      dialog = textOf(await client.callTool({ name: "ego_dialog_status", arguments: {} }));
      if (dialog.includes("Desktop dialog")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!dialog.includes("Desktop dialog")) throw new Error(`Desktop dialog event missing: ${dialog}`);
    const handled = textOf(await client.callTool({ name: "ego_dialog_respond", arguments: { accept: true } }));
    const cleared = textOf(await client.callTool({ name: "ego_dialog_status", arguments: {} }));
    const dialogState = textOf(await client.callTool({ name: "ego_evaluate", arguments: { expression: "window.dialogState" } }));
    snapshot = textOf(await client.callTool({ name: "ego_snapshot", arguments: { scope: "viewport", stableLocators: true } }));
    const uploadInput = snapshot.match(/(?:button|textbox) "Upload" \[(@\d+)\]/)?.[1];
    if (!uploadInput) throw new Error(`Desktop upload ref missing: ${snapshot}`);
    const uploadPath = join(work, "desktop-upload.txt");
    writeFileSync(uploadPath, "desktop upload fixture", "utf8");
    await client.callTool({ name: "ego_upload", arguments: { target: uploadInput, paths: [uploadPath] } });
    const uploadedName = textOf(await client.callTool({ name: "ego_evaluate", arguments: { expression: 'document.querySelector("#upload-result").textContent' } }));
    const silentDownloadLink = snapshot.match(/link "Silent Download" \[(@\d+)\]/)?.[1];
    if (!silentDownloadLink) throw new Error(`Desktop silent download ref missing: ${snapshot}`);
    const silentDownloadPath = join(work, "agent-downloads", "agent-silent-fixture.txt");
    await client.callTool({ name: "ego_click", arguments: { target: silentDownloadLink, button: "left", clickCount: 1 } });
    const silentDownloadDeadline = Date.now() + 5000;
    let silentDownloadContents = "";
    while (Date.now() < silentDownloadDeadline) {
      try {
        if (existsSync(silentDownloadPath)) silentDownloadContents = readFileSync(silentDownloadPath, "utf8");
      } catch {}
      if (silentDownloadContents === "agent silent download") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const downloadLink = snapshot.match(/link "Download" \[(@\d+)\]/)?.[1];
    if (!downloadLink) throw new Error(`Desktop download ref missing: ${snapshot}`);
    const savedDownload = join(work, "desktop-download.txt");
    const download = textOf(await client.callTool({
      name: "ego_download",
      arguments: { target: downloadLink, saveAs: savedDownload, timeout: 10_000 },
    }));
    const downloadContents = existsSync(savedDownload) ? readFileSync(savedDownload, "utf8") : "";
    const downloadsState = JSON.parse(readFileSync(join(work, "desktop-downloads.json"), "utf8"));
    const finalDownloadRecord = downloadsState.downloads?.find((record) => record.state === "completed" && record.savePath === savedDownload);
    const networkButton = snapshot.match(/button "Network" \[(@\d+)\]/)?.[1];
    if (!networkButton) throw new Error(`Desktop network ref missing: ${snapshot}`);
    const network = textOf(await client.callTool({
      name: "ego_click_wait_for_response",
      arguments: {
        target: networkButton,
        url: `${fixture.url}/api`,
        match: "exact",
        method: "POST",
        status: 200,
        timeout: 10_000,
      },
    }));
    const popupButton = snapshot.match(/button "Popup" \[(@\d+)\]/)?.[1];
    if (!popupButton) throw new Error(`Desktop popup ref missing: ${snapshot}`);
    const popup = textOf(await client.callTool({
      name: "ego_click_new_tab",
      arguments: { target: popupButton, timeout: 10_000, select: true },
    }));
    const popupHeading = textOf(await client.callTool({ name: "ego_evaluate", arguments: { expression: "location.href" } }));
    const checks = {
      visibleTaskSynced: status.backend?.visible?.taskId === selected.taskId
        && status.backend?.visible?.taskName === taskName,
      interaction: heading.includes("Full MCP"),
      screenshotCaptured: Boolean(screenshotSize)
        && screenshotScale.x >= 1
        && screenshotScale.x <= 4
        && Math.abs(screenshotScale.x - screenshotScale.y) <= 0.01,
      reloadLoadEvent: reloadedTitle.includes("MCP smoke"),
      dialogOpening: dialog.includes("Desktop dialog"),
      dialogHandled: /handled[^\n]*true/i.test(handled),
      dialogCleared: cleared.trim() === "null",
      dialogResumed: dialogState.includes("closed"),
      uploadCompleted: uploadedName.includes("desktop-upload.txt"),
      agentSilentDownload: silentDownloadContents === "agent silent download",
      downloadCompleted: download.includes("desktop-fixture.txt"),
      downloadSaved: downloadContents === "desktop download fixture",
      downloadCenterPath: finalDownloadRecord?.filename === "desktop-download.txt",
      networkResponse: network.includes('"status": 200') && network.includes("desktop-network"),
      popupCaptured: popup.includes("about:blank"),
      popupSelected: popupHeading.includes("about:blank"),
    };
    return {
      passed: Object.values(checks).every(Boolean),
      ...checks,
      ...checks.screenshotCaptured ? {} : { pageInfo, screenshotSize, screenshotScale },
      ...checks.downloadCompleted && checks.downloadCenterPath ? {} : {
        downloadResult: download,
        downloadRecords: downloadsState.downloads,
        expectedDownloadPath: savedDownload,
      },
      ...checks.agentSilentDownload ? {} : { silentDownloadPath, silentDownloadContents },
      ...checks.popupCaptured && checks.popupSelected ? {} : { popupResult: popup, popupHeadingResult: popupHeading },
    };
  } finally {
    if (taskCreated) {
      await client.callTool({ name: "ego_task_close", arguments: { task: taskName } }).catch(() => {});
    }
    await client.close().catch(() => {});
  }
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
