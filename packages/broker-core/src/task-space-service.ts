import { randomUUID } from "node:crypto";
import { canonicalAgentClientId } from "./agent-registry.ts";

import {
  EgoProtocolError,
  egoError,
  type BrowserBackendKind,
  type ControlMode,
  type Lease,
  type PublicTaskSpace,
  type TaskSpaceRecord,
} from "@ego-compat/protocol";

export interface Clock {
  now(): number;
}

export interface TaskSpaceServiceOptions {
  backend?: BrowserBackendKind;
  leaseTtlMs?: number;
  clock?: Clock;
  store?: TaskSpaceStore;
  isUserClient?: (clientId: string) => boolean;
  controlMode?: ControlMode;
}

export interface LeaseRevokedEvent {
  taskId: string;
  clientId: string;
  leaseEpoch: number;
}

export interface AgentReturnResult {
  space: TaskSpaceRecord;
  agentClientId?: string;
}

export interface TaskSpaceStore {
  load(): TaskSpaceRecord[];
  save(spaces: TaskSpaceRecord[]): void;
}

const systemClock: Clock = { now: () => Date.now() };

export class TaskSpaceService {
  readonly #spaces = new Map<number, TaskSpaceRecord>();
  readonly #leases = new Map<string, Lease>();
  readonly #selectedByClient = new Map<string, number>();
  readonly #takeoverConsents = new Set<number>();
  readonly #leaseRevokedListeners = new Set<(event: LeaseRevokedEvent) => void>();
  readonly #backend: BrowserBackendKind;
  readonly #leaseTtlMs: number;
  readonly #clock: Clock;
  readonly #store: TaskSpaceStore | undefined;
  readonly #isUserClient: (clientId: string) => boolean;
  #controlMode: ControlMode;
  #nextId = 1;

