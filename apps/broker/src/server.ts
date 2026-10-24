import { createServer, type Server, type Socket } from "node:net";
import { timingSafeEqual, randomUUID } from "node:crypto";

import { BrokerCore, FakeBrowserBackend, TaskSpaceService, inferAgentClientKind, canonicalAgentClientId } from "@ego-compat/broker-core";
import {
  EgoProtocolError,
  PROTOCOL_VERSION,
  SCOPED_REFS_CAPABILITY,
  type AgentClientKind,
  type AgentInfo,
  type AgentRegistration,
  type CodexOperationRecord,
  type RpcFailure,
  type RpcRequest,
  type RpcSuccess,
  type RefFormat,
  type ReferenceActionBindRequest,
  type ReferenceActionGroupBindRequest,
  type ReferenceActionWire,
} from "@ego-compat/protocol";
import type { ChatAttachment, ChatProvider } from "./chat-provider.ts";
import type { CodexAgentProvider, CodexImageAttachment } from "./codex-agent.ts";
import type { CodexOperationStore } from "./sqlite-task-store.ts";

export const DEFAULT_PIPE_NAME = "\\\\.\\pipe\\ego-compat-dev";
const MAX_RPC_FRAME_LENGTH = 32 * 1024 * 1024;
const AGENT_SWEEP_INTERVAL_MS = 10_000;
const BASE_CAPABILITIES = ["task-spaces", "cdp", "agent-registry", "user-control"];

export interface BrokerPipeServerOptions {
  desktopControlToken?: string;
}

export class BrokerPipeServer {
  readonly #server: Server;
  readonly #broker: BrokerCore;
  readonly #sockets = new Set<Socket>();
  readonly #clientSockets = new Map<string, Socket>();
  readonly #socketClientIds = new WeakMap<Socket, string>();
  readonly #socketCapabilities = new WeakMap<Socket, ReadonlySet<string>>();
  readonly #trustedDesktopSockets = new WeakSet<Socket>();
  readonly #desktopControlToken: string | undefined;
  readonly #clientsByTask = new Map<string, Set<string>>();
  readonly #unsubscribeCdp: (() => void) | undefined;
  readonly #unsubscribeTabChanged: (() => void) | undefined;
  readonly #unsubscribeTextSelection: (() => void) | undefined;
  readonly #chatProvider: ChatProvider | undefined;
  readonly #codexAgent: CodexAgentProvider | undefined;
  readonly #operationStore: CodexOperationStore | undefined;
  readonly #activeChatStreams = new Map<string, { controller: AbortController; socket: Socket }>();
  readonly #activeCodexStreams = new Map<string, { controller: AbortController; socket: Socket; threadId?: string }>();
  readonly #activeCodexThreads = new Map<string, string>();
  readonly #unsubscribeAgents: (() => void) | undefined;
  readonly #unsubscribeSpaces: (() => void) | undefined;
  readonly #unsubscribeControl: () => void;
  readonly #unsubscribeLeaseRevoked: (() => void) | undefined;
  readonly #agentSweep: NodeJS.Timeout | undefined;

