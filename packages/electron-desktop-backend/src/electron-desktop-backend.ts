import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

import type { BrowserBackend, MutationContext, SnapshotRequestContext } from "@ego-compat/broker-core";
import type {
  AIPageContent,
  BrowserBackendStatus,
  CdpRequestContext,
  PublicTab,
  ReferenceActionBinding,
  ReferenceActionBindRequest,
  ReferenceActionGroupBinding,
  ReferenceActionGroupBindRequest,
  ReferenceActionWire,
  SnapshotOptions,
  SnapshotResult,
  TaskSpaceRecord,
} from "@ego-compat/protocol";

export class ElectronDesktopBackend implements BrowserBackend {
  readonly #client: DesktopBridgeClient;
  readonly #cdpListeners = new Set<(taskId: string, payload: string, clientId?: string) => void>();
  readonly #tabListeners = new Set<(taskId: string, tab: PublicTab) => void>();

  constructor(pipeName = "\\\\.\\pipe\\ego-compat-desktop") {
    this.#client = new DesktopBridgeClient(pipeName);
    this.#client.onNotification((method, params) => {
      if (method === "cdp.event" && typeof params.taskId === "string" && typeof params.payload === "string") {
        const recipient = typeof params.clientId === "string" ? params.clientId : undefined;
        for (const listener of this.#cdpListeners) listener(params.taskId, params.payload, recipient);
      }
      if (method === "tab.changed" && typeof params.taskId === "string" && params.tab && typeof params.tab === "object") {
        for (const listener of this.#tabListeners) listener(params.taskId, params.tab as PublicTab);
      }
    });
  }

  async status(): Promise<BrowserBackendStatus> {
    try {
      return await this.#client.request<BrowserBackendStatus>("desktop.status");
    } catch (error) {
      return { kind: "desktop", ready: false, connected: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  automationRequest(taskId: string, operation: string, input: Record<string, unknown>, mutation: MutationContext): Promise<unknown> {
    return this.#client.request("automation.request", { taskId, operation, input, __egoMutation: mutation });
  }

  async createSpace(space: TaskSpaceRecord, options: { visualSync?: boolean } = {}): Promise<void> {
    await this.#client.request("space.create", { taskId: space.taskId, name: space.name, profileId: space.profileId || "default", visualSync: options.visualSync === true });
  }

  async closeSpace(taskId: string, options: { visualSync?: boolean } = {}): Promise<void> {
    await this.#client.request("space.close", { taskId, visualSync: options.visualSync === true });
  }

  listTabs(taskId: string): Promise<PublicTab[]> {
    return this.#client.request("tabs.list", { taskId });
  }

  createTab(taskId: string, url = "about:blank", mutation?: MutationContext): Promise<PublicTab> {
    return this.#client.request("tabs.create", { taskId, url, __egoMutation: mutation });
  }

  snapshot(taskId: string, options: SnapshotOptions = {}, targetId?: string, context?: SnapshotRequestContext): Promise<SnapshotResult> {
    return this.#client.request("page.snapshot", { taskId, targetId, options, __egoRequestContext: context });
  }

  async getAIPageContent(taskId: string, targetId: string, options: SnapshotOptions = {}): Promise<AIPageContent> {
    const [tab, snapshot] = await Promise.all([
      this.listTabs(taskId).then((tabs) => tabs.find((item) => item.targetId === targetId)),
      this.snapshot(taskId, options, targetId),
    ]);
    if (!tab) throw new Error(`Unknown desktop target: ${targetId}`);
    return {
      title: tab.title,
      url: tab.url,
      ...snapshot,
      rootNode: {
        attributeType: 0,
        children: snapshot.content
          ? [{ attributeType: 5, textInfo: { textContent: snapshot.content }, children: [] }]
          : [],
      },
    };
  }

  bindReferenceAction(
    taskId: string,
    request: ReferenceActionBindRequest,
    mutation: MutationContext,
  ): Promise<ReferenceActionBinding> {
    return this.#client.request("ref.bind", { taskId, request, __egoMutation: mutation });
  }

  async releaseReferenceAction(
    taskId: string,
    refAction: ReferenceActionWire,
    mutation: MutationContext,
  ): Promise<void> {
    await this.#client.request("ref.release", { taskId, refAction, __egoMutation: mutation });
  }

  bindReferenceActionGroup(taskId: string, request: ReferenceActionGroupBindRequest, mutation: MutationContext): Promise<ReferenceActionGroupBinding> {
    return this.#client.request("ref.bindGroup", { taskId, request, __egoMutation: mutation });
  }

  sendCdp(
    taskId: string,
    payload: string,
    mutation?: MutationContext,
    context?: CdpRequestContext,
  ): Promise<string> {
    return this.#client.request("cdp.send", {
      taskId,
      payload,
      __egoMutation: mutation,
      __egoRequestContext: context,
    });
  }

  async prepareControl(taskId: string): Promise<void> {
    await this.#client.request("space.select", { taskId, visualSync: true });
  }
  async relinquishControl(_taskId: string): Promise<void> {}
  async updateSpaceState(space: TaskSpaceRecord): Promise<void> {
    await this.#client.request("space.updateState", { space });
  }
  async dispose(): Promise<void> { this.#client.close(); }

  onCdpMessage(listener: (taskId: string, payload: string, clientId?: string) => void): () => void {
    this.#cdpListeners.add(listener);
    return () => this.#cdpListeners.delete(listener);
  }

  onTabChanged(listener: (taskId: string, tab: PublicTab) => void): () => void {
    this.#tabListeners.add(listener);
    return () => this.#tabListeners.delete(listener);
  }
}

class DesktopBridgeClient {
  readonly #pipeName: string;
  #socket: Socket | undefined;
  #buffer = "";
  #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  #notificationListeners = new Set<(method: string, params: Record<string, unknown>) => void>();

  constructor(pipeName: string) {
    this.#pipeName = pipeName;
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.#socket || this.#socket.destroyed) await this.#connect();
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#socket!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, __egoBridgeToken: process.env.EGO_DESKTOP_CONTROL_TOKEN } })}\n`, (error) => {
        if (error) this.#fail(error);
      });
    });
  }

  close(): void { this.#socket?.destroy(); }

  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  #connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.#pipeName);
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        this.#socket = socket;
        socket.on("data", (chunk: string) => this.#receive(chunk));
        socket.on("error", (error) => this.#fail(error));
        socket.on("close", () => this.#fail(new Error("Ego desktop bridge closed")));
        resolve();
      });
    });
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line) as { id?: string; result?: unknown; error?: { code?: string; message: string; data?: unknown } };
      if (!response.id) {
        const notification = response as unknown as { method?: string; params?: Record<string, unknown> };
        if (notification.method) {
          for (const listener of this.#notificationListeners) listener(notification.method, notification.params ?? {});
        }
        continue;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) continue;
      this.#pending.delete(response.id);
      if (response.error) {
        const error = Object.assign(new Error(response.error.message), {
          code: response.error.code,
          error_code: response.error.code,
          data: response.error.data,
        });
        pending.reject(error);
      }
      else pending.resolve(response.result);
    }
  }

  #fail(error: Error): void {
    this.#socket = undefined;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
