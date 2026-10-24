import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BrokerPipeServer } from "../apps/broker/src/server.ts";
import { loadCompanionConfig } from "../apps/broker/src/companion-config.ts";
import { BrokerCore, TaskSpaceService } from "@ego-compat/broker-core";
import { CompanionBackend } from "@ego-compat/companion-backend";
import { createEgoRuntime, PipeRuntimeTransport } from "@ego-compat/runtime-adapter";

const edgePath = process.env.EGO_EDGE_PATH ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const extensionPath = resolve("apps/companion-extension");
const profilePath = await mkdtemp(join(tmpdir(), "ego-companion-edge-"));
const companionConfig = loadCompanionConfig();
const runtimePipe = `\\\\.\\pipe\\ego-companion-runtime-${process.pid}-${Date.now()}`;
const fixture = await startFixture();
const backend = new CompanionBackend(
  companionConfig.pipeName,
  companionConfig.authSecret,
  companionConfig.hostPath,
);
const broker = new BrokerCore(new TaskSpaceService({ backend: "companion" }), backend);
const server = new BrokerPipeServer(broker);
let edge;
let transport;

try {
  await backend.start();
  await server.listen(runtimePipe);
  edge = spawn(edgePath, [
    `--user-data-dir=${profilePath}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--disable-default-apps",
    "about:blank",
  ], {
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  });

  transport = await PipeRuntimeTransport.connect(runtimePipe);
  const runtime = createEgoRuntime(transport, { clientId: "companion-real-smoke" });
  const space = await runtime.createTaskSpace("Companion real smoke");
  const tab = await runtime.createTab(fixture.url);
  const sessionId = await attach(runtime, tab.targetId);
  await waitForExpression(runtime, sessionId, 'document.title === "Companion fixture"');

  const selected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for selection event")), 5_000);
    runtime.onTextSelectionChanged = (selection) => {
      clearTimeout(timer);
      resolve(selection);
    };
  });
  await sendCdp(runtime, {
    id: 2,
    method: "Runtime.evaluate",
    sessionId,
    params: {
      expression: `(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector("#selectable"));
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      })()`,
    },
  });
  assert.equal((await selected).text, "Selectable companion text");

  const snapshot = await runtime.snapshot({ includeActionMarks: true });
  assert.match(snapshot.content, /Companion fixture/);
  assert.ok(snapshot.refs.some((ref) => ref.role === "button"));

  const result = await sendCdp(runtime, {
    id: 3,
    method: "Runtime.evaluate",
    sessionId,
    params: {
      expression: 'document.querySelector("#result").textContent = "Companion works"; document.querySelector("#result").textContent',
      returnByValue: true,
    },
  });
  assert.equal(result.result.result.value, "Companion works");

  const tabsBeforePopup = new Set((await runtime.listTabs()).tabs.map((candidate) => candidate.targetId));
  await sendCdp(runtime, {
    id: 31,
    method: "Runtime.evaluate",
    sessionId,
    params: {
      expression: 'window.open("/popup", "ego-companion-popup")',
      returnByValue: true,
      userGesture: true,
    },
  });
  const popup = await waitForNewTab(runtime, tabsBeforePopup);
  const popupSessionId = await attach(runtime, popup.targetId, 32);
  await waitForExpression(runtime, popupSessionId, 'document.title === "Companion popup"');

  await runtime.handOffTaskSpace();
  const listed = await runtime.listTaskSpaces();
  assert.equal(listed.taskSpaces.find((candidate) => candidate.id === space.id)?.ownership, "agentDelegatedToUser");
  const error = await sendCdpError(runtime, {
    id: 4,
    method: "Runtime.evaluate",
    sessionId,
    params: { expression: "1" },
  });
  assert.equal(error.code, "EGO_TASK_SPACE_USER_IN_CONTROL");

  broker.authorizeTakeover(space.id);
  await runtime.takeOverTaskSpace();
  const staleSession = await sendCdp(runtime, {
    id: 5,
    method: "Runtime.evaluate",
    sessionId,
    params: { expression: "1", returnByValue: true },
  });
  assert.match(staleSession.error?.message || "", /outside the selected task/);
  const resumedSessionId = await attach(runtime, tab.targetId, 6);
  const resumed = await sendCdp(runtime, {
    id: 7,
    method: "Runtime.evaluate",
    sessionId: resumedSessionId,
    params: { expression: "6 * 7", returnByValue: true },
  });
  assert.equal(resumed.result.result.value, 42);

  console.log(JSON.stringify({
    ok: true,
    taskId: space.taskId,
    targetId: tab.targetId,
    snapshotRefs: snapshot.refs.length,
    handoffError: error.code,
    staleSessionRejected: true,
    resumed: true,
    selectionEvent: true,
    popupInherited: true,
  }, null, 2));
} finally {
  await transport?.close().catch(() => {});
  await server.close().catch(() => {});
  if (edge && !edge.killed) edge.kill();
  await fixture.close().catch(() => {});
  await rm(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function sendCdp(runtime, payload) {
  return new Promise((resolve, reject) => {
    runtime.onCDPMessage = (message) => {
      const response = JSON.parse(message);
      if (response.id === payload.id) resolve(response);
    };
    runtime.onSendCDPMessageError = (message, errorCode) =>
      reject(Object.assign(new Error(message), { error_code: errorCode }));
    runtime.sendCDPMessage(JSON.stringify(payload));
  });
}

function sendCdpError(runtime, payload) {
  return new Promise((resolve) => {
    runtime.onCDPMessage = () => {};
    runtime.onSendCDPMessageError = (message, code) => resolve({ message, code });
    runtime.sendCDPMessage(JSON.stringify(payload));
  });
}

async function attach(runtime, targetId, id = 1) {
  const response = await sendCdp(runtime, {
    id,
    method: "Target.attachToTarget",
    params: { targetId, flatten: true },
  });
  return response.result.sessionId;
}

async function waitForExpression(runtime, sessionId, expression) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const id = Date.now();
    const response = await sendCdp(runtime, {
      id,
      method: "Runtime.evaluate",
      sessionId,
      params: { expression, returnByValue: true },
    });
    if (response.result?.result?.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Companion fixture");
}

async function waitForNewTab(runtime, previous) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const popup = (await runtime.listTabs()).tabs.find((tab) => !previous.has(tab.targetId));
    if (popup) return popup;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for inherited Companion popup");
}

async function startFixture() {
  const server = createServer((request, response) => {
    if (request.url === "/popup") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Companion popup</title><h1>Popup content</h1>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>Companion fixture</title><button id="run">Run</button><p id="selectable">Selectable companion text</p><p id="result"></p>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
