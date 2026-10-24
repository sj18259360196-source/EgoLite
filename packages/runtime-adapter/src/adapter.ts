import {
  type AIPageContent,
  type CollectionItem,
  type EgoTab,
  type EgoTabGroup,
  EGO_ERROR_CODES,
  type EgoErrorCode,
  type EgoRuntime,
  type PublicTab,
  type PublicTaskSpace,
  type ReferenceActionBinding,
  type ReferenceActionBindRequest,
  type ReferenceActionGroupBinding,
  type ReferenceActionGroupBindRequest,
  type ReferenceActionWire,
  type SnapshotOptions,
  type SnapshotResult,
  type TextSelection,
  type SpaceControlState,
  type ControlRequest,
  SCOPED_REFS_CAPABILITY,
} from "@ego-compat/protocol";

import type { RuntimeTransport } from "./transport.ts";

interface RuntimeAdapterOptions {
  clientId: string;
  capabilities?: Iterable<string> | (() => Iterable<string>);
  referenceActionMaxLifetimeMs?: number | (() => number | undefined);
}

interface SelectedTask {
  id: number;
  leaseEpoch: number;
}

interface BoundReferenceAction {
  mutation: ReturnType<typeof mutationParams>;
  runtimeId: string;
}

export interface LeaseAwareEgoRuntime extends EgoRuntime {
  /** Renews the selected task lease without requiring a browser operation. */
  heartbeatTaskSpace(): Promise<boolean>;
}

