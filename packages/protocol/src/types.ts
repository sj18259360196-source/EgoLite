export const PROTOCOL_VERSION = 1 as const;
export const SCOPED_REFS_CAPABILITY = "scoped-refs-v1" as const;

export type RefFormat = "native-v0" | "scoped-v1";

export interface ReferenceDescriptor {
  refId: number;
  runtimeId: string;
}

export interface ReferenceExpectedScope {
  pageId: string;
}

export interface ReferenceActionBindRequest {
  ref: ReferenceDescriptor;
  expectedScope: ReferenceExpectedScope;
  deadlineAt?: number;
}

export interface ReferenceActionGroupBindRequest {
  kind: "drag";
  source: ReferenceDescriptor;
  target: ReferenceDescriptor;
  expectedScope: ReferenceExpectedScope;
  deadlineAt?: number;
}

export interface ReferenceActionGroupMemberBinding {
  refId: number;
  backendNodeId: number;
}

export interface ReferenceActionGroupBinding extends ReferenceActionWire {
  kind: "drag";
  expiresAt: number;
  pageId: string;
  frameId: string;
  documentId: string;
  documentEpoch: number;
  sessionId?: string;
  source: ReferenceActionGroupMemberBinding;
  target: ReferenceActionGroupMemberBinding;
}

export interface ReferenceActionWire {
  version: "scoped-v1";
  runtimeId: string;
  token: string;
}

export interface ReferenceActionBinding extends ReferenceActionWire {
  expiresAt: number;
  pageId: string;
  frameId: string;
  documentId: string;
  documentEpoch: number;
  backendNodeId: number;
  /** Controlled public routing alias. This is never a native Electron session id. */
  sessionId?: string;
}

export interface CdpRequestContext {
  clientId: string;
  refFormat: RefFormat;
  refAction?: ReferenceActionWire;
}

export type Ownership = "agent" | "agentDelegatedToUser" | "user";
export type ControlMode = "agent" | "collaborative" | "manual";
export interface ControlRequest {
  id: string;
  clientId: string;
  createdAt: string;
  status: "pending" | "approved" | "cancelled";
}
export interface SpaceControlState {
  space: TaskSpaceRecord;
  controllerClientId?: string;
  requests: ControlRequest[];
  revision: number;
  interactionPending: boolean;
}
export type TaskLifecycle =
  | "creating"
  | "active"
  | "inactive"
  | "recovering"
  | "orphaned"
  | "closing"
  | "closed";
export type BrowserBackendKind = "fake" | "managed" | "companion" | "desktop";

export interface BrowserBackendStatus {
  kind: BrowserBackendKind;
  ready: boolean;
  connected?: boolean;
  reconciled?: boolean;
  message?: string;
  capabilities?: string[];
  referenceActionMaxLifetimeMs?: number;
  /** Versioned desktop feature boundaries; absent on backends that do not declare them. */
  automation?: {
    contractVersion: number;
    refFormat: RefFormat;
    scopedRefsEnabled: boolean;
    snapshotRefs: string;
    frameRefs: string;
    locatorScope: string;
    scopedDrag: string;
    scopedElementScreenshot: string;
    scopedNetworkWait: string;
    rawCdpScopedGuarantees: boolean;
    referenceActionMaxLifetimeMs?: number;
  };
}

export interface PublicTaskSpace {
  taskId: string;
  id: number;
  name: string;
  profileId?: string;
  order?: number;
  createdBy?: string;
  ownership?: Ownership;
  recentTabTitles?: string[];
  agentBlocked?: boolean;
  pendingAgentReturn?: boolean;
  lastAgentClientId?: string;
  controlMode?: ControlMode;
}

export type AgentClientKind = "codex" | "claude" | "cursor" | "other" | "desktop-ui";

export type AgentStatus = "online" | "executing" | "user-control" | "offline";

export interface AgentAction {
  tool: string;
  startedAt: string;
}

export interface AgentRegistration {
  clientId: string;
  clientKind?: AgentClientKind;
  displayName?: string;
  version?: string;
}

export interface AgentInfo {
  clientId: string;
  clientKind: AgentClientKind;
  displayName: string;
  version?: string;
  connectedAt: string;
  lastSeenAt: string;
  currentTaskId?: string;
  status: AgentStatus;
  activityStartedAt?: string;
  taskStartedAt?: string;
  currentAction?: AgentAction;
}

export interface BrowserProfile {
  id: string;
  name: string;
  color: string;
  partition: string;
  createdAt: string;
  sourceBrowser?: string;
  sourceProfile?: string;
}

export interface PublicTab {
  targetId: string;
  title: string;
  url: string;
  active: boolean;
  faviconUrl?: string;
  pinned?: boolean;
  muted?: boolean;
  sleeping?: boolean;
  groupId?: string;
  groupTitle?: string;
  groupColor?: string;
  lastActiveAt?: string;
  order?: number;
  zoomFactor?: number;
}

export interface CollectionItem {
  id: string;
  text: string;
  sourceUrl?: string;
  pageTitle?: string;
  faviconUrl?: string;
  group?: string;
  tags?: string[];
  createdAt: string;
  kind?: "bookmark" | "excerpt";
  folderId?: string;
  order?: number;
  deletedAt?: string;
  deletionBatch?: string;
}

export interface CollectionFolder {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  deletedAt?: string;
  deletionBatch?: string;
}

export type CodexOperationStatus = "running" | "completed" | "failed";

export interface CodexOperationRecord {
  id: string;
  taskId: string;
  clientId: string;
  tool: string;
  title: string;
  detail?: string;
  status: CodexOperationStatus;
  startedAt: string;
  finishedAt?: string;
}

export interface TextSelection {
  text: string;
  sourceUrl: string;
  pageTitle: string;
  favicon: string | null;
}

