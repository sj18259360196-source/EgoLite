import {
  type AIPageContent,
  type CollectionItem,
  type EgoTab,
  type EgoTabGroup,
  egoError,
  type ControlMode,
  type AgentInfo,
  type PublicTab,
  type RefFormat,
  type ReferenceActionBinding,
  type ReferenceActionBindRequest,
  type ReferenceActionGroupBinding,
  type ReferenceActionGroupBindRequest,
  type ReferenceActionWire,
  type SnapshotOptions,
  type SnapshotResult,
  type TaskSpaceRecord,
  type ControlRequest,
  type SpaceControlState,
} from "@ego-compat/protocol";

import type { BrowserBackend, SnapshotRequestContext } from "./backend.ts";
import { KeyedMutex } from "./keyed-mutex.ts";
import { randomUUID } from "node:crypto";
import { AgentRegistry, canonicalAgentClientId } from "./agent-registry.ts";
import { CollectionService, type CollectionImportEntry } from "./collection-service.ts";
import { TaskSpaceService, type LeaseRevokedEvent } from "./task-space-service.ts";

export interface SpaceChangedEvent {
  space: TaskSpaceRecord;
  removed?: boolean;
}

export type ControlConsentPolicy = "strict" | "balanced" | "automatic";

export interface BrokerCoreOptions {
  controlHandoffEnabled?: boolean;
  controlMode?: ControlMode;
}

export class BrokerCore {
  assertMutationAllowed(clientId: string, epoch: number, expectedId?: number) {
    return this.spaces.assertMutationAllowed(clientId, epoch, expectedId);
  }

  readonly #controlListeners = new Set<(state: SpaceControlState) => void>();
  readonly #requests = new Map<number, ControlRequest[]>();
  readonly #interactionPending = new Set<number>();
  #controlRevision = 0;

  onControlChanged(listener: (state: SpaceControlState) => void): () => void {
    this.#controlListeners.add(listener);
    return () => this.#controlListeners.delete(listener);
  }