export function createEgoRuntime(
  transport: RuntimeTransport,
  options: RuntimeAdapterOptions,
): LeaseAwareEgoRuntime {
  let selected: SelectedTask | undefined;
  const boundReferenceActions = new Map<string, BoundReferenceAction>();
  const runtime: LeaseAwareEgoRuntime = {
    async automationRequest(operation, input) {
      const current = await heartbeatSelected();
      return transport.request("automation.request", { ...mutationParams(current, options.clientId), operation, input });
    },
    observeTaskSpace(id, targetId, snapshotOptions) { return transport.request<SpaceControlState & { tabs: PublicTab[]; snapshot?: SnapshotResult }>("space.observe", { clientId: options.clientId, id, targetId, options: snapshotOptions, ...snapshotRefFormatParams() }); },
    requestControl(id) { return transport.request<ControlRequest>("space.requestControl", { clientId: options.clientId, id }); },
    async returnControl(id, requestId) {
      const current = await heartbeatSelected();
      if (current.id !== id) throw localNotSelected();
      return transport.request<SpaceControlState>("space.returnControl", { ...mutationParams(current, options.clientId), id, requestId });
    },
    async waitForAgentControl(id, waitOptions = {}) {
      const timeout = waitOptions.timeout ?? 600_000;
      if (!Number.isFinite(timeout) || timeout < 0) throw new Error("Invalid control wait timeout");
      const signal = waitOptions.signal;
      if (signal?.aborted) throw new Error("Control wait cancelled");
      await new Promise<void>((resolve, reject) => {
        let done = false, running = false, dirty = false;
        const finish = (error?: Error) => {
          if (done) return;
          done = true; unsubscribe(); clearTimeout(timer); signal?.removeEventListener("abort", abort);
          if (error) reject(error); else resolve();
        };
        const abort = () => finish(new Error("Control wait cancelled"));
        const check = async () => {
          if (done) return;
          if (running) { dirty = true; return; }
          running = true;
          try {
            const state = await transport.request<SpaceControlState & { takeoverAllowed?: boolean }>("space.controlState", { clientId: options.clientId, id });
            if (done) return;
            if (state.space.lifecycle === "closed") throw new Error("Task space closed while waiting");
            const ownId = options.clientId.replace(/^codex-(?:cli-|mcp-)?([a-f0-9]{24})$/, "codex-$1");
            if (state.controllerClientId === ownId || state.takeoverAllowed) {
              // Claim only after the Broker has explicitly assigned this writer.
              const result = await transport.request<{ leaseEpoch: number }>(state.controllerClientId === ownId ? "space.select" : "space.takeover", { clientId: options.clientId, id });
              if (!done) { selected = { id, leaseEpoch: result.leaseEpoch }; finish(); }
            }
          } catch (error) { if (!done) finish(error instanceof Error ? error : new Error(String(error))); }
          finally { running = false; if (dirty && !done) { dirty = false; void check(); } }
        };
        const unsubscribe = transport.onEvent((method, params) => {
          if (method === "space.controlChanged" && (params as SpaceControlState)?.space?.id === id) void check();
        });
        const timer = setTimeout(() => finish(new Error("Control wait timed out")), timeout);
        signal?.addEventListener("abort", abort, { once: true });
        void check();
      });
    },
    async useOrCreateTaskSpace(nameOrId) {
      const result = await transport.request<PublicTaskSpace & { leaseEpoch: number }>("space.useOrCreate", { clientId: options.clientId, ...(typeof nameOrId === "number" ? { id: nameOrId } : { name: nameOrId }) });
      selected = { id: result.id, leaseEpoch: result.leaseEpoch };
      return result;
    },
    async openOrReuseTab(url, match) {
      const current = await heartbeatSelected();
      return transport.request<PublicTab & { reused: boolean }>("tab.openOrReuse", { ...mutationParams(current, options.clientId), url, match });
    },
    async listTaskSpaces() {
      return transport.request<{ taskSpaces: PublicTaskSpace[] }>("space.list", {
        clientId: options.clientId,
      });
    },

    async createTaskSpace(name, profileId) {
      const result = await transport.request<PublicTaskSpace & { leaseEpoch: number }>(
        "space.create",
        { clientId: options.clientId, name, ...(profileId ? { profileId } : {}) },
      );
      selected = { id: result.id, leaseEpoch: result.leaseEpoch };
      return result;
    },

    async useTaskSpace(id) {
      try {
        const result = await transport.request<{ leaseEpoch: number }>("space.select", {
          clientId: options.clientId,
          id,
        });
        selected = { id, leaseEpoch: result.leaseEpoch };
      } catch (error) {
        if (normalizeError(error).code === "EGO_TASK_SPACE_USER_IN_CONTROL") {
          selected = { id, leaseEpoch: -1 };
        }
        throw error;
      }
    },

    async claimTaskSpace(id, name) {
      const result = await transport.request<PublicTaskSpace & { leaseEpoch: number }>(
        "space.claim",
        { clientId: options.clientId, id, name },
      );
      selected = { id, leaseEpoch: result.leaseEpoch };
      return result;
    },

    async handOffTaskSpace() {
      const current = await heartbeatSelected();
      await transport.request("space.handoff", mutationParams(current, options.clientId));
    },

    async takeOverTaskSpace(id) {
      const targetId = id ?? selected?.id;
      if (targetId === undefined) throw localNotSelected();
      const result = await transport.request<{ leaseEpoch: number }>("space.takeover", {
        clientId: options.clientId,
        id: targetId,
      });
      selected = { id: targetId, leaseEpoch: result.leaseEpoch };
    },

    async completeTaskSpace() {
      const current = await heartbeatSelected();
      await transport.request("space.complete", {
        ...mutationParams(current, options.clientId),
        keep: true,
      });
      selected = undefined;
    },

    async closeTaskSpace() {
      const current = await heartbeatSelected();
      await transport.request("space.close", mutationParams(current, options.clientId));
      selected = undefined;
    },

    async heartbeatTaskSpace() {
      return Boolean(await renewSelected(true));
    },

    async listTabs() {
      return transport.request<{ tabs: PublicTab[] }>("tab.list", {
        clientId: options.clientId,
      });
    },

    async getAllTabs() {
      return transport.request<EgoTab[]>("tab.listAll", { clientId: options.clientId });
    },

    async getTabGroups() {
      return transport.request<EgoTabGroup[]>("tab.groupList", { clientId: options.clientId });
    },

    async activateTab(tab) {
      const targetId = tabId(tab);
      if (!targetId) return false;
      return transport.request<boolean>("tab.activate", { clientId: options.clientId, targetId });
    },

    async closeTab(tab) {
      const targetId = tabId(tab);
      if (!targetId) return false;
      return transport.request<boolean>("tab.close", { clientId: options.clientId, targetId });
    },

    async openUrlInNewTab(url, taskId) {
      return transport.request<EgoTab>("tab.openUrl", {
        clientId: options.clientId,
        url,
        taskId,
      });
    },

    async createTab(url) {
      const current = await heartbeatSelected();
      return transport.request<PublicTab>("tab.create", {
        ...mutationParams(current, options.clientId),
        url,
      });
    },

    async snapshot(snapshotOptions?: SnapshotOptions) {
      const current = await heartbeatSelected();
      return transport.request<SnapshotResult>("snapshot.capture", {
        ...mutationParams(current, options.clientId),
        options: snapshotOptions,
        ...snapshotRefFormatParams(),
      });
    },

    async bindReferenceAction(request: ReferenceActionBindRequest) {
      if (!supportsScopedReferences()) throw scopedReferencesUnavailable();
      const current = await heartbeatSelected();
      const mutation = mutationParams(current, options.clientId);
      const binding = await transport.request<ReferenceActionBinding>("ref.bind", {
        ...mutation,
        request,
      });
      boundReferenceActions.set(referenceActionKey(binding), {
        mutation: { ...mutation },
        runtimeId: binding.runtimeId,
      });
      return binding;
    },

    async bindReferenceActionGroup(request: ReferenceActionGroupBindRequest) {
      if (!supportsScopedReferences()) throw scopedReferencesUnavailable();
      const current = await heartbeatSelected();
      const mutation = mutationParams(current, options.clientId);
      const binding = await transport.request<ReferenceActionGroupBinding>("ref.bind", {
        ...mutation,
        request,
      });
      boundReferenceActions.set(referenceActionKey(binding), {
        mutation: { ...mutation },
        runtimeId: binding.runtimeId,
      });
      return binding;
    },

    getReferenceActionMaxLifetimeMs() {
      return typeof options.referenceActionMaxLifetimeMs === "function"
        ? options.referenceActionMaxLifetimeMs()
        : options.referenceActionMaxLifetimeMs;
    },

    async releaseReferenceAction(action: ReferenceActionWire) {
      const wire = referenceActionWire(action);
      const key = referenceActionKey(wire);
      const bound = boundReferenceActions.get(key);
      if (!bound) return;
      boundReferenceActions.delete(key);
      await transport.request("ref.release", {
        ...bound.mutation,
        refAction: wire,
      });
    },

    async getAIPageContent(tab, snapshotOptions) {
      const targetId = typeof tab === "string" ? tab : tab.targetId ?? tab.id;
      if (!targetId) return null;
      try {
        return await transport.request<AIPageContent>("page.aiContent", {
          clientId: options.clientId,
          targetId,
          options: snapshotOptions,
        });
      } catch {
        return null;
      }
    },

    async saveTextToCollections(text, sourceUrl) {
      return transport.request<boolean>("collection.save", {
        clientId: options.clientId,
        text,
        sourceUrl,
      });
    },

    async listCollections(query) {
      return transport.request<CollectionItem[]>("collection.list", {
        clientId: options.clientId,
        query,
      });
    },

    sendCDPMessage(payload, refAction) {
      const wire = refAction ? referenceActionWire(refAction) : undefined;
      let requestId: number | undefined;
      try {
        const parsed = JSON.parse(payload);
        if (Number.isSafeInteger(parsed?.id)) requestId = parsed.id;
      } catch {
        // Malformed payloads have no trustworthy CDP request identity.
      }
      void heartbeatSelected()
        .then((current) => {
          const mutation = mutationParams(current, options.clientId);
          if (wire) {
            const bound = boundReferenceActions.get(referenceActionKey(wire));
            if (!bound || bound.runtimeId !== wire.runtimeId) throw invalidReferenceAction();
            if (
              bound.mutation.taskSpaceId !== mutation.taskSpaceId
              || bound.mutation.leaseEpoch !== mutation.leaseEpoch
              || bound.mutation.clientId !== mutation.clientId
            ) {
              throw invalidReferenceAction();
            }
          }
          return transport.request<string>("cdp.send", {
            ...mutation,
            payload,
            ...(wire ? { refAction: wire } : {}),
          });
        })
        .then((message) => runtime.onCDPMessage?.(message))
        .catch((error: unknown) => {
          const normalized = normalizeError(error);
          runtime.onSendCDPMessageError?.(normalized.message, normalized.code, requestId);
        });
    },
  };

  transport.onEvent((method, params) => {
    if (method === "cdp.message" && typeof params === "string") {
      runtime.onCDPMessage?.(params);
    }
    // A revoked lease does not deselect the task. Keeping its identity allows the
    // SDK to observe USER_IN_CONTROL and later resume after explicit consent.
    if (method === "lease.revoked" && selected && params && typeof params === "object") {
      const value = params as { taskSpaceId?: unknown };
      if (value.taskSpaceId === selected.id) selected.leaseEpoch = -1;
    }
    if (method === "lease.returned" && selected && params && typeof params === "object") {
      const value = params as { taskSpaceId?: unknown; leaseEpoch?: unknown };
      if (value.taskSpaceId === selected.id && typeof value.leaseEpoch === "number") {
        selected.leaseEpoch = value.leaseEpoch;
      }
    }
    if (method === "tab.changed" && params && typeof params === "object") {
      runtime.onActiveTabChanged?.(params as EgoTab);
    }
    if (method === "text.selectionChanged" && params && typeof params === "object") {
      runtime.onTextSelectionChanged?.(params as TextSelection);
    }
  });

  transport.onReconnect?.(() => {
    boundReferenceActions.clear();
    runtime.onReconnect?.();
  });

  return runtime;

  async function heartbeatSelected(): Promise<SelectedTask> {
    const current = await renewSelected(false);
    if (!current) throw localNotSelected();
    return current;
  }

  function snapshotRefFormatParams() {
    return supportsScopedReferences()
      ? { refFormat: "scoped-v1" as const }
      : {};
  }

  function supportsScopedReferences(): boolean {
    const configured = typeof options.capabilities === "function"
      ? options.capabilities()
      : options.capabilities;
    return Boolean(configured && new Set(configured).has(SCOPED_REFS_CAPABILITY));
  }

  async function renewSelected(skipFencedLease: boolean): Promise<SelectedTask | undefined> {
    const current = selected;
    if (!current || (skipFencedLease && current.leaseEpoch < 0)) return undefined;
    const leaseEpoch = current.leaseEpoch;
    const lease = await transport.request<{ epoch: number }>("space.heartbeat", {
      clientId: options.clientId,
      taskSpaceId: current.id,
      leaseEpoch,
    });
    if (selected !== current || current.leaseEpoch !== leaseEpoch) return undefined;
    current.leaseEpoch = lease.epoch;
    return current;
  }
}

