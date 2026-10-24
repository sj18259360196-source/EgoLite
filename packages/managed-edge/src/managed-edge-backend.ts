import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import type { BrowserBackend } from "@ego-compat/broker-core";
import {
  type AIPageContent,
  type BrowserBackendStatus,
  EgoProtocolError,
  type PublicTab,
  type SnapshotOptions,
  type SnapshotRef,
  type SnapshotResult,
  type TaskSpaceRecord,
  type TextSelection,
} from "@ego-compat/protocol";

import { CdpPipeTransport, type CdpMessage } from "./cdp-pipe.ts";

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
}

interface DomSnapshotDocument {
  nodes: {
    backendNodeId: number[];
    nodeName: number[];
    attributes: Array<number[]>;
  };
  layout: {
    nodeIndex: number[];
    bounds: Array<[number, number, number, number]>;
  };
}

interface DomSnapshotResult {
  documents: DomSnapshotDocument[];
  strings: string[];
}

interface DomNodeInfo {
  nodeName: string;
  attributes: Record<string, string>;
  bounds?: [number, number, number, number];
}

interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PendingPopup {
  taskId: string;
  url?: string;
  createdAt: number;
}

export interface ManagedEdgeOptions {
  executablePath?: string;
  profilePath?: string;
  headless?: boolean;
}

const DEFAULT_EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SELECTION_EXPRESSION = `JSON.stringify({
  text: getSelection()?.toString().trim() || "",
  sourceUrl: location.href,
  pageTitle: document.title,
  favicon: document.querySelector('link[rel~="icon"]')?.href || null,
})`;