  constructor(
    broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend()),
    chatProvider?: ChatProvider,
    codexAgent?: CodexAgentProvider,
    operationStore?: CodexOperationStore,
    options: BrokerPipeServerOptions = {},
  ) {
    this.#broker = broker;
    this.#chatProvider = chatProvider;
    this.#codexAgent = codexAgent;
    this.#operationStore = operationStore;
    this.#desktopControlToken = normalizeControlToken(options.desktopControlToken);
    this.#server = createServer((socket) => this.#accept(socket));
    this.#unsubscribeControl = broker.onControlChanged((state) => {
      this.#broadcast("space.controlChanged", { ...state });
    });
    this.#unsubscribeCdp = broker.backend.onCdpMessage?.((taskId, payload, recipientClientId) => {
      if (recipientClientId) {
        const socket = this.#clientSockets.get(recipientClientId);
        if (socket && !socket.destroyed && this.#clientsByTask.get(taskId)?.has(recipientClientId)) {
          this.#writeEvent(socket, "cdp.message", payload);
        }
        return;
      }
      for (const clientId of this.#clientsByTask.get(taskId) ?? []) {
        const socket = this.#clientSockets.get(clientId);
        if (socket && !socket.destroyed) {
          this.#writeEvent(socket, "cdp.message", payload);
        }
      }
    });
    this.#unsubscribeTabChanged = broker.backend.onTabChanged?.((taskId, tab) => {
      const event = JSON.stringify({
        jsonrpc: "2.0",
        method: "tab.changed",
        params: { ...tab, id: tab.targetId, taskId },
      });
      for (const socket of this.#sockets) {
        if (!socket.destroyed) socket.write(`${event}\n`);
      }
    });
    this.#unsubscribeTextSelection = broker.backend.onTextSelectionChanged?.((_taskId, selection) => {
      const event = JSON.stringify({
        jsonrpc: "2.0",
        method: "text.selectionChanged",
        params: selection,
      });
      for (const socket of this.#sockets) {
        if (!socket.destroyed) socket.write(`${event}\n`);
      }
    });
    broker.backend.setUiRequestHandler?.((method, params) => this.#dispatchUi(method, params));
    this.#unsubscribeAgents = broker.agents.onEvent((event) => {
      if (event.type === "disconnected") {
        void broker.externalAgentDisconnected(event.agent.clientId).catch((error) => {
          console.warn("Agent disconnect state could not be synchronized with the browser", error);
        });
      }
      this.#broadcast(event.type === "disconnected" ? "agent.disconnected" : "agent.changed", {
        agent: event.agent,
      });
    });
    this.#unsubscribeSpaces = broker.onSpaceChanged((event) => {
      if (event.removed) this.#clientsByTask.delete(event.space.taskId);
      this.#broadcast("space.changed", {
        space: event.space,
        ...(event.removed ? { removed: true } : {}),
      });
    });
    this.#unsubscribeLeaseRevoked = broker.onLeaseRevoked((event) => {
      const socket = this.#clientSockets.get(event.clientId);
      if (socket && !socket.destroyed) {
        this.#writeEvent(socket, "lease.revoked", {
          taskId: event.taskId,
          taskSpaceId: this.#spaceIdByTaskId(event.taskId),
          leaseEpoch: event.leaseEpoch,
        });
      }
    });
    this.#agentSweep = setInterval(() => {
      this.#broker.agents.sweep();
    }, AGENT_SWEEP_INTERVAL_MS);
    this.#agentSweep.unref?.();
  }

  get broker(): BrokerCore {
    return this.#broker;
  }

  listen(pipeName = DEFAULT_PIPE_NAME): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(pipeName, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const stream of this.#activeChatStreams.values()) stream.controller.abort();
      this.#activeChatStreams.clear();
      for (const stream of this.#activeCodexStreams.values()) stream.controller.abort();
      this.#activeCodexStreams.clear();
      this.#activeCodexThreads.clear();
      for (const socket of this.#sockets) socket.destroy();
      this.#unsubscribeCdp?.();
      this.#unsubscribeTabChanged?.();
      this.#unsubscribeTextSelection?.();
      this.#unsubscribeAgents?.();
      this.#unsubscribeSpaces?.();
      this.#unsubscribeControl();
      this.#unsubscribeLeaseRevoked?.();
      if (this.#agentSweep) clearInterval(this.#agentSweep);
      this.#server.close((error) => {
        if (error) return reject(error);
        this.#broker.dispose();
        const dispose = this.#broker.backend.dispose;
        if (!dispose) {
          resolve();
          return;
        }
        void dispose.call(this.#broker.backend).then(resolve, reject);
      });
    });
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    // Peer shutdown can race with an agent/space broadcast. The close handler
    // performs cleanup; consuming the socket error keeps the Broker alive.
    socket.on("error", () => {});
    socket.once("close", () => {
      this.#sockets.delete(socket);
      for (const [key, stream] of this.#activeChatStreams) {
        if (stream.socket !== socket) continue;
        stream.controller.abort();
        this.#activeChatStreams.delete(key);
      }
      for (const [key, stream] of this.#activeCodexStreams) {
        if (stream.socket !== socket) continue;
        stream.controller.abort();
        this.#releaseCodexStream(key, stream);
      }
      for (const [clientId, clientSocket] of this.#clientSockets) {
        if (clientSocket !== socket) continue;
        const remaining = [...this.#sockets].find((candidate) => candidate !== socket && !candidate.destroyed && this.#socketClientIds.get(candidate) === clientId);
        if (remaining) {
          this.#clientSockets.set(clientId, remaining);
          continue;
        }
        this.#clientSockets.delete(clientId);
        for (const clients of this.#clientsByTask.values()) clients.delete(clientId);
        this.#broker.agents.disconnect(clientId);
      }
    });
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_RPC_FRAME_LENGTH) {
        socket.destroy(new Error("Broker RPC frame exceeds 32 MB"));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_RPC_FRAME_LENGTH) {
          socket.destroy(new Error("Broker RPC frame exceeds 32 MB"));
          return;
        }
        if (!line.trim()) continue;
        void this.#handle(socket, line);
      }
    });
  }

  async #handle(socket: Socket, line: string): Promise<void> {
    let request: RpcRequest | undefined;
    try {
      request = JSON.parse(line) as RpcRequest;
      const params = request.params as Record<string, unknown>;
      if (typeof params.clientId === "string") params.clientId = canonicalAgentClientId(params.clientId);
      const clientId = typeof params.clientId === "string" ? params.clientId : undefined;
      if (clientId) await this.#bindClientSocket(socket, request.method, params, clientId);
      const result = request.method === "chat.stream.start"
        ? this.#startChatStream(socket, params)
        : request.method === "chat.stream.cancel"
          ? this.#cancelChatStream(socket, params)
          : request.method === "codex.stream.start"
            ? this.#startCodexStream(socket, params)
          : request.method === "codex.stream.cancel"
              ? this.#cancelCodexStream(socket, params)
          : await this.#dispatch(socket, request.method, params);
      if (clientId && request.method.startsWith("space.")) this.#refreshClientTask(clientId);
      this.#write(socket, { jsonrpc: "2.0", id: request.id, result } satisfies RpcSuccess);
      if (request.method.startsWith("collection.") && !["collection.list", "collection.library"].includes(request.method)) {
        this.#broadcast("collection.changed", { clientId });
      }
    } catch (error) {
      const protocolError = error as EgoProtocolError;
      this.#write(socket, {
        jsonrpc: "2.0",
        id: request?.id ?? "invalid-request",
        error: {
          code: protocolError.error_code ?? "EGO_OPERATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      } satisfies RpcFailure);
    }
  }

  async #bindClientSocket(
    socket: Socket,
    method: string,
    params: Record<string, unknown>,
    clientId: string,
  ): Promise<void> {
    const boundClientId = this.#socketClientIds.get(socket);
    if (boundClientId && boundClientId !== clientId) {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "Broker connection cannot change clientId");
    }

    const isDesktopClient = inferAgentClientKind(clientId) === "desktop-ui";
    if (isDesktopClient && !this.#trustedDesktopSockets.has(socket)) {
      if (
        (method !== "hello" && method !== "agent.register")
        || !this.#matchesDesktopControlToken(params.controlToken)
      ) {
        throw new EgoProtocolError("EGO_OPERATION_FAILED", "Desktop client authentication failed");
      }
      this.#trustedDesktopSockets.add(socket);
    }

    const activeSocket = this.#clientSockets.get(clientId);
    if (
      activeSocket
      && activeSocket !== socket
      && !activeSocket.destroyed
      && !activeSocket.writableEnded
      && !/^codex-[a-f0-9]{24}$/.test(clientId)
    ) {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "clientId is already connected");
    }

    this.#socketClientIds.set(socket, clientId);
    this.#clientSockets.set(clientId, socket);
    if (method !== "agent.register" && method !== "hello") {
      const shouldResumePendingReturns = this.#broker.agents.get(clientId)?.status === "offline"
        || !this.#broker.agents.get(clientId);
      this.#broker.agents.observe(clientId);
      if (shouldResumePendingReturns) await this.#resumePendingAgentReturns(socket, clientId);
    }
  }

  #matchesDesktopControlToken(value: unknown): boolean {
    if (!this.#desktopControlToken || typeof value !== "string") return false;
    const expected = Buffer.from(this.#desktopControlToken, "utf8");
    const actual = Buffer.from(value, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async #dispatch(socket: Socket, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "chat.activateTab" || method === "chat.closeTab") {
      this.#requireDesktopUi(socket, requireString(params.clientId, "clientId"));
    }
    if (method.startsWith("chat.") || method.startsWith("codex.")) {
      return this.#dispatchUi(method, params);
    }
    const clientId = requireString(params.clientId, "clientId");
    switch (method) {
      case "hello":
        this.#broker.agents.register(requireAgentRegistration(params, clientId));
        await this.#resumePendingAgentReturns(socket, clientId);
        const capabilities = await this.#negotiateCapabilities(params.capabilities);
        this.#socketCapabilities.set(socket, new Set(capabilities.negotiated));
        return {
          protocolVersion: PROTOCOL_VERSION,
          sessionId: `dev-${clientId}`,
          capabilities: [...BASE_CAPABILITIES, capabilities.backend, ...capabilities.negotiated],
          ...(capabilities.referenceActionMaxLifetimeMs === undefined
            ? {}
            : { referenceActionMaxLifetimeMs: capabilities.referenceActionMaxLifetimeMs }),
        };
      case "backend.status":
        return this.#broker.backend.status
          ? await this.#broker.backend.status()
          : { kind: "fake", ready: true };
      case "automation.request": {
        const epoch = requireNumber(params.leaseEpoch, "leaseEpoch");
        const spaceId = requireNumber(params.taskSpaceId, "taskSpaceId");
        const space = this.#broker.assertMutationAllowed(clientId, epoch, spaceId);
        if (!this.#broker.backend.automationRequest) throw new EgoProtocolError("EGO_BROWSER_UNAVAILABLE", "Automation execution is unavailable on this backend");
        const operation = requireString(params.operation, "operation");
        if (!["begin", "check", "decide", "end", "cancel"].includes(operation)) throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "Unsupported automation operation");
        const input = params.input;
        if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(input).length > 180000) throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "Invalid automation input");
        return this.#broker.backend.automationRequest(space.taskId, operation, input as Record<string, unknown>, { clientId, taskSpaceId: spaceId, leaseEpoch: epoch });
      }
      case "control.handoff.get":
        return { enabled: this.#broker.controlHandoffEnabled() };
      case "control.mode.get":
        return { mode: this.#broker.controlMode() };
      case "control.mode.set": {
        this.#requireDesktopUi(socket, clientId);
        const mode = requireString(params.mode, "mode");
        if (!isControlMode(mode)) {
          throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "Unsupported control mode");
        }
        return { mode: await this.#broker.setControlMode(mode) };
      }
      case "control.handoff.set": {
        this.#requireDesktopUi(socket, clientId);
        const enabled = requireBoolean(params.enabled, "enabled");
        return { enabled: await this.#broker.setControlHandoffEnabled(enabled) };
      }
      case "control.policy.get":
        return { policy: this.#broker.controlConsentPolicy() };
      case "control.policy.set": {
        this.#requireDesktopUi(socket, clientId);
        const policy = requireString(params.policy, "policy");
        if (!isControlConsentPolicy(policy)) {
          throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "Unsupported control consent policy");
        }
        return { policy: this.#broker.setControlConsentPolicy(policy) };
      }
      case "space.list":
        return this.#broker.listTaskSpaces();
      case "mutation.assert": {
        this.#requireDesktopUi(socket, clientId);
        const taskId = requireString(params.taskId, "taskId");
        const space = this.#broker.spaces.recordByTaskId(taskId);
        const actor = requireString(params.actorClientId, "actorClientId");
        const holder = this.#broker.spaces.leaseHolder(taskId);
        const epoch = typeof params.leaseEpoch === "number" ? params.leaseEpoch
          : this.#broker.controlMode() === "agent" ? space.leaseEpoch : holder?.epoch;
        if (epoch === undefined) throw new EgoProtocolError("EGO_TASK_SPACE_USER_IN_CONTROL", "No Agent has write permission; request control first");
        if (params.renew === true) this.#broker.spaces.heartbeat(actor, epoch, space.id);
        this.#broker.assertMutationAllowed(actor, epoch, space.id);
        return { clientId: actor, taskSpaceId: space.id, leaseEpoch: epoch, taskId, space };
      }
      case "space.controlState":
        return { ...this.#broker.controlState(requireNumber(params.id, "id")), takeoverAllowed: this.#broker.spaces.isTakeoverAuthorized(requireNumber(params.id, "id"), clientId) };
      case "space.observe":
        return this.#broker.observeTaskSpace(
          requireNumber(params.id, "id"),
          typeof params.targetId === "string" ? params.targetId : undefined,
          params.options as never,
          {
            clientId,
            taskSpaceId: requireNumber(params.id, "id"),
            refFormat: this.#snapshotRefFormat(socket, params.refFormat),
          },
        );
      case "space.requestControl": {
        if (typeof params.targetClientId === "string") this.#requireDesktopUi(socket, clientId);
        const actor = typeof params.targetClientId === "string" ? params.targetClientId : clientId;
        const id = requireNumber(params.id, "id");
        if (this.#broker.controlMode() === "agent") {
          await this.#broker.claimTaskSpace(id, actor);
          return { id: randomUUID(), clientId: actor, createdAt: new Date().toISOString(), status: "approved" };
        }
        return this.#broker.requestControl(id, actor);
      }
      case "space.cancelControlRequest":
        this.#broker.cancelControlRequest(requireNumber(params.id, "id"), requireString(params.requestId, "requestId"), clientId);
        return {};
      case "space.approveControl": {
        this.#requireDesktopUi(socket, clientId);
        const state = await this.#broker.approveControl(requireNumber(params.id, "id"), requireString(params.requestId, "requestId"), clientId);
        const target = state.controllerClientId && this.#clientSockets.get(state.controllerClientId);
        if (target) this.#writeEvent(target, "lease.returned", { taskSpaceId: state.space.id, leaseEpoch: state.space.leaseEpoch });
        return state;
      }
      case "space.returnControl": {
        const state = await this.#broker.returnControl(requireNumber(params.id, "id"), clientId, requireNumber(params.leaseEpoch, "leaseEpoch"), typeof params.requestId === "string" ? params.requestId : undefined);
        const target = state.controllerClientId && this.#clientSockets.get(state.controllerClientId);
        if (target) this.#writeEvent(target, "lease.returned", { taskSpaceId: state.space.id, leaseEpoch: state.space.leaseEpoch });
        return state;
      }
      case "desktop.userInteraction":
        this.#requireDesktopUi(socket, clientId);
        return this.#broker.userInteraction(requireNumber(params.id, "id"));
      case "space.useOrCreate":
        return this.#broker.useOrCreateTaskSpace(typeof params.id === "number" ? requireNumber(params.id, "id") : requireString(params.name, "name"), clientId);
      case "tab.openOrReuse":
        return this.#broker.openOrReuseTab(clientId, requireNumber(params.leaseEpoch, "leaseEpoch"), requireString(params.url, "url"), typeof params.match === "string" ? params.match : "exact", optionalNumber(params.taskSpaceId, "taskSpaceId"));
      case "space.create":
        return this.#broker.createTaskSpace(
          requireString(params.name, "name"),
          clientId,
          typeof params.profileId === "string" ? params.profileId : "default",
        );
      case "space.rename":
        return this.#broker.renameTaskSpace(
          requireNumber(params.id, "id"),
          requireString(params.name, "name"),
        );
      case "space.reorder":
        return this.#broker.reorderTaskSpaces(requireNumberArray(params.ids, "ids", 10_000));
      case "space.select":
        await this.#broker.useTaskSpace(requireNumber(params.id, "id"), clientId);
        return { leaseEpoch: this.#broker.spaces.currentLease(clientId).epoch };
      case "space.heartbeat":
        return this.#broker.spaces.heartbeat(
          clientId,
          requireNumber(params.leaseEpoch, "leaseEpoch"),
          optionalNumber(params.taskSpaceId, "taskSpaceId"),
        );
      case "space.claim":
        return await this.#broker.claimTaskSpace(requireNumber(params.id, "id"), clientId);
      case "space.handoff":
        await this.#broker.handOffTaskSpace(
          clientId,
          optionalNumber(params.taskSpaceId, "taskSpaceId"),
        );
        return {};
      case "space.authorizeTakeover":
        this.#requireDesktopUi(socket, clientId);
        this.#broker.authorizeTakeover(requireNumber(params.id, "id"));
        return {};
      case "space.takeover": {
        const id = requireNumber(params.id, "id");
        const wasPendingReturn = this.#broker.spaces.byId(id).pendingAgentReturn === true;
        const taken = await this.#broker.takeOverTaskSpace(id, clientId);
        if (wasPendingReturn) {
          const agentSocket = this.#clientSockets.get(clientId);
          if (agentSocket && !agentSocket.destroyed) {
            this.#writeEvent(agentSocket, "lease.returned", {
              taskId: taken.taskId,
              taskSpaceId: taken.id,
              leaseEpoch: taken.leaseEpoch,
            });
          }
        }
        return taken;
      }
      case "space.userTakeover": {
        this.#requireDesktopUi(socket, clientId);
        const taken = await this.#broker.userTakeoverTaskSpace(requireNumber(params.id, "id"));
        return taken;
      }
      case "space.stop": {
        this.#requireDesktopUi(socket, clientId);
        const stopped = await this.#broker.stopAgentTaskSpace(requireNumber(params.id, "id"));
        return stopped;
      }
      case "space.returnToAgent": {
        this.#requireDesktopUi(socket, clientId);
        const returned = await this.#broker.returnToAgentTaskSpace(
          requireNumber(params.id, "id"),
          clientId,
        );
        if (returned.agentClientId) {
          const agentSocket = this.#clientSockets.get(returned.agentClientId);
          if (agentSocket && !agentSocket.destroyed) {
            this.#writeEvent(agentSocket, "lease.returned", {
              taskId: returned.space.taskId,
              taskSpaceId: returned.space.id,
              leaseEpoch: returned.space.leaseEpoch,
            });
          }
        }
        return returned.space;
      }
      case "space.forceClose": {
        this.#requireDesktopUi(socket, clientId);
        return this.#broker.forceCloseTaskSpace(requireNumber(params.id, "id"));
      }
      case "agent.register": {
        const agent = this.#broker.agents.register(requireAgentRegistration(params, clientId));
        await this.#resumePendingAgentReturns(socket, clientId);
        return agent;
      }
      case "agent.list":
        return { agents: this.#broker.agents.list() };
      case "agent.status": {
        const target = typeof params.targetClientId === "string" && params.targetClientId
          ? params.targetClientId
          : clientId;
        const agent = this.#broker.agents.get(target);
        return agent ? { agent } : { agent: null };
      }
      case "agent.heartbeat":
        return this.#broker.agents.observe(clientId);
      case "space.complete":
        await this.#broker.completeTaskSpace(
          clientId,
          params.keep !== false,
          optionalNumber(params.taskSpaceId, "taskSpaceId"),
        );
        return {};
      case "space.close":
        await this.#broker.closeTaskSpace(
          clientId,
          optionalNumber(params.taskSpaceId, "taskSpaceId"),
        );
        return {};
      case "tab.list":
        return this.#broker.listTabs(clientId);
      case "tab.listAll":
        return this.#broker.getAllTabs();
      case "tab.groupList":
        return this.#broker.getTabGroups();
      case "tab.activate":
        this.#requireDesktopUi(socket, clientId);
        return this.#broker.activateTab(requireString(params.targetId, "targetId"));
      case "tab.close":
        this.#requireDesktopUi(socket, clientId);
        return this.#broker.closeTab(requireString(params.targetId, "targetId"));
      case "tab.openUrl":
        this.#requireDesktopUi(socket, clientId);
        return this.#broker.openUrlInNewTab(
          requireString(params.url, "url"),
          typeof params.taskId === "string" ? params.taskId : undefined,
        );
      case "tab.create":
        return this.#broker.createTab(
          clientId,
          requireNumber(params.leaseEpoch, "leaseEpoch"),
          typeof params.url === "string" ? params.url : undefined,
          optionalNumber(params.taskSpaceId, "taskSpaceId"),
        );
      case "snapshot.capture":
        return this.#broker.snapshot(
          clientId,
          requireNumber(params.leaseEpoch, "leaseEpoch"),
          params.options as never,
          optionalNumber(params.taskSpaceId, "taskSpaceId"),
          this.#snapshotRefFormat(socket, params.refFormat),
        );
      case "page.aiContent":
        return this.#broker.getAIPageContent(
          requireString(params.targetId, "targetId"),
          params.options as never,
        );
      case "collection.save":
        return this.#broker.saveTextToCollections(
          requireString(params.text, "text"),
          typeof params.sourceUrl === "string" ? params.sourceUrl : undefined,
        );
      case "collection.library":
        return this.#broker.collections.snapshot();
      case "collection.bookmark":
        return this.#broker.collections.bookmark({
          title: requireString(params.title, "title"),
          url: requireString(params.url, "url"),
          ...(typeof params.id === "string" ? { id: params.id } : {}),
          ...(typeof params.folderId === "string" ? { folderId: params.folderId } : {}),
          ...(typeof params.faviconUrl === "string" ? { faviconUrl: params.faviconUrl } : {}),
          copy: params.copy === true,
          ...(Array.isArray(params.tags) ? { tags: requireStringArray(params.tags, "tags", 30) } : {}),
        });
      case "collection.folderSave":
        return this.#broker.collections.folderSave(
          requireString(params.name, "name"),
          typeof params.parentId === "string" ? params.parentId : "other",
          typeof params.id === "string" ? params.id : undefined,
        );
      case "collection.libraryMove":
        return this.#broker.collections.libraryMove(
          requireStringArray(params.ids, "ids", 10_000), requireString(params.folderId, "folderId"),
          typeof params.beforeId === "string" ? params.beforeId : undefined,
        );
      case "collection.trash":
        return this.#broker.collections.trash(requireStringArray(params.ids, "ids", 10_000));
      case "collection.restore":
        return this.#broker.collections.restore(requireStringArray(params.ids, "ids", 10_000));
      case "collection.list":
        return this.#broker.listCollections(
          typeof params.query === "string" ? params.query : undefined,
        );
      case "collection.update":
        return this.#broker.updateCollection(requireString(params.id, "id"), {
          ...(Object.prototype.hasOwnProperty.call(params, "group") ? { group: typeof params.group === "string" ? params.group : null } : {}),
          ...(Object.prototype.hasOwnProperty.call(params, "text") ? { text: requireString(params.text, "text").slice(0, 20_000) } : {}),
          ...(Object.prototype.hasOwnProperty.call(params, "pageTitle") ? { pageTitle: typeof params.pageTitle === "string" ? params.pageTitle.slice(0, 2_000) : null } : {}),
          ...(Object.prototype.hasOwnProperty.call(params, "tags") ? { tags: requireStringArray(params.tags, "tags", 30).map((tag) => tag.slice(0, 60)) } : {}),
        });
      case "collection.move":
        return this.#broker.moveCollections(requireStringArray(params.ids, "ids", 10_000), typeof params.group === "string" ? params.group : null);
      case "collection.delete":
        return Array.isArray(params.ids)
          ? this.#broker.deleteCollections(requireStringArray(params.ids, "ids", 10_000))
          : this.#broker.deleteCollection(requireString(params.id, "id"));
      case "collection.merge":
        return this.#broker.mergeCollections(
          requireStringArray(params.ids, "ids", 100),
          typeof params.primaryId === "string" ? params.primaryId : undefined,
        );
      case "collection.import":
        return this.#broker.importCollections(requireCollectionImportEntries(params.entries));
      case "collection.importLibrary": {
        if (!Array.isArray(params.folders) || params.folders.length > 10_000) throw new Error("Invalid folders");
        const folders = params.folders.map((value: unknown) => {
          if (!value || typeof value !== "object") throw new Error("Invalid folder");
          const folder = value as Record<string, unknown>;
          return {
            id: requireString(folder.id, "id"),
            name: requireString(folder.name, "name").slice(0, 120),
            parentId: typeof folder.parentId === "string" ? folder.parentId : null,
            order: typeof folder.order === "number" && Number.isFinite(folder.order) ? folder.order : 0,
          };
        });
        return this.#broker.collections.importLibrary(requireCollectionImportEntries(params.entries), folders);
      }
      case "operation.list": {
        const taskId = typeof params.taskId === "string" && params.taskId
          ? params.taskId
          : this.#broker.spaces.selected(clientId).taskId;
        return this.#operationStore?.listOperations(taskId, typeof params.limit === "number" ? params.limit : 200) ?? [];
      }
      case "operation.record": {
        const explicitDesktopTask = clientId.startsWith("desktop-") && typeof params.taskId === "string" && params.taskId
          ? params.taskId
          : undefined;
        const taskId = explicitDesktopTask ?? this.#broker.spaces.selected(clientId).taskId;
        const record = requireOperationRecord(params, taskId, clientId);
        this.#broker.agents.setCurrentTask(clientId, taskId);
        if (record.status === "running") {
          this.#broker.agents.startActivity(clientId, { tool: record.tool, startedAt: record.startedAt }, taskId);
        } else {
          this.#broker.agents.finishActivity(clientId);
        }
        this.#operationStore?.saveOperation(record);
        this.#broadcast("operation.changed", { taskId, record });
        return record;
      }
      case "operation.clear": {
        const taskId = typeof params.taskId === "string" && params.taskId
          ? params.taskId
          : this.#broker.spaces.selected(clientId).taskId;
        this.#operationStore?.clearOperations(taskId);
        this.#broadcast("operation.cleared", { taskId });
        return { cleared: true };
      }
      case "ref.bind": {
        this.#requireScopedReferences(socket);
        const request = requireReferenceActionBindRequest(params.request);
        if (isReferenceActionGroupBindRequest(request)) {
          return this.#broker.bindReferenceActionGroup(
            clientId,
            requireNumber(params.leaseEpoch, "leaseEpoch"),
            request,
            optionalNumber(params.taskSpaceId, "taskSpaceId"),
          );
        }
        return this.#broker.bindReferenceAction(
          clientId,
          requireNumber(params.leaseEpoch, "leaseEpoch"),
          request,
          optionalNumber(params.taskSpaceId, "taskSpaceId"),
        );
      }
      case "ref.release":
        this.#requireScopedReferences(socket);
        await this.#broker.releaseReferenceAction(
          clientId,
          requireNumber(params.leaseEpoch, "leaseEpoch"),
          requireReferenceActionWire(params.refAction),
          optionalNumber(params.taskSpaceId, "taskSpaceId"),
        );
        return {};
      case "cdp.send":
        const refAction = params.refAction === undefined
          ? undefined
          : requireReferenceActionWire(params.refAction);
        if (refAction) this.#requireScopedReferences(socket);
        return this.#broker.sendCdp(
          clientId,
          requireNumber(params.leaseEpoch, "leaseEpoch"),
          requireString(params.payload, "payload"),
          optionalNumber(params.taskSpaceId, "taskSpaceId"),
          this.#connectionRefFormat(socket),
          refAction,
        );
      default:
        throw new EgoProtocolError("EGO_INVALID_ARGUMENT", `Unknown RPC method: ${method}`);
    }
  }

  async #negotiateCapabilities(requested: unknown): Promise<{
    backend: string;
    negotiated: string[];
    referenceActionMaxLifetimeMs?: number;
  }> {
    if (!Array.isArray(requested) || requested.some((item) => typeof item !== "string")) {
      if (requested !== undefined) {
        throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "capabilities must be an array of strings");
      }
    }
    const status = await this.#broker.backend.status?.();
    const supported = new Set(status?.capabilities ?? []);
    const values = Array.isArray(requested) ? requested as string[] : [];
    const negotiated = [...new Set(values)].filter((capability) => supported.has(capability));
    const maxLifetime = status?.referenceActionMaxLifetimeMs;
    return {
      backend: `${status?.kind ?? "fake"}-backend`,
      negotiated,
      ...(negotiated.includes(SCOPED_REFS_CAPABILITY)
        && typeof maxLifetime === "number"
        && Number.isFinite(maxLifetime)
        && maxLifetime > 0
        ? { referenceActionMaxLifetimeMs: maxLifetime }
        : {}),
    };
  }

  #snapshotRefFormat(socket: Socket, requested: unknown): RefFormat {
    if (requested === undefined || requested === "native-v0") return "native-v0";
    if (requested !== "scoped-v1") {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "Unsupported snapshot ref format");
    }
    if (!this.#socketCapabilities.get(socket)?.has(SCOPED_REFS_CAPABILITY)) {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "scoped-v1 refs were not negotiated on this connection");
    }
    return "scoped-v1";
  }

  #connectionRefFormat(socket: Socket): RefFormat {
    return this.#socketCapabilities.get(socket)?.has(SCOPED_REFS_CAPABILITY)
      ? "scoped-v1"
      : "native-v0";
  }

  #requireScopedReferences(socket: Socket): void {
    if (this.#connectionRefFormat(socket) !== "scoped-v1") {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "scoped-v1 refs were not negotiated on this connection");
    }
  }

  #requireDesktopUi(socket: Socket, clientId: string): void {
    if (
      !this.#trustedDesktopSockets.has(socket)
      || this.#socketClientIds.get(socket) !== clientId
    ) {
      throw new EgoProtocolError("EGO_OPERATION_FAILED", "Only the EgoLite desktop UI can change user control");
    }
  }

  async #resumePendingAgentReturns(socket: Socket, clientId: string): Promise<void> {
    const resumed = await this.#broker.resumePendingAgentReturns(clientId);
    for (const space of resumed) {
      this.#writeEvent(socket, "lease.returned", {
        taskId: space.taskId,
        taskSpaceId: space.id,
        leaseEpoch: space.leaseEpoch,
      });
    }
  }

  async #dispatchUi(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "chat.state":
        return {
          tabs: await this.#broker.getAllTabs(),
          groups: await this.#broker.getTabGroups(),
          collections: this.#broker.listCollections(
            typeof params.query === "string" ? params.query : undefined,
          ),
        };
      case "chat.pageContent":
        return this.#broker.getAIPageContent(requireString(params.targetId, "targetId"));
      case "chat.saveSelection":
        return this.#broker.saveTextToCollections(
          requireString(params.text, "text"),
          typeof params.sourceUrl === "string" ? params.sourceUrl : undefined,
        );
      case "chat.activateTab":
        return this.#broker.activateTab(requireString(params.targetId, "targetId"));
      case "chat.closeTab":
        return this.#broker.closeTab(requireString(params.targetId, "targetId"));
      case "chat.send":
        if (!this.#chatProvider) {
          throw new EgoProtocolError("EGO_BROWSER_UNAVAILABLE", "Chat provider is not configured");
        }
        return this.#chatProvider.send({
          prompt: requireString(params.prompt, "prompt"),
          ...(typeof params.context === "string" && params.context.trim()
            ? { context: params.context }
            : {}),
          attachments: requireChatAttachments(params.attachments),
        });
      case "codex.send":
        if (!this.#codexAgent) {
          throw new EgoProtocolError("EGO_BROWSER_UNAVAILABLE", "Codex is not configured");
        }
        return this.#codexAgent.send({
          prompt: requireString(params.prompt, "prompt"),
          ...(typeof params.context === "string" && params.context.trim()
            ? { context: params.context }
            : {}),
          ...(typeof params.threadId === "string" && params.threadId
            ? { threadId: params.threadId }
            : {}),
          ...(typeof params.workingDirectory === "string" && params.workingDirectory
            ? { workingDirectory: params.workingDirectory }
            : {}),
          attachments: requireCodexImageAttachments(params.attachments),
        });
      default:
        throw new EgoProtocolError("EGO_INVALID_ARGUMENT", `Unknown UI RPC method: ${method}`);
    }
  }

  #startChatStream(socket: Socket, params: Record<string, unknown>): { requestId: string } {
    if (!this.#chatProvider) {
      throw new EgoProtocolError("EGO_BROWSER_UNAVAILABLE", "Chat provider is not configured");
    }
    const clientId = requireString(params.clientId, "clientId");
    const requestId = requireString(params.requestId, "requestId");
    const key = `${clientId}:${requestId}`;
    if (this.#activeChatStreams.has(key)) {
      throw new EgoProtocolError("EGO_OPERATION_FAILED", `Chat stream is already active: ${requestId}`);
    }
    const controller = new AbortController();
    this.#activeChatStreams.set(key, { controller, socket });
    const request = {
      prompt: requireString(params.prompt, "prompt"),
      ...(typeof params.context === "string" && params.context.trim()
        ? { context: params.context }
        : {}),
      attachments: requireChatAttachments(params.attachments),
    };
    void (async () => {
      try {
        const response = this.#chatProvider!.stream
          ? await this.#chatProvider!.stream(request, {
              signal: controller.signal,
              onDelta: (delta) => this.#writeEvent(socket, "chat.stream.delta", { clientId, requestId, delta }),
            })
          : await this.#chatProvider!.send(request);
        if (!this.#chatProvider!.stream) {
          this.#writeEvent(socket, "chat.stream.delta", { clientId, requestId, delta: response.text });
        }
        this.#writeEvent(socket, "chat.stream.complete", { clientId, requestId, ...response });
      } catch (error) {
        if (controller.signal.aborted) {
          this.#writeEvent(socket, "chat.stream.cancelled", { clientId, requestId });
        } else {
          this.#writeEvent(socket, "chat.stream.error", {
            clientId,
            requestId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        const active = this.#activeChatStreams.get(key);
        if (active?.controller === controller) this.#activeChatStreams.delete(key);
      }
    })();
    return { requestId };
  }

  #cancelChatStream(socket: Socket, params: Record<string, unknown>): { cancelled: boolean } {
    const clientId = requireString(params.clientId, "clientId");
    const requestId = requireString(params.requestId, "requestId");
    const stream = this.#activeChatStreams.get(`${clientId}:${requestId}`);
    if (!stream || stream.socket !== socket) return { cancelled: false };
    stream.controller.abort();
    return { cancelled: true };
  }

  #startCodexStream(socket: Socket, params: Record<string, unknown>): { requestId: string } {
    if (!this.#codexAgent) {
      throw new EgoProtocolError("EGO_BROWSER_UNAVAILABLE", "Codex is not configured");
    }
    const clientId = requireString(params.clientId, "clientId");
    const requestId = requireString(params.requestId, "requestId");
    const key = `${clientId}:${requestId}`;
    if (this.#activeCodexStreams.has(key)) {
      throw new EgoProtocolError("EGO_OPERATION_FAILED", `Codex stream is already active: ${requestId}`);
    }
    const requestedThreadId = typeof params.threadId === "string" && params.threadId ? params.threadId : undefined;
    if (requestedThreadId && this.#activeCodexThreads.has(requestedThreadId)) {
      throw new EgoProtocolError("EGO_OPERATION_FAILED", "This Codex thread already has a running turn");
    }
    const request = {
      prompt: requireString(params.prompt, "prompt"),
      conversationKey: typeof params.taskId === "string" && params.taskId ? params.taskId : clientId,
      ...(typeof params.context === "string" && params.context.trim() ? { context: params.context } : {}),
      ...(requestedThreadId ? { threadId: requestedThreadId } : {}),
      ...(typeof params.workingDirectory === "string" && params.workingDirectory
        ? { workingDirectory: params.workingDirectory }
        : {}),
      attachments: requireCodexImageAttachments(params.attachments),
    };
    const controller = new AbortController();
    const active = { controller, socket, ...(requestedThreadId ? { threadId: requestedThreadId } : {}) };
    this.#activeCodexStreams.set(key, active);
    if (requestedThreadId) this.#activeCodexThreads.set(requestedThreadId, key);
    void (async () => {
      try {
        const response = this.#codexAgent!.stream
          ? await this.#codexAgent!.stream(request, {
              signal: controller.signal,
              onEvent: (event) => {
                if (event.type === "thread") {
                  const owner = this.#activeCodexThreads.get(event.threadId);
                  if (owner && owner !== key) {
                    controller.abort();
                    throw new EgoProtocolError("EGO_OPERATION_FAILED", "This Codex thread already has a running turn");
                  }
                  active.threadId = event.threadId;
                  this.#activeCodexThreads.set(event.threadId, key);
                }
                this.#writeEvent(socket, "codex.stream.event", { clientId, requestId, event });
              },
            })
          : await this.#codexAgent!.send(request);
        this.#writeEvent(socket, "codex.stream.complete", { clientId, requestId, ...response });
      } catch (error) {
        if (controller.signal.aborted) {
          this.#writeEvent(socket, "codex.stream.cancelled", { clientId, requestId, threadId: active.threadId });
        } else {
          this.#writeEvent(socket, "codex.stream.error", {
            clientId,
            requestId,
            threadId: active.threadId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        this.#releaseCodexStream(key, active);
      }
    })();
    return { requestId };
  }

  #cancelCodexStream(socket: Socket, params: Record<string, unknown>): { cancelled: boolean } {
    const clientId = requireString(params.clientId, "clientId");
    const requestId = requireString(params.requestId, "requestId");
    const stream = this.#activeCodexStreams.get(`${clientId}:${requestId}`);
    if (!stream || stream.socket !== socket) return { cancelled: false };
    stream.controller.abort();
    return { cancelled: true };
  }

  #releaseCodexStream(key: string, stream: { controller: AbortController; socket: Socket; threadId?: string }): void {
    if (this.#activeCodexStreams.get(key) === stream) this.#activeCodexStreams.delete(key);
    if (stream.threadId && this.#activeCodexThreads.get(stream.threadId) === key) {
      this.#activeCodexThreads.delete(stream.threadId);
    }
  }

  #writeEvent(socket: Socket, method: string, params: unknown): void {
    if (method === "lease.revoked" || method === "lease.returned" || method === "cdp.message") {
      const clientId = this.#socketClientIds.get(socket);
      for (const peer of this.#sockets) {
        if (peer !== socket && !peer.destroyed && clientId && this.#socketClientIds.get(peer) === clientId) {
          peer.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
        }
      }
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  #spaceIdByTaskId(taskId: string): number | undefined {
    try {
      return this.#broker.spaces.recordByTaskId(taskId).id;
    } catch {
      return undefined;
    }
  }

  #broadcast(method: string, params: Record<string, unknown>): void {
    const event = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
    for (const socket of this.#sockets) if (!socket.destroyed) socket.write(event);
  }

  #write(socket: Socket, message: RpcSuccess | RpcFailure): void {
    socket.write(`${JSON.stringify(message)}\n`);
  }

  #refreshClientTask(clientId: string): void {
    for (const clients of this.#clientsByTask.values()) clients.delete(clientId);
    try {
      const taskId = this.#broker.spaces.selected(clientId).taskId;
      let clients = this.#clientsByTask.get(taskId);
      if (!clients) {
        clients = new Set();
        this.#clientsByTask.set(taskId, clients);
      }
      clients.add(clientId);
    } catch {
      // A completed or closed client has no selected task.
    }
  }
}