function mutationParams(selected: SelectedTask | undefined, clientId: string) {
  if (!selected) throw localNotSelected();
  return {
    clientId,
    taskSpaceId: selected.id,
    leaseEpoch: selected.leaseEpoch,
  };
}

function referenceActionKey(action: ReferenceActionWire): string {
  return `${action.runtimeId}\u0000${action.token}`;
}

function referenceActionWire(action: ReferenceActionWire): ReferenceActionWire {
  return {
    version: "scoped-v1",
    runtimeId: action.runtimeId,
    token: action.token,
  };
}

function scopedReferencesUnavailable() {
  return Object.assign(new Error("Scoped reference actions were not negotiated"), {
    error_code: "EGO_ACTION_CONTEXT_INVALID" satisfies EgoErrorCode,
  });
}

function invalidReferenceAction() {
  return Object.assign(new Error("Scoped reference action is no longer valid for the selected lease"), {
    error_code: "EGO_ACTION_CONTEXT_INVALID" satisfies EgoErrorCode,
  });
}

function tabId(tab: string | { id?: string; targetId?: string }): string | undefined {
  return typeof tab === "string" ? tab : tab.targetId ?? tab.id;
}

function localNotSelected() {
  return Object.assign(new Error("No task space is selected"), {
    error_code: "EGO_TASK_SPACE_NOT_SELECTED" satisfies EgoErrorCode,
  });
}

function normalizeError(error: unknown): { message: string; code: string } {
  const value = error as { message?: unknown; error_code?: unknown } | undefined;
  const message = typeof value?.message === "string" ? value.message : String(error);
  const code =
    typeof value?.error_code === "string" &&
    EGO_ERROR_CODES.includes(value.error_code as EgoErrorCode)
      ? value.error_code
      : "EGO_CDP_SEND_FAILED";
  return { message, code };
}