export class ManagedEdgeBackend implements BrowserBackend {
  readonly #tabListeners = new Set<(taskId: string, tab: PublicTab) => void>();
  readonly #selectionListeners = new Set<(taskId: string, selection: TextSelection) => void>();
  readonly #selectionSignatureByTask = new Map<string, string>();
  #selectionTimer: NodeJS.Timeout | undefined;
  readonly #options: Required<ManagedEdgeOptions>;
  readonly #targetsByTask = new Map<string, Set<string>>();
  readonly #activeTargetByTask = new Map<string, string>();
  readonly #taskBySession = new Map<string, string>();
  readonly #targetBySession = new Map<string, string>();
  readonly #taskByTarget = new Map<string, string>();
  readonly #taskByFrame = new Map<string, string>();
  readonly #pendingPopups: PendingPopup[] = [];
  readonly #listeners = new Set<(taskId: string, payload: string) => void>();
  #transport: CdpPipeTransport | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(options: ManagedEdgeOptions = {}) {
    this.#options = {
      executablePath: options.executablePath ?? DEFAULT_EDGE,
      profilePath:
        options.profilePath ??
        join(process.env.LOCALAPPDATA ?? process.cwd(), "EgoCompat", "Profiles", "dev"),
      headless: options.headless ?? false,
    };
  }

  async start(): Promise<void> {
    if (this.#transport) return;
    await access(this.#options.executablePath);
    this.#transport = await CdpPipeTransport.launch(this.#options);
    this.#unsubscribe = this.#transport.onMessage((message) => this.#forwardEvent(message));
    await this.#transport.send("Target.setDiscoverTargets", { discover: true });
    await this.#transport.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  status(): BrowserBackendStatus {
    return {
      kind: "managed",
      ready: true,
      connected: Boolean(this.#transport),
      message: this.#transport
        ? "Managed Edge is running."
        : "Managed Edge is ready and will start when Codex creates a task space.",
    };
  }

  onCdpMessage(listener: (taskId: string, payload: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.#selectionTimer) clearTimeout(this.#selectionTimer);
    this.#selectionTimer = undefined;
    this.#selectionListeners.clear();
    this.#selectionSignatureByTask.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const transport = this.#transport;
    this.#transport = undefined;
    if (transport) await transport.close();
  }

  async createSpace(space: TaskSpaceRecord): Promise<void> {
    await this.start();
    this.#targetsByTask.set(space.taskId, new Set());
  }

  async closeSpace(taskId: string): Promise<void> {
    const targets = [...(this.#targetsByTask.get(taskId) ?? [])];
    for (const targetId of targets) {
      try {
        await this.#send("Target.closeTarget", { targetId });
      } catch {
        // A user may already have closed the tab.
      }
    }
    this.#targetsByTask.delete(taskId);
    this.#activeTargetByTask.delete(taskId);
    for (const [sessionId, owner] of this.#taskBySession) {
      if (owner === taskId) this.#taskBySession.delete(sessionId);
    }
    for (const [sessionId, targetId] of this.#targetBySession) {
      if (targets.includes(targetId)) this.#targetBySession.delete(sessionId);
    }
    for (const [targetId, owner] of this.#taskByTarget) {
      if (owner === taskId) this.#taskByTarget.delete(targetId);
    }
  }

  async listTabs(taskId: string): Promise<PublicTab[]> {
    const owned = this.#requireTask(taskId);
    const infos = await this.#targetInfos();
    const activeTargetId = this.#activeTargetByTask.get(taskId);
    return infos
      .filter((target) => target.type === "page" && owned.has(target.targetId))
      .map((target) => ({
        targetId: target.targetId,
        title: target.title,
        url: target.url,
        active: target.targetId === activeTargetId,
      }));
  }

  async createTab(taskId: string, url = "about:blank"): Promise<PublicTab> {
    const owned = this.#requireTask(taskId);
    const response = await this.#send("Target.createTarget", { url });
    const targetId = readString(response.result, "targetId");
    this.#bindTarget(taskId, targetId);
    await this.#send("Target.activateTarget", { targetId });
    this.#activeTargetByTask.set(taskId, targetId);
    const tab = { targetId, title: url === "about:blank" ? "New Tab" : url, url, active: true };
    this.#emitTabChanged(taskId, tab);
    return tab;
  }

  onTabChanged(listener: (taskId: string, tab: PublicTab) => void): () => void {
    this.#tabListeners.add(listener);
    return () => this.#tabListeners.delete(listener);
  }

  onTextSelectionChanged(
    listener: (taskId: string, selection: TextSelection) => void,
  ): () => void {
    this.#selectionListeners.add(listener);
    this.#ensureSelectionPolling();
    return () => {
      this.#selectionListeners.delete(listener);
      if (!this.#selectionListeners.size && this.#selectionTimer) {
        clearTimeout(this.#selectionTimer);
        this.#selectionTimer = undefined;
      }
    };
  }

  async snapshot(
    taskId: string,
    options: SnapshotOptions = {},
    targetId?: string,
  ): Promise<SnapshotResult> {
    const target = targetId
      ? await this.#ownedTarget(taskId, targetId)
      : await this.#activeTarget(taskId);
    return (await this.#capturePage(taskId, target, options)).snapshot;
  }

  async #capturePage(taskId: string, target: TargetInfo, options: SnapshotOptions) {
    const attached = await this.#send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const sessionId = readString(attached.result, "sessionId");
    this.#taskBySession.set(sessionId, taskId);
    this.#targetBySession.set(sessionId, target.targetId);
    const [axResponse, domResponse, metricsResponse] = await Promise.all([
      this.#send("Accessibility.getFullAXTree", {}, sessionId),
      this.#send(
        "DOMSnapshot.captureSnapshot",
        { computedStyles: [], includeDOMRects: true, includePaintOrder: true },
        sessionId,
      ),
      options.scope === "only_within_viewport"
        ? this.#send("Page.getLayoutMetrics", {}, sessionId)
        : Promise.resolve(undefined),
    ]);
    const nodes = readArray<AxNode>(axResponse.result, "nodes");
    const dom = domResponse.result as DomSnapshotResult;
    return {
      nodes,
      snapshot: serializeAxTree(nodes, options, buildDomIndex(dom), readViewport(metricsResponse?.result)),
    };
  }

  async getAIPageContent(
    taskId: string,
    targetId: string,
    options: SnapshotOptions = {},
  ): Promise<AIPageContent> {
    const target = await this.#ownedTarget(taskId, targetId);
    const captured = await this.#capturePage(taskId, target, {
      includeActionMarks: true,
      includeStableLocator: true,
      ...options,
    });
    return toAIPageContent(target, captured.snapshot, captured.nodes);
  }

  async sendCdp(taskId: string, payload: string): Promise<string> {
    const request = JSON.parse(payload) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    const params = request.params ?? {};
    let response: CdpMessage;

    switch (request.method) {
      case "Target.getTargets": {
        const owned = this.#requireTask(taskId);
        const targetInfos = (await this.#targetInfos()).filter((target) => owned.has(target.targetId));
        return JSON.stringify({ id: request.id, result: { targetInfos } });
      }
      case "Target.createTarget": {
        response = await this.#send(request.method, params);
        const targetId = readString(response.result, "targetId");
        this.#bindTarget(taskId, targetId);
        break;
      }
      case "Target.attachToTarget": {
        this.#assertTarget(taskId, requireParamString(params, "targetId"));
        response = await this.#send(request.method, params);
        const sessionId = readString(response.result, "sessionId");
        this.#taskBySession.set(sessionId, taskId);
        this.#targetBySession.set(sessionId, requireParamString(params, "targetId"));
        break;
      }
      case "Target.activateTarget":
      case "Target.closeTarget": {
        const targetId = requireParamString(params, "targetId");
        this.#assertTarget(taskId, targetId);
        response = await this.#send(request.method, params);
        if (request.method === "Target.activateTarget") {
          this.#activeTargetByTask.set(taskId, targetId);
          const info = (await this.#targetInfos()).find((item) => item.targetId === targetId);
          if (info) this.#emitTabChanged(taskId, {
            targetId,
            title: info.title,
            url: info.url,
            active: true,
          });
        } else {
          this.#requireTask(taskId).delete(targetId);
          this.#taskByTarget.delete(targetId);
          if (this.#activeTargetByTask.get(taskId) === targetId) {
            this.#activeTargetByTask.delete(taskId);
          }
        }
        break;
      }
      case "Browser.setDownloadBehavior": {
        return JSON.stringify({
          id: request.id,
          error: { code: -32601, message: "'Browser.setDownloadBehavior' wasn't found" },
        });
      }
      default:
        if (!request.sessionId || this.#taskBySession.get(request.sessionId) !== taskId) {
          throw new EgoProtocolError(
            "EGO_CDP_CHANNEL_UNAVAILABLE",
            "CDP session does not belong to the selected task space",
          );
        }
        response = await this.#send(
          request.method,
          request.method === "DOM.setFileInputFiles"
            ? await validateUploadParams(params)
            : request.method === "Page.setDownloadBehavior"
              ? await validateDownloadBehavior(params)
              : params,
          request.sessionId,
        );
    }

    return JSON.stringify({
      id: request.id,
      ...(response.result !== undefined ? { result: response.result } : {}),
      ...(response.error ? { error: response.error } : {}),
    });
  }

  async relinquishControl(_taskId: string): Promise<void> {
    // Managed mode keeps its private CDP pipe alive; the Broker epoch is the hard gate.
  }

  async prepareControl(_taskId: string): Promise<void> {}

  async updateSpaceState(_space: TaskSpaceRecord): Promise<void> {}

  async #activeTarget(taskId: string): Promise<TargetInfo> {
    const tabs = await this.listTabs(taskId);
    const active = tabs.find((tab) => tab.active) ?? tabs.at(-1);
    if (!active) {
      throw new EgoProtocolError("EGO_WEB_CONTENTS_UNAVAILABLE", "Task space has no active tab");
    }
    return {
      targetId: active.targetId,
      type: "page",
      title: active.title,
      url: active.url,
    };
  }

  async #ownedTarget(taskId: string, targetId: string): Promise<TargetInfo> {
    this.#assertTarget(taskId, targetId);
    const target = (await this.#targetInfos()).find((item) => item.targetId === targetId);
    if (!target || target.type !== "page") {
      throw new EgoProtocolError("EGO_WEB_CONTENTS_UNAVAILABLE", "Target page is unavailable");
    }
    return target;
  }

  async #targetInfos(): Promise<TargetInfo[]> {
    const response = await this.#send("Target.getTargets", {});
    return readArray<TargetInfo>(response.result, "targetInfos");
  }

  #requireTask(taskId: string): Set<string> {
    const targets = this.#targetsByTask.get(taskId);
    if (!targets) {
      throw new EgoProtocolError("EGO_TASK_SPACE_NOT_FOUND", `Unknown managed task: ${taskId}`);
    }
    return targets;
  }

  #assertTarget(taskId: string, targetId: string): void {
    if (!this.#requireTask(taskId).has(targetId)) {
      throw new EgoProtocolError(
        "EGO_CDP_CHANNEL_UNAVAILABLE",
        "Target does not belong to the selected task space",
      );
    }
  }

  #send(method: string, params: unknown = {}, sessionId?: string): Promise<CdpMessage> {
    if (!this.#transport) {
      throw new EgoProtocolError("EGO_BROWSER_UNAVAILABLE", "Managed Edge is not running");
    }
    return this.#transport.send(method, params, sessionId);
  }

  #forwardEvent(message: CdpMessage): void {
    const params = message.params as Record<string, any> | undefined;
    if (process.env.EGO_DEBUG_CDP === "1") {
      console.error("[managed-edge:event]", message.method, message.sessionId ?? "browser", {
        guid: params?.guid,
        state: params?.state,
        targetId: params?.targetInfo?.targetId ?? params?.targetId,
        openerId: params?.targetInfo?.openerId,
        openerFrameId: params?.targetInfo?.openerFrameId,
        type: params?.targetInfo?.type,
        urlPath: safeUrlPath(params?.targetInfo?.url),
      });
    }
    let taskId = message.sessionId ? this.#taskForSession(message.sessionId) : undefined;
    if ((message.method === "Page.frameAttached" || message.method === "Page.frameNavigated") && taskId) {
      const frameId = params?.frame?.id ?? params?.frameId;
      if (typeof frameId === "string") this.#taskByFrame.set(frameId, taskId);
    } else if (message.method === "Page.frameDetached") {
      const frameId = params?.frameId;
      if (typeof frameId === "string") this.#taskByFrame.delete(frameId);
    } else if (message.method === "Page.windowOpen" && taskId) {
      this.#pendingPopups.push({
        taskId,
        ...(typeof params?.url === "string" ? { url: params.url } : {}),
        createdAt: Date.now(),
      });
      this.#prunePendingPopups();
    } else if (message.method === "Target.attachedToTarget") {
      const parentTask = message.sessionId
        ? this.#taskForSession(message.sessionId)
        : this.#resolveNewTargetTask(params?.targetInfo);
      const childSessionId = params?.sessionId;
      const childTargetId = params?.targetInfo?.targetId;
      if (typeof childSessionId === "string" && typeof childTargetId === "string") {
        this.#targetBySession.set(childSessionId, childTargetId);
      }
      if (parentTask && typeof childSessionId === "string") {
        this.#taskBySession.set(childSessionId, parentTask);
        taskId = parentTask;
      }
      if (parentTask && typeof childTargetId === "string") {
        this.#bindTarget(parentTask, childTargetId);
      }
      if (typeof childSessionId === "string") {
        void this.#send("Runtime.runIfWaitingForDebugger", {}, childSessionId).catch(() => {});
      }
    } else if (message.method === "Target.targetCreated") {
      const createdTargetId = params?.targetInfo?.targetId;
      const parentTask = this.#resolveNewTargetTask(params?.targetInfo);
      if (parentTask && typeof createdTargetId === "string") {
        this.#bindTarget(parentTask, createdTargetId);
        taskId = parentTask;
      }
    } else if (message.method === "Target.targetInfoChanged") {
      const targetId = params?.targetInfo?.targetId;
      if (typeof targetId === "string") {
        taskId = this.#taskByTarget.get(targetId) ?? this.#resolveNewTargetTask(params?.targetInfo);
        if (taskId) {
          this.#bindTarget(taskId, targetId);
          const info = params?.targetInfo;
          if (info?.type === "page") this.#emitTabChanged(taskId, {
            targetId,
            title: typeof info.title === "string" ? info.title : "",
            url: typeof info.url === "string" ? info.url : "",
            active: this.#activeTargetByTask.get(taskId) === targetId,
          });
        }
      }
    } else if (message.method === "Target.detachedFromTarget") {
      const childSessionId = params?.sessionId;
      if (typeof childSessionId === "string") {
        this.#taskBySession.delete(childSessionId);
        this.#targetBySession.delete(childSessionId);
      }
    } else if (message.method === "Target.targetDestroyed") {
      const targetId = params?.targetId;
      if (typeof targetId === "string") {
        const owner = this.#taskByTarget.get(targetId);
        if (owner) this.#requireTask(owner).delete(targetId);
        this.#taskByTarget.delete(targetId);
      }
    }
    if (!taskId) return;
    const payload = JSON.stringify(message);
    for (const listener of this.#listeners) listener(taskId, payload);
  }

  #emitTabChanged(taskId: string, tab: PublicTab): void {
    for (const listener of this.#tabListeners) listener(taskId, structuredClone(tab));
  }

  #ensureSelectionPolling(): void {
    if (this.#selectionTimer || !this.#selectionListeners.size) return;
    const poll = async () => {
      this.#selectionTimer = undefined;
      for (const taskId of this.#targetsByTask.keys()) {
        try {
          const target = await this.#activeTarget(taskId);
          const attached = await this.#send("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
          });
          const sessionId = readString(attached.result, "sessionId");
          this.#taskBySession.set(sessionId, taskId);
          this.#targetBySession.set(sessionId, target.targetId);
          const response = await this.#send("Runtime.evaluate", {
            expression: SELECTION_EXPRESSION,
            returnByValue: true,
          }, sessionId);
          const result = response.result as { result?: { value?: unknown } };
          if (typeof result.result?.value !== "string") continue;
          const selection = JSON.parse(result.result.value) as TextSelection;
          const signature = `${selection.sourceUrl}::${selection.text}`;
          if (this.#selectionSignatureByTask.get(taskId) === signature) continue;
          this.#selectionSignatureByTask.set(taskId, signature);
          for (const listener of this.#selectionListeners) listener(taskId, selection);
        } catch {
          // A tab may disappear or navigate between polling steps.
        }
      }
      if (this.#selectionListeners.size) {
        this.#selectionTimer = setTimeout(poll, 250);
        this.#selectionTimer.unref();
      }
    };
    this.#selectionTimer = setTimeout(poll, 0);
  }

  #resolveNewTargetTask(targetInfo: Record<string, unknown> | undefined): string | undefined {
    const targetId = targetInfo?.targetId;
    if (typeof targetId === "string") {
      const taskId = this.#taskByTarget.get(targetId) ?? this.#taskByFrame.get(targetId);
      if (taskId) return taskId;
    }
    const openerId = targetInfo?.openerId;
    if (typeof openerId === "string") {
      const taskId = this.#taskByTarget.get(openerId);
      if (taskId) return taskId;
    }
    const openerFrameId = targetInfo?.openerFrameId;
    if (typeof openerFrameId === "string") {
      const taskId = this.#taskByFrame.get(openerFrameId);
      if (taskId) return taskId;
    }
    if (targetInfo?.type !== "page") return undefined;
    this.#prunePendingPopups();
    const url = typeof targetInfo.url === "string" ? targetInfo.url : undefined;
    const exactIndex = url
      ? this.#pendingPopups.findIndex((popup) => popup.url === url)
      : -1;
    const index = exactIndex >= 0 ? exactIndex : this.#pendingPopups.length ? 0 : -1;
    if (index < 0) return undefined;
    return this.#pendingPopups.splice(index, 1)[0]?.taskId;
  }

  #bindTarget(taskId: string, targetId: string): void {
    this.#taskByTarget.set(targetId, taskId);
    this.#requireTask(taskId).add(targetId);
    for (const [sessionId, sessionTargetId] of this.#targetBySession) {
      if (sessionTargetId === targetId) this.#taskBySession.set(sessionId, taskId);
    }
  }

  #taskForSession(sessionId: string): string | undefined {
    const direct = this.#taskBySession.get(sessionId);
    if (direct) return direct;
    const targetId = this.#targetBySession.get(sessionId);
    if (!targetId) return undefined;
    const taskId = this.#taskByTarget.get(targetId);
    if (taskId) this.#taskBySession.set(sessionId, taskId);
    return taskId;
  }

  #prunePendingPopups(): void {
    const cutoff = Date.now() - 5_000;
    while (this.#pendingPopups[0] && this.#pendingPopups[0].createdAt < cutoff) {
      this.#pendingPopups.shift();
    }
  }
}

function safeUrlPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).pathname;
  } catch {
    return value.slice(0, 64);
  }
}

async function validateDownloadBehavior(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const downloadPath = params.downloadPath;
  if (typeof downloadPath !== "string" || !isAbsolute(downloadPath)) {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "downloadPath must be absolute");
  }
  const resolved = resolve(downloadPath);
  const tempRoot = resolve(tmpdir());
  const rel = relative(tempRoot, resolved);
  if (
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    !resolved.split(/[\\/]/).at(-1)?.startsWith("ego-browser-downloads-")
  ) {
    throw new EgoProtocolError(
      "EGO_INVALID_ARGUMENT",
      "Downloads are restricted to ego-browser task temp directories",
    );
  }
  await mkdir(resolved, { recursive: true });
  return { ...params, downloadPath: resolved };
}

async function validateUploadParams(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!Array.isArray(params.files) || params.files.length === 0) {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "files must be a non-empty array");
  }
  const files: string[] = [];
  for (const file of params.files) {
    if (typeof file !== "string" || !isAbsolute(file)) {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "Upload paths must be absolute");
    }
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new EgoProtocolError("EGO_INVALID_ARGUMENT", "Upload path must be a regular file");
    }
    files.push(await realpath(file));
  }
  return { ...params, files };
}