function isControlConsentPolicy(value: string): value is "strict" | "balanced" | "automatic" {
  return value === "strict" || value === "balanced" || value === "automatic";
}

function isControlMode(value: string): value is "agent" | "collaborative" | "manual" {
  return value === "agent" || value === "collaborative" || value === "manual";
}

function normalizeControlToken(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token.length >= 32 ? token : undefined;
}

function requireAgentRegistration(params: Record<string, unknown>, clientId: string): AgentRegistration {
  const kind = params.clientKind;
  if (kind !== undefined && !["codex", "claude", "cursor", "other", "desktop-ui"].includes(kind as string)) {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "clientKind is invalid");
  }
  if (kind === "desktop-ui" && inferAgentClientKind(clientId) !== "desktop-ui") {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "desktop-ui registration requires a desktop clientId");
  }
  return {
    clientId,
    ...(kind ? { clientKind: kind as AgentClientKind } : {}),
    ...(typeof params.displayName === "string" ? { displayName: params.displayName } : {}),
    ...(typeof params.version === "string" ? { version: params.version } : {}),
  };
}

function requireOperationRecord(
  params: Record<string, unknown>,
  taskId: string,
  clientId: string,
): CodexOperationRecord {
  const status = params.status;
  if (!(["running", "completed", "failed"] as unknown[]).includes(status)) {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "operation status is invalid");
  }
  return {
    id: requireString(params.id, "id").slice(0, 200),
    taskId,
    clientId,
    tool: requireString(params.tool, "tool").slice(0, 120),
    title: requireString(params.title, "title").slice(0, 500),
    ...(typeof params.detail === "string" && params.detail.trim()
      ? { detail: params.detail.trim().slice(0, 4_000) }
      : {}),
    status: status as CodexOperationRecord["status"],
    startedAt: typeof params.startedAt === "string" ? params.startedAt : new Date().toISOString(),
    ...(typeof params.finishedAt === "string" ? { finishedAt: params.finishedAt } : {}),
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", `${name} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", `${name} must be a number`);
  }
  return value;
}

