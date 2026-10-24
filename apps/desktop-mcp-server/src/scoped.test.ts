import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import test from "node:test";

import {
  BrokerCore,
  FakeBrowserBackend,
  TaskSpaceService,
  type MutationContext,
  type SnapshotRequestContext,
} from "@ego-compat/broker-core";
import type {
  CdpRequestContext,
  ReferenceActionBindRequest,
  ReferenceActionWire,
  SnapshotOptions,
  SnapshotResult,
} from "@ego-compat/protocol";
import { PipeRuntimeTransport, PROTOCOL_VERSION } from "@ego-compat/runtime-adapter";
import { BrokerPipeServer } from "../../broker/src/server.ts";
import { DesktopRpcClient } from "./client.ts";
import { resolveDesktopScopedRef } from "./scoped-refs.ts";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { browserSnapshotRefsToRefMap, invalidateSession, setPreferredTarget } from "../../../vendor/ego-browser/src/browser-runtime.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { browserRefMap, clearScopedReferenceState } from "../../../vendor/ego-browser/src/ref-state.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { click, hover } from "../../../vendor/ego-browser/src/driver/pointer.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { fill } from "../../../vendor/ego-browser/src/driver/keyboard.js";

test("desktop MCP scoped refs use exact visible Broker page and never expose refId as native node", async (t) => {
  const brokerPipe = `\\\\.\\pipe\\desktop-scoped-broker-${randomUUID()}`;
  const automationPipe = `\\\\.\\pipe\\desktop-scoped-automation-${randomUUID()}`;
  const previous = process.env.EGO_COMPAT_PIPE;
  process.env.EGO_COMPAT_PIPE = brokerPipe;
  t.after(() => { if (previous === undefined) delete process.env.EGO_COMPAT_PIPE; else process.env.EGO_COMPAT_PIPE = previous; });

  const backend = new ScopedBackend();
  const broker = new BrokerPipeServer(new BrokerCore(new TaskSpaceService(), backend));
  await broker.listen(brokerPipe);
  const client = new DesktopRpcClient(automationPipe);
  const space = await broker.broker.createTaskSpace("Direct scoped", client.clientId);
  const tab = await broker.broker.createTab(client.clientId, space.leaseEpoch, "https://visible.test", space.id);
  const sockets = new Set<Socket>();
  const automation = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const request = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        const result = request.method === "desktop.status"
          ? { kind: "desktop", ready: true, visible: { taskId: space.taskId, taskSpaceId: space.id, targetId: tab.targetId } }
          : request.method === "mutation.context"
            ? { taskId: space.taskId, taskSpaceId: space.id, leaseEpoch: space.leaseEpoch }
            : null;
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => automation.listen(automationPipe, resolve));

  const previousEgo = (globalThis as any).ego;
  try {
    const options: SnapshotOptions = {
      scope: "only_within_viewport",
      includeStableLocator: true,
      includeActionMarks: false,
      maxResultLength: 128,
    };
    const snapshot = await client.captureScopedSnapshot(options);
    assert.ok(snapshot);
    assert.equal(snapshot.refFormat, "scoped-v1");
    assert.equal(snapshot.pageId, tab.targetId);
    assert.equal(backend.snapshotContexts[0]?.refFormat, "scoped-v1");
    assert.equal(backend.snapshotTargetIds[0], tab.targetId);
    assert.deepEqual(backend.snapshotOptions[0], options);
    assert.equal(backend.snapshotContexts[0]?.clientId, client.clientId);
    assert.equal(broker.broker.spaces.leaseHolder(space.taskId)?.clientId, client.clientId);
    browserSnapshotRefsToRefMap(browserRefMap, snapshot);

    backend.nextRefId = 56;
    const partial = await client.captureScopedSnapshot(options);
    assert.ok(partial);
    browserSnapshotRefsToRefMap(browserRefMap, partial);
    assert.equal(resolveDesktopScopedRef("@55", snapshot.runtimeId, snapshot.pageId).refId, 55);
    assert.equal(resolveDesktopScopedRef("@56", snapshot.runtimeId, snapshot.pageId).refId, 56);
    assert.throws(() => resolveDesktopScopedRef("@55", "runtime-other", snapshot.pageId), isStaleRef);
    assert.throws(() => resolveDesktopScopedRef("@55", snapshot.runtimeId, "page-other"), isStaleRef);

    const legacy = await PipeRuntimeTransport.connect(brokerPipe);
    try {
      await legacy.negotiateHello({ protocolVersion: PROTOCOL_VERSION, clientId: "legacy-observer", pid: process.pid });
      await assert.rejects(legacy.request("space.observe", {
        clientId: client.clientId,
        id: space.id,
        targetId: tab.targetId,
        options,
        refFormat: "scoped-v1",
      }), (error: any) => error?.error_code === "EGO_INVALID_ARGUMENT");
      await legacy.request("space.observe", { clientId: "legacy-observer", id: space.id, targetId: tab.targetId, options });
      assert.equal(backend.snapshotContexts.at(-1)?.refFormat, "native-v0");
      assert.equal(backend.snapshotContexts.at(-1)?.clientId, "legacy-observer");
      assert.deepEqual(backend.snapshotOptions.at(-1), options);
      assert.equal(broker.broker.spaces.leaseHolder(space.taskId)?.clientId, client.clientId);
    } finally {
      await legacy.close();
    }

    for (const action of [
      () => click("@55"),
      () => fill("@55", "direct"),
      () => hover("@55"),
    ]) {
      const prepared = await client.prepareScopedAction(tab.targetId);
      assert.ok(prepared);
      (globalThis as any).ego = prepared.runtime;
      invalidateSession();
      setPreferredTarget(prepared.targetId);
      await action();
    }

    assert.equal(backend.bindRequests.length, 3);
    assert.ok(backend.bindRequests.every((request) => request.ref.refId === 55));
    const nativeNodeIds = backend.cdpPayloads
      .filter((payload) => ["DOM.getBoxModel", "DOM.resolveNode", "DOM.focus"].includes(payload.method))
      .map((payload) => payload.params?.backendNodeId);
    assert.ok(nativeNodeIds.length > 0);
    assert.ok(nativeNodeIds.every((value) => value === 1234));
    assert.equal(nativeNodeIds.includes(55), false);
    assert.ok(backend.cdpContexts.filter((context) => context?.refAction).every((context) => (
      context?.clientId === client.clientId && context.refFormat === "scoped-v1"
    )));

    backend.rejectNextBind = true;
    const prepared = await client.prepareScopedAction(tab.targetId);
    assert.ok(prepared);
    (globalThis as any).ego = prepared.runtime;
    invalidateSession();
    setPreferredTarget(prepared.targetId);
    await assert.rejects(click("@55"), (error: any) => error?.error_code === "EGO_REFERENCE_STALE");

    backend.completeness = "complete-page";
    const complete = await client.captureScopedSnapshot({ scope: "full_page" });
    assert.ok(complete);
    browserSnapshotRefsToRefMap(browserRefMap, complete);
    assert.throws(() => resolveDesktopScopedRef("@55", complete.runtimeId, complete.pageId), isStaleRef);
    assert.equal(resolveDesktopScopedRef("@56", complete.runtimeId, complete.pageId).refId, 56);
  } finally {
    clearScopedReferenceState();
    invalidateSession();
    if (previousEgo === undefined) delete (globalThis as any).ego;
    else (globalThis as any).ego = previousEgo;
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => automation.close(() => resolve()));
    await broker.close();
  }
});

