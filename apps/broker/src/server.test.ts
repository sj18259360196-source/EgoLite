import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BrokerCore,
  FakeBrowserBackend,
  type MutationContext,
  TaskSpaceService,
  type SnapshotRequestContext,
} from "@ego-compat/broker-core";
import { ManagedEdgeBackend } from "@ego-compat/managed-edge";
import type {
  CdpRequestContext,
  ReferenceActionBindRequest,
  ReferenceActionGroupBindRequest,
  ReferenceActionWire,
} from "@ego-compat/protocol";
import {
  buildTabGroupAttachment,
  collectionItemsToContentBlocks,
  createEgoRuntime,
  PipeRuntimeTransport,
  PROTOCOL_VERSION,
  SCOPED_REFS_CAPABILITY,
  tabAttachmentsToContentBlocks,
} from "@ego-compat/runtime-adapter";

import { BrokerPipeServer } from "./server.ts";
import type { CodexAgentProvider } from "./codex-agent.ts";

const DESKTOP_CONTROL_TOKEN = "desktop-control-test-token-32-bytes-minimum";

test("targeted CDP events reach only their recipient while legacy events retain task fanout", async () => {
  const pipeName = `\\\\.\\pipe\\ego-targeted-cdp-${process.pid}-${Date.now()}`;
  let emitCdp: ((taskId: string, payload: string, clientId?: string) => void) | undefined;
  class EventBackend extends FakeBrowserBackend {
    onCdpMessage(listener: (taskId: string, payload: string, clientId?: string) => void) {
      emitCdp = listener;
      return () => { emitCdp = undefined; };
    }
  }
  const server = new BrokerPipeServer(new BrokerCore(new TaskSpaceService(), new EventBackend()));
  await server.listen(pipeName);
  const first = await PipeRuntimeTransport.connect(pipeName);
  const second = await PipeRuntimeTransport.connect(pipeName);
  const firstEvents: Array<{ method: string; params: unknown }> = [];
  const secondEvents: Array<{ method: string; params: unknown }> = [];
  first.onEvent((method, params) => firstEvents.push({ method, params }));
  second.onEvent((method, params) => secondEvents.push({ method, params }));
  try {
    await first.negotiateHello({ protocolVersion: PROTOCOL_VERSION, clientId: "recipient-a", pid: process.pid });
    await second.negotiateHello({ protocolVersion: PROTOCOL_VERSION, clientId: "recipient-b", pid: process.pid });
    const firstRuntime = createEgoRuntime(first, { clientId: "recipient-a" });
    const secondRuntime = createEgoRuntime(second, { clientId: "recipient-b" });
    const space = await firstRuntime.createTaskSpace("targeted-events");
    await firstRuntime.createTab("https://events.test");
    await secondRuntime.createTaskSpace("other-events");

    emitCdp?.(space.taskId, "target-only", "recipient-a");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(firstEvents.some((event) => event.method === "cdp.message" && event.params === "target-only"), true);
    assert.equal(secondEvents.some((event) => event.method === "cdp.message" && event.params === "target-only"), false);

    emitCdp?.(space.taskId, "legacy-fanout");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(firstEvents.some((event) => event.method === "cdp.message" && event.params === "legacy-fanout"), true);
    assert.equal(secondEvents.some((event) => event.method === "cdp.message" && event.params === "legacy-fanout"), false);
  } finally {
    await first.close();
    await second.close();
    await server.close();
  }
});

