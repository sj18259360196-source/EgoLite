import assert from "node:assert/strict";
import test from "node:test";

import { createEgoRuntime } from "./adapter.ts";
import type { RuntimeTransport } from "./transport.ts";

class FakeTransport implements RuntimeTransport {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly handlers = new Set<(method: string, params: unknown) => void>();
  failure: Error | undefined;

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (this.failure) throw this.failure;
    if (method === "space.create") {
      return {
        id: 1,
        taskId: "task-1",
        name: "poc",
        ownership: "agent",
        leaseEpoch: 3,
      } as T;
    }
    if (method === "space.select") {
      return { leaseEpoch: 4 } as T;
    }
    if (method === "space.takeover") {
      return { leaseEpoch: 5 } as T;
    }
    if (method === "space.heartbeat") {
      const leaseEpoch = (params as { leaseEpoch: number }).leaseEpoch;
      return { taskId: "task-1", clientId: "agent-a", epoch: leaseEpoch, expiresAt: Date.now() + 15_000 } as T;
    }
    if (method === "cdp.send") {
      return JSON.stringify({ id: 1, result: {} }) as T;
    }
    if (method === "tab.listAll") {
      return [{ id: "target-1", targetId: "target-1", taskId: "task-1", title: "One", url: "https://one.test", active: true }] as T;
    }
    if (method === "tab.groupList") {
      return [{ id: "task-1", taskId: "task-1", title: "poc", color: "blue", tabs: [] }] as T;
    }
    if (method === "page.aiContent") {
      return {
        title: "One",
        url: "https://one.test",
        content: "heading \"One\"",
        refs: [],
        rootNode: { attributeType: 0, children: [] },
      } as T;
    }
    if (method === "collection.save") return true as T;
    if (method === "collection.list") {
      return [{ id: "saved-1", text: "useful", createdAt: "2026-08-13T00:00:00.000Z" }] as T;
    }
    if (method === "tab.activate" || method === "tab.close") return true as T;
    if (method === "tab.openUrl") {
      return { id: "target-2", targetId: "target-2", taskId: "task-1", title: "Two", url: "https://two.test", active: true } as T;
    }
    return undefined as T;
  }

  onEvent(listener: (method: string, params: unknown) => void): () => void {
    this.handlers.add(listener);
    return () => this.handlers.delete(listener);
  }

  emit(method: string, params: unknown): void {
    for (const handler of this.handlers) handler(method, params);
  }
}

test("wait subscribes before querying and does not lose a concurrent grant event", async () => {
  let queries = 0;
  class ControlTransport extends FakeTransport {
    override async request<T>(method: string, params?: unknown): Promise<T> {
      if (method !== "space.controlState") return super.request<T>(method, params);
      queries++;
      if (queries === 1) {
        this.emit("space.controlChanged", { space: { id: 2 } });
        return { space: { id: 2, lifecycle: "active" } } as T;
      }
      return { space: { id: 2, lifecycle: "active" }, controllerClientId: "agent-a" } as T;
    }
  }
  const transport = new ControlTransport();
  const runtime = createEgoRuntime(transport, { clientId: "agent-a" });
  await runtime.createTaskSpace("original");
  const initialHandlers = transport.handlers.size;
  await runtime.waitForAgentControl!(2, { timeout: 500 });
  assert.equal(queries, 2);
  assert.equal(transport.handlers.size, initialHandlers);
  assert.deepEqual(transport.calls.find((call) => call.method === "space.select")?.params, { clientId: "agent-a", id: 2 });
});