function requireReferenceActionBindRequest(value: unknown): ReferenceActionBindRequest | ReferenceActionGroupBindRequest {
  if (!value || typeof value !== "object") {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "reference bind request must be an object");
  }
  const request = value as Record<string, unknown>;
  if (request.kind !== undefined) {
    if (request.kind !== "drag") {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "reference group kind must be drag");
    }
    if (Object.hasOwn(request, "constraints") || Object.hasOwn(request, "refs") || Object.hasOwn(request, "ref")) {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "drag group scope constraints are server-defined");
    }
    if (!request.source || typeof request.source !== "object"
      || !request.target || typeof request.target !== "object") {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "drag group requires exact source and target refs");
    }
    if (!request.expectedScope || typeof request.expectedScope !== "object") {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "drag group expectedScope must be an object");
    }
    const source = requireReferenceDescriptor(request.source, "source");
    const target = requireReferenceDescriptor(request.target, "target");
    if (source.runtimeId !== target.runtimeId) {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "drag group refs must use the same runtimeId");
    }
    const expectedScope = request.expectedScope as Record<string, unknown>;
    return {
      kind: "drag",
      source,
      target,
      expectedScope: { pageId: requireString(expectedScope.pageId, "expectedScope.pageId") },
      ...(request.deadlineAt === undefined
        ? {}
        : { deadlineAt: requireNumber(request.deadlineAt, "deadlineAt") }),
    };
  }
  if (!request.ref || typeof request.ref !== "object") {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "reference bind request ref must be an object");
  }
  if (!request.expectedScope || typeof request.expectedScope !== "object") {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "reference bind expectedScope must be an object");
  }
  const ref = request.ref as Record<string, unknown>;
  const expectedScope = request.expectedScope as Record<string, unknown>;
  const refId = requireNumber(ref.refId, "ref.refId");
  if (!Number.isSafeInteger(refId) || refId <= 0) {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "ref.refId must be a positive safe integer");
  }
  return {
    ref: {
      refId,
      runtimeId: requireString(ref.runtimeId, "ref.runtimeId"),
    },
    expectedScope: {
      pageId: requireString(expectedScope.pageId, "expectedScope.pageId"),
    },
    ...(request.deadlineAt === undefined
      ? {}
      : { deadlineAt: requireNumber(request.deadlineAt, "deadlineAt") }),
  };
}

