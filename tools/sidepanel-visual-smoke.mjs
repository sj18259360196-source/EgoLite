import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BrokerPipeServer } from "../apps/broker/src/server.ts";
import { loadCompanionConfig } from "../apps/broker/src/companion-config.ts";
import { BrokerCore, TaskSpaceService } from "@ego-compat/broker-core";
import { CompanionBackend } from "@ego-compat/companion-backend";
import { createEgoRuntime, PipeRuntimeTransport } from "@ego-compat/runtime-adapter";
import { createServer } from "node:http";

const extensionId = "omdijpknicgkhnpadadcggpnbojohpdc";
const edgePath = process.env.EGO_EDGE_PATH ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const extensionPath = resolve("apps/companion-extension");
const outputPath = resolve("apps/companion-extension/sidepanel-smoke.png");
const profilePath = await mkdtemp(join(tmpdir(), "ego-sidepanel-visual-"));
const config = loadCompanionConfig();
const backend = new CompanionBackend(config.pipeName, config.authSecret, config.hostPath);
const broker = new BrokerCore(new TaskSpaceService({ backend: "companion" }), backend);
let capturedChatRequest;
const capturedCodexRequests = [];
const server = new BrokerPipeServer(broker, {
  async send(request) {
    capturedChatRequest = request;
    return { text: `页面总结：${request.prompt}`, model: "visual-fixture" };
  },
}, {
  async send(request) {
    capturedCodexRequests.push(request);
    return {
      text: `Codex 完成：${request.prompt}`,
      model: "Codex fixture",
      threadId: request.threadId || "thread-visual",
      activities: ["已修改：fixture.txt"],
    };
  },
});
const runtimePipe = `\\\\.\\pipe\\ego-sidepanel-runtime-${process.pid}-${Date.now()}`;
let edge;
let transport;
let cdp;
const fixture = await startFixture();

try {
  await backend.start();
  await server.listen(runtimePipe);
  edge = spawn(edgePath, [
    `--user-data-dir=${profilePath}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--disable-default-apps",
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  transport = await PipeRuntimeTransport.connect(runtimePipe);
  const runtime = createEgoRuntime(transport, { clientId: "sidepanel-visual" });
  await runtime.createTaskSpace("Side Panel fixture");
  await runtime.createTab(fixture.url);

  const port = await waitForDevToolsPort(profilePath);
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  cdp = await connectCdp(version.webSocketDebuggerUrl);
  const target = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/sidepanel.html`,
  });
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  }, attached.sessionId);
  await waitForPanel(cdp, attached.sessionId);
  const layout = await cdp.send("Runtime.evaluate", {
    expression: `({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      spaces: document.querySelectorAll('.space').length,
      title: document.querySelector('.space-name')?.textContent,
      ownership: document.querySelector('.ownership')?.textContent
      ,chatVisible: document.querySelector('#chat-view')?.classList.contains('active')
      ,composer: Boolean(document.querySelector('#prompt'))
    })`,
    returnByValue: true,
  }, attached.sessionId);
  assert.equal(layout.result.value.scrollWidth, layout.result.value.clientWidth);
  assert.equal(layout.result.value.spaces, 1);
  assert.equal(layout.result.value.title, "Side Panel fixture");
  assert.equal(layout.result.value.ownership, "Agent 控制");
  assert.equal(layout.result.value.chatVisible, true);
  assert.equal(layout.result.value.composer, true);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('#add-context').click()`,
  }, attached.sessionId);
  await waitForExpression(cdp, attached.sessionId, `document.querySelectorAll('.source-row').length >= 2`);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelectorAll('.source-row input')[1].click()`,
  }, attached.sessionId);
  await waitForExpression(cdp, attached.sessionId, `document.querySelector('.attachment.success') !== null`);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      document.querySelector('#prompt').value = '总结这个页面';
      document.querySelector('#send').click();
    })()`,
  }, attached.sessionId);
  await waitForExpression(cdp, attached.sessionId,
    `document.querySelector('.message.assistant .message-meta')?.textContent === 'visual-fixture'`);
  const chat = await cdp.send("Runtime.evaluate", {
    expression: `({
      attachments: document.querySelectorAll('.attachment.success').length,
      messages: document.querySelectorAll('.message').length,
      answer: document.querySelector('.message.assistant > div')?.textContent,
      model: document.querySelector('.message.assistant .message-meta')?.textContent,
      pickerHidden: document.querySelector('#context-picker')?.hidden,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    })`,
    returnByValue: true,
  }, attached.sessionId);
  assert.equal(chat.result.value.attachments, 1);
  assert.equal(chat.result.value.messages, 2);
  assert.equal(chat.result.value.answer, "页面总结：总结这个页面");
  assert.equal(chat.result.value.model, "visual-fixture");
  assert.equal(chat.result.value.pickerHidden, true);
  assert.equal(capturedChatRequest.prompt, "总结这个页面");
  assert.match(capturedChatRequest.context, /Chat visual fixture/);
  assert.equal(chat.result.value.scrollWidth, chat.result.value.clientWidth);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      document.querySelector('.mode-tab[data-mode="codex"]').click();
      document.querySelector('#prompt').value = '执行第一次修改';
      document.querySelector('#send').click();
    })()`,
  }, attached.sessionId);
  await waitForExpression(cdp, attached.sessionId,
    `document.querySelectorAll('.message.assistant').length === 2 && document.querySelectorAll('.message.assistant')[1].textContent.includes('Codex 完成')`);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      document.querySelector('#prompt').value = '继续检查';
      document.querySelector('#send').click();
    })()`,
  }, attached.sessionId);
  await waitForExpression(cdp, attached.sessionId,
    `document.querySelectorAll('.message.assistant').length === 3 && document.querySelectorAll('.message.assistant')[2].textContent.includes('Codex 完成')`);
  assert.equal(capturedCodexRequests.length, 2);
  assert.equal(capturedCodexRequests[0].threadId, undefined);
  assert.equal(capturedCodexRequests[1].threadId, "thread-visual");
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" }, attached.sessionId);
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(outputPath, Buffer.from(screenshot.data, "base64")),
  );
  console.log(JSON.stringify({ ok: true, outputPath, layout: layout.result.value }, null, 2));
} finally {
  cdp?.close();
  await transport?.close().catch(() => {});
  await server.close().catch(() => {});
  await fixture.close().catch(() => {});
  if (edge && !edge.killed) edge.kill();
  await rm(profilePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function waitForExpression(cdp, sessionId, expression) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
    if (response.result?.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function startFixture() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Chat visual fixture</title><main><h1>Chat visual fixture</h1><p>Context body</p></main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function waitForDevToolsPort(profile) {
  const file = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return Number((await readFile(file, "utf8")).split(/\r?\n/)[0]); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Edge DevTools port");
}

async function waitForPanel(cdp, sessionId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState === 'complete' && document.querySelectorAll('.space').length === 1",
      returnByValue: true,
    }, sessionId);
    if (response.result?.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Side Panel state");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() { socket.close(); },
  };
}
