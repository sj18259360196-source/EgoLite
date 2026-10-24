import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { resolveAgentClientId } from "../../../packages/runtime-adapter/src/agent-identity.ts";
import {
  createEgoRuntime,
  type LeaseAwareEgoRuntime,
  PipeRuntimeTransport,
  PROTOCOL_VERSION,
  SCOPED_REFS_CAPABILITY,
} from "../../../packages/runtime-adapter/src/index.ts";
import type { SnapshotOptions, SnapshotResult } from "../../../packages/protocol/src/types.ts";

export class DesktopRpcClient {
  readonly clientId = resolveAgentClientId();
  #broker: PipeRuntimeTransport | undefined;
  #registration: Promise<void> | undefined;
  #scopedRuntime: LeaseAwareEgoRuntime | undefined;
  readonly pipeName: string;
  #socket: Socket | undefined;
  #connecting: Promise<Socket> | undefined;
  #dialingSocket: Socket | undefined;
  #cancelDial: ((error: Error) => void) | undefined;
  #cancelRetry: ((error: Error) => void) | undefined;
  #reconnectListeners = new Set<() => void>();
  #generation = 0;
  #closed = false;
  #pending = new Map<string, {
    generation: number;
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();

  constructor(pipeName: string) {
    this.pipeName = pipeName;
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === "desktop.status" || method === "control.request" || method.startsWith("page.") || method.startsWith("tabs.") || method === "cdp.send") {
      await this.#ensureAgentRegistration();
      await this.#broker!.request("agent.heartbeat", { clientId: this.clientId });
    }
    const mutation = ["tabs.create", "tabs.activate", "tabs.close", "page.click", "page.fill", "page.hover", "page.press", "page.type", "page.scroll", "page.evaluate", "page.goto", "page.navigate", "cdp.send"].includes(method);
    if (mutation) {
      const context = await this.request<{ taskId: string; leaseEpoch: number }>("mutation.context", params);
      params = { ...params, taskId: context.taskId, __egoMutation: context };
    }
    const socket = await this.#ensureConnected();
    const id = randomUUID();
    const generation = this.#generation;
    const requestParams = { ...params, __egoSource: "desktop-mcp", __egoClientId: this.clientId };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        generation,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: requestParams })}\n`, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        this.#disconnect(socket, generation, error);
        reject(error);
      });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const closedError = new Error("Desktop RPC client closed");
    this.#cancelDial?.(closedError);
    this.#cancelRetry?.(closedError);
    this.#dialingSocket?.destroy();
    this.#dialingSocket = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.destroy();
    this.#failAll(closedError);
    this.#reconnectListeners.clear();
    void this.#broker?.close();
  }

  async captureScopedSnapshot(options: SnapshotOptions): Promise<SnapshotResult | null> {
    await this.#ensureAgentRegistration();
    if (!this.#broker!.negotiatedCapabilities.includes(SCOPED_REFS_CAPABILITY)) return null;
    const visible = await this.#visiblePage();
    const observed = await this.#broker!.request<{ snapshot?: SnapshotResult }>("space.observe", {
      clientId: this.clientId,
      id: visible.taskSpaceId,
      targetId: visible.targetId,
      options,
      refFormat: "scoped-v1",
    });
    if (!observed.snapshot) throw scopedClientError("Visible page snapshot is unavailable", "EGO_REFERENCE_STALE");
    if (observed.snapshot.pageId && observed.snapshot.pageId !== visible.targetId) {
      throw scopedClientError("Visible page changed while taking the snapshot", "EGO_ACTION_SCOPE_MISMATCH");
    }
    return observed.snapshot;
  }

  async prepareScopedAction(expectedPageId: string): Promise<{
    runtime: LeaseAwareEgoRuntime;
    targetId: string;
  } | null> {
    await this.#ensureAgentRegistration();
    if (!this.#broker!.negotiatedCapabilities.includes(SCOPED_REFS_CAPABILITY)) return null;
    const visible = await this.#visiblePage();
    if (visible.targetId !== expectedPageId) {
      throw scopedClientError("Visible page changed; take a new snapshot", "EGO_REFERENCE_STALE");
    }
    const mutation = await this.request<{
      taskId: string;
      taskSpaceId: number;
      leaseEpoch: number;
    }>("mutation.context");
    if (mutation.taskId !== visible.taskId || mutation.taskSpaceId !== visible.taskSpaceId) {
      throw scopedClientError("Visible page task changed before the action", "EGO_ACTION_SCOPE_MISMATCH");
    }
    await this.#scopedRuntime!.useTaskSpace(visible.taskSpaceId);
    const current = await this.#visiblePage();
    if (current.taskId !== visible.taskId || current.targetId !== visible.targetId) {
      throw scopedClientError("Visible page changed before the action", "EGO_ACTION_SCOPE_MISMATCH");
    }
    return { runtime: this.#scopedRuntime!, targetId: visible.targetId };
  }

  #ensureAgentRegistration(): Promise<void> {
    if (this.#registration) return this.#registration;
    this.#registration = (async () => {
      const broker = await PipeRuntimeTransport.connect(process.env.EGO_COMPAT_PIPE || process.env.EGO_DESKTOP_PIPE || "\\\\.\\pipe\\ego-compat-desktop-broker");
      if (this.#closed) { await broker.close(); throw new Error("Desktop RPC client closed"); }
      this.#broker = broker;
      await broker.negotiateHello({
        protocolVersion: PROTOCOL_VERSION,
        clientId: this.clientId,
        pid: process.pid,
        sdkVersion: "ego-desktop-mcp-server",
        clientKind: this.clientId.startsWith("codex-") ? "codex" : "other",
        displayName: "Desktop MCP",
        version: "ego-desktop-mcp-server",
        capabilities: [SCOPED_REFS_CAPABILITY],
      });
      await broker.request("agent.register", { clientId: this.clientId, displayName: "Desktop MCP", clientKind: this.clientId.startsWith("codex-") ? "codex" : "other" });
      this.#scopedRuntime = createEgoRuntime(broker, {
        clientId: this.clientId,
        capabilities: () => broker.negotiatedCapabilities,
        referenceActionMaxLifetimeMs: () => broker.referenceActionMaxLifetimeMs,
      });
    })().catch(async (error) => {
      await this.#broker?.close();
      this.#broker = undefined;
      this.#scopedRuntime = undefined;
      this.#registration = undefined;
      throw error;
    });
    return this.#registration;
  }

  async #visiblePage(): Promise<{ taskId: string; taskSpaceId: number; targetId: string }> {
    const status = await this.request<{
      visible?: { taskId?: unknown; taskSpaceId?: unknown; targetId?: unknown };
    }>("desktop.status");
    const visible = status.visible;
    if (typeof visible?.taskId !== "string" || !visible.taskId
      || typeof visible.taskSpaceId !== "number" || !Number.isSafeInteger(visible.taskSpaceId)
      || typeof visible.targetId !== "string" || !visible.targetId) {
      throw scopedClientError("Ego desktop has no exact visible page", "EGO_WEB_CONTENTS_UNAVAILABLE");
    }
    return {
      taskId: visible.taskId,
      taskSpaceId: visible.taskSpaceId,
      targetId: visible.targetId,
    };
  }

  onReconnect(listener: () => void): () => void {
    this.#reconnectListeners.add(listener);
    return () => this.#reconnectListeners.delete(listener);
  }

  #ensureConnected(): Promise<Socket> {
    if (this.#closed) return Promise.reject(new Error("Desktop RPC client closed"));
    if (this.#socket && !this.#socket.destroyed && !this.#socket.writableEnded) {
      return Promise.resolve(this.#socket);
    }
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connectWithRetry().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connectWithRetry(): Promise<Socket> {
    const deadline = Date.now() + 5_000;
    let delay = 50;
    let lastError = new Error(`Unable to connect to ${this.pipeName}`);
    while (!this.#closed) {
      try {
        return await this.#connectOnce();
      } catch (error) {
        if (this.#closed) throw new Error("Desktop RPC client closed");
        lastError = error instanceof Error ? error : new Error(String(error));
        if (Date.now() >= deadline) throw lastError;
        await this.#waitForRetry(delay);
        delay = Math.min(delay * 2, 400);
      }
    }
    throw new Error("Desktop RPC client closed");
  }

  #connectOnce(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.pipeName);
      this.#dialingSocket = socket;
      let settled = false;
      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
        if (this.#dialingSocket === socket) this.#dialingSocket = undefined;
        if (this.#cancelDial === fail) this.#cancelDial = undefined;
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onError = (error: Error) => {
        fail(error);
      };
      const onClose = () => fail(new Error("Ego desktop connection closed while connecting"));
      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.#closed) {
          socket.destroy();
          reject(new Error("Desktop RPC client closed"));
          return;
        }
        resolve(this.#attach(socket));
      };
      this.#cancelDial = fail;
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("connect", onConnect);
    });
  }

  #waitForRetry(delay: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#cancelRetry = undefined;
        resolve();
      }, delay);
      this.#cancelRetry = (error) => {
        clearTimeout(timer);
        this.#cancelRetry = undefined;
        reject(error);
      };
    });
  }

  #attach(socket: Socket): Socket {
    const generation = ++this.#generation;
    this.#socket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.#dispatch(JSON.parse(line) as {
            id?: string;
            result?: unknown;
            error?: { message: string; code?: string | number; data?: unknown };
          }, generation);
        } catch (error) {
          const reason = error instanceof Error ? error : new Error(String(error));
          socket.destroy();
          this.#disconnect(socket, generation, reason);
          return;
        }
      }
    });
    socket.on("error", (error) => this.#disconnect(socket, generation, error));
    socket.on("close", () => this.#disconnect(socket, generation, new Error("Ego desktop connection closed")));
    if (generation > 1) {
      for (const listener of this.#reconnectListeners) {
        try {
          listener();
        } catch {
          // One listener must not break the connection.
        }
      }
    }
    return socket;
  }

  #dispatch(response: {
    id?: string;
    result?: unknown;
    error?: { message: string; code?: string | number; data?: unknown };
  }, generation: number): void {
    if (!response.id) return;
    const pending = this.#pending.get(response.id);
    if (!pending || pending.generation !== generation) return;
    this.#pending.delete(response.id);
    if (response.error) {
      pending.reject(Object.assign(new Error(response.error.message), {
        error_code: response.error.code,
        data: response.error.data,
      }));
    } else {
      pending.resolve(response.result);
    }
  }

  #failAll(error: Error, generation?: number): void {
    for (const [id, pending] of this.#pending) {
      if (generation !== undefined && pending.generation !== generation) continue;
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  #disconnect(socket: Socket, generation: number, error: Error): void {
    this.#failAll(error, generation);
    if (this.#socket !== socket || this.#generation !== generation) return;
    this.#socket = undefined;
  }
}

function scopedClientError(message: string, error_code: string): Error {
  return Object.assign(new Error(message), { error_code });
}