function isReferenceActionGroupBindRequest(
  request: ReferenceActionBindRequest | ReferenceActionGroupBindRequest,
): request is ReferenceActionGroupBindRequest {
  return "kind" in request && request.kind === "drag";
}

function requireReferenceDescriptor(value: unknown, name: string): { refId: number; runtimeId: string } {
  const descriptor = value as Record<string, unknown>;
  const refId = requireNumber(descriptor.refId, `${name}.refId`);
  if (!Number.isSafeInteger(refId) || refId <= 0) {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", `${name}.refId must be a positive safe integer`);
  }
  return {
    refId,
    runtimeId: requireString(descriptor.runtimeId, `${name}.runtimeId`),
  };
}

function requireReferenceActionWire(value: unknown): ReferenceActionWire {
  if (!value || typeof value !== "object") {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "refAction must be an object");
  }
  const action = value as Record<string, unknown>;
  if (action.version !== "scoped-v1") {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "refAction.version must be scoped-v1");
  }
  return {
    version: "scoped-v1",
    runtimeId: requireString(action.runtimeId, "refAction.runtimeId"),
    token: requireString(action.token, "refAction.token"),
  };
}

function optionalNumber(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : requireNumber(value, name);
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", `${name} must be a boolean`);
  }
  return value;
}