  controlState(id: number): SpaceControlState {
    const space = this.spaces.byId(id);
    const holder = this.spaces.leaseHolder(space.taskId);
    return { space, ...(holder && this.#controlMode !== "agent" ? { controllerClientId: holder.clientId } : {}), requests: structuredClone(this.#requests.get(id) ?? []), revision: this.#controlRevision, interactionPending: this.#interactionPending.has(id) };
  }

  #publishControl(id: number): void {
    this.#controlRevision++;
    const state = this.controlState(id);
    for (const listener of this.#controlListeners) listener(state);
  }

  async observeTaskSpace(
    id: number,
    targetId?: string,
    options: SnapshotOptions = {},
    snapshotContext?: SnapshotRequestContext,
  ) {
    const state = this.controlState(id);
    if (state.space.lifecycle === "closed") egoError("EGO_TASK_SPACE_INACTIVE", "Task space is closed");
    const tabs = await this.backend.listTabs(state.space.taskId);
    if (targetId && !tabs.some((tab) => tab.targetId === targetId)) egoError("EGO_WEB_CONTENTS_UNAVAILABLE", "Tab does not belong to the observed workspace");
    const snapshot = targetId
      ? await this.backend.snapshot(state.space.taskId, options, targetId, snapshotContext)
      : undefined;
    return { ...this.controlState(id), tabs, ...(snapshot ? { snapshot } : {}) };
  }

  requestControl(id: number, clientId: string): ControlRequest {
    clientId = canonicalAgentClientId(clientId);
    const state = this.controlState(id);
    if (state.space.lifecycle === "closed") egoError("EGO_TASK_SPACE_INACTIVE", "Task space is closed");
    const records = this.#requests.get(id) ?? [];
    const existing = records.find((request) => request.clientId === clientId && request.status === "pending");
    if (existing) return structuredClone(existing);
    if (records.filter((request) => request.status === "pending").length >= 100) egoError("EGO_TASK_SPACE_UNAVAILABLE", "Too many pending control requests");
    const request: ControlRequest = { id: randomUUID(), clientId, createdAt: new Date().toISOString(), status: "pending" };
    this.#requests.set(id, [...records.filter((r) => r.status === "pending" || records.indexOf(r) >= records.length - 100), request]);
    this.#publishControl(id);
    return structuredClone(request);
  }

  cancelControlRequest(id: number, requestId: string, clientId: string): void {
    const request = this.#requests.get(id)?.find((item) => item.id === requestId);
    if (!request || request.clientId !== canonicalAgentClientId(clientId)) egoError("EGO_INVALID_ARGUMENT", "Control request is unavailable");
    if (request.status === "pending") { request.status = "cancelled"; this.#publishControl(id); }
  }

  async approveControl(id: number, requestId: string, userClientId: string): Promise<SpaceControlState> {
    return this.#runControlTransition(async () => this.#grantControl(id, requestId, userClientId));
  }

  async #grantControl(id: number, requestId: string, userClientId: string): Promise<SpaceControlState> {
    if (this.#controlMode === "manual") egoError("EGO_TASK_SPACE_USER_IN_CONTROL", "Switch out of manual mode before granting agent control");
    const request = this.#requests.get(id)?.find((item) => item.id === requestId && item.status === "pending");
    if (!request) egoError("EGO_INVALID_ARGUMENT", "Control request is no longer pending");
    const agent = this.agents.get(request.clientId);
    if (!agent || agent.status === "offline" || agent.clientKind === "desktop-ui") egoError("EGO_TASK_SPACE_UNAVAILABLE", "The target Agent is offline");
    const previous = this.spaces.byId(id);
    if (previous.lifecycle === "closed") egoError("EGO_TASK_SPACE_INACTIVE", "Task space is closed");
    const oldWriter = this.spaces.leaseHolder(previous.taskId)?.clientId;
    if (this.#controlMode === "agent") {
      const granted = await this.claimTaskSpace(id, request.clientId);
      request.status = "approved";
      this.#publishControl(granted.id);
      return this.controlState(granted.id);
    }
    // No await between revoking the old lease and assigning the new writer.
    if (previous.ownership === "agent") this.spaces.userTakeover(id);
    const granted = previous.ownership === "user" || oldWriter === userClientId
      ? this.spaces.claim(id, request.clientId, true)
      : this.spaces.returnToAgent(id, userClientId, request.clientId).space;
    request.status = "approved";
    this.#interactionPending.delete(id);
    if (oldWriter && oldWriter !== request.clientId) this.agents.clearTask(previous.taskId);
    this.agents.setCurrentTask(request.clientId, granted.taskId);
    this.agents.clearUserControl(request.clientId);
    this.#emitSpace(granted);
    await this.backend.updateSpaceState?.(granted);
    return this.controlState(id);
  }

  async returnControl(id: number, clientId: string, epoch: number, requestId?: string): Promise<SpaceControlState> {
    return this.#runControlTransition(async () => {
      this.spaces.assertMutationAllowed(clientId, epoch, id);
      if (requestId) return this.#grantControl(id, requestId, clientId);
      const space = this.spaces.handoff(clientId, true, id);
      this.agents.noteUserControl(clientId);
      this.#emitSpace(space);
      await this.backend.relinquishControl?.(space.taskId);
      await this.backend.updateSpaceState?.(space);
      return this.controlState(id);
    });
  }

  async userInteraction(id: number): Promise<SpaceControlState> {
    return this.#runControlTransition(async () => {
      const state = this.controlState(id);
      if (this.#controlMode !== "collaborative" || !state.controllerClientId || this.agents.get(state.controllerClientId)?.clientKind === "desktop-ui") return state;
      const space = this.spaces.stopAgent(id);
      this.#interactionPending.add(id);
      this.agents.noteUserControl(state.controllerClientId);
      this.#emitSpace(space);
      await this.backend.relinquishControl?.(space.taskId);
      await this.backend.updateSpaceState?.(space);
      return this.controlState(id);
    });
  }
  readonly #operations = new KeyedMutex();

