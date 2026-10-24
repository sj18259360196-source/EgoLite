import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BrokerPipeServer } from "../apps/broker/src/server.ts";
import { loadCompanionConfig } from "../apps/broker/src/companion-config.ts";
import { SqliteTaskSpaceStore } from "../apps/broker/src/sqlite-task-store.ts";
import { BrokerCore, TaskSpaceService } from "@ego-compat/broker-core";
import { CompanionBackend } from "@ego-compat/companion-backend";
import { createEgoRuntime, PipeRuntimeTransport } from "@ego-compat/runtime-adapter";

const edgePath = process.env.EGO_EDGE_PATH ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const extensionPath = resolve("apps/companion-extension");
const directory = await mkdtemp(join(tmpdir(), "ego-companion-restart-"));
const profilePath = join(directory, "profile");
const statePath = join(directory, "state.db");
const config = loadCompanionConfig();
const fixture = await startFixture();
let edge;
let first;
let second;

try {
  first = await startBroker("first", statePath, config);
  edge = spawn(edgePath, [
    `--user-data-dir=${profilePath}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--disable-default-apps",
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  const created = await first.runtime.createTaskSpace("Restart fixture");
  const tab = await first.runtime.createTab(fixture.url);
  const firstSession = await attach(first.runtime, tab.targetId, 1);
  await waitForExpression(first.runtime, firstSession, 'document.title === "Restart fixture"');

  await first.close();
  first = undefined;

  second = await startBroker("second", statePath, config, true);
  const restored = (await second.runtime.listTaskSpaces()).taskSpaces.find(
    (space) => space.taskId === created.taskId,
  );
  assert.equal(restored?.ownership, "user");
  await assert.rejects(
    () => second.runtime.useTaskSpace(created.id),
    (error) => error?.error_code === "EGO_TASK_SPACE_INACTIVE",
  );

  await second.runtime.claimTaskSpace(created.id);
  const tabs = await waitForTabs(second.runtime);
  assert.ok(tabs.some((candidate) => candidate.targetId === tab.targetId));
  const targetsBeforeAttach = await sendCdp(second.runtime, {
    id: 2,
    method: "Target.getTargets",
  });
  const restoredTarget = targetsBeforeAttach.result.targetInfos.find(
    (candidate) => candidate.targetId === tab.targetId,
  );
  assert.equal(restoredTarget.attached, false);

  const resumedSession = await attach(second.runtime, tab.targetId, 3);
  const resumed = await sendCdp(second.runtime, {
    id: 4,
    method: "Runtime.evaluate",
    sessionId: resumedSession,
    params: { expression: "21 * 2", returnByValue: true },
  });
  assert.equal(resumed.result.result.value, 42);

  console.log(JSON.stringify({
    ok: true,
    taskId: created.taskId,
    restoredOwnership: restored.ownership,
    restoredWithoutAttach: true,
    tabReconciled: true,
    resumed: true,
  }, null, 2));
} finally {
  await first?.close().catch(() => {});
  await second?.close().catch(() => {});
  if (edge && !edge.killed) edge.kill();
  await fixture.close().catch(() => {});
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function startBroker(label, statePath, config, recover = false) {
  const backend = new CompanionBackend(config.pipeName, config.authSecret, config.hostPath);
  const store = new SqliteTaskSpaceStore(statePath);
  const spaces = new TaskSpaceService({ backend: "companion", store });
  if (recover) spaces.recoverAfterRestart();
  const broker = new BrokerCore(spaces, backend);
  const server = new BrokerPipeServer(broker);
  const pipe = `\\\\.\\pipe\\ego-companion-restart-${label}-${process.pid}-${Date.now()}`;
  await backend.start();
  await server.listen(pipe);
  const transport = await PipeRuntimeTransport.connect(pipe);
  return {
    runtime: createEgoRuntime(transport, { clientId: `restart-${label}` }),
    async close() {
      await transport.close();
      await server.close();
      store.close();
    },
  };
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

async function attach(runtime, targetId, id) {
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
    const response = await sendCdp(runtime, {
      id: Date.now(),
      method: "Runtime.evaluate",
      sessionId,
      params: { expression, returnByValue: true },
    });
    if (response.result?.result?.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for restart fixture");
}

async function waitForTabs(runtime) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const tabs = (await runtime.listTabs()).tabs;
    if (tabs.length) return tabs;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for restored Companion tabs");
}

async function startFixture() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Restart fixture</title><h1>Restart fixture</h1>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