test("cancelling an outstanding status query removes listeners and ignores its late response", async () => {
  let answer!: (value: unknown) => void;
  class ControlTransport extends FakeTransport {
    override async request<T>(method: string, params?: unknown): Promise<T> {
      if (method === "space.controlState") return new Promise((resolve) => { answer = resolve as (value: unknown) => void; });
      return super.request<T>(method, params);
    }
  }
  const transport = new ControlTransport();
  const runtime = createEgoRuntime(transport, { clientId: "agent-a" });
  await runtime.createTaskSpace("original");
  const initialHandlers = transport.handlers.size;
  const controller = new AbortController();
  const pending = runtime.waitForAgentControl!(2, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  answer({ space: { id: 2, lifecycle: "active" }, controllerClientId: "agent-a" });
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.heartbeatTaskSpace();
  assert.equal(transport.handlers.size, initialHandlers);
  assert.equal(transport.calls.some((call) => call.method === "space.select"), false);
  assert.equal((transport.calls.at(-1)?.params as { taskSpaceId: number }).taskSpaceId, 1);
});

test("runtime carries selected task and lease epoch into mutations", async () => {
  const transport = new FakeTransport();
  const runtime = createEgoRuntime(transport, { clientId: "agent-a" });

  await runtime.createTaskSpace("poc");
  await runtime.createTab("https://example.test");

  assert.equal(transport.calls[1]?.method, "space.heartbeat");
  assert.deepEqual(transport.calls[2], {
    method: "tab.create",
    params: {
      clientId: "agent-a",
      taskSpaceId: 1,
      leaseEpoch: 3,
      url: "https://example.test",
    },
  });
});

test("runtime requests scoped snapshot refs only when the negotiated capability is present", async () => {
  const transport = new FakeTransport();
  let capabilities = new Set<string>();
  const runtime = createEgoRuntime(transport, {
    clientId: "agent-a",
    capabilities: () => capabilities,
  });
  await runtime.createTaskSpace("poc");
  await runtime.snapshot();
  assert.equal((transport.calls.at(-1)?.params as { refFormat?: string }).refFormat, undefined);

  capabilities = new Set(["scoped-refs-v1"]);
  await runtime.snapshot();
  assert.equal((transport.calls.at(-1)?.params as { refFormat?: string }).refFormat, "scoped-v1");
});

test("scoped ref actions keep their original lease tuple through CDP send and release", async () => {
  class ReferenceTransport extends FakeTransport {
    override async request<T>(method: string, params?: unknown): Promise<T> {
      if (method === "ref.bind") {
        this.calls.push({ method, params });
        return {
          version: "scoped-v1",
          token: "token-1",
          expiresAt: Date.now() + 10_000,
          runtimeId: "runtime-1",
          pageId: "page-1",
          frameId: "frame-1",
          documentId: "document-1",
          documentEpoch: 1,
          backendNodeId: 44,
        } as T;
      }
      return super.request<T>(method, params);
    }
  }
  const transport = new ReferenceTransport();
  const runtime = createEgoRuntime(transport, {
    clientId: "agent-a",
    capabilities: ["scoped-refs-v1"],
    referenceActionMaxLifetimeMs: 300_000,
  });
  assert.equal(runtime.getReferenceActionMaxLifetimeMs?.(), 300_000);
  await runtime.createTaskSpace("poc");
  const binding = await runtime.bindReferenceAction!({
    ref: { refId: 9, runtimeId: "runtime-1" },
    expectedScope: { pageId: "page-1" },
  });
  const response = new Promise<string>((resolve) => { runtime.onCDPMessage = resolve; });
  runtime.sendCDPMessage(JSON.stringify({ id: 8, method: "DOM.getBoxModel" }), binding);
  await response;
  await runtime.releaseReferenceAction!(binding);

  const bind = transport.calls.find((call) => call.method === "ref.bind")!;
  const send = transport.calls.find((call) => call.method === "cdp.send")!;
  const release = transport.calls.find((call) => call.method === "ref.release")!;
  assert.equal((bind.params as any).leaseEpoch, 3);
  assert.equal((send.params as any).leaseEpoch, 3);
  assert.equal((release.params as any).leaseEpoch, 3);
  assert.deepEqual((send.params as any).refAction, {
    version: "scoped-v1",
    runtimeId: "runtime-1",
    token: "token-1",
  });

  const rebound = await runtime.bindReferenceAction!({
    ref: { refId: 10, runtimeId: "runtime-1" },
    expectedScope: { pageId: "page-1" },
  });
  transport.emit("lease.returned", { taskSpaceId: 1, leaseEpoch: 4 });
  const error = new Promise<{ code: string; requestId: number | undefined }>((resolve) => {
    runtime.onSendCDPMessageError = (_message, code, requestId) => resolve({ code, requestId });
  });
  const sendsBefore = transport.calls.filter((call) => call.method === "cdp.send").length;
  runtime.sendCDPMessage(JSON.stringify({ id: 9, method: "Input.insertText" }), rebound);
  assert.deepEqual(await error, { code: "EGO_ACTION_CONTEXT_INVALID", requestId: 9 });
  assert.equal(transport.calls.filter((call) => call.method === "cdp.send").length, sendsBefore);
});

test("scoped drag group uses one stored token tuple and clears it on reconnect", async () => {
  class GroupTransport extends FakeTransport {
    readonly reconnectHandlers = new Set<() => void>();
    groupSequence = 0;

    onReconnect(listener: () => void): () => void {
      this.reconnectHandlers.add(listener);
      return () => this.reconnectHandlers.delete(listener);
    }

    emitReconnect(): void {
      for (const listener of this.reconnectHandlers) listener();
    }

    override async request<T>(method: string, params?: unknown): Promise<T> {
      if (method === "ref.bind" && (params as any)?.request?.kind === "drag") {
        this.calls.push({ method, params });
        const request = (params as any).request;
        const suffix = ++this.groupSequence;
        return {
          kind: "drag",
          version: "scoped-v1",
          token: `drag-token-${suffix}`,
          expiresAt: request.deadlineAt,
          runtimeId: request.source.runtimeId,
          pageId: request.expectedScope.pageId,
          frameId: "frame-1",
          documentId: "document-1",
          documentEpoch: 1,
          sessionId: "public-session-1",
          source: { refId: request.source.refId, backendNodeId: 101 },
          target: { refId: request.target.refId, backendNodeId: 102 },
        } as T;
      }
      return super.request<T>(method, params);
    }
  }

  const transport = new GroupTransport();
  const runtime = createEgoRuntime(transport, {
    clientId: "agent-a",
    capabilities: ["scoped-refs-v1"],
  });
  await runtime.createTaskSpace("poc");
  const request = {
    kind: "drag" as const,
    source: { refId: 11, runtimeId: "runtime-1" },
    target: { refId: 12, runtimeId: "runtime-1" },
    expectedScope: { pageId: "page-1" },
    deadlineAt: 50_000,
  };
  const binding = await runtime.bindReferenceActionGroup!(request);
  assert.equal(binding.token, "drag-token-1");
  const bindCall = transport.calls.find((call) => call.method === "ref.bind")!;
  assert.deepEqual(bindCall.params, {
    clientId: "agent-a",
    taskSpaceId: 1,
    leaseEpoch: 3,
    request,
  });

  const response = new Promise<string>((resolve) => { runtime.onCDPMessage = resolve; });
  runtime.sendCDPMessage(JSON.stringify({ id: 31, method: "DOM.getBoxModel" }), binding);
  await response;
  const cdpCall = transport.calls.find((call) => call.method === "cdp.send")!;
  assert.deepEqual((cdpCall.params as any).refAction, {
    version: "scoped-v1",
    runtimeId: "runtime-1",
    token: "drag-token-1",
  });
  await runtime.releaseReferenceAction!(binding);
  const release = transport.calls.find((call) => call.method === "ref.release")!;
  assert.equal((release.params as any).leaseEpoch, 3);
  assert.deepEqual((release.params as any).refAction, {
    version: "scoped-v1",
    runtimeId: "runtime-1",
    token: "drag-token-1",
  });

  const second = await runtime.bindReferenceActionGroup!(request);
  const releasesBeforeReconnect = transport.calls.filter((call) => call.method === "ref.release").length;
  transport.emitReconnect();
  await runtime.releaseReferenceAction!(second);
  assert.equal(transport.calls.filter((call) => call.method === "ref.release").length, releasesBeforeReconnect);
  const sendsBeforeReconnect = transport.calls.filter((call) => call.method === "cdp.send").length;
  const error = new Promise<string>((resolve) => {
    runtime.onSendCDPMessageError = (_message, code) => resolve(code);
  });
  runtime.sendCDPMessage(JSON.stringify({ id: 32, method: "Input.dispatchMouseEvent" }), second);
  assert.equal(await error, "EGO_ACTION_CONTEXT_INVALID");
  assert.equal(transport.calls.filter((call) => call.method === "cdp.send").length, sendsBeforeReconnect);
});

test("runtime can renew a selected lease during non-browser work", async () => {
  const transport = new FakeTransport();
  const runtime = createEgoRuntime(transport, { clientId: "agent-a" });

  assert.equal(await runtime.heartbeatTaskSpace(), false);
  await runtime.createTaskSpace("poc");
  assert.equal(await runtime.heartbeatTaskSpace(), true);
  assert.deepEqual(transport.calls.at(-1), {
    method: "space.heartbeat",
    params: { clientId: "agent-a", taskSpaceId: 1, leaseEpoch: 3 },
  });

  transport.emit("lease.revoked", { taskSpaceId: 1, leaseEpoch: 4 });
  const beforeFencedHeartbeat = transport.calls.length;
  assert.equal(await runtime.heartbeatTaskSpace(), false);
  assert.equal(transport.calls.length, beforeFencedHeartbeat);
});

test("task lifecycle mutations renew the lease before completing or closing", async () => {
  const transport = new FakeTransport();
  const runtime = createEgoRuntime(transport, { clientId: "agent-a" });

  await runtime.createTaskSpace("complete");
  await runtime.completeTaskSpace();
  await runtime.createTaskSpace("close");
  await runtime.closeTaskSpace();

  assert.deepEqual(transport.calls.map((call) => call.method), [
    "space.create",
    "space.heartbeat",
    "space.complete",
    "space.create",
    "space.heartbeat",
    "space.close",
  ]);
});

test("standalone Chat can open, activate, and close tabs without an Agent lease", async () => {
  const transport = new FakeTransport();
  const runtime = createEgoRuntime(transport, { clientId: "chat" });
  const tab = await runtime.openUrlInNewTab("https://two.test", "task-1");
  assert.equal(await runtime.activateTab(tab), true);
  assert.equal(await runtime.closeTab(tab.id), true);
  assert.deepEqual(transport.calls.map((call) => call.method), [
    "tab.openUrl",
    "tab.activate",
    "tab.close",
  ]);
});

test("runtime exposes collection save and search for the WebUI bridge", async () => {
  const transport = new FakeTransport();
  const runtime = createEgoRuntime(transport, { clientId: "chat" });
  assert.equal(await runtime.saveTextToCollections("useful", "https://example.test"), true);
  assert.equal((await runtime.listCollections("use"))[0]?.text, "useful");
  assert.equal(transport.calls.at(-1)?.method, "collection.list");
});

test("runtime exposes original all-tabs and page-content bridge methods", async () => {
  const transport = new FakeTransport();
  const runtime = createEgoRuntime(transport, { clientId: "agent-a" });

  const tabs = await runtime.getAllTabs();
  const groups = await runtime.getTabGroups();
  const firstTab = tabs[0];
  assert.ok(firstTab);
  const page = await runtime.getAIPageContent(firstTab);

  assert.equal(tabs[0]?.id, "target-1");
  assert.equal(groups[0]?.title, "poc");
  assert.equal(page?.title, "One");
  assert.equal(transport.calls.at(-1)?.method, "page.aiContent");
  assert.deepEqual(transport.calls.at(-1)?.params, {
    clientId: "agent-a",
    targetId: "target-1",
    options: undefined,
  });
});

test("CDP transport failures use the native callback contract", async () => {
  const transport = new FakeTransport();
  const runtime = createEgoRuntime(transport, { clientId: "agent-a" });
  await runtime.createTaskSpace("poc");
  transport.failure = Object.assign(new Error("User took control"), {
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });

  const callback = new Promise<{ message: string; code: string; requestId: number | undefined }>((resolve) => {
    runtime.onSendCDPMessageError = (message, code, requestId) => resolve({ message, code, requestId });
  });
  runtime.sendCDPMessage(JSON.stringify({ id: 1, method: "Runtime.enable" }));

  assert.deepEqual(await callback, {
    message: "User took control",
    code: "EGO_TASK_SPACE_USER_IN_CONTROL",
    requestId: 1,
  });
});

test("CDP responses are forwarded through onCDPMessage", async () => {
  const transport = new FakeTransport();
  const runtime = createEgoRuntime(transport, { clientId: "agent-a" });
  await runtime.createTaskSpace("poc");

  const callback = new Promise<string>((resolve) => {
    runtime.onCDPMessage = resolve;
  });
  runtime.sendCDPMessage(JSON.stringify({ id: 1, method: "Runtime.enable" }));

  assert.equal(await callback, JSON.stringify({ id: 1, result: {} }));
});

test("lease.returned refreshes the fenced agent epoch", async () => {
  const transport = new FakeTransport();
  const runtime = createEgoRuntime(transport, { clientId: "agent-a" });
  await runtime.createTaskSpace("poc");
  transport.emit("lease.revoked", { taskSpaceId: 1, leaseEpoch: 2 });
  transport.emit("lease.returned", { taskSpaceId: 1, leaseEpoch: 3 });
  runtime.sendCDPMessage(JSON.stringify({ id: 4, method: "Runtime.enable" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((transport.calls[1]?.params as { leaseEpoch: number }).leaseEpoch, 3);
});

test("user-controlled selection retains the task id for a later takeover", async () => {
  const transport = new FakeTransport();
  const runtime = createEgoRuntime(transport, { clientId: "agent-a" });
  transport.failure = Object.assign(new Error("User took control"), {
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });

  await assert.rejects(
    runtime.useTaskSpace(9),
    (error: unknown) =>
      (error as { error_code?: unknown }).error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );

  transport.failure = undefined;
  await runtime.takeOverTaskSpace();
  assert.deepEqual(transport.calls.at(-1), {
    method: "space.takeover",
    params: {
      clientId: "agent-a",
      id: 9,
    },
  });
});

test("handoff retains task selection for user-control errors and later takeover", async () => {
  const transport = new FakeTransport();
  const runtime = createEgoRuntime(transport, { clientId: "agent-a" });
  await runtime.createTaskSpace("poc");

  await runtime.handOffTaskSpace();
  runtime.sendCDPMessage(JSON.stringify({ id: 2, method: "Runtime.enable" }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.calls.slice(1).map((call) => call.method), [
    "space.heartbeat",
    "space.handoff",
    "space.heartbeat",
    "cdp.send",
  ]);
  assert.equal(
    (transport.calls[4]?.params as { taskSpaceId: number }).taskSpaceId,
    1,
  );
});
