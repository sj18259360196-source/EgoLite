import {
  type AgentAction,
  type AgentClientKind,
  type AgentInfo,
  type AgentRegistration,
} from "@ego-compat/protocol";

import type { Clock } from "./task-space-service.ts";

export interface AgentRegistryOptions {
  clock?: Clock;
  timeoutMs?: number;
}

export type AgentRegistryEvent =
  | { type: "changed"; agent: AgentInfo }
  | { type: "disconnected"; agent: AgentInfo };

export type AgentRegistryListener = (event: AgentRegistryEvent) => void;

interface InternalAgent {
  clientId: string;
  clientKind: AgentClientKind;
  displayName: string;
  version?: string;
  connectedAt: number;
  lastSeenAt: number;
  currentTaskId?: string;
  taskStartedAt?: number;
  runningCount: number;
  activityStartedAt?: number;
  currentAction?: AgentAction;
  offline: boolean;
  userControl: boolean;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_OFFLINE_AGENTS = 32;

const DEFAULT_DISPLAY_NAMES: Record<AgentClientKind, string> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  other: "Agent",
  "desktop-ui": "EgoLite",
};

const KNOWN_KINDS = new Set<AgentClientKind>([
  "codex",
  "claude",
  "cursor",
  "other",
  "desktop-ui",
]);

const systemClock: Clock = { now: () => Date.now() };

/**
 * Infers the agent kind from the conventional clientId prefixes used across
 * the runtime: Codex MCP sessions, the desktop shell, and external tools.
 */
export function inferAgentClientKind(clientId: string): AgentClientKind {
  if (clientId.startsWith("codex-")) return "codex";
  if (clientId.startsWith("claude-")) return "claude";
  if (clientId.startsWith("cursor-")) return "cursor";
  if (clientId.startsWith("desktop-")) return "desktop-ui";
  return "other";
}

export function canonicalAgentClientId(clientId: string): string {
  return clientId.replace(/^codex-(?:cli-|mcp-)?([a-f0-9]{24})$/, "codex-$1");
}

/**
 * Tracks every broker client that can hold a task-space lease: connection
 * state, the space it currently operates, and the running-operation summary
 * the desktop HUD renders. All state is in memory, so a broker restart
 * naturally reports every agent as gone instead of restoring control.
 */
export class AgentRegistry {
  readonly #agents = new Map<string, InternalAgent>();
  readonly #listeners = new Set<AgentRegistryListener>();
  readonly #clock: Clock;
  readonly #timeoutMs: number;

