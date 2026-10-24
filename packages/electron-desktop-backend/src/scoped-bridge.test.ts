import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// @ts-expect-error The desktop RPC server is a plain ESM integration boundary.
import { DesktopRpcServer } from "../../../apps/desktop-shell/desktop-rpc-server.mjs";
import { ElectronDesktopBackend } from "./electron-desktop-backend.ts";

test("scoped bridge forwards trusted contexts and preserves typed desktop errors", async () => {
  const pipe = `\\\\.\\pipe\\ego-scoped-bridge-${randomUUID()}`;
  const previousToken = process.env.EGO_DESKTOP_CONTROL_TOKEN;
  process.env.EGO_DESKTOP_CONTROL_TOKEN = "test-control-token-that-is-at-least-thirty-two-bytes";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = new DesktopRpcServer(async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "desktop.status") return {
      kind: "desktop", ready: true, capabilities: ["scoped-refs-v1"], referenceActionMaxLifetimeMs: 300_000,
    };
    if (method === "page.snapshot") return { content: "", refs: [], refFormat: "scoped-v1", runtimeId: "runtime-1" };
    if (method === "ref.bind") return {
      version: "scoped-v1", token: "token-1", expiresAt: 10_000, runtimeId: "runtime-1",
      pageId: "page-1", frameId: "frame-root", documentId: "document-1", documentEpoch: 1,
      backendNodeId: 7, sessionId: "public-alias",
    };
    if (method === "ref.release") return true;
    if (method === "ref.bindGroup") return {
      version: "scoped-v1", kind: "drag", token: "group-token", expiresAt: 10_000, runtimeId: "runtime-1",
      pageId: "page-1", frameId: "frame-root", documentId: "document-1", documentEpoch: 1,
      source: { refId: 100, backendNodeId: 7 }, target: { refId: 101, backendNodeId: 8 }, sessionId: "public-alias",
    };
    if (method === "cdp.send") {
      throw Object.assign(new Error("reference expired"), {
        code: "EGO_REFERENCE_STALE",
        data: { retry: "resnapshot", delivery: "not_sent" },
      });
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const backend = new ElectronDesktopBackend(pipe);
  try {
    await server.listen(pipe);
    assert.equal((await backend.status()).referenceActionMaxLifetimeMs, 300_000);
    const mutation = { clientId: "agent-1", taskSpaceId: 3, leaseEpoch: 4 };
    const snapshotContext = { clientId: "agent-1", taskSpaceId: 3, leaseEpoch: 4, refFormat: "scoped-v1" as const };
    await backend.snapshot("task-1", {}, "page-1", snapshotContext);
    const targetedEvent = new Promise<{ taskId: string; payload: string; clientId?: string }>((resolve) => {
      const unsubscribe = backend.onCdpMessage((taskId, payload, clientId) => {
        unsubscribe();
        resolve({ taskId, payload, ...(clientId ? { clientId } : {}) });
      });
    });
    server.notify("cdp.event", { taskId: "task-1", clientId: "agent-1", payload: "targeted-event" });
    assert.deepEqual(await targetedEvent, { taskId: "task-1", payload: "targeted-event", clientId: "agent-1" });
    const legacyEvent = new Promise<{ taskId: string; payload: string; clientId?: string }>((resolve) => {
      const unsubscribe = backend.onCdpMessage((taskId, payload, clientId) => {
        unsubscribe();
        resolve({ taskId, payload, ...(clientId ? { clientId } : {}) });
      });
    });
    server.notify("cdp.event", { taskId: "task-1", payload: "legacy-event" });
    assert.deepEqual(await legacyEvent, { taskId: "task-1", payload: "legacy-event" });
    const binding = await backend.bindReferenceAction!("task-1", {
      ref: { refId: 9, runtimeId: "runtime-1" }, expectedScope: { pageId: "page-1" }, deadlineAt: 9_000,
    }, mutation);
    const group = await backend.bindReferenceActionGroup("task-1", { kind: "drag",
      source: { refId: 100, runtimeId: "runtime-1" }, target: { refId: 101, runtimeId: "runtime-1" }, expectedScope: { pageId: "page-1" },
    }, mutation);
    assert.equal(group.kind, "drag");
    assert.equal(group.target.backendNodeId, 8);
    assert.deepEqual(calls.find((call) => call.method === "ref.bindGroup")?.params.__egoMutation, mutation);
    await backend.releaseReferenceAction!("task-1", binding, mutation);
    await assert.rejects(
      backend.sendCdp("task-1", JSON.stringify({ id: 1, method: "Input.insertText", params: { text: "x" } }), mutation, {
        clientId: "agent-1",
        refFormat: "scoped-v1",
        refAction: binding,
      }),
      (error: Error & { code?: string; error_code?: string; data?: { retry?: string } }) => error.code === "EGO_REFERENCE_STALE"
        && error.error_code === "EGO_REFERENCE_STALE" && error.data?.retry === "resnapshot",
    );
    assert.equal((calls.find((call) => call.method === "page.snapshot")?.params.__egoRequestContext as { refFormat?: string })?.refFormat, "scoped-v1");
    assert.equal((calls.find((call) => call.method === "ref.bind")?.params.__egoMutation as { clientId?: string })?.clientId, "agent-1");
    assert.equal((calls.find((call) => call.method === "cdp.send")?.params.__egoRequestContext as { refAction?: { token?: string } })?.refAction?.token, "token-1");
    assert.ok(calls.every((call) => call.params.__egoBridgeToken === process.env.EGO_DESKTOP_CONTROL_TOKEN));
  } finally {
    await backend.dispose();
    await server.close().catch(() => {});
    if (previousToken === undefined) delete process.env.EGO_DESKTOP_CONTROL_TOKEN;
    else process.env.EGO_DESKTOP_CONTROL_TOKEN = previousToken;
  }
});