function serializeAxTree(
  nodes: AxNode[],
  options: SnapshotOptions,
  dom = new Map<number, DomNodeInfo>(),
  viewport?: Viewport,
): SnapshotResult {
  const refs: SnapshotRef[] = [];
  const lines: string[] = [];
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childIds = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const roots = nodes.filter((node) => !childIds.has(node.nodeId));

  const visit = (node: AxNode, depth: number): void => {
    if (node.ignored) {
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) visit(child, depth);
      }
      return;
    }
    const role = String(node.role?.value ?? "generic");
    const name = String(node.name?.value ?? "").trim();
    const value = String(node.value?.value ?? "").trim();
    const domNode =
      node.backendDOMNodeId === undefined ? undefined : dom.get(node.backendDOMNodeId);
    const inViewport =
      options.scope !== "only_within_viewport" ||
      (domNode?.bounds !== undefined && viewport !== undefined && intersects(domNode.bounds, viewport));
    const actionable =
      isActionable(role) && node.backendDOMNodeId !== undefined && isRendered(domNode) && inViewport;
    let mark = "";
    if (actionable && options.includeActionMarks !== false) {
      mark = ` [ref=@${node.backendDOMNodeId}]`;
      refs.push({
        backendNodeId: node.backendDOMNodeId!,
        role,
        name,
        ...(options.includeStableLocator !== false && name
          ? { stableLocator: stableLocator(role, name, domNode) }
          : {}),
      });
    }
    const includeNode =
      options.scope !== "only_within_viewport" || role === "RootWebArea" || inViewport;
    if (includeNode && (name || value || actionable || role === "RootWebArea")) {
      const locator =
        actionable && options.includeStableLocator !== false
          ? ` loc=${JSON.stringify(stableLocator(role, name, domNode))}`
          : "";
      lines.push(`${"  ".repeat(depth)}${role}${mark}${locator}${name ? ` "${name}"` : ""}${value ? ` value="${value}"` : ""}`);
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child, depth + 1);
    }
  };

  for (const root of roots) visit(root, 0);
  let content = lines.join("\n");
  if (options.maxResultLength && content.length > options.maxResultLength) {
    content = content.slice(0, options.maxResultLength);
  }
  const visibleIds = new Set(
    [...content.matchAll(/\[ref=@(\d+)\]/g)].map((match) => Number(match[1])),
  );
  const visibleRefs = refs.filter((ref) => visibleIds.has(ref.backendNodeId));
  return { content, refs: visibleRefs };
}