test("scoped snapshot refs require per-socket hello negotiation and backend support", async () => {
  const pipeName = `\\\\.\\pipe\\ego-scoped-ref-negotiation-${process.pid}-${Date.now()}`;
  const contexts: Array<SnapshotRequestContext | undefined> = [];
  const cdpContexts: Array<CdpRequestContext | undefined> = [];
  const released: ReferenceActionWire[] = [];
  const groupBinds: Array<{
    taskId: string;
    request: ReferenceActionGroupBindRequest;
    mutation: MutationContext;
  }> = [];
  class CapableBackend extends FakeBrowserBackend {
    override status() {
      return {
        kind: "desktop" as const,
        ready: true,
        connected: true,
        capabilities: [SCOPED_REFS_CAPABILITY],
        referenceActionMaxLifetimeMs: 300_000,
      };
    }

    override async snapshot(taskId: string, options = {}, targetId?: string, context?: SnapshotRequestContext) {
      contexts.push(context);
      return super.snapshot(taskId, options, targetId);
    }

    async bindReferenceAction(_taskId: string, request: ReferenceActionBindRequest) {
      return {
        version: "scoped-v1" as const,
        token: "bound-token",
        expiresAt: Date.now() + 10_000,
        runtimeId: request.ref.runtimeId,
        pageId: request.expectedScope.pageId,
        frameId: "frame-1",
        documentId: "document-1",
        documentEpoch: 1,
        backendNodeId: 91,
        sessionId: "public-child-alias",
      };
    }

    async bindReferenceActionGroup(
      taskId: string,
      request: ReferenceActionGroupBindRequest,
      mutation: MutationContext,
    ) {
      groupBinds.push({ taskId, request, mutation });
      return {
        kind: "drag" as const,
        version: "scoped-v1" as const,
        token: "drag-token",
        expiresAt: request.deadlineAt ?? Date.now() + 10_000,
        runtimeId: request.source.runtimeId,
        pageId: request.expectedScope.pageId,
        frameId: "frame-1",
        documentId: "document-1",
        documentEpoch: 1,
        sessionId: "public-child-alias",
        source: { refId: request.source.refId, backendNodeId: 101 },
        target: { refId: request.target.refId, backendNodeId: 102 },
      };
    }

    async releaseReferenceAction(_taskId: string, action: ReferenceActionWire) {
      released.push(action);
    }

    override async sendCdp(taskId: string, payload: string, mutation?: any, context?: CdpRequestContext) {
      cdpContexts.push(context);
      return super.sendCdp(taskId, payload);
    }
  }
  const server = new BrokerPipeServer(new BrokerCore(new TaskSpaceService(), new CapableBackend()));
  await server.listen(pipeName);
  const scoped = await PipeRuntimeTransport.connect(pipeName);
  const legacy = await PipeRuntimeTransport.connect(pipeName);
  try {
    const hello = await scoped.negotiateHello({
      protocolVersion: PROTOCOL_VERSION,
      clientId: "scoped-client",
      pid: process.pid,
      capabilities: [SCOPED_REFS_CAPABILITY],
    });
    assert.ok(hello.capabilities.includes("desktop-backend"));
    assert.ok(hello.capabilities.includes(SCOPED_REFS_CAPABILITY));
    assert.equal(hello.referenceActionMaxLifetimeMs, 300_000);
    const scopedRuntime = createEgoRuntime(scoped, {
      clientId: "scoped-client",
      capabilities: () => scoped.negotiatedCapabilities,
    });
    const scopedSpace = await scopedRuntime.createTaskSpace("scoped");
    const scopedTab = await scopedRuntime.createTab("https://scoped.test");
    await scopedRuntime.snapshot();
    await scopedRuntime.observeTaskSpace?.(scopedSpace.id, scopedTab.targetId);
    const binding = await scopedRuntime.bindReferenceAction?.({
      ref: { refId: 7, runtimeId: "runtime-1" },
      expectedScope: { pageId: scopedTab.targetId },
    });
    assert.ok(binding);
    const cdpResponse = new Promise<string>((resolve) => {
      scopedRuntime.onCDPMessage = resolve;
    });
    scopedRuntime.sendCDPMessage(JSON.stringify({ id: 41, method: "DOM.getBoxModel", params: { backendNodeId: 91 } }), binding);
    await cdpResponse;
    await scopedRuntime.releaseReferenceAction?.(binding);
    const groupRequest = {
      kind: "drag" as const,
      source: { refId: 11, runtimeId: "runtime-1" },
      target: { refId: 12, runtimeId: "runtime-1" },
      expectedScope: { pageId: scopedTab.targetId },
      deadlineAt: Date.now() + 30_000,
    };
    const groupBinding = await scopedRuntime.bindReferenceActionGroup?.(groupRequest);
    assert.equal(groupBinding?.token, "drag-token");
    await scopedRuntime.releaseReferenceAction?.(groupBinding!);
    assert.equal(groupBinds.length, 1);
    assert.deepEqual(groupBinds[0]?.request, groupRequest);
    assert.equal(groupBinds[0]?.mutation.clientId, "scoped-client");
    assert.equal(groupBinds[0]?.mutation.taskSpaceId, scopedSpace.id);
    assert.equal(typeof groupBinds[0]?.mutation.leaseEpoch, "number");

    const groupMutation = groupBinds[0]!.mutation;
    for (const malformed of [
      { kind: "drag", source: groupRequest.source, expectedScope: groupRequest.expectedScope },
      { ...groupRequest, target: { refId: 12, runtimeId: "runtime-2" } },
      { ...groupRequest, constraints: { sameFrame: false } },
    ]) {
      await assert.rejects(
        scoped.request("ref.bind", {
          clientId: "scoped-client",
          taskSpaceId: groupMutation.taskSpaceId,
          leaseEpoch: groupMutation.leaseEpoch,
          request: malformed,
        }),
        (error: any) => error?.error_code === "EGO_INVALID_ARGUMENT",
      );
    }
    assert.equal(groupBinds.length, 1);

    await legacy.request("agent.register", { clientId: "legacy-client" });
    const legacyRuntime = createEgoRuntime(legacy, { clientId: "legacy-client" });
    const legacySpace = await legacyRuntime.createTaskSpace("legacy") as any;
    await legacyRuntime.createTab("https://legacy.test");
    await legacyRuntime.snapshot();

    assert.deepEqual(contexts.map((context) => context?.refFormat), [
      "scoped-v1",
      "scoped-v1",
      "native-v0",
    ]);
    assert.deepEqual(contexts[0], {
      clientId: "scoped-client",
      taskSpaceId: scopedSpace.id,
      leaseEpoch: contexts[0]?.leaseEpoch,
      refFormat: "scoped-v1",
    });
    assert.deepEqual(contexts[1], {
      clientId: "scoped-client",
      taskSpaceId: scopedSpace.id,
      refFormat: "scoped-v1",
    });
    assert.deepEqual(cdpContexts[0], {
      clientId: "scoped-client",
      refFormat: "scoped-v1",
      refAction: {
        version: "scoped-v1",
        runtimeId: "runtime-1",
        token: "bound-token",
      },
    });
    assert.deepEqual(released, [{
      version: "scoped-v1",
      runtimeId: "runtime-1",
      token: "bound-token",
    }, {
      version: "scoped-v1",
      runtimeId: "runtime-1",
      token: "drag-token",
    }]);

    await assert.rejects(
      legacy.request("snapshot.capture", {
        clientId: "legacy-client",
        taskSpaceId: 2,
        leaseEpoch: 1,
        refFormat: "scoped-v1",
      }),
      /not negotiated/,
    );
    await assert.rejects(
      legacy.request("ref.bind", {
        clientId: "legacy-client",
        taskSpaceId: legacySpace.id,
        leaseEpoch: legacySpace.leaseEpoch,
        request: groupRequest,
      }),
      /not negotiated/,
    );
  } finally {
    await scoped.close();
    await legacy.close();
    await server.close();
  }
});

