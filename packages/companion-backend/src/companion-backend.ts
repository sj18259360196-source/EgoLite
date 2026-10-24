import type { BrowserBackend } from "@ego-compat/broker-core";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type AIPageContent,
  type BrowserBackendStatus,
  EgoProtocolError,
  type PublicTab,
  type SnapshotOptions,
  type SnapshotResult,
  type TaskSpaceRecord,
  type TextSelection,
} from "@ego-compat/protocol";

import { CompanionBridgeServer } from "./companion-bridge.ts";

export class CompanionBackend implements BrowserBackend {
  readonly #listeners = new Set<(taskId: string, payload: string) => void>();
  readonly #controlListeners = new Set<(taskId: string, reason: string) => void>();
  readonly #takeoverListeners = new Set<(taskId: string) => void>();
  readonly #tabListeners = new Set<(taskId: string, tab: PublicTab) => void>();
  readonly #selectionListeners = new Set<(taskId: string, selection: TextSelection) => void>();
  readonly #bridge: CompanionBridgeServer;
  readonly #pipeName: string;
  readonly #relayPath: string | undefined;
  readonly #externalPipeName: string | undefined;
  #relay: ChildProcess | undefined;
  #started = false;
  #unsubscribe: (() => void) | undefined;
  #reconciled!: Promise<void>;
  #resolveReconciled: (() => void) | undefined;
  #hasReconciled = false;
  #uiRequestHandler: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined;