function toAIPageContent(
  target: TargetInfo,
  snapshot: SnapshotResult,
  nodes: AxNode[],
): AIPageContent {
  return {
    title: target.title,
    url: target.url,
    ...snapshot,
    rootNode: buildAIPageTree(nodes),
  };
}

function buildAIPageTree(nodes: AxNode[]) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childIds = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const roots = nodes.filter((node) => !childIds.has(node.nodeId));
  const convert = (node: AxNode): import("@ego-compat/protocol").AIPageNode[] => {
    const children = (node.childIds ?? []).flatMap((id) => {
      const child = byId.get(id);
      return child ? convert(child) : [];
    });
    if (node.ignored) return children;
    const role = String(node.role?.value ?? "generic");
    const text = String(node.name?.value ?? node.value?.value ?? "").trim();
    const attributeType = aiAttributeType(role);
    const label = role.toLowerCase() === "link" ? axProperty(node, "url") : text;
    return [{
      attributeType,
      ...(text ? { textInfo: { textContent: text } } : {}),
      ...([4, 7].includes(attributeType) && label ? { label } : {}),
      children,
    }];
  };
  const converted = roots.flatMap(convert);
  const root = converted.find((node) => node.attributeType === 0);
  return root ?? { attributeType: 0, children: converted };
}