test("runtime and broker communicate over a real Windows named pipe", async () => {
  const pipeName = `\\\\.\\pipe\\ego-compat-test-${process.pid}-${Date.now()}`;
  const server = new BrokerPipeServer();
  await server.listen(pipeName);
  const transport = await PipeRuntimeTransport.connect(pipeName);

  try {
    const runtime = createEgoRuntime(transport, { clientId: "agent-pipe" });
    const space = await runtime.createTaskSpace("pipe-poc");
    await runtime.useTaskSpace(space.id);
    const tab = await runtime.createTab("https://example.test/pipe");
    const snapshot = await runtime.snapshot();

    assert.equal(space.name, "pipe-poc");
    assert.equal(tab.url, "https://example.test/pipe");
    assert.match(snapshot.content, /example\.test\/pipe/);
  } finally {
    await transport.close();
    await server.close();
  }
});

test("broker disconnect rejects pending CDP through the native error callback", async () => {
  const pipeName = `\\\\.\\pipe\\ego-compat-disconnect-${process.pid}-${Date.now()}`;
  const backend = new (class {
    async createSpace() {}
    async closeSpace() {}
    async listTabs() { return []; }
    async createTab(): Promise<never> { throw new Error("not used"); }
    async snapshot() { return { content: "document", refs: [] }; }
    async sendCdp() { return new Promise<string>(() => {}); }
  })();
  const broker = new BrokerCore(new TaskSpaceService(), backend);
  const server = new BrokerPipeServer(broker);
  await server.listen(pipeName);
  const transport = await PipeRuntimeTransport.connect(pipeName);
  const runtime = createEgoRuntime(transport, { clientId: "disconnect-agent" });

  await runtime.createTaskSpace("disconnect-poc");
  const callback = new Promise<{ message: string; code: string }>((resolve) => {
    runtime.onSendCDPMessageError = (message, code) => resolve({ message, code });
  });
  runtime.sendCDPMessage(JSON.stringify({ id: 1, method: "Runtime.enable" }));
  await new Promise((resolve) => setImmediate(resolve));
  await server.close();

  assert.deepEqual(await callback, {
    message: "Broker pipe closed",
    code: "EGO_CDP_SEND_FAILED",
  });
  await transport.close();
});

test("broker streams Codex events, rejects concurrent thread turns, and cancels the owner stream", async () => {
  const pipeName = `\\\\.\\pipe\\ego-compat-codex-stream-${process.pid}-${Date.now()}`;
  let observedSignal: AbortSignal | undefined;
  let observedAttachments: unknown;
  const provider: CodexAgentProvider = {
    async send() {
      throw new Error("stream expected");
    },
    async stream(request, options) {
      observedSignal = options.signal;
      observedAttachments = request.attachments;
      options.onEvent({ type: "thread", threadId: request.threadId ?? "thread-new" });
      options.onEvent({
        type: "activity",
        phase: "started",
        activity: { id: "cmd", type: "command_execution", status: "in_progress", title: "npm test" },
      });
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    },
  };
  const server = new BrokerPipeServer(
    undefined,
    undefined,
    provider,
    undefined,
    { desktopControlToken: DESKTOP_CONTROL_TOKEN },
  );
  await server.listen(pipeName);
  const transport = await PipeRuntimeTransport.connect(pipeName);
  const events: Array<{ method: string; params: any }> = [];
  transport.onEvent((method, params) => events.push({ method, params }));

  try {
    await transport.request("agent.register", {
      clientId: "desktop-test",
      clientKind: "desktop-ui",
      displayName: "Desktop Test",
      controlToken: DESKTOP_CONTROL_TOKEN,
    });
    const started = await transport.request<{ requestId: string }>("codex.stream.start", {
      clientId: "desktop-test",
      requestId: "request-1",
      taskId: "task-1",
      prompt: "Keep running",
      threadId: "thread-busy",
      attachments: [{ kind: "image", id: "image-1", name: "screen.png", mimeType: "image/png", size: 3, source: "page-screenshot", dataBase64: "YWJj" }],
    });
    assert.equal(started.requestId, "request-1");
    await waitFor(() => events.some((event) => event.method === "codex.stream.event"));
    assert.deepEqual(
      events.find((event) => event.method === "codex.stream.event")?.params.event,
      { type: "thread", threadId: "thread-busy" },
    );
    assert.deepEqual(observedAttachments, [{ kind: "image", id: "image-1", name: "screen.png", mimeType: "image/png", size: 3, source: "page-screenshot", dataBase64: "YWJj" }]);
    await assert.rejects(
      transport.request("codex.stream.start", {
        clientId: "desktop-test",
        requestId: "request-text",
        taskId: "task-1",
        prompt: "Text attachment",
        attachments: [{ kind: "text", id: "text-1", name: "notes.txt", mimeType: "text/plain", size: 4, source: "file", text: "test" }],
      }),
      /image attachments only/,
    );
    await assert.rejects(
      transport.request("codex.stream.start", {
        clientId: "desktop-test",
        requestId: "request-2",
        taskId: "task-1",
        prompt: "Overlap",
        threadId: "thread-busy",
      }),
      /already has a running turn/,
    );
    assert.deepEqual(
      await transport.request("codex.stream.cancel", { clientId: "desktop-test", requestId: "request-1" }),
      { cancelled: true },
    );
    await waitFor(() => events.some((event) => event.method === "codex.stream.cancelled"));
    assert.equal(observedSignal?.aborted, true);
    assert.equal(events.some((event) => event.method === "codex.stream.complete"), false);
  } finally {
    await transport.close();
    await server.close();
  }
});