  constructor(
    pipeName = "\\\\.\\pipe\\ego-compat-companion",
    authSecret?: Buffer,
    relayPath?: string,
  ) {
    this.#externalPipeName = relayPath ? pipeName : undefined;
    this.#pipeName = relayPath
      ? `\\\\.\\pipe\\ego-compat-internal-${process.pid}-${randomUUID()}`
      : pipeName;
    this.#relayPath = relayPath;
    this.#bridge = new CompanionBridgeServer(authSecret);
    this.#bridge.setRequestHandler(async (method, params) => {
      if (!this.#uiRequestHandler) {
        throw new EgoProtocolError("EGO_BROWSER_UNAVAILABLE", "Broker UI handler is unavailable");
      }
      return this.#uiRequestHandler(method, params);
    });
    this.#resetReconciliation();
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await this.#bridge.listen(this.#pipeName);
    if (this.#relayPath && this.#externalPipeName) {
      await this.#startRelay(this.#relayPath, this.#externalPipeName, this.#pipeName);
    }
    this.#unsubscribe = this.#bridge.onEvent(({ method, params }) => {
      if (process.env.EGO_DEBUG_COMPANION === "1") {
        console.error("[companion:event]", method, params);
      }
      if (method === "bridge.connected") {
        if (!this.#resolveReconciled) this.#resetReconciliation();
        return;
      }
      if (method === "bridge.disconnected") {
        this.#resetReconciliation();
        return;
      }
      if (method === "control.lost" || method === "bridge.ready") {
        const reason = typeof params.reason === "string" ? params.reason : "extension-reconnected";
        const taskIds = method === "bridge.ready" ? params.recoveredTaskIds : [params.taskId];
        if (Array.isArray(taskIds)) {
          for (const taskId of taskIds) {
            if (typeof taskId !== "string") continue;
            for (const listener of this.#controlListeners) listener(taskId, reason);
          }
        }
        if (method === "bridge.ready") {
          this.#hasReconciled = true;
          this.#resolveReconciled?.();
          this.#resolveReconciled = undefined;
        }
        return;
      }
      if (method === "control.takeoverAuthorized") {
        const taskId = params.taskId;
        if (typeof taskId === "string") {
          for (const listener of this.#takeoverListeners) listener(taskId);
        }
        return;
      }
      if (method === "tab.changed") {
        const taskId = params.taskId;
        const tab = params.tab as PublicTab | undefined;
        if (typeof taskId === "string" && tab) {
          for (const listener of this.#tabListeners) listener(taskId, tab);
        }
        return;
      }
      if (method === "text.selectionChanged") {
        const taskId = params.taskId;
        const selection = params.selection as TextSelection | undefined;
        if (typeof taskId === "string" && selection) {
          for (const listener of this.#selectionListeners) listener(taskId, selection);
        }
        return;
      }
      if (method !== "cdp.event") return;
      const taskId = params.taskId;
      const payload = params.payload;
      if (typeof taskId !== "string" || typeof payload !== "string") return;
      for (const listener of this.#listeners) listener(taskId, payload);
    });
    this.#started = true;
  }

  async status(): Promise<BrowserBackendStatus> {
    await this.start();
    const connected = this.#bridge.connected;
    return {
      kind: "companion",
      ready: connected && this.#hasReconciled,
      connected,
      reconciled: this.#hasReconciled,
      message: !connected
        ? "Ego Companion extension is not connected. Load or enable the Ego extension in the current Edge/Chrome profile."
        : !this.#hasReconciled
          ? "Ego Companion extension is connected but browser state reconciliation is still pending."
          : "Ego Companion is ready and can reuse the current browser profile.",
    };
  }

  onControlLost(listener: (taskId: string, reason: string) => void): () => void {
    this.#controlListeners.add(listener);
    return () => this.#controlListeners.delete(listener);
  }

  onTakeoverAuthorized(listener: (taskId: string) => void): () => void {
    this.#takeoverListeners.add(listener);
    return () => this.#takeoverListeners.delete(listener);
  }

  onCdpMessage(listener: (taskId: string, payload: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onTabChanged(listener: (taskId: string, tab: PublicTab) => void): () => void {
    this.#tabListeners.add(listener);
    return () => this.#tabListeners.delete(listener);
  }

  onTextSelectionChanged(
    listener: (taskId: string, selection: TextSelection) => void,
  ): () => void {
    this.#selectionListeners.add(listener);
    return () => this.#selectionListeners.delete(listener);
  }

  setUiRequestHandler(
    handler: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.#uiRequestHandler = handler;
  }

  async createSpace(space: TaskSpaceRecord): Promise<void> {
    await this.start();
    await this.#waitForReconciliation();
    await this.#bridge.request("space.create", { taskId: space.taskId, name: space.name, profileId: space.profileId || "default" });
  }

  async closeSpace(taskId: string): Promise<void> {
    await this.#waitForReconciliation();
    await this.#bridge.request("space.close", { taskId });
  }

  async listTabs(taskId: string): Promise<PublicTab[]> {
    await this.#waitForReconciliation();
    return (await this.#bridge.request("tab.list", { taskId })) as PublicTab[];
  }

  async createTab(taskId: string, url = "about:blank"): Promise<PublicTab> {
    await this.#waitForReconciliation();
    return (await this.#bridge.request("tab.create", { taskId, url })) as PublicTab;
  }

  async snapshot(
    taskId: string,
    options: SnapshotOptions = {},
    targetId?: string,
  ): Promise<SnapshotResult> {
    await this.#waitForReconciliation();
    return (await this.#bridge.request("snapshot.capture", {
      taskId,
      options,
      targetId,
    })) as SnapshotResult;
  }

  async getAIPageContent(
    taskId: string,
    targetId: string,
    options: SnapshotOptions = {},
  ): Promise<AIPageContent> {
    await this.#waitForReconciliation();
    return (await this.#bridge.request("page.aiContent", {
      taskId,
      targetId,
      options,
    })) as AIPageContent;
  }

  async sendCdp(taskId: string, payload: string): Promise<string> {
    await this.#waitForReconciliation();
    const response = await this.#bridge.request("cdp.send", { taskId, payload });
    if (typeof response !== "string") {
      throw new EgoProtocolError("EGO_INVALID_RESULT_PAYLOAD", "Companion returned invalid CDP");
    }
    return response;
  }

  async relinquishControl(taskId: string): Promise<void> {
    await this.#waitForReconciliation();
    await this.#bridge.request("space.handoff", { taskId });
  }

  async prepareControl(_taskId: string): Promise<void> {
    await this.#waitForReconciliation();
  }

  async updateSpaceState(space: TaskSpaceRecord): Promise<void> {
    await this.#waitForReconciliation();
    await this.#bridge.request("space.state", {
      taskId: space.taskId,
      ownership: space.ownership,
      lifecycle: space.lifecycle,
      leaseEpoch: space.leaseEpoch,
    });
  }

  async dispose(): Promise<void> {
    this.#unsubscribe?.();
    if (this.#started) await this.#bridge.close();
    this.#relay?.kill();
    this.#relay = undefined;
    this.#started = false;
  }

  async #waitForReconciliation(): Promise<void> {
    const timeoutMs = this.#hasReconciled ? 3_000 : 10_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#reconciled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new EgoProtocolError(
              "EGO_BROWSER_UNAVAILABLE",
              this.#bridge.connected
                ? "Companion extension connected but reconciliation timed out"
                : "Companion extension is not connected; enable the Ego extension in Edge or Chrome",
            )),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #resetReconciliation(): void {
    this.#reconciled = new Promise<void>((resolve) => {
      this.#resolveReconciled = resolve;
    });
  }

  #startRelay(executable: string, externalPipe: string, internalPipe: string): Promise<void> {
    const external = pipeLeaf(externalPipe);
    const internal = pipeLeaf(internalPipe);
    const relay = spawn(executable, ["--pipe-relay", "--external", external, "--internal", internal], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#relay = relay;
    return new Promise((resolve, reject) => {
      let output = "";
      let errorOutput = "";
      const timer = setTimeout(() => {
        relay.kill();
        reject(new Error("Companion SID-only pipe relay did not start"));
      }, 10_000);
      relay.stderr?.setEncoding("utf8");
      relay.stderr?.on("data", (chunk) => (errorOutput += chunk));
      relay.stdout?.setEncoding("utf8");
      relay.stdout?.on("data", (chunk) => {
        output += chunk;
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          const status = JSON.parse(output.slice(0, newline)) as {
            ready?: boolean;
            protectedAcl?: boolean;
            allowedSids?: string[];
          };
          if (!status.ready || !status.protectedAcl || status.allowedSids?.length !== 2) {
            throw new Error("Relay did not confirm its protected ACL");
          }
          resolve();
        } catch (error) {
          relay.kill();
          reject(error);
        }
      });
      relay.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      relay.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== null) reject(new Error(`Companion relay exited ${code}: ${errorOutput}`));
      });
    });
  }
}

function pipeLeaf(value: string): string {
  const prefix = "\\\\.\\pipe\\";
  if (!value.startsWith(prefix)) throw new Error(`Invalid Windows pipe path: ${value}`);
  return value.slice(prefix.length);
}