export interface EgoTab extends PublicTab {
  id: string;
  taskId: string;
  faviconUrl?: string;
}

export interface EgoTabGroup {
  id: string;
  title: string;
  color: string;
  taskId: string;
  tabs: EgoTab[];
}

export interface AIPageNode {
  attributeType: number;
  textInfo?: { textContent: string };
  label?: string;
  children: AIPageNode[];
}

export interface AIPageContent extends SnapshotResult {
  title: string;
  url: string;
  rootNode: AIPageNode;
}

export interface SnapshotOptions {
  scope?: "only_within_viewport" | "full_page";
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
  maxResultLength?: number;
}

export interface SnapshotRef {
  backendNodeId: number;
  refId?: number;
  pageId?: string;
  frameId?: string;
  documentId?: string;
  documentEpoch?: number;
  role: string;
  name: string;
  stableLocator?: string;
}

export interface SnapshotResult {
  content: string;
  refs: SnapshotRef[];
  refFormat?: RefFormat;
  completeness?: "partial" | "complete-page";
  runtimeId?: string;
  pageId?: string;
  documentId?: string;
  documentEpoch?: number;
  incompleteFrames?: string[];
  truncation?: {
    reasons: Array<"node_limit" | "max_result_length">;
    maxResultLength?: number;
    totalLines: number;
    includedLines: number;
    omittedLines: number;
  };
}

export interface TaskSpaceRecord extends PublicTaskSpace {
  createdBy: string;
  ownership: Ownership;
  lifecycle: TaskLifecycle;
  backend: BrowserBackendKind;
  generation: number;
  leaseEpoch: number;
  activeTargetId?: string;
  createdAt: string;
  updatedAt: string;
  controlMode?: ControlMode;
}

export interface Lease {
  taskId: string;
  clientId: string;
  epoch: number;
  expiresAt: number;
}

export interface RpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: T;
}

export interface RpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: string;
  result: T;
}

export interface RpcFailure {
  jsonrpc: "2.0";
  id: string;
  error: {
    code: string;
    message: string;
    data?: unknown;
  };
}

export type RpcResponse<T = unknown> = RpcSuccess<T> | RpcFailure;

export interface RpcEvent<T = unknown> {
  jsonrpc: "2.0";
  method: string;
  params: T;
}

export interface HelloParams {
  protocolVersion: number;
  clientId: string;
  pid: number;
  capabilities?: string[];
  sdkVersion?: string;
  clientKind?: AgentClientKind;
  displayName?: string;
  version?: string;
}

export interface HelloResult {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  capabilities: string[];
  referenceActionMaxLifetimeMs?: number;
}

export interface EgoRuntime {
  automationRequest?(operation: string, input: Record<string, unknown>): Promise<unknown>;
  observeTaskSpace?(id: number, targetId?: string, options?: SnapshotOptions): Promise<SpaceControlState & { tabs: PublicTab[]; snapshot?: SnapshotResult }>;
  requestControl?(id: number): Promise<ControlRequest>;
  returnControl?(id: number, requestId?: string): Promise<SpaceControlState>;
  waitForAgentControl?(id: number, options?: { timeout?: number; signal?: AbortSignal }): Promise<void>;
  useOrCreateTaskSpace?(nameOrId: string | number): Promise<PublicTaskSpace>;
  openOrReuseTab?(url: string, match?: string): Promise<PublicTab & { reused: boolean }>;
  listTaskSpaces(): Promise<{ taskSpaces: PublicTaskSpace[] }>;
  createTaskSpace(name: string, profileId?: string): Promise<PublicTaskSpace>;
  useTaskSpace(id: number): Promise<void>;
  claimTaskSpace(id: number, name?: string): Promise<PublicTaskSpace>;
  handOffTaskSpace(): Promise<void>;
  takeOverTaskSpace(id?: number): Promise<void>;
  completeTaskSpace(): Promise<void>;
  closeTaskSpace(): Promise<void>;
  listTabs(): Promise<{ tabs: PublicTab[] }>;
  getAllTabs(): Promise<EgoTab[]>;
  getTabGroups(): Promise<EgoTabGroup[]>;
  activateTab(tab: string | { id?: string; targetId?: string }): Promise<boolean>;
  closeTab(tab: string | { id?: string; targetId?: string }): Promise<boolean>;
  openUrlInNewTab(url: string, taskId?: string): Promise<EgoTab>;
  createTab(url?: string): Promise<PublicTab>;
  snapshot(options?: SnapshotOptions): Promise<SnapshotResult>;
  getAIPageContent(
    tab: string | { id?: string; targetId?: string },
    options?: SnapshotOptions,
  ): Promise<AIPageContent | null>;
  saveTextToCollections(text: string, sourceUrl?: string): Promise<boolean>;
  listCollections(query?: string): Promise<CollectionItem[]>;
  bindReferenceAction?(request: ReferenceActionBindRequest): Promise<ReferenceActionBinding>;
  bindReferenceActionGroup?(request: ReferenceActionGroupBindRequest): Promise<ReferenceActionGroupBinding>;
  releaseReferenceAction?(action: ReferenceActionWire): Promise<void>;
  getReferenceActionMaxLifetimeMs?(): number | undefined;
  sendCDPMessage(payload: string, refAction?: ReferenceActionWire): void;
  onReconnect?: () => void;
  onCDPMessage?: (payload: string) => void;
  onActiveTabChanged?: (tab: EgoTab) => void;
  onTextSelectionChanged?: (selection: TextSelection) => void;
  onSendCDPMessageError?: (message: string, errorCode: string, requestId?: number) => void;
  setAgentTaskState?(label: string): void;
  animationHighlightMouseToPosition?(x: number, y: number): void;
}