function requireStringArray(value: unknown, name: string, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", `${name} must be an array with at most ${limit} items`);
  }
  return value.map((item, index) => requireString(item, `${name}[${index}]`));
}

function requireNumberArray(value: unknown, name: string, limit: number): number[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", `${name} must be an array with at most ${limit} items`);
  }
  return value.map((item, index) => requireNumber(item, `${name}[${index}]`));
}

function requireChatAttachments(value: unknown): ChatAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "attachments must be an array with at most 8 items");
  }
  return value.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object") {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", `attachments[${index}] must be an object`);
    }
    const item = attachment as Record<string, unknown>;
    const common = {
      id: requireString(item.id, `attachments[${index}].id`),
      name: requireString(item.name, `attachments[${index}].name`),
      mimeType: requireString(item.mimeType, `attachments[${index}].mimeType`),
      size: requireNumber(item.size, `attachments[${index}].size`),
      source: requireString(item.source, `attachments[${index}].source`),
    };
    if (item.kind === "text") {
      return { ...common, kind: "text", text: requireString(item.text, `attachments[${index}].text`) };
    }
    if (item.kind === "image") {
      return { ...common, kind: "image", dataBase64: requireString(item.dataBase64, `attachments[${index}].dataBase64`) };
    }
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", `attachments[${index}].kind is invalid`);
  });
}