  async useOrCreateTaskSpace(nameOrId: string | number, clientId: string) {
    const key = typeof nameOrId === "number" ? `space-name:${this.spaces.byId(nameOrId).name}` : `space-name:${nameOrId.trim()}`;
    return this.#operations.run(key, async () => {
      const existing = this.spaces.findUnique(nameOrId);
      if (!existing) return this.#createTaskSpace(String(nameOrId).trim(), clientId);
      return this.#operations.run(`space-id:${existing.id}`, async () => {
        const current = this.spaces.byId(existing.id);
        if (current.ownership === "agentDelegatedToUser") return this.takeOverTaskSpace(current.id, clientId);
        if (current.ownership === "user") return this.claimTaskSpace(current.id, clientId);
        await this.useTaskSpace(current.id, clientId);
        return this.spaces.byId(current.id);
      });
    });
  }

  async openOrReuseTab(clientId: string, epoch: number, url: string, match = "exact", expectedId?: number) {
    if (!["exact", "origin", "origin+path", "includes"].includes(match)) egoError("EGO_INVALID_ARGUMENT", "Unsupported URL match mode");
    const task = this.spaces.assertMutationAllowed(clientId, epoch, expectedId);
    return this.#operations.run(`tabs:${task.taskId}`, async () => {
      this.spaces.assertMutationAllowed(clientId, epoch, task.id);
      const tabs = await this.backend.listTabs(task.taskId);
      this.spaces.assertMutationAllowed(clientId, epoch, task.id);
      const existing = tabs.find((tab) => matchesTabUrl(tab.url, url, match));
      if (existing) {
        const response = JSON.parse(await this.backend.sendCdp(task.taskId, JSON.stringify({ id: 1, method: "Target.activateTarget", params: { targetId: existing.targetId } }), { clientId, taskSpaceId: task.id, leaseEpoch: epoch }));
        if (response.error) egoError("EGO_OPERATION_FAILED", response.error.message || "Tab activation failed");
        return { ...existing, active: true, reused: true };
      }
      return { ...await this.backend.createTab(task.taskId, url, { clientId, taskSpaceId: task.id, leaseEpoch: epoch }), reused: false };
    });
  }
  readonly spaces: TaskSpaceService;
  readonly backend: BrowserBackend;
  readonly collections: CollectionService;
  readonly agents: AgentRegistry;
  readonly #unsubscribeControlLost: (() => void) | undefined;
  readonly #unsubscribeTakeoverAuthorized: (() => void) | undefined;
  readonly #spaceListeners = new Set<(event: SpaceChangedEvent) => void>();
  #controlTransitionTail: Promise<void> = Promise.resolve();
  #controlConsentPolicy: ControlConsentPolicy = "strict";
  #controlHandoffEnabled = true;
  #controlMode: ControlMode;

  constructor(
    spaces: TaskSpaceService,
    backend: BrowserBackend,
    collections = new CollectionService(),
    agents = new AgentRegistry(),
    options: BrokerCoreOptions = {},
  ) {
    this.spaces = spaces;
    this.backend = backend;
    this.collections = collections;
    this.agents = agents;
    this.#controlMode = options.controlMode
      ?? (options.controlHandoffEnabled === false ? "agent" : "collaborative");
    this.#controlHandoffEnabled = this.#controlMode !== "agent";
    this.spaces.setControlMode(this.#controlMode);
    this.#unsubscribeControlLost = backend.onControlLost?.((taskId) => {
      void this.#runControlTransition(async () => {
        if (this.#controlMode === "agent" || this.spaces.recordByTaskId(taskId).lifecycle === "closed") return;
        this.spaces.externalControlLost(taskId, this.#controlHandoffEnabled);
        const space = this.spaces.recordByTaskId(taskId);
        if (space.lastAgentClientId) {
          if (this.#controlHandoffEnabled) this.agents.noteUserControl(space.lastAgentClientId);
          else if (this.agents.get(space.lastAgentClientId)?.currentTaskId === taskId) {
            this.agents.setCurrentTask(space.lastAgentClientId, undefined);
          }
        }
        this.#emitSpace(space);
        await this.backend.updateSpaceState?.(space);
      }).catch(() => undefined);
    });
    this.#unsubscribeTakeoverAuthorized = backend.onTakeoverAuthorized?.((taskId) => {
      if (!this.#controlHandoffEnabled) return;
      this.spaces.authorizeTakeoverByTaskId(taskId);
      this.#publishControl(this.spaces.recordByTaskId(taskId).id);
    });
  }

  /** Subscribes to ownership/lifecycle changes so servers can broadcast them. */
  onSpaceChanged(listener: (event: SpaceChangedEvent) => void): () => void {
    this.#spaceListeners.add(listener);
    return () => this.#spaceListeners.delete(listener);
  }

  /** Subscribes to lease revocations so servers can notify the agent client. */
  onLeaseRevoked(listener: (event: LeaseRevokedEvent) => void): () => void {
    return this.spaces.onLeaseRevoked(listener);
  }

  #emitSpace(space: TaskSpaceRecord, removed = false): void {
    if (removed) this.#interactionPending.delete(space.id);
    this.#publishControl(space.id);
    const event: SpaceChangedEvent = removed ? { space, removed: true } : { space };
    for (const listener of this.#spaceListeners) listener(event);
  }

  #runControlTransition<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#controlTransitionTail.then(operation, operation);
    this.#controlTransitionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async createTaskSpace(name: string, clientId: string, profileId = "default") {
    return this.#operations.run(`space-name:${name.trim()}`, async () => {
      if (this.spaces.findUnique(name)) egoError("EGO_INVALID_ARGUMENT", "Task space name already exists; use its ID or choose another name");
      return this.#createTaskSpace(name, clientId, profileId);
    });
  }

  async #createTaskSpace(name: string, clientId: string, profileId = "default") {
    const space = this.spaces.create(name, clientId, profileId);
    this.agents.setCurrentTask(clientId, space.taskId);
    try {
      await this.backend.createSpace(space, { visualSync: shouldSyncDesktopVisuals(clientId) });
      await this.backend.updateSpaceState?.(space);
      this.#emitSpace(space);
      return space;
    } catch (error) {
      this.spaces.forceClose(space.id);
      throw error;
    }
  }

  listTaskSpaces() {
    return { taskSpaces: this.spaces.list() };
  }

  async renameTaskSpace(id: number, name: string) {
    return this.#operations.run(`space-name:${name.trim()}`, async () => {
      const duplicate = this.spaces.list().find((space) => space.name === name.trim() && space.id !== id);
      if (duplicate) egoError("EGO_INVALID_ARGUMENT", "Task space name already exists");
      const space = this.spaces.rename(id, name);
      await this.backend.updateSpaceState?.(space);
      this.#emitSpace(space);
      return space;
    });
  }

  reorderTaskSpaces(ids: number[]) {
    return { taskSpaces: this.spaces.reorder(ids) };
  }

  async useTaskSpace(id: number, clientId: string): Promise<void> {
    const space = this.spaces.select(id, clientId);
    this.agents.setCurrentTask(clientId, space.taskId);
    if (shouldSyncDesktopVisuals(clientId)) await this.backend.prepareControl?.(space.taskId);
    this.#publishControl(id);
  }

  async claimTaskSpace(id: number, clientId: string) {
    const taskId = this.spaces.list().find((space) => space.id === id)?.taskId;
    const space = this.spaces.claim(id, clientId);
    this.agents.setCurrentTask(clientId, space.taskId);
    if (taskId && shouldSyncDesktopVisuals(clientId)) await this.backend.prepareControl?.(taskId);
    await this.backend.updateSpaceState?.(space);
    this.#emitSpace(space);
    return space;
  }

  async handOffTaskSpace(clientId: string, expectedId?: number): Promise<void> {
    return this.#runControlTransition(async () => {
      const taskId = this.spaces.selected(clientId, expectedId).taskId;
      const space = this.spaces.handoff(clientId, this.#controlHandoffEnabled, expectedId);
      if (this.#controlMode === "agent") {
        this.agents.setCurrentTask(clientId, undefined);
        this.#publishControl(space.id);
        return;
      }
      if (this.#controlHandoffEnabled) this.agents.noteUserControl(clientId);
      else this.agents.setCurrentTask(clientId, undefined);
      await this.backend.relinquishControl?.(taskId);
      await this.backend.updateSpaceState?.(space);
      this.#emitSpace(space);
    });
  }

  authorizeTakeover(id: number): void {
    this.#assertControlHandoffEnabled();
    this.spaces.authorizeTakeover(id);
    this.#publishControl(id);
  }

  async setControlHandoffEnabled(enabled: boolean): Promise<boolean> {
    await this.setControlMode(enabled ? "collaborative" : "agent");
    return enabled;
  }

  controlHandoffEnabled(): boolean {
    return this.#controlHandoffEnabled;
  }

  controlMode(): ControlMode {
    return this.#controlMode;
  }

  async setControlMode(mode: ControlMode): Promise<ControlMode> {
    if (mode !== "agent" && mode !== "collaborative" && mode !== "manual") {
      egoError("EGO_INVALID_ARGUMENT", "Unsupported control mode");
    }
    return this.#runControlTransition(async () => {
      this.#controlMode = mode;
      this.#controlHandoffEnabled = mode !== "agent";
      const changed = this.spaces.setControlMode(mode);
      for (const space of changed) {
        if (mode === "manual" && space.lastAgentClientId) {
          this.agents.noteUserControl(space.lastAgentClientId);
        }
        if (mode === "agent" && space.lastAgentClientId) {
          this.agents.clearUserControl(space.lastAgentClientId);
          if (this.agents.get(space.lastAgentClientId)?.currentTaskId === space.taskId) {
            this.agents.setCurrentTask(space.lastAgentClientId, undefined);
          }
        }
        this.#emitSpace(space);
      }
      await Promise.allSettled(changed.map(async (space) => this.backend.updateSpaceState?.(space)));
      return mode;
    });
  }

  setControlConsentPolicy(policy: ControlConsentPolicy): ControlConsentPolicy {
    this.#controlConsentPolicy = policy;
    return policy;
  }

  controlConsentPolicy(): ControlConsentPolicy {
    return this.#controlConsentPolicy;
  }

  /** Fences spaces whose agent connection has disconnected or timed out. */
  async externalAgentDisconnected(clientId: string): Promise<void> {
    clientId = canonicalAgentClientId(clientId);
    return this.#runControlTransition(async () => {
      for (const publicSpace of this.spaces.list()) {
        const lease = this.spaces.leaseHolder(publicSpace.taskId);
        if (lease?.clientId !== clientId) continue;
        this.spaces.externalControlLost(publicSpace.taskId, this.#controlHandoffEnabled);
        const space = this.spaces.recordByTaskId(publicSpace.taskId);
        await this.backend.updateSpaceState?.(space);
        this.#emitSpace(space);
      }
    });
  }

  /**
   * The desktop user seizes a space from the controlling agent: the agent
   * lease is revoked (epoch fenced, lease.revoked pushed by the server), and
   * ownership moves to the user while tabs and page state stay untouched.
   */
  async userTakeoverTaskSpace(id: number): Promise<TaskSpaceRecord> {
    return this.#runControlTransition(async () => {
      this.#assertControlHandoffEnabled();
      const previous = this.#leaseHolderBySpaceId(id);
      const previousClientId = previous?.clientId ?? this.spaces.byId(id).lastAgentClientId;
      const space = this.spaces.userTakeover(id);
      this.#interactionPending.delete(id);
      if (previousClientId) this.agents.noteUserControl(previousClientId);
      await this.backend.relinquishControl?.(space.taskId);
      await this.backend.updateSpaceState?.(space);
      this.#emitSpace(space);
      return space;
    });
  }

  /** Stops an agent on a space and blocks re-claiming until the user returns it. */
  async stopAgentTaskSpace(id: number): Promise<TaskSpaceRecord> {
    return this.#runControlTransition(async () => {
      this.#assertControlHandoffEnabled();
      const previous = this.#leaseHolderBySpaceId(id);
      const previousClientId = previous?.clientId ?? this.spaces.byId(id).lastAgentClientId;
      const space = this.spaces.stopAgent(id);
      if (previousClientId) this.agents.noteUserControl(previousClientId);
      await this.backend.relinquishControl?.(space.taskId);
      await this.backend.updateSpaceState?.(space);
      this.#emitSpace(space);
      return space;
    });
  }

  /**
   * Returns a user-held space to a uniquely identifiable online successor.
   * When none is available, the return stays pending until a later takeover.
   */
  async returnToAgentTaskSpace(
    id: number,
    requesterClientId: string,
  ): Promise<{ space: TaskSpaceRecord; agentClientId?: string }> {
    return this.#runControlTransition(async () => {
      this.#assertControlHandoffEnabled();
      const waiting = this.spaces.byId(id);
      const successor = this.#resolveAgentReturnSuccessor(waiting, requesterClientId);
      if (successor && shouldSyncDesktopVisuals(successor.clientId)) {
        await this.backend.prepareControl?.(waiting.taskId);
        this.#assertControlHandoffEnabled();
      }
      const returned = this.spaces.returnToAgent(id, requesterClientId, successor?.clientId);
      if (returned.agentClientId) {
        this.agents.setCurrentTask(returned.agentClientId, returned.space.taskId);
        this.agents.clearUserControl(returned.agentClientId);
      }
      await this.backend.updateSpaceState?.(returned.space);
      this.#emitSpace(returned.space);
      return returned;
    });
  }

  /**
   * Completes an already-authorized pending return when one reconnecting agent
   * is the only safe match. Servers should call this after registration and
   * send lease.returned for every returned space.
   */
  async resumePendingAgentReturns(clientId: string): Promise<TaskSpaceRecord[]> {
    clientId = canonicalAgentClientId(clientId);
    return this.#runControlTransition(async () => {
      if (!this.#controlHandoffEnabled) return [];
      const agent = this.agents.get(clientId);
      if (!agent || agent.status === "offline" || agent.clientKind === "desktop-ui") return [];
      const pending = this.spaces.list()
        .filter((space) => (
          space.ownership === "agentDelegatedToUser"
          && space.pendingAgentReturn === true
          && space.agentBlocked !== true
        ))
        .map((space) => this.spaces.byId(space.id));
      const exactMatches = pending.filter((space) => space.lastAgentClientId === clientId);
      const successorMatches = exactMatches.length > 0
        ? []
        : pending.filter((space) => this.#resolveAgentReturnSuccessor(space, "")?.clientId === clientId);
      const matches = exactMatches.length > 0
        ? exactMatches
        : successorMatches.length === 1 ? successorMatches : [];
      const resumed: TaskSpaceRecord[] = [];
      for (const waiting of matches) {
        if (shouldSyncDesktopVisuals(clientId)) {
          await this.backend.prepareControl?.(waiting.taskId);
          this.#assertControlHandoffEnabled();
        }
        const space = this.spaces.takeover(
          waiting.id,
          clientId,
          false,
          waiting.lastAgentClientId !== clientId,
        );
        this.agents.setCurrentTask(clientId, space.taskId);
        this.agents.clearUserControl(clientId);
        await this.backend.updateSpaceState?.(space);
        this.#emitSpace(space);
        resumed.push(space);
      }
      return resumed;
    });
  }

  #resolveAgentReturnSuccessor(
    space: TaskSpaceRecord,
    requesterClientId: string,
  ): AgentInfo | undefined {
    const previousClientId = space.lastAgentClientId;
    if (!previousClientId) return undefined;
    const isEligible = (agent: AgentInfo): boolean => (
      agent.clientId !== requesterClientId
      && agent.clientKind !== "desktop-ui"
      && agent.status !== "offline"
      && (!agent.currentTaskId || agent.currentTaskId === space.taskId)
    );
    const previous = this.agents.get(previousClientId);
    if (previous && isEligible(previous)) return previous;
    if (!isLegacyCliClientId(previousClientId)) return undefined;

    let candidates = this.agents.online().filter((agent) => (
      isEligible(agent)
      && agent.clientId !== previousClientId
      && isCompatibleLegacyCliClient(agent)
    ));
    if (previous) {
      candidates = candidates.filter((agent) => (
        previous.clientKind === "other"
          ? agent.clientKind === "other" || agent.clientKind === "codex"
          : agent.clientKind === previous.clientKind
      ));
      if (!isGenericAgentDisplayName(previous.displayName)) {
        candidates = candidates.filter((agent) => agent.displayName === previous.displayName);
      }
    }
    if (previous?.version) {
      const sameVersion = candidates.filter((agent) => agent.version === previous.version);
      if (sameVersion.length > 0) candidates = sameVersion;
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  #leaseHolderBySpaceId(id: number): { clientId: string } | undefined {
    let holder: { clientId: string } | undefined;
    try {
      const space = this.spaces.byId(id);
      holder = this.spaces.leaseHolder(space.taskId);
    } catch {
      holder = undefined;
    }
    return holder;
  }

  #assertControlHandoffEnabled(): void {
    if (!this.#controlHandoffEnabled) {
      egoError("EGO_INVALID_ARGUMENT", "Task-space control handoff is disabled");
    }
  }

  async takeOverTaskSpace(id: number, clientId: string) {
    clientId = canonicalAgentClientId(clientId);
    return this.#runControlTransition(async () => {
      this.#assertControlHandoffEnabled();
      const waiting = this.spaces.byId(id);
      const allowAutomaticReturn = this.#controlConsentPolicy === "automatic"
        && waiting.agentBlocked !== true;
      const pendingSuccessor = waiting.pendingAgentReturn
        ? this.#resolveAgentReturnSuccessor(waiting, "")
        : undefined;
      const allowPendingSuccessor = pendingSuccessor?.clientId === clientId;
      const space = this.spaces.takeover(
        id,
        clientId,
        allowAutomaticReturn,
        allowPendingSuccessor,
      );
      this.agents.setCurrentTask(clientId, space.taskId);
      if (shouldSyncDesktopVisuals(clientId)) await this.backend.prepareControl?.(waiting.taskId);
      await this.backend.updateSpaceState?.(space);
      this.#emitSpace(space);
      return space;
    });
  }

  async completeTaskSpace(clientId: string, keep = true, expectedId?: number): Promise<void> {
    const task = this.spaces.selected(clientId, expectedId);
    this.spaces.complete(clientId, keep, expectedId);
    this.agents.setCurrentTask(clientId, undefined);
    if (!keep) await this.backend.closeSpace(task.taskId, { visualSync: shouldSyncDesktopVisuals(clientId) });
    this.#emitSpace(this.spaces.byId(task.id), !keep);
  }

  async closeTaskSpace(clientId: string, expectedId?: number): Promise<void> {
    return this.completeTaskSpace(clientId, false, expectedId);
  }

  /** Permanently deletes a task space through the trusted desktop path. */
  async forceCloseTaskSpace(id: number): Promise<TaskSpaceRecord> {
    return this.#runControlTransition(async () => {
      const space = this.spaces.forceClose(id);
      this.agents.clearTask(space.taskId);
      try {
        await this.backend.closeSpace(space.taskId, { visualSync: true });
      } finally {
        this.#emitSpace(space, true);
      }
      return space;
    });
  }

  async listTabs(clientId: string): Promise<{ tabs: PublicTab[] }> {
    const task = this.spaces.selected(clientId);
    return { tabs: await this.backend.listTabs(task.taskId) };
  }

  async getAllTabs(): Promise<EgoTab[]> {
    const result: EgoTab[] = [];
    for (const space of this.spaces.list()) {
      const tabs = await this.backend.listTabs(space.taskId);
      result.push(...tabs.map((tab) => ({ ...tab, id: tab.targetId, taskId: space.taskId })));
    }
    return result;
  }

  async getTabGroups(): Promise<EgoTabGroup[]> {
    const groups = await Promise.all(this.spaces.list().map(async (space, index) => {
      const tabs = await this.backend.listTabs(space.taskId);
      const explicit = new Map<string, EgoTabGroup>();
      const ungrouped: EgoTabGroup = {
        id: space.taskId,
        taskId: space.taskId,
        title: space.name,
        color: TAB_GROUP_COLORS[index % TAB_GROUP_COLORS.length]!,
        tabs: [],
      };
      for (const tab of tabs) {
        const egoTab = {
          ...tab,
          id: tab.targetId,
          taskId: space.taskId,
        };
        if (!tab.groupId) {
          ungrouped.tabs.push(egoTab);
          continue;
        }
        const group = explicit.get(tab.groupId) || {
          id: tab.groupId,
          taskId: space.taskId,
          title: tab.groupTitle || "Tab Group",
          color: tab.groupColor || TAB_GROUP_COLORS[index % TAB_GROUP_COLORS.length]!,
          tabs: [],
        };
        group.tabs.push(egoTab);
        explicit.set(tab.groupId, group);
      }
      return [...explicit.values(), ...(ungrouped.tabs.length ? [ungrouped] : [])];
    }));
    return groups.flat();
  }

  async activateTab(targetId: string): Promise<boolean> {
    const owner = await this.#findTabOwner(targetId);
    const response = JSON.parse(await this.backend.sendCdp(owner.taskId, JSON.stringify({
      id: 1,
      method: "Target.activateTarget",
      params: { targetId },
    }))) as { error?: unknown };
    return !response.error;
  }

  async closeTab(targetId: string): Promise<boolean> {
    const owner = await this.#findTabOwner(targetId);
    const response = JSON.parse(await this.backend.sendCdp(owner.taskId, JSON.stringify({
      id: 1,
      method: "Target.closeTarget",
      params: { targetId },
    }))) as { error?: unknown };
    return !response.error;
  }

  async openUrlInNewTab(url: string, taskId?: string): Promise<EgoTab> {
    const space = taskId
      ? this.spaces.list().find((item) => item.taskId === taskId)
      : this.spaces.list()[0];
    if (!space) egoError("EGO_TASK_SPACE_NOT_FOUND", "No task space is available");
    const tab = await this.backend.createTab(space.taskId, url);
    return { ...tab, id: tab.targetId, taskId: space.taskId };
  }

  async saveTextToCollections(text: string, sourceUrl?: string): Promise<boolean> {
    let sourceTab: PublicTab | undefined;
    if (sourceUrl) {
      for (const space of this.spaces.list()) {
        sourceTab = (await this.backend.listTabs(space.taskId)).find(
          (tab) => tab.url === sourceUrl,
        );
        if (sourceTab) break;
      }
    }
    return this.collections.save(text, {
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(sourceTab?.title ? { pageTitle: sourceTab.title } : {}),
      ...(sourceTab?.faviconUrl ? { faviconUrl: sourceTab.faviconUrl } : {}),
    });
  }

  listCollections(query?: string): CollectionItem[] {
    return this.collections.list(query);
  }

  updateCollection(id: string, changes: { group?: string | null; text?: string; pageTitle?: string | null; tags?: string[] }): CollectionItem | false {
    return this.collections.update(id, changes);
  }

  mergeCollections(ids: string[], primaryId?: string) {
    return this.collections.merge(ids, primaryId);
  }

  moveCollections(ids: string[], group?: string | null) {
    return this.collections.move(ids, group);
  }

  deleteCollection(id: string): boolean {
    return this.collections.delete(id);
  }

  deleteCollections(ids: string[]) {
    return this.collections.remove(ids);
  }

  importCollections(entries: CollectionImportEntry[]): { added: number; skipped: number } {
    return this.collections.import(entries);
  }

  async createTab(clientId: string, epoch: number, url?: string, expectedId?: number): Promise<PublicTab> {
    const task = this.spaces.assertMutationAllowed(clientId, epoch, expectedId);
    return this.backend.createTab(task.taskId, url, { clientId, taskSpaceId: task.id, leaseEpoch: epoch });
  }

  async snapshot(
    clientId: string,
    epoch: number,
    options?: SnapshotOptions,
    expectedId?: number,
    refFormat: RefFormat = "native-v0",
  ): Promise<SnapshotResult> {
    const task = this.spaces.assertMutationAllowed(clientId, epoch, expectedId);
    return this.backend.snapshot(task.taskId, options, undefined, {
      clientId,
      taskSpaceId: task.id,
      leaseEpoch: epoch,
      refFormat,
    });
  }

  async bindReferenceAction(
    clientId: string,
    epoch: number,
    request: ReferenceActionBindRequest,
    expectedId?: number,
  ): Promise<ReferenceActionBinding> {
    const task = this.spaces.assertMutationAllowed(clientId, epoch, expectedId);
    if (!this.backend.bindReferenceAction) {
      egoError("EGO_OPERATION_FAILED", "Scoped reference actions are unavailable");
    }
    return this.backend.bindReferenceAction(task.taskId, request, {
      clientId,
      taskSpaceId: task.id,
      leaseEpoch: epoch,
    });
  }

  async bindReferenceActionGroup(
    clientId: string,
    epoch: number,
    request: ReferenceActionGroupBindRequest,
    expectedId?: number,
  ): Promise<ReferenceActionGroupBinding> {
    const task = this.spaces.assertMutationAllowed(clientId, epoch, expectedId);
    if (!this.backend.bindReferenceActionGroup) {
      egoError("EGO_OPERATION_FAILED", "Scoped drag groups are unavailable");
    }
    return this.backend.bindReferenceActionGroup(task.taskId, request, {
      clientId,
      taskSpaceId: task.id,
      leaseEpoch: epoch,
    });
  }

  async releaseReferenceAction(
    clientId: string,
    epoch: number,
    action: ReferenceActionWire,
    expectedId?: number,
  ): Promise<void> {
    const task = this.spaces.assertMutationAllowed(clientId, epoch, expectedId);
    if (!this.backend.releaseReferenceAction) return;
    await this.backend.releaseReferenceAction(task.taskId, action, {
      clientId,
      taskSpaceId: task.id,
      leaseEpoch: epoch,
    });
  }

  async getAIPageContent(
    targetId: string,
    options?: SnapshotOptions,
  ): Promise<AIPageContent> {
    let owner: { taskId: string } | undefined;
    let tab: PublicTab | undefined;
    for (const space of this.spaces.list()) {
      const candidate = (await this.backend.listTabs(space.taskId)).find(
        (item) => item.targetId === targetId,
      );
      if (candidate) {
        owner = space;
        tab = candidate;
        break;
      }
    }
    if (!owner || !tab) egoError("EGO_WEB_CONTENTS_UNAVAILABLE", "Tab is unavailable");
    if (this.backend.getAIPageContent) {
      return this.backend.getAIPageContent(owner.taskId, targetId, options);
    }
    const snapshot = await this.backend.snapshot(owner.taskId, options, targetId);
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

  async #findTabOwner(targetId: string): Promise<{ taskId: string; tab: PublicTab }> {
    for (const space of this.spaces.list()) {
      const tab = (await this.backend.listTabs(space.taskId)).find(
        (item) => item.targetId === targetId,
      );
      if (tab) return { taskId: space.taskId, tab };
    }
    egoError("EGO_WEB_CONTENTS_UNAVAILABLE", "Tab is unavailable");
  }

  async sendCdp(
    clientId: string,
    epoch: number,
    payload: string,
    expectedId?: number,
    refFormat: RefFormat = "native-v0",
    refAction?: ReferenceActionWire,
  ): Promise<string> {
    const task = this.spaces.assertMutationAllowed(clientId, epoch, expectedId);
    if (refAction && refFormat !== "scoped-v1") {
      egoError("EGO_INVALID_ARGUMENT", "Reference action metadata requires scoped-v1 negotiation");
    }
    try {
      JSON.parse(payload);
    } catch {
      egoError("EGO_INVALID_ARGUMENT", "CDP payload must be valid JSON");
    }
    return this.backend.sendCdp(
      task.taskId,
      payload,
      { clientId, taskSpaceId: task.id, leaseEpoch: epoch },
      { clientId, refFormat, ...(refAction ? { refAction } : {}) },
    );
  }

  dispose(): void {
    this.#unsubscribeControlLost?.();
    this.#unsubscribeTakeoverAuthorized?.();
  }
}