class ScopedBackend extends FakeBrowserBackend {
  readonly snapshotContexts: Array<SnapshotRequestContext | undefined> = [];
  readonly snapshotTargetIds: Array<string | undefined> = [];
  readonly snapshotOptions: SnapshotOptions[] = [];
  nextRefId = 55;
  completeness: NonNullable<SnapshotResult["completeness"]> = "partial";
  readonly bindRequests: ReferenceActionBindRequest[] = [];
  readonly cdpPayloads: any[] = [];
  readonly cdpContexts: Array<CdpRequestContext | undefined> = [];
  rejectNextBind = false;
  #token = 0;

  override status() {
    return {
      kind: "desktop" as const,
      ready: true,
      connected: true,
      capabilities: ["scoped-refs-v1"],
      referenceActionMaxLifetimeMs: 300_000,
    };
  }

  override async snapshot(taskId: string, options = {}, targetId?: string, context?: SnapshotRequestContext): Promise<SnapshotResult> {
    if (!targetId) throw new Error(`Scoped snapshot target is required for ${taskId}`);
    this.snapshotContexts.push(context);
    this.snapshotTargetIds.push(targetId);
    this.snapshotOptions.push(options);
    return {
      content: "- textbox \"Direct\" [ref=@55]",
      refs: [{
        refId: this.nextRefId,
        backendNodeId: 999,
        pageId: targetId,
        frameId: "frame-1",
        documentId: "document-1",
        documentEpoch: 1,
        role: "textbox",
        name: "Direct",
      }],
      refFormat: "scoped-v1" as const,
      completeness: this.completeness,
      runtimeId: "runtime-1",
      pageId: targetId,
      documentId: "document-1",
      documentEpoch: 1,
    };
  }