test(
  "runtime reaches a real page through named pipe, broker, and managed Edge",
  { timeout: 30_000 },
  async (t) => {
    const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    try {
      await readFile(edgePath);
    } catch {
      t.skip("Microsoft Edge is not installed");
      return;
    }

    const profilePath = await mkdtemp(join(tmpdir(), "ego-broker-edge-test-"));
    const fixture = await startFixtureServer();
    const managed = new ManagedEdgeBackend({ executablePath: edgePath, profilePath, headless: true });
    const broker = new BrokerCore(new TaskSpaceService({ backend: "managed" }), managed);
    const pipeName = `\\\\.\\pipe\\ego-compat-managed-${process.pid}-${Date.now()}`;
    const server = new BrokerPipeServer(broker);
    await server.listen(pipeName);
    const transport = await PipeRuntimeTransport.connect(pipeName);
    let chatTransport: PipeRuntimeTransport | undefined;

    try {
      const runtime = createEgoRuntime(transport, { clientId: "agent-managed" });
      const createdSpace = await runtime.createTaskSpace("managed-poc");
      const tab = await runtime.createTab(fixture.url);
      const secondTab = await runtime.createTab(fixture.secondUrl);
      const sessionId = await attach(runtime, tab.targetId);
      await waitForRuntimeExpression(
        runtime,
        sessionId,
        'document.readyState === "complete" && Boolean(document.querySelector("#task-form"))',
      );
      await sendRuntimeCdp(runtime, {
        id: 2,
        method: "Target.activateTarget",
        params: { targetId: tab.targetId },
      });
      const snapshot = await runtime.snapshot({ includeActionMarks: true });
      const allTabs = await runtime.getAllTabs();
      const tabGroups = await runtime.getTabGroups();
      const page = await runtime.getAIPageContent(tab, { includeActionMarks: true });
      const secondPage = await runtime.getAIPageContent(secondTab);
      const contextTabs = allTabs.filter(
        (item) => item.id === tab.targetId || item.id === secondTab.targetId,
      );
      const groupAttachment = await buildTabGroupAttachment(runtime, {
        id: "managed-e2e",
        title: "Managed research",
        color: "blue",
        tabs: contextTabs,
      }, { retryDelayMs: 0 });
      const contextBlock = tabAttachmentsToContentBlocks([groupAttachment])[0];
      chatTransport = await PipeRuntimeTransport.connect(pipeName);
      const chatRuntime = createEgoRuntime(chatTransport, { clientId: "standalone-chat" });
      const chatTabs = await chatRuntime.getAllTabs();
      const chatPage = await chatRuntime.getAIPageContent(
        chatTabs.find((item) => item.id === secondTab.targetId)!,
      );
      assert.equal(
        await chatRuntime.saveTextToCollections("Second page finding", fixture.secondUrl),
        true,
      );
      const savedSelections = await chatRuntime.listCollections("finding");
      const selectionBlock = collectionItemsToContentBlocks(savedSelections)[0];
      const changedTab = new Promise<{ id: string; active: boolean }>((resolve) => {
        chatRuntime.onActiveTabChanged = resolve;
      });
      await sendRuntimeCdp(runtime, {
        id: 3,
        method: "Target.activateTarget",
        params: { targetId: secondTab.targetId },
      });

      assert.match(snapshot.content, /Task fixture/);
      assert.ok(snapshot.refs.length >= 2);
      assert.equal(allTabs.some((item) => item.id === tab.targetId), true);
      assert.equal(tabGroups[0]?.title, "managed-poc");
      assert.equal(tabGroups[0]?.tabs.length, 2);
      assert.equal(page?.url, fixture.url);
      assert.match(page?.content ?? "", /Task fixture/);
      assert.ok((page?.rootNode.children.length ?? 0) > 0);
      assert.equal(secondPage?.url, fixture.secondUrl);
      assert.match(secondPage?.content ?? "", /Second tab content/);
      assert.doesNotMatch(secondPage?.content ?? "", /Task fixture/);
      assert.equal(groupAttachment.status, "success");
      assert.equal(groupAttachment.tabCount, 2);
      assert.match(contextBlock?.content ?? "", /<context-group title="Managed research"/);
      assert.match(contextBlock?.content ?? "", /Task fixture/);
      assert.match(contextBlock?.content ?? "", /Second tab content/);
      assert.match(contextBlock?.content ?? "", new RegExp(escapeRegExp(fixture.url)));
      assert.match(contextBlock?.content ?? "", new RegExp(escapeRegExp(fixture.secondUrl)));
      assert.equal(chatTabs.length, 2);
      assert.match(chatPage?.content ?? "", /Second tab content/);
      assert.equal(savedSelections[0]?.pageTitle, "Second page");
      assert.equal(savedSelections[0]?.sourceUrl, fixture.secondUrl);
      assert.match(selectionBlock?.content ?? "", /type="selected-text"/);
      assert.match(selectionBlock?.content ?? "", /Second page finding/);
      const receivedTab = await changedTab;
      assert.equal(receivedTab.id, secondTab.targetId);
      assert.equal(receivedTab.active, true);
      await assert.rejects(chatRuntime.openUrlInNewTab(fixture.thirdUrl, createdSpace.taskId), /desktop UI/);
      await assert.rejects(chatRuntime.activateTab(tab.targetId), /desktop UI/);
      await assert.rejects(chatRuntime.closeTab(tab.targetId), /desktop UI/);
      const thirdTab = await runtime.createTab(fixture.thirdUrl);
      await sendRuntimeCdp(runtime, { id: 4, method: "Target.activateTarget", params: { targetId: thirdTab.targetId } });
      await sendRuntimeCdp(runtime, { id: 5, method: "Target.closeTarget", params: { targetId: thirdTab.targetId } });
      assert.equal(
        (await chatRuntime.getAllTabs()).some((item) => item.id === thirdTab.targetId),
        false,
      );
    } finally {
      await chatTransport?.close();
      await transport.close();
      await server.close();
      await fixture.close();
      await rm(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);

function sendRuntimeCdp(
  runtime: ReturnType<typeof createEgoRuntime>,
  payload: Record<string, unknown>,
): Promise<Record<string, any>> {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

async function attach(
  runtime: ReturnType<typeof createEgoRuntime>,
  targetId: string,
): Promise<string> {
  const response = await sendRuntimeCdp(runtime, {
    id: 1,
    method: "Target.attachToTarget",
    params: { targetId, flatten: true },
  });
  return response.result.sessionId as string;
}

async function waitForRuntimeExpression(
  runtime: ReturnType<typeof createEgoRuntime>,
  sessionId: string,
  expression: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await sendRuntimeCdp(runtime, {
      id: Date.now(),
      method: "Runtime.evaluate",
      sessionId,
      params: { expression, returnByValue: true },
    });
    if (response.result?.result?.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for fixture page");
}

async function startFixtureServer(): Promise<{
  url: string;
  secondUrl: string;
  thirdUrl: string;
  close(): Promise<void>;
}> {
  const html = await readFile(
    new URL("../../../fixtures/browser/form.html", import.meta.url),
    "utf8",
  );
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      request.url === "/second.html"
        ? "<!doctype html><title>Second page</title><main><h1>Second tab content</h1></main>"
        : html,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/form.html`,
    secondUrl: `http://127.0.0.1:${address.port}/second.html`,
    thirdUrl: `http://127.0.0.1:${address.port}/third.html`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
test("agent registry, user takeover, lease fencing, and return work over the pipe", async () => {
  const pipeName = `\\\\.\\pipe\\ego-agent-control-${process.pid}-${Date.now()}`;
  const server = new BrokerPipeServer(
    undefined,
    undefined,
    undefined,
    undefined,
    { desktopControlToken: DESKTOP_CONTROL_TOKEN },
  );
  await server.listen(pipeName);
  const agent = await PipeRuntimeTransport.connect(pipeName);
  const desktop = await PipeRuntimeTransport.connect(pipeName);
  const agentEvents: Array<{ method: string; params: any }> = [];
  agent.onEvent((method, params) => agentEvents.push({ method, params }));
  try {
    await agent.request("agent.register", { clientId: "codex-mcp-control", clientKind: "codex", displayName: "Control Codex", version: "1" });
    const created = await agent.request<any>("space.create", { clientId: "codex-mcp-control", name: "Agent control" });
    await desktop.request("agent.register", {
      clientId: "desktop-control",
      clientKind: "desktop-ui",
      displayName: "Desktop",
      controlToken: DESKTOP_CONTROL_TOKEN,
    });
    const listed = await desktop.request<{ agents: Array<{ clientId: string; displayName: string; status: string }> }>("agent.list", { clientId: "desktop-control" });
    assert.ok(listed.agents.some((item) => item.clientId === "codex-mcp-control" && item.displayName === "Control Codex"));
    const oldEpoch = created.leaseEpoch;
    const taken = await desktop.request<any>("space.userTakeover", { clientId: "desktop-control", id: created.id });
    assert.equal(taken.ownership, "agentDelegatedToUser");
    assert.ok(taken.leaseEpoch > oldEpoch);
    await waitFor(() => agentEvents.some((event) => event.method === "lease.revoked"));
    assert.equal(agentEvents.find((event) => event.method === "lease.revoked")?.params.leaseEpoch, taken.leaseEpoch);
    await assert.rejects(
      agent.request("tab.create", { clientId: "codex-mcp-control", taskSpaceId: created.id, leaseEpoch: oldEpoch, url: "https://blocked.test" }),
      (error: any) => error?.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
    );
    const returned = await desktop.request<any>("space.returnToAgent", { clientId: "desktop-control", id: created.id });
    assert.equal(returned.ownership, "agent");
    await waitFor(() => agentEvents.some((event) => event.method === "lease.returned"));
    assert.equal(agentEvents.find((event) => event.method === "lease.returned")?.params.leaseEpoch, returned.leaseEpoch);
    const resumed = await agent.request<any>("tab.create", {
      clientId: "codex-mcp-control",
      taskSpaceId: created.id,
      leaseEpoch: returned.leaseEpoch,
      url: "https://resumed.test",
    });
    assert.equal(resumed.url, "https://resumed.test");
    await agent.request("space.handoff", { clientId: "codex-mcp-control" });
    await desktop.request("control.policy.set", { clientId: "desktop-control", policy: "automatic" });
    const automatic = await agent.request<any>("space.takeover", { clientId: "codex-mcp-control", id: created.id });
    assert.equal(automatic.ownership, "agent");
  } finally {
    await agent.close();
    await desktop.close();
    await server.close();
  }
});

test("desktop controls require the socket token and reject online clientId reuse", async () => {
  const pipeName = `\\\\.\\pipe\\ego-agent-control-auth-${process.pid}-${Date.now()}`;
  const server = new BrokerPipeServer(
    undefined,
    undefined,
    undefined,
    undefined,
    { desktopControlToken: DESKTOP_CONTROL_TOKEN },
  );
  await server.listen(pipeName);
  const agent = await PipeRuntimeTransport.connect(pipeName);
  const missingToken = await PipeRuntimeTransport.connect(pipeName);
  const wrongToken = await PipeRuntimeTransport.connect(pipeName);
  const desktop = await PipeRuntimeTransport.connect(pipeName);
  const duplicate = await PipeRuntimeTransport.connect(pipeName);
  try {
    await agent.request("agent.register", { clientId: "codex-mcp-auth", clientKind: "codex", displayName: "Auth Codex" });
    const created = await agent.request<any>("space.create", { clientId: "codex-mcp-auth", name: "Protected control" });
    await assert.rejects(
      agent.request("space.userTakeover", { clientId: "codex-mcp-auth", id: created.id }),
      (error: any) => error?.error_code === "EGO_OPERATION_FAILED",
    );
    await assert.rejects(
      missingToken.request("agent.register", {
        clientId: "desktop-spoof-missing",
        clientKind: "desktop-ui",
      }),
      (error: any) => error?.error_code === "EGO_OPERATION_FAILED",
    );
    await assert.rejects(
      wrongToken.request("agent.register", {
        clientId: "desktop-spoof-wrong",
        clientKind: "desktop-ui",
        controlToken: "wrong-desktop-control-token-32-bytes",
      }),
      (error: any) => error?.error_code === "EGO_OPERATION_FAILED",
    );
    await desktop.request("agent.register", {
      clientId: "desktop-authenticated",
      clientKind: "desktop-ui",
      displayName: "Desktop",
      controlToken: DESKTOP_CONTROL_TOKEN,
    });
    await desktop.request("space.userTakeover", { clientId: "desktop-authenticated", id: created.id });
    await assert.rejects(
      duplicate.request("agent.register", {
        clientId: "desktop-authenticated",
        clientKind: "desktop-ui",
        displayName: "Duplicate Desktop",
        controlToken: DESKTOP_CONTROL_TOKEN,
      }),
      (error: any) => error?.error_code === "EGO_INVALID_ARGUMENT",
    );
    await assert.rejects(
      agent.request("control.handoff.set", { clientId: "codex-mcp-auth", enabled: false }),
      (error: any) => error?.error_code === "EGO_OPERATION_FAILED",
    );
    const disabled = await desktop.request<{ enabled: boolean }>("control.handoff.set", {
      clientId: "desktop-authenticated",
      enabled: false,
    });
    assert.equal(disabled.enabled, false);
    assert.deepEqual(
      await desktop.request("control.handoff.get", { clientId: "desktop-authenticated" }),
      { enabled: false },
    );
    assert.equal(server.broker.spaces.byId(created.id).ownership, "user");
    assert.equal(server.broker.spaces.byId(created.id).lifecycle, "inactive");
  } finally {
    await agent.close();
    await missingToken.close();
    await wrongToken.close();
    await desktop.close();
    await duplicate.close();
    await server.close();
  }
});

test("agent disconnect becomes offline and relinquishes its space", async () => {
  const pipeName = `\\\\.\\pipe\\ego-agent-disconnect-${process.pid}-${Date.now()}`;
  const server = new BrokerPipeServer(
    undefined,
    undefined,
    undefined,
    undefined,
    { desktopControlToken: DESKTOP_CONTROL_TOKEN },
  );
  await server.listen(pipeName);
  const agent = await PipeRuntimeTransport.connect(pipeName);
  const desktop = await PipeRuntimeTransport.connect(pipeName);
  const desktopEvents: Array<{ method: string; params: any }> = [];
  desktop.onEvent((method, params) => desktopEvents.push({ method, params }));
  try {
    await desktop.request("agent.register", {
      clientId: "desktop-disconnect",
      clientKind: "desktop-ui",
      displayName: "Desktop",
      controlToken: DESKTOP_CONTROL_TOKEN,
    });
    await agent.request("agent.register", { clientId: "codex-mcp-disconnect", clientKind: "codex", displayName: "Disconnect Codex" });
    const created = await agent.request<any>("space.create", { clientId: "codex-mcp-disconnect", name: "Disconnect" });
    await agent.close();
    await waitFor(() => desktopEvents.some((event) => event.method === "agent.disconnected" && event.params.agent.clientId === "codex-mcp-disconnect"));
    await waitFor(() => server.broker.spaces.list().find((space) => space.id === created.id)?.ownership === "agentDelegatedToUser");
    const listed = await desktop.request<{ agents: Array<{ clientId: string; status: string }> }>("agent.list", { clientId: "desktop-disconnect" });
    assert.equal(listed.agents.find((item) => item.clientId === "codex-mcp-disconnect")?.status, "offline");
  } finally {
    await desktop.close();
    await server.close();
  }
});

test("an offline return stays pending and a new agent id receives lease.returned after takeover", async () => {
  const pipeName = `\\\\.\\pipe\\ego-agent-pending-return-${process.pid}-${Date.now()}`;
  const server = new BrokerPipeServer(
    undefined,
    undefined,
    undefined,
    undefined,
    { desktopControlToken: DESKTOP_CONTROL_TOKEN },
  );
  await server.listen(pipeName);
  const original = await PipeRuntimeTransport.connect(pipeName);
  const desktop = await PipeRuntimeTransport.connect(pipeName);
  let successor: PipeRuntimeTransport | undefined;
  const desktopEvents: Array<{ method: string; params: any }> = [];
  const successorEvents: Array<{ method: string; params: any }> = [];
  desktop.onEvent((method, params) => desktopEvents.push({ method, params }));
  try {
    await desktop.request("agent.register", {
      clientId: "desktop-pending-return",
      clientKind: "desktop-ui",
      displayName: "Desktop",
      controlToken: DESKTOP_CONTROL_TOKEN,
    });
    await original.request("agent.register", {
      clientId: "codex-mcp-return-old",
      clientKind: "codex",
      displayName: "Return Codex",
      version: "1",
    });
    const created = await original.request<any>("space.create", {
      clientId: "codex-mcp-return-old",
      name: "Pending return",
    });
    await original.close();
    await waitFor(() => server.broker.spaces.byId(created.id).ownership === "agentDelegatedToUser");

    const pending = await desktop.request<any>("space.returnToAgent", {
      clientId: "desktop-pending-return",
      id: created.id,
    });
    assert.equal(pending.ownership, "agentDelegatedToUser");
    assert.equal(pending.pendingAgentReturn, true);
    assert.equal(desktopEvents.some((event) => event.method === "lease.returned"), false);

    successor = await PipeRuntimeTransport.connect(pipeName);
    successor.onEvent((method, params) => successorEvents.push({ method, params }));
    await successor.request("agent.register", {
      clientId: "codex-mcp-return-new",
      clientKind: "codex",
      displayName: "Return Codex",
      version: "1",
    });
    await waitFor(() => desktopEvents.some((event) => (
      event.method === "agent.changed"
      && event.params.agent.clientId === "codex-mcp-return-new"
      && event.params.agent.status === "online"
    )));
    const request = await successor.request<any>("space.requestControl", {
      clientId: "codex-mcp-return-new",
      id: created.id,
    });
    await desktop.request("space.approveControl", {
      clientId: "desktop-pending-return", id: created.id, requestId: request.id,
    });
    const resumed = await successor.request<any>("space.select", {
      clientId: "codex-mcp-return-new",
      id: created.id,
    });
    assert.equal(server.broker.spaces.byId(created.id).ownership, "agent");
    assert.equal(server.broker.spaces.byId(created.id).pendingAgentReturn, undefined);
    await waitFor(() => successorEvents.some((event) => event.method === "lease.returned"));
    const leaseReturned = successorEvents.find((event) => event.method === "lease.returned");
    assert.equal(leaseReturned?.params.taskSpaceId, created.id);
    assert.equal(leaseReturned?.params.leaseEpoch, resumed.leaseEpoch);
  } finally {
    await successor?.close();
    await original.close();
    await desktop.close();
    await server.close();
  }
});

test("registering the original agent automatically completes a pending return", async () => {
  const pipeName = `\\\\.\\pipe\\ego-agent-register-resume-${process.pid}-${Date.now()}`;
  const server = new BrokerPipeServer(
    undefined,
    undefined,
    undefined,
    undefined,
    { desktopControlToken: DESKTOP_CONTROL_TOKEN },
  );
  await server.listen(pipeName);
  const original = await PipeRuntimeTransport.connect(pipeName);
  const desktop = await PipeRuntimeTransport.connect(pipeName);
  let reconnected: PipeRuntimeTransport | undefined;
  try {
    await desktop.request("agent.register", {
      clientId: "desktop-register-resume",
      clientKind: "desktop-ui",
      displayName: "Desktop",
      controlToken: DESKTOP_CONTROL_TOKEN,
    });
    await original.request("agent.register", {
      clientId: "codex-mcp-register-resume",
      clientKind: "codex",
      displayName: "Codex",
    });
    const created = await original.request<any>("space.create", {
      clientId: "codex-mcp-register-resume",
      name: "Register resume",
    });
    await original.close();
    await waitFor(() => server.broker.spaces.byId(created.id).ownership === "agentDelegatedToUser");
    const pending = await desktop.request<any>("space.returnToAgent", {
      clientId: "desktop-register-resume",
      id: created.id,
    });
    assert.equal(pending.pendingAgentReturn, true);

    reconnected = await PipeRuntimeTransport.connect(pipeName);
    const events: Array<{ method: string; params: any }> = [];
    reconnected.onEvent((method, params) => events.push({ method, params }));
    await reconnected.request("agent.register", {
      clientId: "codex-mcp-register-resume",
      clientKind: "codex",
      displayName: "Codex",
    });

    await waitFor(() => events.some((event) => event.method === "lease.returned"));
    assert.equal(server.broker.spaces.byId(created.id).ownership, "agent");
    assert.equal(events.find((event) => event.method === "lease.returned")?.params.taskSpaceId, created.id);
  } finally {
    await reconnected?.close();
    await original.close();
    await desktop.close();
    await server.close();
  }
});

test("a legacy CLI can resume a pending return through its first ordinary request", async () => {
  const pipeName = `\\\\.\\pipe\\ego-agent-observe-resume-${process.pid}-${Date.now()}`;
  const server = new BrokerPipeServer(
    undefined,
    undefined,
    undefined,
    undefined,
    { desktopControlToken: DESKTOP_CONTROL_TOKEN },
  );
  await server.listen(pipeName);
  const original = await PipeRuntimeTransport.connect(pipeName);
  const desktop = await PipeRuntimeTransport.connect(pipeName);
  let successor: PipeRuntimeTransport | undefined;
  try {
    await desktop.request("agent.register", {
      clientId: "desktop-observe-resume",
      clientKind: "desktop-ui",
      displayName: "Desktop",
      controlToken: DESKTOP_CONTROL_TOKEN,
    });
    await original.request("agent.register", {
      clientId: "cli-observe-original",
      clientKind: "other",
      displayName: "Agent",
    });
    const created = await original.request<any>("space.create", {
      clientId: "cli-observe-original",
      name: "Observe resume",
    });
    await original.close();
    await waitFor(() => server.broker.spaces.byId(created.id).ownership === "agentDelegatedToUser");
    await desktop.request("space.returnToAgent", {
      clientId: "desktop-observe-resume",
      id: created.id,
    });

    successor = await PipeRuntimeTransport.connect(pipeName);
    const events: Array<{ method: string; params: any }> = [];
    successor.onEvent((method, params) => events.push({ method, params }));
    const listed = await successor.request<{ taskSpaces: Array<{ id: number; ownership?: string }> }>("space.list", {
      clientId: "cli-observe-successor",
    });

    await waitFor(() => events.some((event) => event.method === "lease.returned"));
    assert.equal(listed.taskSpaces.find((space) => space.id === created.id)?.ownership, "agent");
    assert.equal(server.broker.spaces.leaseHolder(created.taskId)?.clientId, "cli-observe-successor");
  } finally {
    await successor?.close();
    await original.close();
    await desktop.close();
    await server.close();
  }
});

test("broker restart restores neither agent registry nor agent ownership", async () => {
  let persisted: any[] = [];
  const store = { load: () => persisted, save: (spaces: any[]) => { persisted = structuredClone(spaces); } };
  const firstSpaces = new TaskSpaceService({ store });
  const first = new BrokerCore(firstSpaces, new FakeBrowserBackend());
  first.agents.register({ clientId: "codex-mcp-restart", clientKind: "codex" });
  firstSpaces.create("Restart", "codex-mcp-restart");
  const recoveredSpaces = new TaskSpaceService({ store });
  recoveredSpaces.recoverAfterRestart();
  const restarted = new BrokerCore(recoveredSpaces, new FakeBrowserBackend());
  assert.deepEqual(restarted.agents.list(), []);
  assert.equal(restarted.spaces.list()[0]?.ownership, "user");
  assert.equal(restarted.spaces.leaseHolder(restarted.spaces.list()[0]!.taskId), undefined);
});