const TAB_GROUP_COLORS = ["blue", "green", "yellow", "red", "purple", "cyan", "orange", "grey"];

function matchesTabUrl(actual: string, wanted: string, match: string): boolean {
  if (!actual) return false;
  if (match === "includes") return actual.includes(wanted);
  try {
    const a = new URL(actual), b = new URL(wanted);
    if (match === "origin") return a.origin === b.origin;
    if (match === "origin+path") return a.origin === b.origin && (a.pathname.replace(/\/+$/, "") || "/") === (b.pathname.replace(/\/+$/, "") || "/");
    return a.href === b.href;
  } catch { return actual === wanted; }
}

function shouldSyncDesktopVisuals(clientId: string): boolean {
  return !clientId.startsWith("desktop-");
}

function isLegacyCliClientId(clientId: string): boolean {
  return clientId.startsWith("cli-");
}

function isCompatibleLegacyCliClient(agent: AgentInfo): boolean {
  return (
    agent.clientKind === "codex" || agent.clientKind === "other"
  ) && (
    agent.clientId.startsWith("codex-cli-")
    || agent.clientId.startsWith("codex-mcp-")
    || agent.clientId.startsWith("cli-")
  );
}

function isGenericAgentDisplayName(displayName: string): boolean {
  return displayName === "Agent" || displayName === "Codex";
}