  async bindReferenceAction(_taskId: string, request: ReferenceActionBindRequest, _mutation: MutationContext) {
    this.bindRequests.push(request);
    if (this.rejectNextBind) {
      this.rejectNextBind = false;
      throw Object.assign(new Error("Reference is stale"), { error_code: "EGO_REFERENCE_STALE" });
    }
    return {
      version: "scoped-v1" as const,
      token: `token-${++this.#token}`,
      expiresAt: request.deadlineAt ?? Date.now() + 30_000,
      runtimeId: request.ref.runtimeId,
      pageId: request.expectedScope.pageId,
      frameId: "frame-1",
      documentId: "document-1",
      documentEpoch: 1,
      backendNodeId: 1234,
      sessionId: "session-1",
    };
  }

  async releaseReferenceAction(_taskId: string, _action: ReferenceActionWire, _mutation: MutationContext) {}

  override async sendCdp(
    _taskId: string,
    rawPayload: string,
    _mutation?: MutationContext,
    context?: CdpRequestContext,
  ): Promise<string> {
    const payload = JSON.parse(rawPayload);
    this.cdpPayloads.push(payload);
    this.cdpContexts.push(context);
    let result: any = {};
    if (payload.method === "Target.attachToTarget") result = { sessionId: "session-1" };
    else if (payload.method === "DOM.getBoxModel") result = { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } };
    else if (payload.method === "DOM.resolveNode") result = { object: { objectId: "object-1" } };
    else if (payload.method === "Runtime.callFunctionOn") result = { result: { value: true } };
    else if (payload.method === "Runtime.evaluate") {
      const finishing = payload.params?.expression?.includes("delete probes");
      result = { result: { value: finishing ? { seen: true, fallback: false } : true } };
    }
    return JSON.stringify({ id: payload.id, result, ...(payload.sessionId ? { sessionId: payload.sessionId } : {}) });
  }
}

function isStaleRef(error: unknown): boolean {
  return (error as { error_code?: string })?.error_code === "EGO_REFERENCE_STALE";
}

test("desktop scoped lookup follows shared map document and runtime invalidation", (t) => {
  t.after(clearScopedReferenceState);
  const snapshot: SnapshotResult = {
    content: "",
    refs: [{ refId: 71, backendNodeId: 99, role: "button", name: "First", frameId: "frame-1" }],
    refFormat: "scoped-v1",
    completeness: "partial",
    runtimeId: "runtime-lookup-1",
    pageId: "page-lookup-1",
    documentId: "document-lookup-1",
    documentEpoch: 1,
  };
  browserSnapshotRefsToRefMap(browserRefMap, snapshot);
  assert.equal(resolveDesktopScopedRef("@71", snapshot.runtimeId, snapshot.pageId).refId, 71);

  const navigated: SnapshotResult = {
    ...snapshot,
    documentEpoch: 2,
    refs: [{ refId: 72, backendNodeId: 100, role: "button", name: "Second", frameId: "frame-1" }],
  };
  browserSnapshotRefsToRefMap(browserRefMap, navigated);
  assert.throws(() => resolveDesktopScopedRef("@71", navigated.runtimeId, navigated.pageId), isStaleRef);
  assert.equal(resolveDesktopScopedRef("@72", navigated.runtimeId, navigated.pageId).refId, 72);

  const restarted: SnapshotResult = {
    ...navigated,
    runtimeId: "runtime-lookup-2",
    refs: [{ refId: 73, backendNodeId: 100, role: "button", name: "Third", frameId: "frame-1" }],
  };
  browserSnapshotRefsToRefMap(browserRefMap, restarted);
  assert.throws(() => resolveDesktopScopedRef("@72", restarted.runtimeId, restarted.pageId), isStaleRef);
  assert.equal(resolveDesktopScopedRef("@73", restarted.runtimeId, restarted.pageId).refId, 73);
  clearScopedReferenceState();
  assert.throws(() => resolveDesktopScopedRef("@73", restarted.runtimeId, restarted.pageId), isStaleRef);
});
