import type {
  AIPageContent,
  BrowserBackendStatus,
  CdpRequestContext,
  PublicTab,
  RefFormat,
  ReferenceActionBinding,
  ReferenceActionBindRequest,
  ReferenceActionGroupBinding,
  ReferenceActionGroupBindRequest,
  ReferenceActionWire,
  SnapshotOptions,
  SnapshotResult,
  TaskSpaceRecord,
  TextSelection,
} from "@ego-compat/protocol";

export interface MutationContext {
  clientId: string;
  taskSpaceId: number;
  leaseEpoch: number;
}

export interface SnapshotRequestContext {
  clientId: string;
  taskSpaceId?: number;
  leaseEpoch?: number;
  refFormat: RefFormat;
}

export interface BrowserBackend {
  automationRequest?(taskId: string, operation: string, input: Record<string, unknown>, mutation: MutationContext): Promise<unknown>;
  start?(): Promise<void>;
  status?(): Promise<BrowserBackendStatus> | BrowserBackendStatus;
  createSpace(space: TaskSpaceRecord, options?: { visualSync?: boolean }): Promise<void>;
  closeSpace(taskId: string, options?: { visualSync?: boolean }): Promise<void>;
  listTabs(taskId: string): Promise<PublicTab[]>;
  createTab(taskId: string, url?: string, mutation?: MutationContext): Promise<PublicTab>;
  snapshot(
    taskId: string,
    options?: SnapshotOptions,
    targetId?: string,
    context?: SnapshotRequestContext,
  ): Promise<SnapshotResult>;
  getAIPageContent?(
    taskId: string,
    targetId: string,
    options?: SnapshotOptions,
  ): Promise<AIPageContent>;
  bindReferenceAction?(
    taskId: string,
    request: ReferenceActionBindRequest,
    mutation: MutationContext,
  ): Promise<ReferenceActionBinding>;
  bindReferenceActionGroup?(
    taskId: string,
    request: ReferenceActionGroupBindRequest,
    mutation: MutationContext,
  ): Promise<ReferenceActionGroupBinding>;
  releaseReferenceAction?(
    taskId: string,
    action: ReferenceActionWire,
    mutation: MutationContext,
  ): Promise<void>;
  sendCdp(
    taskId: string,
    payload: string,
    mutation?: MutationContext,
    context?: CdpRequestContext,
  ): Promise<string>;
  prepareControl?(taskId: string): Promise<void>;
  updateSpaceState?(space: TaskSpaceRecord): Promise<void>;
  relinquishControl?(taskId: string): Promise<void>;
  onCdpMessage?(listener: (taskId: string, payload: string, clientId?: string) => void): () => void;
  onTabChanged?(listener: (taskId: string, tab: PublicTab) => void): () => void;
  onTextSelectionChanged?(
    listener: (taskId: string, selection: TextSelection) => void,
  ): () => void;
  setUiRequestHandler?(
    handler: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ): void;
  onControlLost?(listener: (taskId: string, reason: string) => void): () => void;
  onTakeoverAuthorized?(listener: (taskId: string) => void): () => void;
  dispose?(): Promise<void>;
}

export class FakeBrowserBackend implements BrowserBackend {
  readonly tabs = new Map<string, PublicTab[]>();

  status(): BrowserBackendStatus {
    return { kind: "fake", ready: true, connected: true };
  }

  async createSpace(space: TaskSpaceRecord): Promise<void> {
    this.tabs.set(space.taskId, []);
  }

  async closeSpace(taskId: string): Promise<void> {
    this.tabs.delete(taskId);
  }

  async listTabs(taskId: string): Promise<PublicTab[]> {
    return structuredClone(this.tabs.get(taskId) ?? []);
  }

  async createTab(taskId: string, url = "about:blank"): Promise<PublicTab> {
    const tabs = this.tabs.get(taskId);
    if (!tabs) throw new Error(`Unknown fake task: ${taskId}`);
    for (const tab of tabs) tab.active = false;
    const tab: PublicTab = {
      targetId: `fake-target-${taskId}-${tabs.length + 1}`,
      title: url === "about:blank" ? "New Tab" : url,
      url,
      active: true,
    };
    tabs.push(tab);
    return structuredClone(tab);
  }

  async snapshot(
    taskId: string,
    _options = {},
    targetId?: string,
  ): Promise<SnapshotResult> {
    const active = targetId
      ? (this.tabs.get(taskId) ?? []).find((tab) => tab.targetId === targetId)
      : (this.tabs.get(taskId) ?? []).find((tab) => tab.active);
    return {
      content: active ? `document "${active.title}"` : "document",
      refs: [],
    };
  }

  async getAIPageContent(taskId: string, targetId: string): Promise<AIPageContent> {
    const tab = (this.tabs.get(taskId) ?? []).find((item) => item.targetId === targetId);
    if (!tab) throw new Error(`Unknown fake target: ${targetId}`);
    const snapshot = await this.snapshot(taskId, {}, targetId);
    return pageContent(tab, snapshot);
  }

  async sendCdp(taskId: string, payload: string): Promise<string> {
    const request = JSON.parse(payload) as {
      id?: number;
      method?: string;
      params?: { targetId?: string };
    };
    const tabs = this.tabs.get(taskId);
    if (!tabs) throw new Error(`Unknown fake task: ${taskId}`);
    if (request.method === "Target.closeTarget" && request.params?.targetId) {
      const index = tabs.findIndex((tab) => tab.targetId === request.params?.targetId);
      if (index >= 0) tabs.splice(index, 1);
      if (tabs.length && !tabs.some((tab) => tab.active)) {
        tabs[Math.min(index, tabs.length - 1)]!.active = true;
      }
      return JSON.stringify({ id: request.id, result: { success: index >= 0 } });
    }
    if (request.method === "Target.activateTarget" && request.params?.targetId) {
      let found = false;
      for (const tab of tabs) {
        tab.active = tab.targetId === request.params.targetId;
        found ||= tab.active;
      }
      return JSON.stringify({ id: request.id, result: { success: found } });
    }
    return JSON.stringify({
      id: request.id,
      result: { method: request.method, params: request.params ?? {} },
    });
  }

  async relinquishControl(_taskId: string): Promise<void> {}
  async prepareControl(_taskId: string): Promise<void> {}
  async updateSpaceState(_space: TaskSpaceRecord): Promise<void> {}
}

function pageContent(tab: PublicTab, snapshot: SnapshotResult): AIPageContent {
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