function axProperty(node: AxNode, name: string): string {
  const value = node.properties?.find((property) => property.name === name)?.value?.value;
  return typeof value === "string" ? value : "";
}

function aiAttributeType(role: string): number {
  switch (role.toLowerCase()) {
    case "rootwebarea": return 0;
    case "iframe": return 1;
    case "statictext": case "inlinetextbox": return 3;
    case "link": return 4;
    case "paragraph": return 5;
    case "heading": return 6;
    case "image": return 7;
    case "canvas": return 9;
    case "video": return 10;
    case "form": return 11;
    case "table": case "grid": return 13;
    case "row": return 14;
    case "cell": case "gridcell": case "columnheader": case "rowheader": return 15;
    case "list": return 17;
    case "listitem": return 18;
    default: return isActionable(role) ? 12 : 2;
  }
}

function buildDomIndex(snapshot: DomSnapshotResult): Map<number, DomNodeInfo> {
  const index = new Map<number, DomNodeInfo>();
  for (const document of snapshot.documents ?? []) {
    const boundsByNodeIndex = new Map<number, [number, number, number, number]>();
    for (let layoutIndex = 0; layoutIndex < document.layout.nodeIndex.length; layoutIndex += 1) {
      const nodeIndex = document.layout.nodeIndex[layoutIndex];
      const bounds = document.layout.bounds[layoutIndex];
      if (nodeIndex !== undefined && bounds) boundsByNodeIndex.set(nodeIndex, bounds);
    }
    for (let nodeIndex = 0; nodeIndex < document.nodes.backendNodeId.length; nodeIndex += 1) {
      const backendNodeId = document.nodes.backendNodeId[nodeIndex];
      if (backendNodeId === undefined) continue;
      const rawAttributes = document.nodes.attributes[nodeIndex] ?? [];
      const attributes: Record<string, string> = {};
      for (let i = 0; i < rawAttributes.length; i += 2) {
        const key = snapshot.strings[rawAttributes[i] ?? -1];
        const value = snapshot.strings[rawAttributes[i + 1] ?? -1];
        if (key !== undefined && value !== undefined) attributes[key] = value;
      }
      index.set(backendNodeId, {
        nodeName: snapshot.strings[document.nodes.nodeName[nodeIndex] ?? -1] ?? "",
        attributes,
        ...(boundsByNodeIndex.has(nodeIndex)
          ? { bounds: boundsByNodeIndex.get(nodeIndex)! }
          : {}),
      });
    }
  }
  return index;
}