function requireCodexImageAttachments(value: unknown): CodexImageAttachment[] {
  const attachments = requireChatAttachments(value);
  for (const attachment of attachments) {
    if (attachment.kind !== "image") {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "Codex currently supports image attachments only");
    }
  }
  return attachments as CodexImageAttachment[];
}

function requireCollectionImportEntries(value: unknown) {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "entries must be an array with at most 10000 items");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", `entries[${index}] must be an object`);
    }
    const item = entry as Record<string, unknown>;
    return {
      text: requireString(item.text, `entries[${index}].text`).slice(0, 20_000),
      ...(typeof item.sourceUrl === "string" ? { sourceUrl: item.sourceUrl.slice(0, 20_000) } : {}),
      ...(typeof item.pageTitle === "string" ? { pageTitle: item.pageTitle.slice(0, 2_000) } : {}),
      ...(typeof item.faviconUrl === "string" ? { faviconUrl: item.faviconUrl.slice(0, 20_000) } : {}),
      ...(typeof item.group === "string" ? { group: item.group.slice(0, 120) } : {}),
      ...(Array.isArray(item.tags) ? { tags: requireStringArray(item.tags, `entries[${index}].tags`, 30).map((tag) => tag.slice(0, 60)) } : {}),
      ...(typeof item.createdAt === "string" ? { createdAt: item.createdAt.slice(0, 100) } : {}),
      ...(item.kind === "bookmark" || item.kind === "excerpt" ? { kind: item.kind as "bookmark" | "excerpt" } : {}),
      ...(typeof item.folderId === "string" ? { folderId: item.folderId } : {}),
      ...(typeof item.order === "number" ? { order: item.order } : {}),
    };
  });
}