  constructor(options: AgentRegistryOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  onEvent(listener: AgentRegistryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  register(registration: AgentRegistration, publish = true): AgentInfo {
    const clientId = canonicalAgentClientId(registration.clientId);
    const existing = this.#agents.get(canonicalAgentClientId(clientId));
    const clientKind = knownKind(registration.clientKind) ?? existing?.clientKind ?? inferAgentClientKind(clientId);
    const displayName = cleanText(registration.displayName) || existing?.displayName || DEFAULT_DISPLAY_NAMES[clientKind];
    const now = this.#clock.now();
    if (existing) {
      const wasOffline = existing.offline;
      const previousKind = existing.clientKind;
      const previousName = existing.displayName;
      const previousVersion = existing.version;
      existing.clientKind = clientKind;
      existing.displayName = displayName;
      if (typeof registration.version === "string" && registration.version.trim()) {
        existing.version = registration.version.trim().slice(0, 60);
      }
      existing.lastSeenAt = now;
      if (wasOffline) this.#revive(existing, now);
      if (publish && (wasOffline || previousKind !== existing.clientKind || previousName !== existing.displayName || previousVersion !== existing.version)) {
        return this.#publish(existing, "changed");
      }
      return toPublic(existing);
    }
    const agent: InternalAgent = {
      clientId,
      clientKind,
      displayName,
      ...(typeof registration.version === "string" && registration.version.trim()
        ? { version: registration.version.trim().slice(0, 60) }
        : {}),
      connectedAt: now,
      lastSeenAt: now,
      runningCount: 0,
      offline: false,
      userControl: false,
    };
    this.#agents.set(clientId, agent);
    return publish ? this.#publish(agent, "changed") : toPublic(agent);
  }

  /**
   * Records that a client is still attached. Unknown clients are registered
   * with an inferred kind so legacy sessions still show up in agent.list.
   */
  observe(clientId: string): AgentInfo {
    return this.register({ clientId });
  }

  get(clientId: string): AgentInfo | undefined {
    const agent = this.#agents.get(canonicalAgentClientId(clientId));
    return agent ? toPublic(agent) : undefined;
  }

  list(): AgentInfo[] {
    return [...this.#agents.values()].map(toPublic);
  }

  online(): AgentInfo[] {
    return this.list().filter((agent) => agent.status !== "offline");
  }

  disconnect(clientId: string): AgentInfo | undefined {
    const agent = this.#agents.get(canonicalAgentClientId(clientId));
    if (!agent) return undefined;
    agent.offline = true;
    agent.runningCount = 0;
    delete agent.activityStartedAt;
    delete agent.currentAction;
    delete agent.currentTaskId;
    delete agent.taskStartedAt;
    agent.userControl = false;
    this.#evictOffline();
    return this.#publish(agent, "disconnected");
  }

  /** Marks agents whose lastSeenAt exceeded the timeout as offline. */
  sweep(): AgentInfo[] {
    const now = this.#clock.now();
    const expired: AgentInfo[] = [];
    for (const agent of this.#agents.values()) {
      if (agent.offline || agent.lastSeenAt + this.#timeoutMs > now) continue;
      expired.push(this.disconnect(agent.clientId)!);
    }
    return expired;
  }

  setCurrentTask(clientId: string, taskId: string | undefined): AgentInfo | undefined {
    const agent = this.#agents.get(canonicalAgentClientId(clientId));
    if (!agent || agent.offline) return undefined;
    if (agent.currentTaskId === taskId) {
      agent.lastSeenAt = this.#clock.now();
      return toPublic(agent);
    }
    if (taskId) agent.currentTaskId = taskId;
    else delete agent.currentTaskId;
    if (taskId) agent.taskStartedAt = this.#clock.now();
    else delete agent.taskStartedAt;
    agent.userControl = false;
    return this.#publish(agent, "changed");
  }

  /** Clears task selection and any executing state for every agent on a task. */
  clearTask(taskId: string): AgentInfo[] {
    const cleared: AgentInfo[] = [];
    for (const agent of this.#agents.values()) {
      if (agent.currentTaskId !== taskId) continue;
      delete agent.currentTaskId;
      delete agent.taskStartedAt;
      agent.runningCount = 0;
      delete agent.activityStartedAt;
      delete agent.currentAction;
      agent.userControl = false;
      cleared.push(this.#publish(agent, "changed"));
    }
    return cleared;
  }

  startActivity(clientId: string, action: AgentAction, taskId?: string): AgentInfo | undefined {
    const agent = this.#agents.get(canonicalAgentClientId(clientId));
    if (!agent) return undefined;
    if (agent.offline) this.#revive(agent, this.#clock.now());
    agent.lastSeenAt = this.#clock.now();
    if (taskId && agent.currentTaskId !== taskId) {
      agent.currentTaskId = taskId;
      agent.taskStartedAt = agent.lastSeenAt;
    }
    agent.userControl = false;
    agent.runningCount += 1;
    agent.currentAction = { tool: action.tool.slice(0, 120), startedAt: action.startedAt };
    if (!agent.activityStartedAt) agent.activityStartedAt = agent.lastSeenAt;
    return this.#publish(agent, "changed");
  }

  finishActivity(clientId: string): AgentInfo | undefined {
    const agent = this.#agents.get(canonicalAgentClientId(clientId));
    if (!agent) return undefined;
    agent.lastSeenAt = this.#clock.now();
    agent.runningCount = Math.max(0, agent.runningCount - 1);
    if (agent.runningCount === 0) {
      delete agent.activityStartedAt;
      delete agent.currentAction;
    }
    return this.#publish(agent, "changed");
  }

  /** Clears the user-control marker after the user explicitly returns the space. */
  clearUserControl(clientId: string): AgentInfo | undefined {
    const agent = this.#agents.get(canonicalAgentClientId(clientId));
    if (!agent || agent.offline) return undefined;
    if (!agent.userControl) return toPublic(agent);
    agent.userControl = false;
    return this.#publish(agent, "changed");
  }

  /** Flags that the user took over a space this agent was operating. */
  noteUserControl(clientId: string): AgentInfo | undefined {
    const agent = this.#agents.get(canonicalAgentClientId(clientId));
    if (!agent || agent.offline) return undefined;
    if (!agent.userControl) {
      agent.userControl = true;
      agent.runningCount = 0;
      delete agent.activityStartedAt;
      delete agent.currentAction;
      return this.#publish(agent, "changed");
    }
    return toPublic(agent);
  }

  reset(): void {
    this.#agents.clear();
  }

  #revive(agent: InternalAgent, now: number): void {
    agent.offline = false;
    agent.connectedAt = now;
    agent.lastSeenAt = now;
    agent.runningCount = 0;
    agent.userControl = false;
  }

  #evictOffline(): void {
    const offline = [...this.#agents.values()].filter((agent) => agent.offline);
    if (offline.length <= MAX_OFFLINE_AGENTS) return;
    for (const agent of offline
      .sort((left, right) => left.lastSeenAt - right.lastSeenAt)
      .slice(0, offline.length - MAX_OFFLINE_AGENTS)) {
      this.#agents.delete(agent.clientId);
    }
  }

  #publish(agent: InternalAgent, type: "changed" | "disconnected"): AgentInfo {
    const info = toPublic(agent);
    for (const listener of this.#listeners) listener({ type, agent: info });
    return info;
  }
}

function knownKind(value: unknown): AgentClientKind | undefined {
  return typeof value === "string" && KNOWN_KINDS.has(value as AgentClientKind)
    ? (value as AgentClientKind)
    : undefined;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function toPublic(agent: InternalAgent): AgentInfo {
  return {
    clientId: agent.clientId,
    clientKind: agent.clientKind,
    displayName: agent.displayName,
    ...(agent.version ? { version: agent.version } : {}),
    connectedAt: new Date(agent.connectedAt).toISOString(),
    lastSeenAt: new Date(agent.lastSeenAt).toISOString(),
    ...(agent.currentTaskId ? { currentTaskId: agent.currentTaskId } : {}),
    status: agentStatus(agent),
    ...(agent.activityStartedAt
      ? { activityStartedAt: new Date(agent.activityStartedAt).toISOString() }
      : {}),
    ...(agent.taskStartedAt
      ? { taskStartedAt: new Date(agent.taskStartedAt).toISOString() }
      : {}),
    ...(agent.currentAction ? { currentAction: agent.currentAction } : {}),
  };
}

function agentStatus(agent: InternalAgent): AgentInfo["status"] {
  if (agent.offline) return "offline";
  if (agent.userControl) return "user-control";
  if (agent.runningCount > 0) return "executing";
  return "online";
}