function readViewport(result: unknown): Viewport | undefined {
  const viewport = (result as { visualViewport?: Record<string, unknown> } | undefined)
    ?.visualViewport;
  if (!viewport) return undefined;
  const x = Number(viewport.pageX);
  const y = Number(viewport.pageY);
  const width = Number(viewport.clientWidth);
  const height = Number(viewport.clientHeight);
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : undefined;
}

function isRendered(node: DomNodeInfo | undefined): boolean {
  return Boolean(node?.bounds && node.bounds[2] > 0 && node.bounds[3] > 0);
}

function intersects(
  [x, y, width, height]: [number, number, number, number],
  viewport: Viewport,
): boolean {
  return (
    width > 0 &&
    height > 0 &&
    x + width > viewport.x &&
    y + height > viewport.y &&
    x < viewport.x + viewport.width &&
    y < viewport.y + viewport.height
  );
}

function stableLocator(role: string, name: string, node: DomNodeInfo | undefined): string {
  const attributes = node?.attributes ?? {};
  for (const key of ["data-testid", "data-test", "data-qa"]) {
    if (attributes[key]) return `[${key}=${JSON.stringify(attributes[key])}]`;
  }
  if (attributes.id && !looksGenerated(attributes.id)) return `#${cssEscape(attributes.id)}`;
  if (attributes.name) return `${node?.nodeName.toLowerCase() || "*"}[name=${JSON.stringify(attributes.name)}]`;
  if (attributes.placeholder) return `[placeholder=${JSON.stringify(attributes.placeholder)}]`;
  return `role=${role}[name=${JSON.stringify(name)}]`;
}

function looksGenerated(value: string): boolean {
  return value.length > 48 || /[a-f\d]{12,}/i.test(value);
}

function cssEscape(value: string): string {
  return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

function isActionable(role: string): boolean {
  return new Set([
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "menuitem",
    "option",
    "slider",
    "spinbutton",
    "switch",
    "tab",
  ]).has(role.toLowerCase());
}

function readString(value: unknown, key: string): string {
  const field = (value as Record<string, unknown> | undefined)?.[key];
  if (typeof field !== "string") throw new Error(`CDP response is missing ${key}`);
  return field;
}

function readArray<T>(value: unknown, key: string): T[] {
  const field = (value as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(field)) throw new Error(`CDP response is missing ${key}`);
  return field as T[];
}

function requireParamString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") {
    throw new EgoProtocolError("EGO_INVALID_ARGUMENT", `${key} must be a string`);
  }
  return value;
}