  constructor(options: TaskSpaceServiceOptions = {}) {
    this.#backend = options.backend ?? "fake";
    this.#leaseTtlMs = options.leaseTtlMs ?? 15_000;
    this.#clock = options.clock ?? systemClock;
    this.#store = options.store;
    this.#isUserClient = options.isUserClient ?? ((clientId) => clientId.startsWith("desktop-"));
    this.#controlMode = normalizeControlMode(options.controlMode);
    const restored = options.store?.load() ?? [];
    restored.forEach((space, index) => this.#spaces.set(space.id, {
      ...structuredClone(space),
      createdBy: canonicalAgentClientId(space.createdBy),
      ...(space.lastAgentClientId ? { lastAgentClientId: canonicalAgentClientId(space.lastAgentClientId) } : {}),
      profileId: normalizeProfileId(space.profileId),
      controlMode: normalizeControlMode(space.controlMode ?? this.#controlMode),
      order: typeof space.order === "number" && Number.isFinite(space.order) ? space.order : index,
    }));
    this.#nextId = Math.max(0, ...restored.map((space) => space.id)) + 1;
  }

  list(): PublicTaskSpace[] {
    return [...this.#spaces.values()]
      .filter((space) => space.lifecycle !== "closed")
      .sort((left, right) => Number(left.order ?? left.id) - Number(right.order ?? right.id))
      .map(toPublicSpace);
  }

  findUnique(nameOrId: string | number): TaskSpaceRecord | undefined {
    if (typeof nameOrId === "number") return this.byId(nameOrId);
    const name = nameOrId.trim();
    if (!name) egoError("EGO_INVALID_ARGUMENT", "Task space name is required");
    const matches = [...this.#spaces.values()].filter((space) => space.lifecycle !== "closed" && space.name === name);
    if (matches.length > 1) egoError("EGO_INVALID_ARGUMENT", "Task space name is ambiguous; select by ID or rename the spaces");
    return matches[0] ? structuredClone(matches[0]) : undefined;
  }

  create(name: string, clientId: string, profileId = "default"): TaskSpaceRecord {
    clientId = canonicalAgentClientId(clientId);
    this.#assertAgentModeAllowed(clientId);
    const cleanName = name.trim();
    if (!cleanName) egoError("EGO_INVALID_ARGUMENT", "Task space name is required");
    const now = new Date(this.#clock.now()).toISOString();
    const space: TaskSpaceRecord = {
      id: this.#nextId++,
      taskId: randomUUID(),
      name: cleanName,
      profileId: normalizeProfileId(profileId),
      order: Math.max(-1, ...[...this.#spaces.values()].filter((item) => item.lifecycle !== "closed").map((item) => Number(item.order ?? item.id))) + 1,
      createdBy: clientId,
      ownership: "agent",
      controlMode: this.#controlMode,
      lifecycle: "active",
      backend: this.#backend,
      generation: 1,
      leaseEpoch: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.#spaces.set(space.id, space);
    this.#selectedByClient.set(clientId, space.id);
    this.#acquire(space, clientId);
    this.#persist();
    return structuredClone(space);
  }

  rename(id: number, name: string): TaskSpaceRecord {
    const cleanName = name.trim();
    if (!cleanName) egoError("EGO_INVALID_ARGUMENT", "Task space name is required");
    const space = this.#get(id);
    if (space.lifecycle === "closed") egoError("EGO_TASK_SPACE_INACTIVE", "Task space is closed");
    space.name = cleanName;
    this.#touch(space);
    return structuredClone(space);
  }

  controlMode(): ControlMode {
    return this.#controlMode;
  }

  isTakeoverAuthorized(id: number, clientId: string): boolean {
    const space = this.#get(id);
    return this.#controlMode !== "manual" && !space.agentBlocked && space.ownership === "agentDelegatedToUser"
      && (this.#takeoverConsents.has(id) || space.pendingAgentReturn === true && space.lastAgentClientId === canonicalAgentClientId(clientId));
  }

  setControlMode(mode: ControlMode): TaskSpaceRecord[] {
    const nextMode = normalizeControlMode(mode);
    const leavingAutonomous = this.#controlMode === "agent" && nextMode !== "agent";
    this.#controlMode = nextMode;
    const changed: TaskSpaceRecord[] = [];
    for (const space of this.#spaces.values()) {
      if (space.lifecycle === "closed") continue;
      let changedState = space.controlMode !== nextMode;
      space.controlMode = nextMode;
      if (leavingAutonomous && space.ownership === "agent") this.#revoke(space, true);
      if (nextMode === "manual" && space.ownership === "agent") {
        this.#revoke(space);
        space.ownership = "agentDelegatedToUser";
        space.agentBlocked = true;
        delete space.pendingAgentReturn;
        changedState = true;
      }
      if (nextMode === "agent" && (space.ownership === "agentDelegatedToUser" || space.agentBlocked)) {
        this.#revoke(space);
        space.ownership = "user";
        space.lifecycle = "inactive";
        delete space.agentBlocked;
        delete space.pendingAgentReturn;
        for (const [clientId, selectedId] of this.#selectedByClient) {
          if (selectedId === space.id) this.#selectedByClient.delete(clientId);
        }
        changedState = true;
      }
      if (changedState) {
        this.#touch(space);
        changed.push(structuredClone(space));
      }
    }
    if (changed.length === 0) this.#persist();
    return changed;
  }

  reorder(ids: number[]): PublicTaskSpace[] {
    const active = [...this.#spaces.values()].filter((space) => space.lifecycle !== "closed");
    const expected = new Set(active.map((space) => space.id));
    if (ids.length !== expected.size || new Set(ids).size !== ids.length || ids.some((id) => !expected.has(id))) {
      egoError("EGO_INVALID_ARGUMENT", "Task space order must include every active task exactly once");
    }
    ids.forEach((id, index) => {
      const space = this.#get(id);
      space.order = index;
      space.updatedAt = new Date(this.#clock.now()).toISOString();
    });
    this.#persist();
    return this.list();
  }

  select(id: number, clientId: string): TaskSpaceRecord {
    clientId = canonicalAgentClientId(clientId);
    const space = this.#get(id);
    this.#assertAgentModeAllowed(clientId);
    if (this.#controlMode === "agent" && space.lifecycle !== "closed" && !space.agentBlocked
      && space.ownership === "user") return this.claim(id, clientId);
    this.#assertControllable(space);
    this.#assertNotBlocked(space, clientId);
    const controlChanged = this.#acquire(space, clientId);
    this.#selectedByClient.set(clientId, id);
    if (controlChanged) this.#touch(space);
    return structuredClone(space);
  }

  claim(id: number, clientId: string, allowUserControlled = false): TaskSpaceRecord {
    clientId = canonicalAgentClientId(clientId);
    const space = this.#get(id);
    this.#assertAgentModeAllowed(clientId);
    if (space.lifecycle === "closed") {
      egoError("EGO_TASK_SPACE_INACTIVE", "Task space is closed");
    }
    if (
      space.ownership === "agentDelegatedToUser"
      && !allowUserControlled
      && !this.#isUserClient(clientId)
    ) {
      egoError("EGO_TASK_SPACE_USER_IN_CONTROL", "Task space is under user control");
    }
    this.#assertNotBlocked(space, clientId);
    if (this.#controlMode === "agent" && space.ownership === "agent" && space.lifecycle === "active") {
      this.#selectedByClient.set(clientId, id);
      this.#acquire(space, clientId);
      return structuredClone(space);
    }
    const holder = this.#leases.get(space.taskId);
    if (!allowUserControlled && !this.#isUserClient(clientId) && holder && holder.clientId !== clientId && holder.expiresAt > this.#clock.now()) {
      egoError("EGO_TASK_SPACE_UNAVAILABLE", "Request control from the current writer before claiming this space");
    }
    this.#revoke(space);
    space.ownership = "agent";
    space.lifecycle = "active";
    delete space.pendingAgentReturn;
    this.#takeoverConsents.delete(id);
    this.#selectedByClient.set(clientId, id);
    this.#acquire(space, clientId);
    this.#touch(space);
    return structuredClone(space);
  }

  handoff(clientId: string, delegateToUser = true, expectedId?: number): TaskSpaceRecord {
    clientId = canonicalAgentClientId(clientId);
    const space = this.selected(clientId, expectedId);
    this.assertMutationAllowed(clientId, space.leaseEpoch, expectedId);
    if (this.#controlMode === "agent") {
      this.#selectedByClient.delete(clientId);
      return structuredClone(space);
    }
    this.#revoke(space);
    space.ownership = delegateToUser ? "agentDelegatedToUser" : "user";
    space.lifecycle = delegateToUser ? "active" : "inactive";
    delete space.pendingAgentReturn;
    delete space.agentBlocked;
    this.#takeoverConsents.delete(space.id);
    if (!delegateToUser) this.#selectedByClient.delete(clientId);
    this.#touch(space);
    return structuredClone(space);
  }

  externalControlLost(taskId: string, delegateToUser = true): void {
    if (this.#controlMode === "agent") return;
    const space = [...this.#spaces.values()].find((candidate) => candidate.taskId === taskId);
    if (!space || space.lifecycle === "closed" || space.ownership !== "agent") return;
    this.#revoke(space);
    space.ownership = delegateToUser ? "agentDelegatedToUser" : "user";
    space.lifecycle = delegateToUser ? "active" : "inactive";
    delete space.pendingAgentReturn;
    delete space.agentBlocked;
    this.#takeoverConsents.delete(space.id);
    if (!delegateToUser) {
      for (const [clientId, selectedId] of this.#selectedByClient) {
        if (selectedId === space.id) this.#selectedByClient.delete(clientId);
      }
    }
    this.#touch(space);
  }

  /**
   * Removes every persisted user-control handoff when the desktop feature is
   * disabled. Live agent/desktop leases stay valid after their stale flags are
   * removed; delegated or inactive records become ordinary inactive user spaces.
   */
  clearControlHandoffs(): TaskSpaceRecord[] {
    const changed: TaskSpaceRecord[] = [];
    const now = new Date(this.#clock.now()).toISOString();
    for (const space of this.#spaces.values()) {
      if (space.lifecycle === "closed") continue;
      const delegated = space.ownership === "agentDelegatedToUser";
      const hasControlState = delegated || space.agentBlocked === true || space.pendingAgentReturn === true;
      if (!hasControlState) continue;
      if (space.ownership !== "agent") {
        this.#revoke(space);
        space.ownership = "user";
        space.lifecycle = "inactive";
        for (const [clientId, selectedId] of this.#selectedByClient) {
          if (selectedId === space.id) this.#selectedByClient.delete(clientId);
        }
      }
      delete space.agentBlocked;
      delete space.pendingAgentReturn;
      this.#takeoverConsents.delete(space.id);
      space.updatedAt = now;
      changed.push(structuredClone(space));
    }
    if (changed.length > 0) this.#persist();
    return changed;
  }

  /**
   * Permanently closes a task space by id for the trusted desktop deletion
   * path. This does not depend on control-handoff state or lease ownership.
   */
  forceClose(id: number): TaskSpaceRecord {
    const space = this.#get(id);
    if (space.lifecycle === "closed") {
      egoError("EGO_TASK_SPACE_INACTIVE", "Task space is closed");
    }
    this.#revoke(space);
    for (const [clientId, selectedId] of this.#selectedByClient) {
      if (selectedId === id) this.#selectedByClient.delete(clientId);
    }
    this.#takeoverConsents.delete(id);
    delete space.pendingAgentReturn;
    delete space.agentBlocked;
    space.ownership = "user";
    space.lifecycle = "closed";
    this.#touch(space);
    return structuredClone(space);
  }

  authorizeTakeover(id: number): void {
    const space = this.#get(id);
    if (space.ownership !== "agentDelegatedToUser") {
      egoError("EGO_INVALID_ARGUMENT", "Task space is not awaiting user handoff");
    }
    this.#takeoverConsents.add(id);
  }

  authorizeTakeoverByTaskId(taskId: string): void {
    const space = [...this.#spaces.values()].find((candidate) => candidate.taskId === taskId);
    if (!space) egoError("EGO_TASK_SPACE_NOT_FOUND", `Task space ${taskId} was not found`);
    this.authorizeTakeover(space.id);
  }

  takeover(
    id: number,
    clientId: string,
    allowWithoutConsent = false,
    allowPendingSuccessor = false,
  ): TaskSpaceRecord {
    const space = this.#get(id);
    if (space.ownership !== "agentDelegatedToUser") {
      egoError("EGO_TASK_SPACE_USER_IN_CONTROL", "Task space is not awaiting an agent return");
    }
    this.#assertNotBlocked(space, clientId);
    clientId = canonicalAgentClientId(clientId);
    const authorizedByPendingReturn = space.pendingAgentReturn === true
      && (
        space.lastAgentClientId === clientId
        || allowPendingSuccessor
      );
    const authorizedAutomatically = allowWithoutConsent;
    if (
      !authorizedByPendingReturn
      && !authorizedAutomatically
      && !this.#takeoverConsents.delete(id)
    ) {
      egoError("EGO_TASK_SPACE_USER_IN_CONTROL", "User consent is required");
    }
    return this.claim(id, clientId, true);
  }

  /**
   * Registers a listener invoked whenever a live lease is revoked, so the
   * broker can push lease.revoked to the affected agent client.
   */
  onLeaseRevoked(listener: (event: LeaseRevokedEvent) => void): () => void {
    this.#leaseRevokedListeners.add(listener);
    return () => this.#leaseRevokedListeners.delete(listener);
  }

  leaseHolder(taskId: string): Lease | undefined {
    const lease = this.#leases.get(taskId);
    return lease ? structuredClone(lease) : undefined;
  }

  byId(id: number): TaskSpaceRecord {
    return structuredClone(this.#get(id));
  }

  /**
   * The user seizes control of a space from the agent. Revokes the agent
   * lease, fences stale mutations through the epoch bump, and records which
   * agent was in control so control can later be returned to it.
   */
  userTakeover(id: number): TaskSpaceRecord {
    const space = this.#get(id);
    if (space.lifecycle === "closed") {
      egoError("EGO_TASK_SPACE_INACTIVE", "Task space is closed");
    }
    if (space.ownership === "user") {
      egoError("EGO_TASK_SPACE_INACTIVE", "Task space is not agent-controlled");
    }
    if (space.ownership === "agent") {
      this.#revoke(space);
      space.ownership = "agentDelegatedToUser";
    }
    delete space.pendingAgentReturn;
    this.#takeoverConsents.delete(id);
    this.#touch(space);
    return structuredClone(space);
  }

  /**
   * Stops the agent on a space without closing its tabs: same fencing as a
   * takeover, plus a persisted block that keeps agent clients from simply
   * re-claiming the space until the user returns control.
   */
  stopAgent(id: number): TaskSpaceRecord {
    const space = this.#get(id);
    if (space.lifecycle === "closed") {
      egoError("EGO_TASK_SPACE_INACTIVE", "Task space is closed");
    }
    if (space.ownership === "user") {
      egoError("EGO_TASK_SPACE_INACTIVE", "Task space is not agent-controlled");
    }
    if (space.ownership === "agent") {
      this.#revoke(space);
      space.ownership = "agentDelegatedToUser";
    }
    space.agentBlocked = true;
    delete space.pendingAgentReturn;
    this.#takeoverConsents.delete(id);
    this.#touch(space);
    return structuredClone(space);
  }

  /**
   * Records the user's explicit intent to return a user-held space. This also
   * clears a previous stop, while keeping the user in control until an agent
   * actually claims the new lease.
   */
  authorizeAgentReturn(id: number, requesterClientId: string): TaskSpaceRecord {
    const space = this.#get(id);
    if (space.lifecycle === "closed") {
      egoError("EGO_TASK_SPACE_INACTIVE", "Task space is closed");
    }
    if (space.ownership !== "agentDelegatedToUser") {
      egoError("EGO_INVALID_ARGUMENT", "Task space is not under user control");
    }
    const agentClientId = space.lastAgentClientId;
    if (!agentClientId || agentClientId === requesterClientId) {
      egoError("EGO_TASK_SPACE_UNAVAILABLE", "No agent is waiting to resume this task space");
    }
    space.agentBlocked = false;
    space.pendingAgentReturn = true;
    this.#touch(space);
    return structuredClone(space);
  }

  /**
   * Returns control immediately when a connected successor is known, or
   * persists a pending return that a later agent takeover can consume.
   */
  returnToAgent(
    id: number,
    requesterClientId: string,
    agentClientId?: string,
  ): AgentReturnResult {
    const waiting = this.authorizeAgentReturn(id, requesterClientId);
    if (!agentClientId) return { space: waiting };
    if (agentClientId === requesterClientId) {
      egoError("EGO_TASK_SPACE_UNAVAILABLE", "The requesting user cannot receive the agent lease");
    }
    return {
      space: this.claim(id, agentClientId, true),
      agentClientId,
    };
  }

  complete(clientId: string, keep: boolean, expectedId?: number): void {
    clientId = canonicalAgentClientId(clientId);
    const space = this.selected(clientId, expectedId);
    this.assertMutationAllowed(clientId, space.leaseEpoch, expectedId);
    if (this.#controlMode === "agent" && keep) {
      this.#selectedByClient.delete(clientId);
      return;
    }
    this.#revoke(space);
    space.ownership = "user";
    space.lifecycle = keep ? "inactive" : "closed";
    delete space.pendingAgentReturn;
    this.#selectedByClient.delete(clientId);
    this.#touch(space);
  }

  close(clientId: string, expectedId?: number): void {
    clientId = canonicalAgentClientId(clientId);
    this.complete(clientId, false, expectedId);
  }

  selected(clientId: string, expectedId?: number): TaskSpaceRecord {
    clientId = canonicalAgentClientId(clientId);
    const id = this.#selectedByClient.get(clientId);
    if (id === undefined) {
      egoError("EGO_TASK_SPACE_NOT_SELECTED", "No task space is selected");
    }
    if (expectedId !== undefined && id !== expectedId) {
      egoError(
        "EGO_TASK_SPACE_UNAVAILABLE",
        "Task space selection changed in another concurrent Agent operation",
      );
    }
    return this.#get(id);
  }

  recordByTaskId(taskId: string): TaskSpaceRecord {
    const space = [...this.#spaces.values()].find((candidate) => candidate.taskId === taskId);
    if (!space) egoError("EGO_TASK_SPACE_NOT_FOUND", `Task space ${taskId} was not found`);
    return structuredClone(space);
  }

  currentLease(clientId: string): Lease {
    clientId = canonicalAgentClientId(clientId);
    const space = this.selected(clientId);
    if (this.#controlMode === "agent") {
      this.#assertControllable(space);
      this.#assertNotBlocked(space, clientId);
      return this.#sharedLease(space, clientId);
    }
    const lease = this.#leases.get(space.taskId);
    if (!lease || lease.clientId !== clientId) {
      egoError("EGO_TASK_SPACE_UNAVAILABLE", "Task space lease is unavailable");
    }
    return structuredClone(lease);
  }

  heartbeat(clientId: string, epoch: number, expectedId?: number): Lease {
    clientId = canonicalAgentClientId(clientId);
    const space = this.#controlMode === "agent" && expectedId !== undefined
      ? this.#get(expectedId) : this.selected(clientId, expectedId);
    if (this.#controlMode === "agent") {
      this.assertMutationAllowed(clientId, epoch, space.id);
      return this.#sharedLease(space, clientId);
    }
    this.#assertControllable(space);
    const lease = this.#leases.get(space.taskId);
    if (!lease) egoError("EGO_TASK_SPACE_UNAVAILABLE", "Task space lease is unavailable");
    if (lease.clientId !== clientId) {
      egoError("EGO_TASK_SPACE_UNAVAILABLE", "Task space lease moved to another Agent");
    }
    if (lease.epoch !== epoch || lease.epoch !== space.leaseEpoch) {
      egoError("EGO_TASK_SPACE_UNAVAILABLE", "Task space lease epoch is stale");
    }
    lease.expiresAt = this.#clock.now() + this.#leaseTtlMs;
    return structuredClone(lease);
  }

  assertMutationAllowed(clientId: string, epoch: number, expectedId?: number): TaskSpaceRecord {
    clientId = canonicalAgentClientId(clientId);
    const space = this.#controlMode === "agent" && expectedId !== undefined
      ? this.#get(expectedId) : this.selected(clientId, expectedId);
    this.#assertAgentModeAllowed(clientId);
    this.#assertNotBlocked(space, clientId);
    if (space.ownership === "agentDelegatedToUser") {
      egoError("EGO_TASK_SPACE_USER_IN_CONTROL", "Task space is under user control");
    }
    if (space.ownership !== "agent" || space.lifecycle !== "active") {
      egoError("EGO_TASK_SPACE_INACTIVE", "Task space is inactive");
    }
    if (this.#controlMode === "agent") {
      if (epoch !== space.leaseEpoch) egoError("EGO_TASK_SPACE_UNAVAILABLE", "Task space generation is stale");
      return structuredClone(space);
    }
    const lease = this.#leases.get(space.taskId);
    if (
      !lease ||
      lease.clientId !== clientId ||
      lease.epoch !== epoch ||
      lease.epoch !== space.leaseEpoch ||
      lease.expiresAt <= this.#clock.now()
    ) {
      egoError("EGO_TASK_SPACE_UNAVAILABLE", "Task space lease is stale or unavailable");
    }
    return structuredClone(space);
  }

  recoverAfterRestart(): void {
    this.#leases.clear();
    this.#selectedByClient.clear();
    this.#takeoverConsents.clear();
    for (const space of this.#spaces.values()) {
      if (space.lifecycle === "closed") continue;
      space.leaseEpoch += 1;
      space.generation += 1;
      if (space.agentBlocked) {
        // Repair records written by the previous restart path, which could
        // persist a stopped space as user/inactive while retaining the block.
        space.ownership = "agentDelegatedToUser";
        space.lifecycle = "active";
        delete space.pendingAgentReturn;
      } else if (space.ownership === "agentDelegatedToUser") {
        space.lifecycle = "active";
      } else if (space.ownership === "agent") {
        space.ownership = "user";
        space.lifecycle = "inactive";
        delete space.pendingAgentReturn;
      }
      this.#touch(space, false);
    }
    this.#persist();
  }

  #get(id: number): TaskSpaceRecord {
    const space = this.#spaces.get(id);
    if (!space) egoError("EGO_TASK_SPACE_NOT_FOUND", `Task space ${id} was not found`);
    return space;
  }

  #assertControllable(space: TaskSpaceRecord): void {
    if (space.ownership === "agentDelegatedToUser") {
      egoError("EGO_TASK_SPACE_USER_IN_CONTROL", "Task space is under user control");
    }
    if (space.ownership !== "agent" || space.lifecycle !== "active") {
      egoError("EGO_TASK_SPACE_INACTIVE", "Task space is inactive");
    }
  }

  #acquire(space: TaskSpaceRecord, clientId: string): boolean {
    if (this.#controlMode === "agent") {
      // This record is informational in autonomous mode, never an exclusive lock.
      this.#leases.set(space.taskId, this.#sharedLease(space, clientId));
      if (!this.#isUserClient(clientId)) space.lastAgentClientId = clientId;
      return false;
    }
    const existing = this.#leases.get(space.taskId);
    if (
      existing &&
      existing.clientId !== clientId &&
      existing.expiresAt > this.#clock.now()
    ) {
      egoError("EGO_TASK_SPACE_UNAVAILABLE", "Task space is controlled by another agent");
    }
    const controlChanged = Boolean(existing && existing.clientId !== clientId);
    if (controlChanged) this.#revoke(space);
    this.#leases.set(space.taskId, {
      taskId: space.taskId,
      clientId,
      epoch: space.leaseEpoch,
      expiresAt: this.#clock.now() + this.#leaseTtlMs,
    });
    if (!this.#isUserClient(clientId)) space.lastAgentClientId = clientId;
    return controlChanged;
  }

  #assertNotBlocked(space: TaskSpaceRecord, clientId: string): void {
    if (space.agentBlocked && !this.#isUserClient(clientId)) {
      egoError("EGO_TASK_SPACE_USER_IN_CONTROL", "Task space is stopped by the user");
    }
  }

  #sharedLease(space: TaskSpaceRecord, clientId: string): Lease {
    return { taskId: space.taskId, clientId, epoch: space.leaseEpoch, expiresAt: Number.MAX_SAFE_INTEGER };
  }

  #assertAgentModeAllowed(clientId: string): void {
    if (!this.#isUserClient(clientId) && this.#controlMode === "manual") {
      egoError("EGO_TASK_SPACE_USER_IN_CONTROL", "人为干预模式下 Agent 无法操作工作区");
    }
  }

  #revoke(space: TaskSpaceRecord, notifyAll = this.#controlMode === "agent"): void {
    const previous = this.#leases.get(space.taskId);
    const affected = new Set(notifyAll ? [...this.#selectedByClient].filter(([, id]) => id === space.id).map(([client]) => client) : []);
    if (previous) affected.add(previous.clientId);
    this.#leases.delete(space.taskId);
    space.leaseEpoch += 1;
    space.generation += 1;
    if (previous && !this.#isUserClient(previous.clientId)) space.lastAgentClientId = previous.clientId;
    for (const clientId of affected) for (const listener of this.#leaseRevokedListeners) {
      listener({ taskId: space.taskId, clientId, leaseEpoch: space.leaseEpoch });
    }
  }

  #touch(space: TaskSpaceRecord, updateTime = true): void {
    if (updateTime) space.updatedAt = new Date(this.#clock.now()).toISOString();
    this.#persist();
  }

  #persist(): void {
    this.#store?.save([...this.#spaces.values()].map((space) => structuredClone(space)));
  }
}

function toPublicSpace(space: TaskSpaceRecord): PublicTaskSpace {
  return {
    taskId: space.taskId,
    id: space.id,
    name: space.name,
    profileId: normalizeProfileId(space.profileId),
    ...(typeof space.order === "number" ? { order: space.order } : {}),
    createdBy: space.createdBy,
    ownership: space.ownership,
    recentTabTitles: space.recentTabTitles ?? [],
    ...(space.agentBlocked ? { agentBlocked: true } : {}),
    ...(space.pendingAgentReturn ? { pendingAgentReturn: true } : {}),
    ...(space.lastAgentClientId ? { lastAgentClientId: space.lastAgentClientId } : {}),
    controlMode: normalizeControlMode(space.controlMode),
  };
}

function normalizeControlMode(value: unknown): ControlMode {
  return value === "collaborative" || value === "manual" ? value : "agent";
}

function normalizeProfileId(value: unknown): string {
  const clean = typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(clean) ? clean : "default";
}

export function isEgoProtocolError(error: unknown): error is EgoProtocolError {
  return error instanceof EgoProtocolError;
}
