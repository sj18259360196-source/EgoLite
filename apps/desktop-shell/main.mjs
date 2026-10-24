import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, screen, session, shell, Tray, webContents, WebContentsView } from "electron";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { MutationGate } from "./mutation-gate.mjs";
import { TranslationService, TranslationSettings, TRANSLATION_WORLD } from "./translation-service.mjs";
import { AutomationDecisionService, AutomationSettings } from "./automation-decision-service.mjs";
import { translationScript } from "./page-translation.mjs";
import { desktopAutomationCapabilities, DEFAULT_REFERENCE_ACTION_MAX_MS, SCOPED_REFS_CAPABILITY } from "./automation-capabilities.mjs";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DesktopBrowserController } from "./desktop-browser-controller.mjs";
import { DeveloperTools } from "./developer-tools.mjs";
import { contextMenuInspectionPoint, resolveInspectionPoint } from "./developer-tools-context.mjs";
import { DesktopFrameRouter } from "./desktop-frame-router.mjs";
import { DurableReferenceIdAllocator } from "./desktop-reference-id-allocator.mjs";
import { DesktopReferenceRegistry } from "./desktop-reference-registry.mjs";
import { DesktopRpcServer } from "./desktop-rpc-server.mjs";
import {
  DesktopScopedAutomation,
  invokeAfterFinalAuthorization,
  scopedCommandRequiresBoundFocus,
  scopedCommandRequiresExactObject,
} from "./desktop-scoped-automation.mjs";
import { AtomicJsonStateWriter } from "./atomic-json-state-writer.mjs";
import { DesktopTabCloseCoordinator } from "./desktop-tab-lifecycle.mjs";
import { popupOpenPolicy, extensionOpenPolicy } from "./tab-open-policy.mjs";
import { browserCommandForInput } from "./public/browser-shortcuts.js";
import { PipeRpcClient } from "./broker-rpc-client.mjs";
import { AgentIntegrationService } from "./agent-integrations.mjs";
import { ChatAttachmentStore } from "./chat-attachments.mjs";
import { createCredentialCipher, CredentialStore } from "./credential-store.mjs";
import { discoverBrowserExtensions, discoverBrowserProfiles, importBrowserProfile } from "./browser-data-import.mjs";
import { createBrowserExtensionRecord, hashBrowserExtensionArchive, normalizeBrowserExtensionPath, publicBrowserExtension } from "./browser-extensions.mjs";
import { bundledExtensionRepository, normalizeExtensionRepository } from "./extension-repository.mjs";
import { analyzeExtensionCompatibility, prepareExtensionRuntime } from "./extension-runtime.mjs";
import { TargetedExtensionHost } from "./extension-targeted-host.mjs";
import { installProcessIoGuards } from "./process-io-guards.mjs";
import { ScanSciService } from "./scansci-service.mjs";
import { CosWorkspace, assertCosRecoveryControl } from "./workspace-packs/cos-workspace.mjs";
import { CosBrowser } from "./workspace-packs/cos-browser.mjs";
import { CosMaintenance, copyCosBuilder } from "./workspace-packs/cos-maintenance.mjs";
import { disposeCosPageScripts } from "./workspace-packs/cos-page-agent.mjs";
import { parseLibraryJson, parseBookmarksDocument, libraryToBookmarksHtml } from "./collection-transfer.mjs";

installProcessIoGuards();

const appDirectory = dirname(fileURLToPath(import.meta.url));
const developmentRoot = join(appDirectory, "..", "..");
const runtimeRoot = app.isPackaged ? process.resourcesPath : developmentRoot;
const dataRoot = join(process.env.LOCALAPPDATA || app.getPath("userData"), "EgoCompat");
const agentRuntimeDirectory = app.isPackaged ? join(runtimeRoot, "runtime") : join(runtimeRoot, ".packaging", "runtime");
const agentSkillSources = {
  "ego-browser": app.isPackaged ? join(agentRuntimeDirectory, "skills", "ego-browser") : join(runtimeRoot, "vendor", "ego-browser", "skill"),
  "web-access-ego": app.isPackaged ? join(agentRuntimeDirectory, "skills", "web-access-ego") : join(runtimeRoot, "vendor", "web-access-ego", "skill"),
};
const browserExtensionManagedRoot = join(dataRoot, "browser-extensions");
const browserExtensionRuntimeRoot = join(browserExtensionManagedRoot, "runtime");
const desktopStatePath = process.env.EGO_DESKTOP_STATE || join(dataRoot, "desktop-tabs.json");
const conversationStatePath = process.env.EGO_DESKTOP_CONVERSATIONS || join(dirname(desktopStatePath), "desktop-conversations.json");
const attachmentStatePath = process.env.EGO_DESKTOP_ATTACHMENTS || join(dirname(conversationStatePath), "attachments");
const preferencesStatePath = process.env.EGO_DESKTOP_PREFERENCES || join(dirname(desktopStatePath), "desktop-preferences.json");
const credentialsStatePath = process.env.EGO_DESKTOP_CREDENTIALS || join(dirname(desktopStatePath), "credentials.json");
const downloadsStatePath = process.env.EGO_DESKTOP_DOWNLOADS || join(dirname(desktopStatePath), "desktop-downloads.json");
const scopedReferenceCounterPath = join(dirname(desktopStatePath), "desktop-reference-ids.json");
const automationPipeName = process.env.EGO_DESKTOP_AUTOMATION_PIPE || "\\\\.\\pipe\\ego-compat-desktop";
const scopedReferencesEnabled = process.env.EGO_SCOPED_REFS !== "0";
const requestedScopedReferenceActionTtlMs = Number(process.env.EGO_REFERENCE_ACTION_MAX_MS);
const scopedReferenceActionTtlMs = Number.isInteger(requestedScopedReferenceActionTtlMs)
  && requestedScopedReferenceActionTtlMs >= 1_000
  && requestedScopedReferenceActionTtlMs <= 2_147_483_647
  ? requestedScopedReferenceActionTtlMs
  : DEFAULT_REFERENCE_ACTION_MAX_MS;
const desktopRuntimeId = `desktop-runtime-${randomUUID()}`;
const clientId = `desktop-${randomUUID()}`;
const configuredDesktopControlToken = String(process.env.EGO_DESKTOP_CONTROL_TOKEN || "").trim();
const desktopControlToken = configuredDesktopControlToken.length >= 32
  ? configuredDesktopControlToken
  : randomBytes(32).toString("base64url");
const MAX_RPC_FRAME_LENGTH = 32 * 1024 * 1024;
const CONTROL_CONSENT_POLICY_VERSION = 3;
const TRUSTED_BRIDGE_REQUEST = Symbol("trustedDesktopBridgeRequest");
const SCOPED_ROUTER_LIFECYCLE_METHODS = new Set([
  "Target.attachedToTarget", "Target.targetInfoChanged", "Target.detachedFromTarget",
  "Page.frameAttached", "Page.frameNavigated", "Page.navigatedWithinDocument", "Page.frameDetached",
  "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared",
]);
let rpc;
let backendConnectionGeneration = 0;
let backendReady = false;
let backendError = "";
let backendInitialization;
let backendRecoveryTimer;
let selectedTask;
let mainWindow;
let homeBarWindow;
let tray;
let isQuitting = false;
let homeBarShortcutRegistered = false;
let homeBarContextDraft = null;
let activeWebviewId;
let desktopRpcServer;
let desktopFrameRouter;
let desktopReferenceRegistry;
let desktopScopedAutomation;
let smokeAgentRpc;
let spawnedBrokerProcess;
let cosQuitPending = false;
let cosQuitDone = false;
let agentIntegrationState;
let cosMaintenance;
const cosWorkspace = new CosWorkspace({
  dialog,
  maintenance: () => cosMaintenance?.describe(),
  automationPipe: automationPipeName,
  defaultDirectory: process.env.EGO_COS_PACK || (app.isPackaged ? join(runtimeRoot, "components", "cos")
    : join(developmentRoot, JSON.parse(readFileSync(join(developmentRoot, "integrations/cos/builtin.json"), "utf8")).directory)),
  builtin: true,
  builtinReplaces: ["2.1.20-ego.0.1.0-58bac857c5f5-161db840"],
  installRoot: join(dirname(desktopStatePath), "components", "cos"),
  registryPath: join(dirname(desktopStatePath), "workspace-packs", "cos", "registry.json"),
  dataDirectory: join(dirname(desktopStatePath), "workspace-packs", "cos", "state"),
  builderRoot: app.isPackaged ? join(process.resourcesPath, "runtime/cos-builder") : developmentRoot,
  acquireWorkRoot: app.isPackaged ? undefined : join(developmentRoot, ".tmp/codex/cos-integration"),
  createView: options => new WebContentsView(options),
  getParent: () => mainWindow,
  showHome: async () => {
    showMainWindow();
    await hostRequest('cos.showHome', {});
    return true;
  },
  listSpaces: async () => (await rpc.request("space.list", { clientId })).taskSpaces || [],
  listAgents: () => rpc.request("agent.list", { clientId }),
  createSpace: profileId => rpc.request("space.create", { clientId, name: "CoS", profileId }),
  claimSpace: async space => {
    assertCosRecoveryControl(brokerSpaceStates.get(space.taskId), controlMode(), clientId);
    return rpc.request("space.claim", { clientId, id: space.id });
  },
  restoreTabs: taskId => ensureDesktopTabsRestored(taskId),
  openTab: (taskId, url) => rpc.request("tab.openUrl", { clientId, taskId, url: normalizedUrl(url) }),
  createBrowser: ({ directory, event, message, preferences, diagnostic }) => new CosBrowser({
    directory, event, message, preferences, diagnostic,
    enabled: () => cosWorkspace.enabled,
    taskId: () => cosWorkspace.taskId,
    windowId: () => cosWorkspace.describe().workspace.id,
    tabs: () => [...desktopTabs.values()],
    contents: tab => webviewContents(tab.webContentsId),
    url: normalizedUrl,
    create: (url, options) => createDesktopTab(cosWorkspace.taskId, normalizedUrl(url), options),
    activate: activateDesktopTab,
    remove: closeDesktopTab,
    update: (targetId, patch) => updateDesktopTabPreferences({ targetId, ...patch }),
    setGroupCollapsed: (groupId, collapsed) => hostRequest('cos.groupCollapsed', { taskId: cosWorkspace.taskId, groupId, collapsed }),
    reorder: targetIds => {
      const result = reorderDesktopTabs({ taskId: cosWorkspace.taskId, targetIds });
      for (const id of result) notifyDesktopTab(desktopTabs.get(id));
      return result;
    },
    sendCommand: (target, method, params, sessionId) => desktopBrowser.sendNativeCommand(target, method, params, sessionId),
    prepareCapture: async contents => {
      // Flush the embedder layout before asking a newly created guest for pixels.
      await mainWindow.webContents.executeJavaScript(`new Promise(resolve => {
        const view = Array.from(document.querySelectorAll('webview')).find(e => {
          try { return e.getWebContentsId() === ${contents.id}; } catch { return false; }
        });
        if (view) view.getBoundingClientRect();
        let done = false;
        const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
        const timer = setTimeout(finish, 250);
        requestAnimationFrame(() => requestAnimationFrame(finish));
      })`);
    },
    disposePage: async (id, contextIds, scripts, backgroundThrottling) => {
      const target = webContents.fromId(id);
      if (!target || target.isDestroyed()) return [];
      if (typeof backgroundThrottling === "boolean") target.setBackgroundThrottling(backgroundThrottling);
      if (!target.debugger.isAttached()) return [];
      return disposeCosPageScripts((method, params) => target.debugger.sendCommand(method, params), contextIds, scripts);
    },
    disposeFrames: async (id, sessions) => {
      const target = webContents.fromId(id);
      if (!target || target.isDestroyed() || !target.debugger.isAttached()) return;
      for (const sessionId of sessions) await target.debugger.sendCommand("Target.detachFromTarget", { sessionId }).catch(() => {});
    },
    runMutation: async operation => {
      const taskId = cosWorkspace.taskId;
      const space = brokerSpaceStates.get(taskId);
      if (!space || controlMode() === "manual" || space.agentBlocked || space.ownership !== "agent") {
        throw new Error("CoS browser execution stopped by user control");
      }
      const context = { clientId, taskId, taskSpaceId: space.id, leaseEpoch: space.leaseEpoch };
      const authority = await rpc.request("mutation.assert", { clientId, taskId, actorClientId: clientId, leaseEpoch: space.leaseEpoch, renew: true });
      updateBrokerSpaceState({ space: authority.space });
      return mutationGate.run(context, operation);
    },
  }),
  changed: () => mainWindow?.webContents.send("ego:event", "space.changed", { packageId: "cos" }),
  log: text => { if (process.env.EGO_COS_DEBUG === "1") process.stderr.write(text); },
});
cosMaintenance = new CosMaintenance({
  root: join(dirname(desktopStatePath), "components", "cos", "maintenance"),
  describe: () => cosWorkspace.describe(),
  prepare: directory => copyCosBuilder(app.isPackaged ? join(runtimeRoot, "runtime/cos-builder") : developmentRoot, directory),
  request: (method, params) => {
    if (!rpc || !backendReady) throw new Error("Agent 后台尚未就绪");
    return rpc.request(method, { ...params, clientId });
  },
  update: directory => cosWorkspace.update(directory),
  changed: () => mainWindow?.webContents.send("ego:event", "space.changed", { packageId: "cos" }),
});
const desktopBrowser = new DesktopBrowserController({ fallbackCapture: captureVisibleDesktopPage });
const developerTools = new DeveloperTools({
  createView: options => new WebContentsView(options),
  getParent: () => mainWindow,
  resolvePoint: (target, point) => resolveInspectionPoint((method, params) => desktopBrowser.sendNativeCommand(target, method, params), point),
  writeClipboard: text => clipboard.writeText(text),
  onState: entries => mainWindow?.webContents.send("ego:devtools-state", entries),
  onError: error => mainWindow?.webContents.send("ego:browser-open-error", { message: error.message }),
  onCopied: () => mainWindow?.webContents.send("ego:browser-command", { command: "element-context-copied" }),
});
const mutationGate = new MutationGate((context, taskId) => {
  const space = brokerSpaceStates.get(context.taskId);
  if (taskId && context.taskId !== taskId) throw new Error("Mutation target does not belong to the authorized workspace");
  if (!space || space.id !== context.taskSpaceId || space.leaseEpoch !== context.leaseEpoch
    || space.ownership !== "agent" || space.lifecycle !== "active"
    || (!context.clientId.startsWith("desktop-") && (space.agentBlocked || controlMode() === "manual"))) {
    throw new Error("Agent write permission was revoked; request control again");
  }
}, async (context) => {
  const checked = await rpc.request("mutation.assert", { clientId, taskId: context.taskId, actorClientId: context.clientId, leaseEpoch: context.leaseEpoch });
  updateBrokerSpaceState({ space: checked.space });
});
const chatAttachments = new ChatAttachmentStore(attachmentStatePath);
const credentialStore = new CredentialStore(credentialsStatePath, createCredentialCipher(safeStorage));
const desktopSpaces = new Map();
const desktopTabs = new Map();
const desktopWebviewBindings = new Map();
const desktopScopedPagePromises = new Map();
const desktopScopedNativeConfigurations = new Map();
const desktopScopedAliasPages = new Map();
const desktopScopedRetiredAliases = new Map();
const desktopScopedRetiredAliasPages = new Map();
const desktopSessions = new Map();
const desktopTargetSessions = new Map();
const visualActivationTargets = new Map();
const visualTabOpenIntents = new Map();
const desktopDownloadPaths = new Map();
const desktopDownloads = new Map(loadPersistedDownloads().map((record) => [record.id, record]));
const observedDownloadSessions = new Set();
const reservedDesktopDownloadPaths = new Set();
const brokerAgentStates = new Map();
const brokerSpaceStates = new Map();
const automationSettings = new AutomationSettings(join(dirname(desktopStatePath), "automation-settings.json"), safeStorage);
const automationDecisions = new AutomationDecisionService({
  settings: automationSettings,
  authorize: async (context, targetId) => {
    const tab = desktopTabs.get(targetId);
    if (!tab || tab.taskId !== context.taskId || !tab.active) throw new Error("Automation page changed or closed");
    const checked = await rpc.request("mutation.assert", { clientId, taskId: context.taskId, actorClientId: context.clientId, leaseEpoch: context.leaseEpoch });
    updateBrokerSpaceState({ space: checked.space });
  },
  changed: jobs => mainWindow?.webContents.send("ego:automation-jobs", jobs),
});
const translationSettings = new TranslationSettings(join(dirname(desktopStatePath), "translation-settings.json"), safeStorage);
const pageTranslations = new TranslationService({
  settings: translationSettings,
  authorize: async (context) => {
    if (!rpc) throw new Error("工作空间尚未连接");
    const state = await rpc.request("space.controlState", { clientId, id: context.spaceId });
    const space = state.space;
    if (space.leaseEpoch !== context.epoch || space.lifecycle === "closed"
      || (controlMode() !== "agent" && state.controllerClientId && state.controllerClientId !== clientId)) {
      throw new Error("页面控制权已变化，请先在控制面板接管页面");
    }
  },
  changed: (context) => {
    const tab = desktopTabs.get(context.targetId);
    if (tab && desktopReferenceRegistry) desktopReferenceRegistry.invalidatePage(scopedPageScope(tab), "page_translation_changed");
  },
});
let brokerAgentStateRevision = 0;
let brokerSpaceStateRevision = 0;
const recentDesktopAgentTasks = new Map();
const configuredWebviewSessions = new WeakSet();
const desktopSessionPermissions = new Map();
const browserExtensionPartition = "persist:ego-desktop";
const DEFAULT_BROWSER_PROFILE = Object.freeze({
  id: "default",
  name: "默认 Profile",
  color: "#5b7c86",
  partition: browserExtensionPartition,
  createdAt: "2026-01-01T00:00:00.000Z",
});
let persistedDesktopTabs = loadPersistedDesktopTabs();
const desktopTabsWriter = new AtomicJsonStateWriter(desktopStatePath, {
  onCommit: (value) => { persistedDesktopTabs = value.tabs; },
  onFailure: (error, details) => writeDiagnostic("desktop-tabs-persistence-error.log", new Error(
    `${error instanceof Error ? error.message : String(error)}; pending=${details.pending}`,
    { cause: error },
  )),
});
let persistedConversations = loadPersistedConversations();
let desktopPreferencesNeedsMigration = false;
let desktopPreferences = loadDesktopPreferences();
if (desktopPreferencesNeedsMigration) persistDesktopPreferences();
const configuredBrowserBackend = desktopPreferences.browserBackend === "companion" ? "companion" : "desktop";
const pipeName = process.env.EGO_DESKTOP_PIPE || `\\\\.\\pipe\\ego-compat-desktop-broker${configuredBrowserBackend === "companion" ? "-companion" : ""}`;
let browserImportProfiles = new Map();
let browserImportExtensions = new Map();
const restoredDesktopTasks = new Set();
const desktopRestorePromises = new Map();
const hostPending = new Map();
const browserPromptPending = new Map();
const browserPromptQueue = [];
let activeBrowserPromptId = "";
const homeBarShortcut = process.env.EGO_HOME_BAR_SHORTCUT || "CommandOrControl+Shift+Space";
const browserProfileSessions = new Map();
let browserExtensionSession;
const loadedBrowserExtensions = new Map();
const browserExtensionRuntimeStates = new Map();
const browserExtensionBackgroundWindows = new Map();
const browserExtensionBackgroundRecovery = new Map();
const browserExtensionActionWindows = new Map();
let targetedExtensionHost;
const agentIntegrations = new AgentIntegrationService({
  userHome: app.getPath("home"),
  codexHome: process.env.CODEX_HOME,
  pipeName,
  runtimeDirectory: agentRuntimeDirectory,
  skillSources: agentSkillSources,
  installRoot: join(dataRoot, "agent-integration"),
  executablePath: process.execPath,
  ...(app.isPackaged ? {} : { desktopAppPath: app.getAppPath() }),
  automationPipeName,
  commandDirectory: userCommandDirectory(),
  version: app.getVersion(),
});
const scanSciService = new ScanSciService({
  projectDirectory: process.env.SCANSCI_PROJECT_DIR || (app.isPackaged ? join(agentRuntimeDirectory, "scansci") : join(developmentRoot, "..", "ScanSci PDF")),
  ...(app.isPackaged ? { pythonCommand: join(agentRuntimeDirectory, "scansci", "python", "python.exe"), runtimeDirectory: agentRuntimeDirectory, dataDirectory: join(dirname(desktopStatePath), "scansci"), pipeName, autoRestart: true } : {}),
});

if (process.env.EGO_DESKTOP_USER_DATA) app.setPath("userData", process.env.EGO_DESKTOP_USER_DATA);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on("second-instance", () => showMainWindow());

app.on("login", (event, target, request, authInfo, callback) => {
  if (!isEgoGuestContents(target)) return;
  event.preventDefault();
  const origin = request?.url ? originOf(request.url) : target.getURL();
  const profileId = profileIdForWebContents(target);
  const saved = credentialStore.find(profileId, origin, authInfo?.realm || "");
  const preferred = saved[0];
  const prefill = preferred ? credentialStore.reveal(profileId, preferred.id) : undefined;
  void requestBrowserPrompt({
    type: "auth",
    title: "网站需要登录",
    message: `${origin || "当前网站"} 请求用户名和密码。${authInfo?.realm ? `\nRealm: ${authInfo.realm}` : ""}`,
    origin,
    webContentsId: target.id,
    credentialProfileId: profileId,
    credentialOptions: saved,
    prefillCredentialId: preferred?.id || "",
    prefillUsername: prefill?.username || "",
    prefillPassword: prefill?.password || "",
    rememberAllowed: true,
  }).then((response) => {
    if (!response.accepted) return callback();
    const username = response.username || "";
    const password = response.password || "";
    if (response.remember && origin && password) {
      credentialStore.save({ profileId, origin, realm: authInfo?.realm || "", username, password });
    }
    if (response.credentialId) credentialStore.touch(profileId, response.credentialId);
    callback(username, password);
  });
});

app.on("certificate-error", (event, target, url, error, certificate, callback) => {
  if (!isEgoGuestContents(target)) return;
  event.preventDefault();
  const requestOrigin = originOf(url);
  const pageOrigin = originOf(target.getURL());
  if (requestOrigin && pageOrigin && requestOrigin !== pageOrigin) {
    callback(false);
    return;
  }
  const subject = certificate?.subjectName ? `\n证书: ${certificate.subjectName}` : "";
  const issuer = certificate?.issuerName ? `\n签发者: ${certificate.issuerName}` : "";
  void requestBrowserPrompt({
    type: "certificate",
    title: "证书无法验证",
    message: `${url}\n${error || "证书错误"}${subject}${issuer}\n仅在你确认该站点可信时继续。`,
    origin: originOf(url),
    webContentsId: target.id,
    rememberAllowed: false,
  }).then((response) => callback(response.accepted === true));
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  registerIpc();
  browserExtensionSession = ensureBrowserProfileSession("default");
  targetedExtensionHost = new TargetedExtensionHost({
    session: browserExtensionSession,
    statePath: join(dirname(preferencesStatePath), 'extension-host-state.json'),
    getWindow: () => mainWindow,
    getTabs: () => [...desktopTabs.values()].filter(tab => tab.webContentsId).map(extensionHostTab),
    getActiveTab: () => activeDesktopTab() ? extensionHostTab(activeDesktopTab()) : undefined,
    assertTabAllowed: tab => mutationGate.assertMutationAllowed(desktopTabs.get(tab.targetId)?.taskId),
    createTab: async details => {
      const taskId = required(activeDesktopTab()?.taskId || selectedTask?.id, 'taskId');
      const created = await createDesktopTab(taskId, details.url, extensionOpenPolicy(details));
      return extensionHostTab(desktopTabs.get(created.targetId));
    },
    updateTab: async (tab, details) => {
      if (details.url) await webviewContents(tab.id).loadURL(normalizedPopupUrl(details.url));
      if (details.active) await activateDesktopTab(tab.targetId, { visual: true });
      return extensionHostTab(desktopTabs.get(tab.targetId));
    },
    removeTab: tab => closeDesktopTab(tab.targetId),
  });
  await restoreBrowserExtensions();
  createWindow();
  if (scopedReferencesEnabled) initializeDesktopScopedAutomation();
  if (!process.env.EGO_DESKTOP_SMOKE_RESULT && process.env.EGO_AGENT_INTEGRATION_DISABLED !== "1") {
    // Publish configuration only after the first backend initialization attempt.
  }
  createTray();
  homeBarShortcutRegistered = globalShortcut.register(homeBarShortcut, toggleHomeBar);
  desktopRpcServer = new DesktopRpcServer(dispatchDesktopPluginAutomation, {
    diagnose: process.env.EGO_SCOPED_DIAGNOSTICS === "1" ? (record) => console.log("scoped-rpc", JSON.stringify(record)) : undefined,
    onDisconnect: () => {
      for (const taskId of brokerSpaceStates.keys()) desktopScopedAutomation?.cancelTask(taskId, "Broker bridge disconnected");
    },
  });
  await desktopRpcServer.listen(automationPipeName);
  await initializeBackend();
  if (process.env.EGO_COS_UPDATE_RESULT && !app.isPackaged) {
    const { runCosUpdateSmoke } = await import("./workspace-packs/cos-update-smoke.mjs");
    void runCosUpdateSmoke({ window: mainWindow, workspace: cosWorkspace,
      brokerPid: () => spawnedBrokerProcess?.pid, quit: () => app.quit() });
  }
  if (process.env.EGO_COS_PRESET_UI_RESULT && !app.isPackaged) {
    const { runCosPresetUiSmoke } = await import("./workspace-packs/cos-preset-ui-smoke.mjs");
    void runCosPresetUiSmoke({ window: mainWindow, workspace: cosWorkspace,
      brokerPid: () => spawnedBrokerProcess?.pid, quit: () => app.quit() });
  }
  if (process.env.EGO_COS_LIFECYCLE_RESULT && !app.isPackaged) {
    const { runCosLifecycleSmoke } = await import("./workspace-packs/cos-lifecycle-smoke.mjs");
    void runCosLifecycleSmoke({ window: mainWindow, workspace: cosWorkspace,
      listSpaces: async () => (await rpc.request("space.list", { clientId })).taskSpaces,
      brokerPid: () => spawnedBrokerProcess?.pid, quit: () => app.quit() });
  }
  if (process.env.EGO_COS_SMOKE_RESULT && (!app.isPackaged || process.env.EGO_COS_PACKAGED_SMOKE === "1")) {
    const { runCosWorkspaceSmoke } = await import("./workspace-packs/cos-workspace-smoke.mjs");
    void runCosWorkspaceSmoke({ window: mainWindow, workspace: cosWorkspace, exit: exitDesktopApp });
  }
  if (app.isPackaged && !process.env.EGO_DESKTOP_SMOKE_RESULT && !process.env.EGO_COS_PACKAGED_SMOKE) {
    void scanSciService.ensure().catch(error => writeDiagnostic("scansci-error.log", error));
    if (process.env.EGO_AGENT_INTEGRATION_DISABLED !== "1") {
      void startCompanionInstaller(false).catch(error => writeDiagnostic("companion-error.log", error));
    }
  }
  if (!process.env.EGO_DESKTOP_SMOKE_RESULT && process.env.EGO_AGENT_INTEGRATION_DISABLED !== "1") syncAgentIntegrations();
}).catch((error) => {
  writeDiagnostic("desktop-error.log", error);
  app.quit();
});

app.on("window-all-closed", async () => {
  for (const binding of desktopWebviewBindings.values()) binding.dispose();
  desktopSessions.clear();
  desktopTargetSessions.clear();
  await rpc?.close().catch(() => {});
  await desktopRpcServer?.close().catch(() => {});
  if (isQuitting && process.platform !== "darwin") app.quit();
});

app.on("activate", () => showMainWindow());
app.on("before-quit", (event) => {
  if (!cosQuitDone && (cosWorkspace.acquiring || cosWorkspace.updating || cosWorkspace.runtime && !["stopped", "failed"].includes(cosWorkspace.runtime.state))) {
    event.preventDefault();
    if (!cosQuitPending) {
      cosQuitPending = true;
      void cosWorkspace.shutdown().then(() => {
        cosQuitDone = true;
        app.quit();
      }).catch(error => {
        cosQuitPending = false;
        writeDiagnostic("desktop-error.log", error);
      });
    }
    return;
  }
  isQuitting = true;
  developerTools.dispose();
  desktopTabsWriter.flush();
  clearTimeout(backendRecoveryTimer);
  globalShortcut.unregisterAll();
  scanSciService.dispose();
  void stopSpawnedBroker();
});

function exitDesktopApp(code) {
  desktopTabsWriter.flush();
  void cosWorkspace.shutdown().then(() => app.exit(code)).catch(error => {
    writeDiagnostic("desktop-error.log", error);
    app.quit();
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#18262b",
    title: "Ego",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#f5f6f7", symbolColor: "#17191c", height: 54 },
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  mainWindow.loadFile(join(dirname(fileURLToPath(import.meta.url)), "public", "index.html"));
  mainWindow.webContents.on("before-input-event", (event, input) => {
    routeBrowserShortcut(event, input);
  });
  mainWindow.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) cancelBrowserPrompts();
  });
  mainWindow.webContents.once("did-finish-load", async () => {
    if (process.env.EGO_EXTENSION_STARTUP_SMOKE_RESULT) {
      const { runExtensionStartupSmoke } = await import("./extension-startup-smoke.mjs");
      await runExtensionStartupSmoke({ window: mainWindow, host: targetedExtensionHost,
        loaded: loadedBrowserExtensions, backgrounds: browserExtensionBackgroundWindows,
        records: browserExtensionRecords(), session: browserExtensionSession, exit: exitDesktopApp });
      return;
    }
    if (process.env.EGO_AUTOMATION_SMOKE_RESULT) {
      const { runAutomationSmoke } = await import("./automation-smoke.mjs");
      await runAutomationSmoke({ window: mainWindow, service: automationDecisions,
        output: process.env.EGO_AUTOMATION_SMOKE_RESULT,
        ready: process.env.EGO_AUTOMATION_SMOKE_READY, finish: process.env.EGO_AUTOMATION_SMOKE_FINISH,
        exit: exitDesktopApp });
      return;
    }
    if (process.env.EGO_BOOKMARK_SMOKE_RESULT) {
      const { runBookmarkLibrarySmoke } = await import("./bookmark-library-smoke.mjs");
      await runBookmarkLibrarySmoke({ window: mainWindow, output: process.env.EGO_BOOKMARK_SMOKE_RESULT, exit: exitDesktopApp });
      return;
    }
    if (process.env.EGO_TRANSLATION_SMOKE_RESULT) {
      const { runTranslationSmoke } = await import("./translation-smoke.mjs");
      await runTranslationSmoke({
        window: mainWindow, service: pageTranslations, getTabs: () => [...desktopTabs.values()],
        getVisibleId: () => activeWebviewId, output: process.env.EGO_TRANSLATION_SMOKE_RESULT,
        fixtureUrl: process.env.EGO_TRANSLATION_SMOKE_URL, exit: exitDesktopApp,
      });
      return;
    }
    if (process.env.EGO_DEVTOOLS_SMOKE_RESULT) {
      const { runDeveloperToolsSmoke } = await import("./developer-tools-smoke.mjs");
      await runDeveloperToolsSmoke({
        window: mainWindow, developerTools, desktopBrowser,
        getTabs: () => [...desktopTabs.values()], getVisibleId: () => activeWebviewId,
        showContextMenu: showWebviewContextMenu,
        output: process.env.EGO_DEVTOOLS_SMOKE_RESULT,
        fixtureUrl: process.env.EGO_DEVTOOLS_SMOKE_URL,
        exit: exitDesktopApp,
      });
      return;
    }
    if (process.env.EGO_DESKTOP_INTERACTION_SMOKE_RESULT) {
      const { runInteractionSmoke } = await import('./interaction-smoke.mjs');
      await runInteractionSmoke({ window: mainWindow, getTabs: () => [...desktopTabs.values()], getVisibleId: () => activeWebviewId, createTab: createDesktopTab, extensionHost: targetedExtensionHost, output: process.env.EGO_DESKTOP_INTERACTION_SMOKE_RESULT, exit: exitDesktopApp });
      return;
    }
    if (process.env.EGO_DESKTOP_CONTROL_SMOKE_RESULT) {
      await runControlCollaborationSmoke();
      return;
    }
    if (process.env.EGO_DESKTOP_CREDENTIAL_SMOKE_RESULT) {
      await runCredentialUiSmoke();
      return;
    }
    if (process.env.EGO_DESKTOP_RESTORE_RESULT) {
      await runDesktopRestoreSmoke();
      return;
    }
    if (process.env.EGO_DESKTOP_SMOKE_RESULT) {
      await runDesktopSmoke();
      return;
    }
    if (process.env.EGO_DESKTOP_CAPTURE_TAB_OVERVIEW) {
      await mainWindow.webContents.executeJavaScript(`(() => {
        if (!document.querySelector("#tab-batchbar").hidden) document.querySelector("#manage-browser-tabs").click();
        if (document.querySelector("#tab-overview").hidden) document.querySelector("#manage-browser-tabs").click();
      })()`);
      await delay(180);
    }
    if (process.env.EGO_DESKTOP_CAPTURE_AGENT_SETTINGS) {
      await mainWindow.webContents.executeJavaScript(`(() => {
        document.querySelector('[data-view="settings"]')?.click();
        document.querySelector('[data-open-view="agent-settings"]')?.click();
        if (document.querySelector(".app-shell")?.classList.contains("assistant-collapsed")) document.querySelector("#titlebar-toggle-assistant")?.click();
      })()`);
      await delay(300);
    }
    if (process.env.EGO_DESKTOP_CAPTURE_CONTROL_SECURITY) {
      await mainWindow.webContents.executeJavaScript(`(() => {
        document.querySelector('[data-view="settings"]')?.click();
        document.querySelector('[data-open-view="agent-settings"]')?.click();
        document.querySelector(".control-security-settings")?.scrollIntoView({ block: "center" });
      })()`);
      await delay(300);
    }
    if (process.env.EGO_DESKTOP_CAPTURE_SCANSCI_SETTINGS) {
      await mainWindow.webContents.executeJavaScript(`(() => {
        document.querySelector('[data-view="settings"]')?.click();
        document.querySelector('[data-open-view="scansci-settings"]')?.click();
      })()`);
      const deadline = Date.now() + 90_000;
      let rendererState;
      do {
        await delay(500);
        rendererState = await mainWindow.webContents.executeJavaScript(`(() => ({
          active: document.querySelector("#scansci-settings-view")?.classList.contains("active") === true,
          service: document.querySelector("#scansci-service-state")?.textContent || "",
          channels: document.querySelector("#scansci-channel-state")?.textContent || "",
          owner: document.querySelector("#scansci-owner-state")?.textContent || "",
          error: document.querySelector("#scansci-service-error")?.textContent || "",
          webviewUrl: document.querySelector("#scansci-settings-webview")?.getAttribute("src") || "",
        }))()`);
        if (rendererState.active && rendererState.service.includes("运行中") && !rendererState.channels.includes("正在")) break;
      } while (Date.now() < deadline);
      await delay(6_000);
      if (process.env.EGO_DESKTOP_CAPTURE_SCANSCI_RESULT) {
        writeFileSync(process.env.EGO_DESKTOP_CAPTURE_SCANSCI_RESULT, JSON.stringify({
          renderer: rendererState,
          service: await scanSciService.status(),
        }, null, 2), "utf8");
      }
    }
    if (process.env.EGO_DESKTOP_CAPTURE) {
      await delay(2500);
      const image = await mainWindow.webContents.capturePage();
      writeFileSync(process.env.EGO_DESKTOP_CAPTURE, image.toPNG());
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  const window = mainWindow;
  window.on("close", (event) => {
    if (isQuitting || process.env.EGO_DESKTOP_SMOKE_RESULT || process.env.EGO_DESKTOP_RESTORE_RESULT) return;
    event.preventDefault();
    window.hide();
  });
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  mainWindow.maximize();
  mainWindow.show();
  mainWindow.focus();
}

function createHomeBarWindow() {
  if (homeBarWindow && !homeBarWindow.isDestroyed()) return homeBarWindow;
  homeBarWindow = new BrowserWindow({
    width: 720,
    height: 92,
    minWidth: 520,
    maxWidth: 860,
    minHeight: 92,
    maxHeight: 92,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    title: "Ego 快捷栏",
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "homebar-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  homeBarWindow.loadFile(join(dirname(fileURLToPath(import.meta.url)), "public", "homebar.html"));
  homeBarWindow.on("blur", () => {
    if (!homeBarWindow?.webContents.isDevToolsOpened()) homeBarWindow?.hide();
  });
  homeBarWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    homeBarWindow.hide();
  });
  homeBarWindow.once("closed", () => { homeBarWindow = undefined; });
  return homeBarWindow;
}

async function toggleHomeBar() {
  if (homeBarWindow?.isVisible()) {
    homeBarWindow.hide();
    return;
  }
  homeBarContextDraft = await captureHomeBarContext();
  const window = createHomeBarWindow();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = Math.min(720, display.workArea.width - 32);
  window.setSize(width, 92, false);
  window.setPosition(
    Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    display.workArea.y + 42,
    false,
  );
  window.show();
  window.focus();
  const sendContext = () => window.webContents.send("ego:homebar-context", publicHomeBarContext(homeBarContextDraft));
  if (window.webContents.isLoadingMainFrame()) window.webContents.once("did-finish-load", sendContext);
  else sendContext();
  window.webContents.executeJavaScript('document.querySelector("#homebar-input")?.focus()').catch(() => {});
}

async function captureHomeBarContext() {
  let target;
  if (activeWebviewId) {
    try { target = webviewContents(activeWebviewId); } catch {}
  }
  let selection = "";
  if (target) {
    try { selection = await selectedTextFromTarget(target); } catch {}
  }
  let tab = [...desktopTabs.values()].find((candidate) => candidate.webContentsId === activeWebviewId);
  if (!tab && target) {
    const binding = desktopWebviewBindings.get(target.id);
    if (binding?.targetId) tab = desktopTabs.get(binding.targetId);
  }
  if (!tab && mainWindow && !mainWindow.isDestroyed()) {
    try {
      const visible = await mainWindow.webContents.executeJavaScript(`(() => {
        const webview = document.querySelector('webview:not([hidden])');
        if (!webview) return null;
        try { return { targetId: webview.dataset.targetId, taskId: webview.dataset.taskId, webContentsId: webview.getWebContentsId(), title: webview.getTitle(), url: webview.getURL() }; } catch { return null; }
      })()`);
      tab = visible?.targetId ? desktopTabs.get(visible.targetId) : undefined;
      if (!tab && visible?.targetId && visible.taskId) tab = visible;
      if (tab && visible.webContentsId) {
        tab.webContentsId = visible.webContentsId;
        activeWebviewId = visible.webContentsId;
        try { target = webviewContents(visible.webContentsId); } catch {}
        if (!selection && target) {
          try { selection = await selectedTextFromTarget(target); } catch {}
        }
      }
    } catch {}
  }
  tab ||= [...desktopTabs.values()].find((candidate) => candidate.active);
  if (!tab?.webContentsId || !target) {
    if (!tab?.webContentsId) return null;
    try { target = webviewContents(tab.webContentsId); } catch { return null; }
  }
  return {
    taskId: tab.taskId,
    targetId: tab.targetId,
    webContentsId: tab.webContentsId,
    title: target.getTitle() || tab.title || tab.url,
    url: target.getURL() || tab.url,
    selection: typeof selection === "string" ? selection.slice(0, 20_000) : "",
  };
}

function selectedTextFromTarget(target) {
  return target.executeJavaScript(`(() => {
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName) && typeof active.selectionStart === "number") {
      return active.value.slice(active.selectionStart, active.selectionEnd).trim();
    }
    return String(window.getSelection?.() || "").trim();
  })()`);
}

function publicHomeBarContext(draft) {
  return draft ? {
    targetId: draft.targetId,
    title: draft.title,
    url: draft.url,
    hasPage: true,
    hasSelection: Boolean(draft.selection),
  } : { hasPage: false, hasSelection: false };
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  const iconPath = join(dirname(fileURLToPath(import.meta.url)), "public", "assets", "ego-start.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Ego");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Ego", click: showMainWindow },
    { label: `快捷栏 (${homeBarShortcut.replace("CommandOrControl", "Ctrl")})`, click: toggleHomeBar },
    { label: "新建任务", click: () => sendToMainWindow("ego:homebar-compose", { action: "new-task" }) },
    { type: "separator" },
    { label: "退出", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", showMainWindow);
}

function sendToMainWindow(channel, payload) {
  showMainWindow();
  const send = () => mainWindow?.webContents.send(channel, payload);
  if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once("did-finish-load", send);
  else send();
}

function routeBrowserShortcut(event, input, targetId = "") {
  const command = browserCommandForInput(input);
  if (!command) return false;
  event.preventDefault();
  if (input.isAutoRepeat && ["toggle-devtools", "inspect-element"].includes(command)) return true;
  if (command === "toggle-fullscreen") {
    mainWindow?.setFullScreen(!mainWindow.isFullScreen());
    return true;
  }
  if (command === "close-window") {
    mainWindow?.close();
    return true;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("ego:browser-command", { command, ...(targetId ? { targetId } : {}) });
  }
  return true;
}

async function runCredentialUiSmoke() {
  try {
    const fixtureOrigin = String(process.env.EGO_DESKTOP_HISTORY_FIXTURE_URL || "http://127.0.0.1").replace(/\/$/, "");
    const credentialFixtureUrl = `${fixtureOrigin}/login`;
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await mainWindow.webContents.executeJavaScript('document.querySelector("#connection")?.textContent === "本地运行中"');
      if (ready) break;
      await delay(100);
    }
    if (!ready) throw new Error("Desktop shell did not connect to the Broker");

    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      window.__egoCredentialSmokeStage = "startup";
      const waitFor = async (predicate, message) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error(message);
      };
      const waitForWebviewReady = async (webview, message) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          try {
            if (webview?.isConnected && webview.getWebContentsId() && !webview.isLoading()) {
              await webview.executeJavaScript("true");
              return;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error(message);
      };
      const waitForWebviewValue = async (webview, expression, message) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          try {
            if (await webview.executeJavaScript(expression)) return;
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error(message);
      };
      const setLoginValues = (username, password, submit = false) => credentialWebview.executeJavaScript('(() => { const values = ' + JSON.stringify({ username, password, submit }) + '; const set = (selector, value) => { const field = document.querySelector(selector); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; if (setter) setter.call(field, value); else field.value = value; field.dispatchEvent(new InputEvent("input", { bubbles: true, data: value })); }; set("#login-username", values.username); set("#login-password", values.password); if (values.submit) document.querySelector("#login-form").requestSubmit(); return true; })()');

      document.querySelector("#new-task").click();
      document.querySelector("#task-name").value = "Credential smoke";
      document.querySelector("#task-form").requestSubmit();
      await waitFor(() => [...document.querySelectorAll(".task-name")].some((node) => node.textContent === "Credential smoke"), "Credential task was not created");

      window.__egoCredentialSmokeStage = "open login fixture";
      document.querySelector("#omnibox").value = ${JSON.stringify(credentialFixtureUrl)};
      document.querySelector("#omnibox-form").requestSubmit();
      await waitFor(() => document.querySelector('webview:not([hidden])')?.getURL() === ${JSON.stringify(credentialFixtureUrl)}, "Credential fixture was not opened");
      const credentialWebview = document.querySelector('webview:not([hidden])');
      await waitForWebviewReady(credentialWebview, "Credential fixture did not become ready");
      await waitFor(() => document.querySelector("#browser-passwords")?.classList.contains("active"), "Credential form was not detected");
      const credentialFormDetected = true;

      window.__egoCredentialSmokeStage = "save first account";
      await setLoginValues("smoke-user", "smoke-password", true);
      await waitFor(() => document.querySelector("#credential-save-dialog")?.open, "Credential save dialog did not open");
      const credentialPromptCaptured = document.querySelector("#credential-save-username").value === "smoke-user"
        && document.querySelector("#credential-save-password").value === "smoke-password"
        && document.querySelector("#credential-save-origin").textContent === ${JSON.stringify(fixtureOrigin)};
      document.querySelector("#credential-save-form").requestSubmit();
      await waitFor(() => !document.querySelector("#credential-save-dialog")?.open
        && document.querySelector("#settings-credential-count")?.textContent === "1 条", "First credential was not saved");
      await setLoginValues("", "");
      await waitForWebviewValue(credentialWebview, 'document.querySelector("#login-username")?.value === "smoke-user" && document.querySelector("#login-password")?.value === "smoke-password"', "Saved credential was not automatically filled");
      const credentialAutoFill = true;

      window.__egoCredentialSmokeStage = "reload autofill";
      const reloadReady = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Credential fixture reload timed out")), 8000);
        credentialWebview.addEventListener("dom-ready", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      credentialWebview.reload();
      await reloadReady;
      await waitForWebviewValue(credentialWebview, 'document.querySelector("#login-username")?.value === "smoke-user" && document.querySelector("#login-password")?.value === "smoke-password"', "Credential was not filled after reload");
      const credentialReloadAutoFill = true;

      window.__egoCredentialSmokeStage = "save second account";
      const autofillToggle = document.querySelector("#password-autofill-enabled");
      autofillToggle.checked = false;
      autofillToggle.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => document.querySelector("#password-autofill-label")?.textContent === "已关闭", "Autofill did not turn off");
      await setLoginValues("smoke-second", "second-password", true);
      await waitFor(() => document.querySelector("#credential-save-dialog")?.open, "Second credential save dialog did not open");
      document.querySelector("#credential-save-form").requestSubmit();
      await waitFor(() => !document.querySelector("#credential-save-dialog")?.open
        && document.querySelector("#settings-credential-count")?.textContent === "2 条", "Second credential was not saved");

      await setLoginValues("", "");
      autofillToggle.checked = true;
      autofillToggle.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => document.querySelector("#password-autofill-label")?.textContent === "已开启", "Autofill did not turn back on");
      await waitForWebviewValue(credentialWebview, 'document.querySelector("#login-username")?.value === "smoke-second" && document.querySelector("#login-password")?.value === "second-password"', "Re-enabled autofill did not fill the form");
      const credentialToggleAutoFill = true;

      window.__egoCredentialSmokeStage = "account picker";
      document.querySelector("#browser-passwords").click();
      await waitFor(() => !document.querySelector("#credentials-panel").hidden
        && document.querySelectorAll(".credential-panel-row").length === 2, "Credential picker did not show both accounts");
      const panelRect = document.querySelector("#credentials-panel").getBoundingClientRect();
      const credentialPanelUi = panelRect.width > 0 && panelRect.height > 0
        && panelRect.left >= 0 && panelRect.right <= innerWidth && panelRect.bottom <= innerHeight;
      await credentialWebview.executeJavaScript('(() => { document.querySelector("#login-username").value = ""; document.querySelector("#login-password").value = ""; return true; })()');
      const firstRow = [...document.querySelectorAll(".credential-panel-row")].find((row) => row.querySelector("strong")?.textContent === "smoke-user");
      firstRow?.querySelector("[data-credential-fill]")?.click();
      await waitForWebviewValue(credentialWebview, 'document.querySelector("#login-username")?.value === "smoke-user" && document.querySelector("#login-password")?.value === "smoke-password"', "Selected account was not filled");
      const credentialAccountSwitch = true;

      window.__egoCredentialSmokeStage = "credential settings";
      document.querySelector('[data-view="settings"]').click();
      await waitFor(() => document.querySelectorAll("#credential-settings-list .credential-settings-row").length === 2, "Credential settings did not render both accounts");
      document.querySelector("#credential-settings-list [data-credential-action=edit]").click();
      await waitFor(() => document.querySelector("#credential-save-dialog")?.open
        && Boolean(document.querySelector("#credential-save-password")?.value), "Credential editor did not load the selected password");
      const credentialSettingsUi = document.querySelector("#credential-profile-filter").value === "default"
        && document.querySelector("#credential-save-title").textContent === "更新密码";
      document.querySelector("#credential-save-cancel").click();
      const isolated = await window.egoDesktop.invoke("credentials.list", { profileId: "credential-isolated-smoke" });
      const credentialProfileIsolation = Array.isArray(isolated) && isolated.length === 0;

      return {
        credentialFormDetected,
        credentialPromptCaptured,
        credentialAutoFill,
        credentialReloadAutoFill,
        credentialToggleAutoFill,
        credentialPanelUi,
        credentialAccountSwitch,
        credentialSettingsUi,
        credentialProfileIsolation,
      };
    })()`);

    writeFileSync(process.env.EGO_DESKTOP_CREDENTIAL_SMOKE_RESULT, JSON.stringify(result, null, 2), "utf8");
    if (Object.values(result).every(Boolean)) app.quit();
    else exitDesktopApp(1);
  } catch (error) {
    const stage = await mainWindow?.webContents.executeJavaScript("window.__egoCredentialSmokeStage || 'unknown'").catch(() => "window unavailable");
    writeFileSync(
      process.env.EGO_DESKTOP_CREDENTIAL_SMOKE_RESULT,
      JSON.stringify({ error: `[${stage}] ${error?.stack || String(error)}` }, null, 2),
      "utf8",
    );
    exitDesktopApp(1);
  }
}

async function runControlCollaborationSmoke() {
  const clients = [];
  const output = process.env.EGO_DESKTOP_CONTROL_SMOKE_RESULT;
  const evaluate = (source) => mainWindow.webContents.executeJavaScript(source);
  const until = async (predicate, message) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(50);
    }
    throw new Error(message);
  };
  try {
    await until(() => evaluate('document.querySelector("#connection")?.textContent === "本地运行中"'), "Desktop did not become ready");
    if (process.env.EGO_DESKTOP_CONTROL_SMOKE_RESTORE === "1") {
      await until(() => evaluate('document.querySelectorAll("webview[data-target-id]").length >= 2'), "Workspace tabs did not restore with their Profile");
      const contents = await evaluate('[...document.querySelectorAll("webview[data-target-id]")].map(view => ({ profile: view.dataset.profileId, url: view.src }))');
      if (!contents.every((tab) => tab.profile === "default") || !contents.some((tab) => tab.url.includes("Control"))) throw new Error("Restored tabs lost their Profile or page");
      writeFileSync(output, JSON.stringify({ passed: true, restoredTabsWithProfile: true }), "utf8");
      exitDesktopApp(0);
      return;
    }
    const a = await PipeRpcClient.connect(pipeName);
    const b = await PipeRpcClient.connect(pipeName);
    clients.push(a, b);
    for (const [client, id] of [[a, "control-agent-a"], [b, "control-agent-b"]]) {
      await client.request("agent.register", { clientId: id, displayName: id, clientKind: "other" });
    }
    const space = await a.request("space.create", { clientId: "control-agent-a", name: "Control smoke" });
    const tab = await a.request("tab.create", { clientId: "control-agent-a", taskSpaceId: space.id, leaseEpoch: space.leaseEpoch, url: "data:text/html,<title>Control smoke</title><input id=input><h1>Unchanged</h1>" });
    await hostRequest("task.visual-select", { taskId: space.taskId });
    await hostRequest("tab.activate", { ...publicDesktopRecord(desktopTabs.get(tab.targetId)), visual: true });
    await evaluate('document.querySelector("#control-panel-open").click()');
    await until(() => evaluate('document.querySelector("#control-panel-agents").textContent.includes("control-agent-b")'), "Panel did not show both agents");
    await evaluate('document.querySelector("#control-auto-collaboration").click()');
    await until(() => desktopPreferences.autoCollaboration === true, "Interaction setting was not saved");
    await evaluate('document.querySelector("#control-panel-close").click()');
    const target = webContents.fromId(desktopTabs.get(tab.targetId).webContentsId);
    const direct = await PipeRpcClient.connect(automationPipeName);
    clients.push(direct);
    const directParams = { taskId: space.taskId, targetId: tab.targetId, __egoSource: "desktop-mcp", __egoClientId: "control-agent-a" };
    directParams.__egoMutation = await direct.request("mutation.context", directParams);
    await direct.request("page.evaluate", { ...directParams, expression: "1 + 1" });
    const originalContext = await rpc.request("mutation.assert", { clientId, taskId: space.taskId, actorClientId: "control-agent-a", leaseEpoch: space.leaseEpoch });
    const backgroundTarget = mutationGate.run(originalContext, () => mutationGate.guardTarget(target, space.taskId));
    target.focus();
    target.sendInputEvent({ type: "keyDown", keyCode: "F8" });
    target.sendInputEvent({ type: "keyUp", keyCode: "F8" });
    await until(() => evaluate('document.querySelector("#confirm-dialog").open'), "Native input did not ask for takeover");
    const paused = await b.request("space.observe", { clientId: "control-agent-b", id: space.id });
    if (!paused.space.agentBlocked || !paused.interactionPending) throw new Error("Agent was not paused");
    const mutationExpression = 'document.querySelector("h1").textContent="WRONG"';
    const denied = await Promise.allSettled([
      a.request("tab.create", { clientId: "control-agent-a", taskSpaceId: space.id, leaseEpoch: space.leaseEpoch, url: "about:blank" }),
      a.request("tab.close", { clientId: "control-agent-a", targetId: tab.targetId }),
      a.request("chat.closeTab", { clientId: "control-agent-a", targetId: tab.targetId }),
      direct.request("page.evaluate", { ...directParams, expression: mutationExpression }),
      direct.request("cdp.send", { ...directParams, payload: JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: mutationExpression } }) }),
      direct.request("page.evaluate", { taskId: space.taskId, expression: mutationExpression }),
      backgroundTarget.executeJavaScript(mutationExpression),
    ]);
    if (denied.some((result) => result.status !== "rejected")) throw new Error("A mutation entry bypassed user control");
    let fenced = false;
    try { await a.request("cdp.send", { clientId: "control-agent-a", taskSpaceId: space.id, leaseEpoch: space.leaseEpoch, payload: JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: 'document.querySelector("h1").textContent="WRONG"' } }) }); }
    catch { fenced = true; }
    if (!fenced || await target.executeJavaScript('document.querySelector("h1").textContent') !== "Unchanged") throw new Error("Old writer changed the page after pause");
    await evaluate('document.querySelector("#confirm-accept").click()');
    await until(async () => !(await b.request("space.controlState", { clientId: "control-agent-b", id: space.id })).interactionPending, "Takeover did not clear the confirmation");
    const request = await b.request("space.requestControl", { clientId: "control-agent-b", id: space.id });
    await evaluate('document.querySelector("#control-panel-open").click()');
    await until(() => evaluate('document.querySelector("#control-panel-requests").textContent.includes("等待批准")'), "Pending request was not rendered");
    await evaluate('document.querySelector("#control-panel-requests button").click()');
    await until(async () => (await b.request("space.controlState", { clientId: "control-agent-b", id: space.id })).controllerClientId === "control-agent-b", "Panel approval did not grant the requested writer");
    const granted = await b.request("space.select", { clientId: "control-agent-b", id: space.id });
    await b.request("tab.create", { clientId: "control-agent-b", taskSpaceId: space.id, leaseEpoch: granted.leaseEpoch, url: "about:blank" });
    const observed = await a.request("space.observe", { clientId: "control-agent-a", id: space.id, targetId: tab.targetId });
    if (!observed.snapshot || observed.tabs.length !== 2) throw new Error("Read-only collaborator could not observe the page");
    const switchMode = async (mode) => {
      await evaluate(`document.querySelector("#control-panel-close").click(); document.querySelector('[data-control-mode="${mode}"]').click()`);
      await until(() => evaluate(`document.querySelector('[data-control-mode="${mode}"]').getAttribute("aria-pressed") === "true" && !document.querySelector('[data-control-mode="${mode}"]').disabled`), `Mode ${mode} did not finish switching`);
      await evaluate('document.querySelector("#control-panel-open").click()');
      await until(() => evaluate('document.querySelector("#control-panel-status").textContent !== "正在读取控制状态"'), "Panel did not refresh after mode change");
    };
    await switchMode("manual");
    if (!await evaluate('document.querySelector("#control-panel-assign").disabled && document.querySelector("#control-panel-target").disabled && document.querySelector("#control-panel-reason").textContent.includes("切换全局模式")')) throw new Error("Manual restriction was not explained");
    await switchMode("agent");
    if (!await evaluate('document.querySelector("#control-panel-status").textContent === "无人接管 · Agent 无写权限"')) throw new Error("Autonomous mode falsely reported a controller");
    await switchMode("collaborative");
    if (!await evaluate('document.querySelector("#control-auto-collaboration").checked && !document.querySelector("#control-auto-collaboration").disabled')) throw new Error("Collaborative mode did not enable interaction detection");
    if ((await b.request("space.controlState", { clientId: "control-agent-b", id: space.id })).controllerClientId) throw new Error("Mode switch silently restored a writer");
    if (process.env.EGO_DESKTOP_CAPTURE) writeFileSync(process.env.EGO_DESKTOP_CAPTURE, (await mainWindow.webContents.capturePage()).toPNG());
    writeFileSync(output, JSON.stringify({ passed: true, nativeInputPaused: true, oldWriterFenced: true, allMutationEntrypointsFenced: true, confirmedTakeover: true, panelApproval: true, readOnlySnapshot: true, modePanelConsistency: true, collaborativeDetectionDefault: true, noSilentWriterRestore: true }), "utf8");
    exitDesktopApp(0);
  } catch (error) {
    writeFileSync(output, JSON.stringify({ error: error.stack || String(error) }), "utf8");
    exitDesktopApp(1);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
  }
}

async function runDesktopSmoke() {
  try {
    const collectionExportSmokePath = join(dirname(process.env.EGO_DESKTOP_SMOKE_RESULT), "collections-export.md");
    const bookmarkExportSmokePath = join(dirname(process.env.EGO_DESKTOP_SMOKE_RESULT), "collections-bookmarks.html");
    const collectionImportSmokePath = join(dirname(process.env.EGO_DESKTOP_SMOKE_RESULT), "collections-import.json");
    writeFileSync(collectionImportSmokePath, JSON.stringify({ version: 1, collections: [{ text: "Imported file collection", sourceUrl: "https://file-import.example/item", pageTitle: "File import", tags: ["文件导入"] }] }), "utf8");
    const fixtureOrigin = String(process.env.EGO_DESKTOP_HISTORY_FIXTURE_URL || "http://127.0.0.1").replace(/\/$/, "");
    const historyFixtureUrl = `${fixtureOrigin}/api`;
    const credentialFixtureUrl = `${fixtureOrigin}/login`;
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await mainWindow.webContents.executeJavaScript(
        `document.querySelector("#connection")?.textContent === "本地运行中"`,
      );
      if (ready) break;
      await delay(150);
    }
    if (!ready) throw new Error("Desktop shell did not connect to the Broker");

    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      window.__egoSmokeStage = "startup";
      const waitFor = async (predicate, message) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const result = predicate();
          if (result instanceof Promise ? await result : result) return;
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error(message);
      };
      const acceptConfirm = async () => {
        await waitFor(() => document.querySelector("#confirm-dialog")?.open, "Confirmation dialog did not open");
        document.querySelector("#confirm-accept").click();
      };
      const waitForWebviewReady = async (webview, message) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          try {
            if (webview?.isConnected && webview.getWebContentsId() && !webview.isLoading()) {
              await webview.executeJavaScript("true");
              return;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error(message);
      };
      const waitForWebviewValue = async (webview, expression, message) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          try {
            if (await webview.executeJavaScript(expression)) return;
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error(message);
      };
      document.querySelector("#new-task").click();
      document.querySelector("#task-name").value = "Desktop smoke";
      document.querySelector("#task-form").requestSubmit();
      await waitFor(
        () => [...document.querySelectorAll(".task-name")].some((node) => node.textContent === "Desktop smoke"),
        "Task was not rendered",
      );
      const newTabChrome = Boolean(document.querySelector("#titlebar-new-tab"))
        && document.querySelector("#titlebar-new-tab")?.title.includes("Ctrl+T")
        && document.querySelector(".browser-tab-placeholder")?.textContent.includes("新建标签页")
        && !document.querySelector("#start-view").classList.contains("has-browser-page");
      const smokeHtml = '<title>Ego Smoke</title><input aria-label="Name"><button id="run">Run</button><h1>Desktop Ready</h1><script>document.querySelector("#run").onclick=()=>document.querySelector("h1").textContent="Automated"<\/script>';
      document.querySelector("#omnibox").value = "data:text/html," + encodeURIComponent(smokeHtml);
      document.querySelector("#omnibox-form").requestSubmit();
      await waitFor(
        () => document.querySelector("#current-address").value.startsWith("data:text/html"),
        "Tab was not opened",
      );
      const workspaceQuickSwitch = document.querySelector("#workspace-quick-switch");
      workspaceQuickSwitch.click();
      await waitFor(() => !document.querySelector(".app-shell").classList.contains("sidebar-collapsed") && document.querySelector("#workspace-sidebar").getClientRects().length > 0, "Workspace sidebar did not open");
      const workspaceQuickSwitchUi = document.querySelector("#workspace-quick-name").textContent === "Desktop smoke"
        && document.querySelector("#workspace-sidebar").contains(document.querySelector("#task-list"))
        && !document.querySelector("#workspace-sidebar").querySelector('[data-open-view="settings"]')
        && document.querySelector("#favorites-workspaces").hidden;
      document.querySelector(".task-row.active").click();
      document.querySelector('[data-view="start"]').click();
      const appMenuNavigation = document.querySelectorAll(".settings-navigation-item").length === 6
        && document.querySelector('[data-open-view="scansci-settings"]')
        && document.querySelector("#titlebar-settings")
        && document.querySelector("#connection").getClientRects().length === 0;
      document.querySelector('[data-view="tasks"]').click();
      const tasksVisible = document.querySelector("#tasks-view").classList.contains("active");
      document.querySelector('[data-view="library"]').click();
      const libraryVisible = document.querySelector("#library-view").classList.contains("active");
      document.querySelector('[data-view="start"]').click();
      const operationOnlyUi = document.querySelector(".assistant-head strong")?.textContent === "Agent 活动"
        && document.querySelector(".composer-wrap").hidden
        && !document.querySelector("#operation-toolbar").hidden;
      document.querySelector("#titlebar-toggle-assistant").click();
      await waitFor(() => document.querySelector(".app-shell").classList.contains("assistant-collapsed"), "Operation panel did not collapse");
      document.querySelector("#titlebar-toggle-assistant").click();
      await waitFor(() => !document.querySelector(".app-shell").classList.contains("assistant-collapsed"), "Operation panel did not expand");
      const assistantCollapse = true;
      let webview = document.querySelector('webview:not([hidden])');
      await waitForWebviewReady(webview, "Webview did not become automation-ready");
      const browserToolsUi = ["#browser-find", "#browser-zoom-out", "#browser-zoom-reset", "#browser-zoom-in", "#browser-print", "#browser-downloads"].every((selector) => document.querySelector(selector));
      document.querySelector("#browser-more").click();
      await waitFor(() => !document.querySelector("#browser-more-menu").hidden, "Browser more menu did not open");
      const browserMoreMenu = document.querySelector("#browser-more-menu").textContent.includes("在页面中查找")
        && document.querySelector("#browser-more-menu").textContent.includes("页面缩放")
        && document.querySelector("#browser-more-menu").textContent.includes("打印");
      document.querySelector("#browser-more").click();
      await waitFor(() => document.querySelector("#browser-more-menu").hidden, "Browser more menu did not close");
      await window.egoDesktop.invoke("downloads.testSeed");
      await waitFor(() => {
        if (document.querySelector("#downloads-panel").hidden) document.querySelector("#browser-downloads").click();
        return !document.querySelector("#downloads-panel").hidden && document.querySelectorAll(".download-row").length === 3;
      }, "Seeded downloads were not rendered in the open panel");
      const downloadsUi = !document.querySelector("#downloads-panel").hidden && Boolean(document.querySelector("#downloads-search") && document.querySelector("#downloads-filter"));
      document.querySelector("#downloads-filter").value = "completed";
      document.querySelector("#downloads-filter").dispatchEvent(new Event("change", { bubbles: true }));
      const downloadFilter = document.querySelectorAll(".download-row").length === 1 && document.querySelector("#downloads-list").textContent.includes("completed-fixture.txt");
      document.querySelector("#downloads-filter").value = "all";
      document.querySelector("#downloads-filter").dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("#downloads-search").value = "interrupted";
      document.querySelector("#downloads-search").dispatchEvent(new Event("input", { bubbles: true }));
      const downloadSearch = document.querySelectorAll(".download-row").length === 1 && document.querySelector("#downloads-list").textContent.includes("interrupted-fixture.txt");
      document.querySelector("#downloads-search").value = "";
      document.querySelector("#downloads-search").dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#downloads-close").click();
      await waitFor(() => document.querySelector("#downloads-panel").hidden, "Downloads close button did not close the panel");
      const downloadsClose = true;
      const promptResultPromise = window.egoDesktop.invoke("browser.prompt.test", { type: "permission" });
      await waitFor(() => document.querySelector("#browser-prompt-dialog").open, "Browser prompt did not open");
      document.querySelector("#browser-prompt-allow").click();
      const promptResult = await promptResultPromise;
      const browserPrompt = promptResult.accepted === true && promptResult.remember === true;
      await window.egoDesktop.invoke("permissions.testSeed", { origin: "https://allowed.example", permission: "notifications", allowed: true });
      await window.egoDesktop.invoke("permissions.testSeed", { origin: "https://blocked.example", permission: "geolocation", allowed: false });
      document.querySelector("#browser-find").click();
      document.querySelector("#find-input").value = "Run";
      document.querySelector("#find-input").dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => document.querySelector("#find-result").textContent !== "0/0", "Find in page did not report a match");
      const findInPage = !document.querySelector("#find-bar").hidden;
      document.querySelector("#find-close").click();
      document.querySelector("#browser-zoom-in").click();
      await waitFor(() => document.querySelector("#browser-zoom-reset").textContent === "110%", "Zoom control did not update");
      const zoomControl = Math.round(webview.getZoomFactor() * 100) === 110;
      window.__egoSmokeStage = "initial target";
      const firstTarget = webview.dataset.targetId;
      await window.egoDesktop.invoke("browser.crash.test", { targetId: firstTarget });
      await waitFor(() => !document.querySelector("#crash-panel").hidden, "Crash recovery panel did not open");
      const crashRecovery = document.querySelector("#crash-title").textContent.includes("页面");
      document.querySelector("#crash-reload").click();
      await waitFor(() => document.querySelector("#crash-panel").hidden, "Crash recovery panel did not close");
      await waitForWebviewReady(webview, "Reloaded webview did not become ready");
      const snapshot = await window.egoDesktop.invoke("browser.snapshot", { webContentsId: webview.getWebContentsId() });
      const textbox = snapshot.refs.find((ref) => ref.role === "textbox");
      const button = snapshot.refs.find((ref) => ref.role === "button" && ref.name === "Run");
      if (!textbox || !button) throw new Error("Desktop CDP snapshot did not expose controls");
      await window.egoDesktop.invoke("browser.fill", { webContentsId: webview.getWebContentsId(), backendNodeId: textbox.backendNodeId, value: "Ego" });
      await window.egoDesktop.invoke("browser.click", { webContentsId: webview.getWebContentsId(), backendNodeId: button.backendNodeId });
      const heading = await window.egoDesktop.invoke("browser.evaluate", { webContentsId: webview.getWebContentsId(), expression: "document.querySelector('h1').textContent" });
      document.querySelector("#omnibox").value = "data:text/html," + encodeURIComponent("<title>Second tab</title><h1>Second</h1>");
      document.querySelector("#omnibox-form").requestSubmit();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 2
        && document.querySelector('webview:not([hidden])')
        && document.querySelector("#welcome").hidden, "Second tab was not created without reopening the welcome page");
      webview = document.querySelector('webview:not([hidden])');
      await waitForWebviewReady(webview, "Second webview did not become automation-ready");
      const newTabSkippedWelcome = document.querySelector("#welcome").hidden;
      window.__egoSmokeStage = "second target";
      const secondTarget = webview.dataset.targetId;
      document.querySelectorAll(".browser-tab")[0].click();
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === firstTarget, "First tab was not restored");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true }));
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === secondTarget, "Ctrl+Tab did not switch tabs");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey: true, bubbles: true }));
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === firstTarget, "Ctrl+Shift+Tab did not switch back");
      webview = document.querySelector('webview:not([hidden])');
      await webview.executeJavaScript('window.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, ctrlKey: true, cancelable: true }))');
      await waitFor(() => document.querySelector("#browser-zoom-reset").textContent === "120%", "Ctrl+wheel did not zoom the active webview");
      const zoomWheelShortcut = Math.round(webview.getZoomFactor() * 100) === 120;
      document.querySelector("#browser-zoom-out").click();
      await waitFor(() => document.querySelector("#browser-zoom-reset").textContent === "110%", "Zoom wheel smoke did not restore the persisted zoom level");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "9", ctrlKey: true, bubbles: true }));
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === secondTarget, "Ctrl+9 did not activate the last tab");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true }));
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === firstTarget, "Ctrl+1 did not activate the first tab");
      const keyboardTabNumber = true;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", ctrlKey: true, bubbles: true }));
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === secondTarget, "Ctrl+PageDown did not activate the next ordered tab");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", ctrlKey: true, bubbles: true }));
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === firstTarget, "Ctrl+PageUp did not activate the previous ordered tab");
      const keyboardOrderedTab = true;
      document.querySelector("#titlebar-new-tab").click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 3
        && document.querySelector(".browser-tab.active .browser-tab-title")?.textContent === "新建标签页"
        && !document.querySelector("#welcome").hidden, "New-tab button did not open a usable start tab");
      const buttonTabTarget = document.querySelector(".browser-tab.active").dataset.targetId;
      document.querySelector("#current-address").value = "data:text/html," + encodeURIComponent("<title>Button tab</title><h1>Button tab works</h1>");
      document.querySelector("#browser-address-form").requestSubmit();
      try {
        await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === buttonTabTarget
          && document.querySelector(".browser-tab.active .browser-tab-title")?.textContent === "Button tab"
          && document.querySelector("#welcome").hidden, "New tab could not navigate from the address bar");
      } catch (error) {
        throw new Error(String(error.message) + "; debug=" + JSON.stringify({
          buttonTabTarget,
          address: document.querySelector("#current-address")?.value,
          welcomeHidden: document.querySelector("#welcome")?.hidden,
          activeTarget: document.querySelector("webview:not([hidden])")?.dataset.targetId,
          titles: [...document.querySelectorAll(".browser-tab .browser-tab-title")].map((node) => node.textContent),
        }));
      }
      await window.egoDesktop.invoke("smoke.capture");
      document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]').click();
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === firstTarget, "Existing tab could not be restored after using the new-tab button");
      document.querySelector('.browser-tab[data-target-id="' + buttonTabTarget + '"]').click();
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === buttonTabTarget, "New button tab could not be selected again");
      document.querySelector('.browser-tab[data-target-id="' + buttonTabTarget + '"] .browser-tab-close').click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 2
        && !document.querySelector('.browser-tab[data-target-id="' + buttonTabTarget + '"]'), "New button tab could not be closed");
      const newTabButtonFlow = true;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "l", ctrlKey: true, bubbles: true }));
      const keyboardAddressFocus = document.activeElement === document.querySelector("#current-address");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }));
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 3
        && !document.querySelector("#welcome").hidden
        && document.activeElement === document.querySelector("#omnibox")
        && document.querySelector("#current-address").value === "ego://start", "Ctrl+T did not open the welcome tab");
      const keyboardNewTab = true;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true }));
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 2, "Ctrl+W did not close the tab");
      const undoButton = [...document.querySelectorAll(".action-toast button")].at(-1);
      if (!undoButton || undoButton.textContent !== "撤销") throw new Error("Closed-tab undo action was not shown");
      undoButton.click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 3, "Closed-tab undo did not restore the tab");
      const closeUndo = true;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true }));
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 2, "Restored tab could not be closed again");
      const closedUndoConsolidated = document.querySelectorAll(".closed-tabs-toast").length === 1;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true, bubbles: true }));
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 3
        && !document.querySelector("#welcome").hidden
        && document.querySelector("#current-address").value === "ego://start", "Ctrl+Shift+T did not restore the welcome tab");
      const keyboardRestoreTab = true;
      document.querySelector('.browser-tab.active .browser-tab-close').click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 2, "Restored keyboard tab was not cleaned up");
      document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]').click();
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === firstTarget, "First tab was not restored after keyboard smoke");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }));
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 3 && document.querySelector(".browser-tab.active"), "Batch-management tab was not created");
      window.__egoSmokeStage = "batch target";
      const batchTarget = document.querySelector(".browser-tab.active").dataset.targetId;
      const tabManager = document.querySelector("#manage-browser-tabs");
      if (!tabManager) throw new Error("Tab manager control was not rendered");
      window.__egoSmokeStage = "tab overview open";
      tabManager.click();
      await waitFor(() => !document.querySelector("#tab-overview").hidden && document.querySelectorAll(".tab-overview-row").length >= 3, "Tab overview did not open");
      const overviewNeedle = document.querySelector(".tab-overview-row .tab-overview-copy strong").textContent;
      document.querySelector("#tab-overview-query").value = overviewNeedle;
      document.querySelector("#tab-overview-query").dispatchEvent(new Event("input", { bubbles: true }));
      const overviewRows = [...document.querySelectorAll(".tab-overview-row")];
      const tabOverviewUi = overviewRows.length >= 1
        && overviewRows.every((row) => row.textContent.includes(overviewNeedle))
        && document.querySelector("#tab-overview-summary").textContent.includes("/")
        && document.querySelector(".tab-overview-search").classList.contains("has-value")
        && document.querySelector("#manage-browser-tabs").getAttribute("aria-pressed") === "true";
      const overviewClear = document.querySelector("#tab-overview-query-clear");
      if (!overviewClear) throw new Error("Tab overview clear control was not rendered");
      overviewClear.click();
      const tabOverviewClear = document.querySelectorAll(".tab-overview-row").length >= 3
        && !document.querySelector("#tab-overview-summary").textContent.includes("/")
        && document.querySelector("#tab-overview-query").value === "";
      const overviewClose = document.querySelector("#tab-overview-close");
      if (!overviewClose) throw new Error("Tab overview close control was not rendered");
      overviewClose.click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "A", ctrlKey: true, shiftKey: true, bubbles: true }));
      await waitFor(() => !document.querySelector("#tab-overview").hidden, "Ctrl+Shift+A did not open tab overview");
      const tabOverviewShortcut = document.activeElement === document.querySelector("#tab-overview-query");
      const overviewBatch = document.querySelector("#tab-overview-batch");
      if (!overviewBatch) throw new Error("Tab overview batch control was not rendered");
      window.__egoSmokeStage = "tab batch open";
      overviewBatch.click();
      await waitFor(() => !document.querySelector("#tab-batchbar").hidden && document.querySelectorAll(".browser-tab-checkbox").length === 3, "Tab batch mode did not open");
      const batchCheckbox = document.querySelector('.browser-tab[data-target-id="' + batchTarget + '"] .browser-tab-checkbox');
      if (!batchCheckbox) throw new Error('Active batch tab was not rendered: ' + batchTarget + ' / ' + [...document.querySelectorAll('.browser-tab')].map((node) => node.dataset.targetId || 'placeholder').join(','));
      window.__egoSmokeStage = "tab batch select";
      batchCheckbox.click();
      const batchPin = document.querySelector("#tab-batch-pin");
      if (!batchPin) throw new Error("Batch pin control was not rendered");
      batchPin.click();
      await waitFor(() => document.body.dataset.lastBatchUpdate === "pinned:success" && document.querySelector('.browser-tab[data-target-id="' + batchTarget + '"]')?.classList.contains("pinned"), "Batch pin did not update the tab");
      const batchMute = document.querySelector("#tab-batch-mute");
      if (!batchMute) throw new Error("Batch mute control was not rendered");
      batchMute.click();
      await waitFor(() => document.body.dataset.lastBatchUpdate === "muted:success" && document.querySelector('.browser-tab[data-target-id="' + batchTarget + '"] .browser-tab-muted'), "Batch mute did not update the tab");
      const tabBatchPreferences = true;
      const batchClose = document.querySelector("#tab-batch-close");
      if (!batchClose) throw new Error("Batch close control was not rendered");
      window.__egoSmokeStage = "tab batch close";
      batchClose.click();
      await acceptConfirm();
      try {
        await waitFor(() => document.querySelectorAll(".browser-tab").length === 2 && !document.querySelector('.browser-tab[data-target-id="' + batchTarget + '"]'), "Batch close did not remove the selected tab");
      } catch {
        const tabs = [...document.querySelectorAll(".browser-tab")].map((node) => ({
          targetId: node.dataset.targetId,
          active: node.classList.contains("active"),
          selected: node.classList.contains("selected"),
          pinned: node.classList.contains("pinned"),
        }));
        throw new Error("Batch close did not remove the selected tab: " + JSON.stringify({ batchTarget, tabs, confirmOpen: document.querySelector("#confirm-dialog").open, closeState: document.body.dataset.lastBatchClose, toasts: document.querySelector("#toast-stack").textContent }));
      }
      const tabBatchClose = true;
      await waitFor(() => document.body.dataset.lastBatchClose === "success", "Batch close operation did not finish");
      const exitBatchManager = document.querySelector("#manage-browser-tabs");
      if (!exitBatchManager) throw new Error("Tab manager control disappeared after batch close");
      exitBatchManager.click();
      await waitFor(() => document.querySelector('webview[data-target-id]:not([hidden])'), "No visible page after leaving tab management");
      webview = document.querySelector('webview:not([hidden])');
      await window.egoDesktop.invoke("collection.save", { text: "Smoke collection excerpt", sourceUrl: webview.getURL() });
      const browserChatRemoved = document.querySelector(".composer-wrap").hidden
        && document.querySelector("#context-strip").hidden
        && !document.querySelector('.assistant-head .mode[data-mode="chat"]')
        && !document.querySelector('.assistant-head .mode[data-mode="codex"]')
        && document.querySelector(".assistant-title strong")?.textContent === "Agent 活动"
        && !document.querySelector("#operation-toolbar").hidden;
      window.__egoSmokeStage = "agent activity";
      const smokeState = await window.egoDesktop.invoke("state");
      const smokeTask = smokeState.spaces.find((space) => space.name === "Desktop smoke");
      if (!smokeTask) throw new Error("Smoke task was not found before control handoff checks");
      const smokeTaskId = smokeTask?.taskId;
      const initialControlSettings = await window.egoDesktop.invoke("settings.get");
      const controlHandoffDefaultOff = initialControlSettings.controlHandoffEnabled === false
        && document.querySelector("#control-handoff-enabled")?.checked === false
        && document.querySelector("#control-consent-enabled")?.disabled === true;
      let controlHandoffBlocked = false;
      try {
        await window.egoDesktop.invoke("task.takeover", { id: smokeTask.id });
      } catch (error) {
        controlHandoffBlocked = String(error?.message || error).includes("控制权交接功能已关闭");
      }
      if (!controlHandoffBlocked) throw new Error("Disabled control handoff did not reject takeover");
      await window.egoDesktop.invoke("settings.setControlHandoff", { enabled: true });
      document.querySelector('[data-view="settings"]').click();
      await waitFor(() => document.querySelector("#control-handoff-enabled")?.checked === true, "Control handoff could not be enabled for smoke coverage");
      document.querySelector('[data-view="start"]').click();
      const agentIndicator = document.querySelector("#browser-codex");
      const idleIndicatorRect = agentIndicator.getBoundingClientRect();
      const browserContentTop = document.querySelector("#webview-stack").getBoundingClientRect().top;
      const agentIndicatorIdle = agentIndicator.dataset.agentState === "idle"
        && agentIndicator.title.includes("Agent 空闲");
      const smokeAgent = await window.egoDesktop.invoke("smoke.agentStart");
      document.querySelector("#control-panel-open").click();
      await waitFor(() => document.querySelector("#control-panel").open
        && document.querySelector("#control-panel-agents").textContent.includes("Codex Smoke")
        && !document.querySelector("#control-panel-assign").disabled, "Control panel did not show online Agent");
      const controlPanelVisible = document.querySelector("#control-panel").getBoundingClientRect().width > 200;
      document.querySelector("#control-panel-close").click();
      const agentOperationStartedAt = new Date().toISOString();
      await window.egoDesktop.invoke("smoke.agentRecord", { id: "desktop-agent-hud", tool: "ego_click", title: "点击页面元素", status: "running", startedAt: agentOperationStartedAt });
      await waitFor(() => agentIndicator.dataset.agentState === "executing"
        && agentIndicator.title.includes("Codex Smoke")
        && agentIndicator.title.includes("正在点击"), "Agent indicator did not enter the executing state");
      const executingIndicatorRect = agentIndicator.getBoundingClientRect();
      const executingColor = getComputedStyle(agentIndicator).color.match(/\\d+(?:\\.\\d+)?/g)?.slice(0, 3).map(Number) || [];
      const waveformAnimation = getComputedStyle(agentIndicator.querySelector("svg > *")).animationName;
      const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const agentHudVisible = agentIndicator.getClientRects().length > 0
        && executingColor.length === 3 && executingColor[1] > executingColor[0] && executingColor[1] > executingColor[2]
        && (reducedMotion || waveformAnimation.includes("agent-heartbeat"));
      const agentHudName = agentIndicator.title.includes("Codex Smoke");
      const agentHudAction = agentIndicator.title.includes("正在点击");
      const agentHudDuration = /\\d+ 秒/.test(agentIndicator.title);
      const agentIndicatorLayoutStable = Math.abs(document.querySelector("#webview-stack").getBoundingClientRect().top - browserContentTop) < 0.5;
      const agentIndicatorFixedSize = Math.abs(executingIndicatorRect.width - idleIndicatorRect.width) < 0.5
        && Math.abs(executingIndicatorRect.height - idleIndicatorRect.height) < 0.5;
      document.querySelector("#agent-hud-takeover").click();
      await waitFor(() => !document.querySelector("#agent-hud-return")?.hidden, "Takeover did not switch HUD controls");
      const agentHudTakeover = document.querySelector("#agent-hud-return span")?.textContent === "归还控制权";
      document.querySelector("#agent-hud-return").click();
      await waitFor(() => document.querySelector("#agent-hud-takeover")?.hidden === false, "Agent return did not restore control");
      const agentHudReturned = document.querySelector("#agent-hud-takeover")?.hidden === false;
      document.querySelector("#agent-hud-stop").click();
      await acceptConfirm();
      await waitFor(() => agentIndicator.dataset.agentState === "idle", "Stopped Agent did not return the indicator to idle");
      const agentHudStop = agentIndicator.dataset.agentState === "idle";
      await window.egoDesktop.invoke("operation.testRecord", {
        id: "desktop-agent-indicator-failure",
        tool: "ego_click",
        title: "点击页面元素",
        detail: '{"target":"@missing-button"}',
        status: "failed",
        startedAt: agentOperationStartedAt,
        finishedAt: new Date().toISOString(),
      });
      await waitFor(() => agentIndicator.dataset.agentState === "failed", "Agent indicator did not enter the failed state");
      const failedIndicatorColor = getComputedStyle(agentIndicator).color.match(/\\d+(?:\\.\\d+)?/g)?.slice(0, 3).map(Number) || [];
      const failureDot = getComputedStyle(agentIndicator, "::after");
      const agentIndicatorFailure = failedIndicatorColor.length === 3
        && failedIndicatorColor[0] > failedIndicatorColor[1]
        && failedIndicatorColor[0] > failedIndicatorColor[2]
        && failureDot.content !== "none"
        && failureDot.backgroundColor !== "rgba(0, 0, 0, 0)"
        && Number.parseFloat(failureDot.width) >= 4;
      const originalTheme = document.documentElement.dataset.theme;
      const hudThemeChecks = {};
      for (const theme of ["night", "light", "paper"]) {
        const select = document.querySelector("#theme-select");
        select.value = theme;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 40));
        const color = getComputedStyle(agentIndicator).color;
        const rgb = color.match(/\\d+(?:\\.\\d+)?/g)?.slice(0, 3).map(Number) || [];
        const visible = agentIndicator.getClientRects().length > 0;
        hudThemeChecks[theme] = visible && rgb.length === 3 && rgb[0] > rgb[1] && rgb[0] > rgb[2];
      }
      const themeSelect = document.querySelector("#theme-select");
      themeSelect.value = originalTheme || "night";
      themeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      const agentHudThemes = Boolean(hudThemeChecks.night && hudThemeChecks.light && hudThemeChecks.paper);
      await window.egoDesktop.invoke("operation.testRecord", {
        id: "desktop-agent-indicator-failure",
        tool: "ego_click",
        title: "点击页面元素",
        detail: '{"target":"@missing-button"}',
        status: "completed",
        startedAt: agentOperationStartedAt,
        finishedAt: new Date().toISOString(),
      });
      await waitFor(() => agentIndicator.dataset.agentState === "idle", "Completed failure fixture did not reset the indicator");
      document.querySelector("#agent-hud-return").click();
      await waitFor(() => document.querySelector("#agent-hud-takeover")?.hidden === false, "Stopped Agent was not returned");
      document.querySelector("#agent-hud-takeover").click();
      await waitFor(() => document.querySelector("#agent-hud-return")?.hidden === false, "Agent HUD cleanup takeover did not complete");
      await window.egoDesktop.invoke("smoke.agentDisconnect");
      await waitFor(() => document.querySelector("#agent-hud-return span")?.textContent === "允许 Agent 接管", "Disconnected Agent did not expose the pending-return action");
      const offlineReturnButton = document.querySelector("#agent-hud-return");
      const agentHudOfflineReturn = !offlineReturnButton.disabled
        && offlineReturnButton.querySelector("span")?.textContent === "允许 Agent 接管";
      offlineReturnButton.click();
      await waitFor(() => document.querySelector("#agent-hud-return span")?.textContent === "取消等待", "Offline Agent return was not queued");
      const agentHudPendingOffline = document.querySelector("#agent-hud-return")?.disabled === false
        && document.querySelector("#agent-hud-return span")?.textContent === "取消等待";
      await window.egoDesktop.invoke("smoke.agentReconnect");
      await waitFor(() => document.querySelector("#agent-hud-takeover")?.hidden === false, "Reconnected Agent did not automatically reclaim the authorized task");
      const agentHudPendingOnline = document.querySelector("#agent-hud-takeover")?.hidden === false
        && document.querySelector("#agent-hud-return")?.hidden === true;
      document.querySelector("#agent-hud-takeover").click();
      await waitFor(() => document.querySelector("#agent-hud-return")?.hidden === false, "Agent HUD cleanup did not restore user control");
      const operationId = "desktop-operation-smoke";
      const operationStartedAt = new Date().toISOString();
      await window.egoDesktop.invoke("operation.testRecord", { id: operationId, tool: "ego_click", title: "点击页面元素", detail: '{"target":"@button-1"}', status: "running", startedAt: operationStartedAt });
      document.querySelector('.mode[data-mode="operations"]').click();
      await waitFor(() => document.querySelector('.operation-record[data-status="running"]'), "Running Codex operation was not rendered");
      const operationComposerHidden = document.querySelector(".composer-wrap").hidden;
      await window.egoDesktop.invoke("operation.testRecord", { id: operationId, tool: "ego_click", title: "点击页面元素", detail: '{"target":"@button-1"}', status: "completed", startedAt: operationStartedAt, finishedAt: new Date().toISOString() });
      await waitFor(() => document.querySelector('.operation-record[data-status="completed"]'), "Completed Codex operation was not rendered");
      const relatedUrl = document.querySelector('webview:not([hidden])').getURL();
      await window.egoDesktop.invoke("operation.testRecord", { id: "desktop-operation-open", tool: "ego_open", title: "打开网页", detail: JSON.stringify({ url: relatedUrl }), status: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
      await waitFor(() => document.querySelector('.operation-record.actionable'), "Actionable operation record was not rendered");
      document.querySelector("#operation-search").value = "打开网页";
      document.querySelector("#operation-search").dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => document.querySelectorAll(".operation-record").length === 1, "Operation search did not filter records");
      document.querySelector("#operation-status-filter").value = "failed";
      document.querySelector("#operation-status-filter").dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => document.querySelector(".assistant-empty")?.textContent.includes("没有匹配记录"), "Operation status filter did not show empty state");
      document.querySelector("#operation-status-filter").value = "completed";
      document.querySelector("#operation-status-filter").dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector(".operation-record.actionable").click();
      await waitFor(() => document.querySelector('webview:not([hidden])')?.getURL() === relatedUrl, "Operation record did not jump to its related tab");
      const operationFilter = !document.querySelector("#operation-toolbar").hidden && document.querySelectorAll(".operation-record").length === 1;
      const operationJump = true;
      document.querySelector("#operation-search").value = "";
      document.querySelector("#operation-search").dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#operation-status-filter").value = "all";
      document.querySelector("#operation-status-filter").dispatchEvent(new Event("change", { bubbles: true }));
      await window.egoDesktop.invoke("operation.testRecord", { id: "desktop-operation-failed-open", tool: "ego_open", title: "打开失败页面", detail: JSON.stringify({ url: relatedUrl, error: "fixture failure" }), status: "failed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
      await waitFor(() => document.querySelector(".operation-retry"), "Retryable failed operation was not rendered");
      await waitFor(() => document.querySelector(".operation-diagnosis")?.textContent.includes("诊断：执行失败"), "Failed operation diagnosis was not rendered");
      const operationDiagnosis = Boolean(document.querySelector(".operation-diagnosis li"));
      const operationRetryButton = document.querySelector('.operation-record[data-operation-id="desktop-operation-failed-open"] .operation-retry');
      operationRetryButton.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (operationRetryButton.title !== "重试完成") throw new Error("Failed operation retry did not complete: " + operationRetryButton.title + " / " + (document.querySelector("#toast")?.textContent || ""));
      const operationRetry = true;
      document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]').click();
      await waitFor(() => document.querySelector(".operation-day")?.textContent === "今天", "Operation records were not grouped by day");
      const operationCopyButton = document.querySelector('.operation-record[data-operation-id="' + operationId + '"] .operation-copy');
      operationCopyButton.click();
      await waitFor(() => operationCopyButton.title === "已复制", "Operation record copy action did not complete");
      const operationGrouped = true;
      const operationCopy = true;
      const operationPersisted = (await window.egoDesktop.invoke("operation.list", { taskId: smokeTaskId })).some((record) => record.id === operationId && record.status === "completed");
      const localizedOperation = document.querySelector('.operation-record[data-operation-id="' + operationId + '"]');
      const operationLocalized = localizedOperation?.textContent.includes("已完成") && localizedOperation?.textContent.includes("目标");
      const originalTaskRow = [...document.querySelectorAll(".task-row")].find((row) => row.querySelector(".task-name")?.textContent === "Desktop smoke");
      document.querySelector("#new-task").click();
      document.querySelector("#task-name").value = "Operation isolation";
      document.querySelector("#task-form").requestSubmit();
      await waitFor(() => [...document.querySelectorAll(".task-name")].some((node) => node.textContent === "Operation isolation"), "Isolation task was not rendered");
      const isolatedConversation = document.querySelectorAll(".operation-record").length === 0;
      document.querySelector('[data-view="tasks"]').click();
      const renameCard = [...document.querySelectorAll(".task-card")].find((card) => card.textContent.includes("Operation isolation"));
      renameCard?.querySelector(".rename-task").click();
      document.querySelector("#task-rename-name").value = "Operation renamed";
      document.querySelector("#task-rename-form").requestSubmit();
      await waitFor(() => [...document.querySelectorAll("#active-task-select option")].some((option) => option.textContent === "Operation renamed"), "Task rename did not update the task switcher");
      const taskRenamed = true;
      originalTaskRow.click();
      await waitFor(() => document.querySelector('.operation-record[data-operation-id="' + operationId + '"]'), "Original task operations were not restored");
      document.querySelector('[data-view="start"]').click();
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === firstTarget, "Original task tab was not restored after conversation switch");
      document.querySelector('[data-view="tasks"]').click();
      const isolationCard = [...document.querySelectorAll(".task-card")].find((card) => card.textContent.includes("Operation renamed"));
      isolationCard?.querySelector(".task-checkbox").click();
      document.querySelector("#task-batch-close").click();
      await acceptConfirm();
      await waitFor(() => ![...document.querySelectorAll(".task-card")].some((card) => card.textContent.includes("Conversation renamed")), "Task close action did not remove the task");
      const taskClosed = true;
      const taskBatchClose = true;
      document.querySelector("#new-task").click();
      document.querySelector("#task-name").value = "Sidebar delete smoke";
      document.querySelector("#task-form").requestSubmit();
      await waitFor(() => [...document.querySelectorAll(".task-row")].some((row) => row.textContent.includes("Sidebar delete smoke")), "Sidebar delete task was not created");
      const sidebarDeleteRow = [...document.querySelectorAll(".task-row")].find((row) => row.textContent.includes("Sidebar delete smoke"));
      sidebarDeleteRow.querySelector(".delete-task").click();
      await acceptConfirm();
      await waitFor(() => ![...document.querySelectorAll(".task-row")].some((row) => row.textContent.includes("Sidebar delete smoke")), "Sidebar delete action did not remove the task");
      const sidebarDelete = true;
      document.querySelector("#new-task").click();
      document.querySelector("#task-name").value = "Task reorder smoke";
      document.querySelector("#task-form").requestSubmit();
      await waitFor(() => [...document.querySelectorAll(".task-name")].some((node) => node.textContent === "Task reorder smoke"), "Task reorder smoke item was not created");
      const reorderRow = [...document.querySelectorAll(".task-row")].find((row) => row.textContent.includes("Task reorder smoke"));
      const reorderBefore = [...document.querySelectorAll(".task-row")].indexOf(reorderRow);
      reorderRow.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
      await waitFor(() => [...document.querySelectorAll(".task-row")].findIndex((row) => row.textContent.includes("Task reorder smoke")) === reorderBefore - 1, "Task keyboard reorder did not move the task");
      const taskReorder = true;
      [...document.querySelectorAll(".task-row")].find((row) => row.textContent.includes("Task reorder smoke")).querySelector(".delete-task").click();
      await acceptConfirm();
      await waitFor(() => ![...document.querySelectorAll(".task-row")].some((row) => row.textContent.includes("Task reorder smoke")), "Task reorder smoke item was not cleaned up");
      document.querySelector('[data-view="start"]').click();
      document.querySelector("#titlebar-toggle-sidebar").click();
      await waitFor(() => !document.querySelector(".app-shell").classList.contains("sidebar-collapsed"), "Legacy workspace entry did not open the workspace sidebar");
      const sidebarCollapse = document.querySelector("#workspace-sidebar").contains(document.querySelector("#task-list"))
        && !document.querySelector("#workspace-sidebar").querySelector('[data-open-view="settings"]');
      document.querySelector("#titlebar-toggle-sidebar").click();
      document.querySelector('[data-view="settings"]').click();
      await waitFor(() => document.querySelector("#settings-view")?.classList.contains("active")
        && document.querySelector('[data-open-view="agent-settings"]'), "Main settings view did not expose Agent settings");
      document.querySelector('[data-open-view="agent-settings"]').click();
      await waitFor(() => document.querySelector("#agent-settings-view")?.classList.contains("active"), "Agent settings did not open as an independent view");
      await waitFor(() => document.querySelectorAll("#agent-integration-list .agent-integration-row").length > 0, "Settings payload did not finish loading");
      await waitFor(() => document.querySelector("#agent-web-access-enabled")?.checked === true
        && document.querySelector("#agent-silent-downloads-enabled")?.checked === true, "Agent capability settings did not default to enabled");
      const silentDownloadsToggle = document.querySelector("#agent-silent-downloads-enabled");
      silentDownloadsToggle.click();
      let disabledAgentPolicy;
      const disabledAgentPolicyDeadline = Date.now() + 8000;
      do {
        disabledAgentPolicy = await window.egoDesktop.invoke("settings.get");
        if (disabledAgentPolicy.agentSilentDownloadsEnabled === false) break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      } while (Date.now() < disabledAgentPolicyDeadline);
      await waitFor(() => silentDownloadsToggle.disabled === false, "Agent silent download toggle did not finish saving");
      silentDownloadsToggle.click();
      let enabledAgentPolicy;
      const enabledAgentPolicyDeadline = Date.now() + 8000;
      do {
        enabledAgentPolicy = await window.egoDesktop.invoke("settings.get");
        if (enabledAgentPolicy.agentSilentDownloadsEnabled === true) break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      } while (Date.now() < enabledAgentPolicyDeadline);
      const agentPolicySettings = document.querySelector("#agent-settings-view")?.classList.contains("active")
        && disabledAgentPolicy.agentSilentDownloadsEnabled === false
        && enabledAgentPolicy.agentSilentDownloadsEnabled === true
        && enabledAgentPolicy.agentWebAccessEnabled === true
        && Boolean(enabledAgentPolicy.agentDownloadDirectory)
        && document.querySelector("#agent-web-access-label")?.textContent === "已开启"
        && document.querySelector("#agent-silent-downloads-label")?.textContent === "已开启";
      await waitFor(() => document.querySelector("#control-handoff-enabled")?.checked === true
        && document.querySelector("#control-consent-enabled")?.checked === false
        && document.querySelector("#control-consent-level")?.disabled === true, "Control security settings did not default to automatic return");
      const controlConsentDefaultOff = document.querySelector("#control-consent-status")?.textContent.includes("自动恢复");
      document.querySelector("#control-handoff-enabled").click();
      let disabledControlSettings;
      const disabledControlDeadline = Date.now() + 8000;
      do {
        disabledControlSettings = await window.egoDesktop.invoke("settings.get");
        if (disabledControlSettings.controlHandoffEnabled === false) break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      } while (Date.now() < disabledControlDeadline);
      try {
        await waitFor(() => document.querySelector("#control-consent-enabled")?.disabled === true
          && document.querySelector("#control-consent-level")?.disabled === true
          && document.querySelector("#control-consent-status")?.textContent.includes("已关闭")
          && document.querySelector("#agent-hud-takeover")?.hidden === true
          && document.querySelector("#agent-hud-stop")?.hidden === true
          && document.querySelector("#agent-hud-return")?.hidden === true, "Disabling control handoff did not hide and lock its controls");
      } catch {
        const disabledState = await window.egoDesktop.invoke("state");
        throw new Error("Disabled control handoff UI state: " + JSON.stringify({
          disabledControlSettings,
          consentDisabled: document.querySelector("#control-consent-enabled")?.disabled,
          levelDisabled: document.querySelector("#control-consent-level")?.disabled,
          statusText: document.querySelector("#control-consent-status")?.textContent,
          indicatorState: document.querySelector("#browser-codex")?.dataset.agentState,
          indicatorTitle: document.querySelector("#browser-codex")?.title,
          task: disabledState.spaces.find((space) => space.taskId === smokeTaskId),
          agents: disabledState.agents,
        }));
      }
      const controlHandoffToggleOff = disabledControlSettings.controlHandoffEnabled === false;
      let controlHandoffRuntimeBlocked = false;
      try {
        await window.egoDesktop.invoke("task.return", { id: smokeTask.id });
      } catch (error) {
        controlHandoffRuntimeBlocked = String(error?.message || error).includes("控制权交接功能已关闭");
      }
      document.querySelector("#control-handoff-enabled").click();
      let enabledControlSettings;
      const enabledControlDeadline = Date.now() + 8000;
      do {
        enabledControlSettings = await window.egoDesktop.invoke("settings.get");
        if (enabledControlSettings.controlHandoffEnabled === true) break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      } while (Date.now() < enabledControlDeadline);
      await waitFor(() => document.querySelector("#control-consent-enabled")?.disabled === false, "Control handoff could not be re-enabled");
      const controlHandoffToggleOn = enabledControlSettings.controlHandoffEnabled === true;
      document.querySelector("#control-consent-enabled").click();
      await waitFor(() => document.querySelector("#control-consent-enabled")?.checked === true
        && document.querySelector("#control-consent-level")?.disabled === false, "Control security authorization could not be enabled");
      document.querySelector("#control-consent-level").value = "strict";
      document.querySelector("#control-consent-level").dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => document.querySelector("#control-consent-status")?.textContent.includes("每次点击归还控制权"), "Strict control security setting was not applied");
      let savedControlPolicy;
      const controlPolicyDeadline = Date.now() + 8000;
      do {
        savedControlPolicy = await window.egoDesktop.invoke("settings.get");
        if (savedControlPolicy.controlHandoffEnabled === true && savedControlPolicy.controlConsentEnabled === true && savedControlPolicy.controlConsentLevel === "strict") break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      } while (Date.now() < controlPolicyDeadline);
      const controlSecuritySettings = controlConsentDefaultOff
        && controlHandoffToggleOff
        && controlHandoffToggleOn
        && controlHandoffRuntimeBlocked
        && savedControlPolicy.controlHandoffEnabled === true
        && savedControlPolicy.controlConsentEnabled === true
        && savedControlPolicy.controlConsentLevel === "strict"
        && !document.querySelector("#control-consent-level").disabled
        && document.querySelector("#control-consent-status").textContent.includes("必须授权");
      if (!controlSecuritySettings) {
        throw new Error("Control security settings did not persist: " + JSON.stringify({
          controlConsentDefaultOff,
          savedControlPolicy,
          levelDisabled: document.querySelector("#control-consent-level").disabled,
          statusText: document.querySelector("#control-consent-status").textContent,
          toasts: document.querySelector("#toast-stack")?.textContent,
        }));
      }
      document.querySelector('#agent-settings-view [data-open-view="settings"]').click();
      await waitFor(() => document.querySelector("#settings-view")?.classList.contains("active"), "Agent settings could not return to main settings");
      document.querySelector('[data-open-view="scansci-settings"]').click();
      await waitFor(() => document.querySelector("#scansci-settings-view")?.classList.contains("active"), "ScanSci settings did not open as an independent settings view");
      await waitFor(() => document.querySelector("#scansci-channel-state")?.textContent.includes("8 个通道已检查"), "ScanSci settings did not automatically check all channels");
      await waitFor(() => document.querySelector("#scansci-settings-webview")?.getAttribute("src")?.startsWith("data:text/html"), "ScanSci settings webview did not load inside EgoLite");
      const scanSciStatus = await window.egoDesktop.invoke("scansci.status");
      const scanSciSettings = scanSciStatus.online === true
        && scanSciStatus.managed === true
        && document.querySelector("#scansci-owner-state")?.textContent === "EgoLite 托管"
        && document.querySelector("#scansci-settings-view")?.contains(document.querySelector("#scansci-settings-webview"));
      document.querySelector('#scansci-settings-view [data-open-view="settings"]').click();
      await waitFor(() => document.querySelector("#settings-view")?.classList.contains("active"), "ScanSci settings could not return to main settings");
      const scanSciLifecycle = (await window.egoDesktop.invoke("scansci.status")).online === true;
      await waitFor(() => document.querySelectorAll(".site-permission-row").length === 2, "Site permission decisions were not rendered");
      const permissionsList = document.querySelector("#site-permissions-list").textContent.includes("allowed.example")
        && document.querySelector("#site-permissions-list").textContent.includes("blocked.example")
        && document.querySelector("#site-permissions-list").textContent.includes("允许")
        && document.querySelector("#site-permissions-list").textContent.includes("阻止");
      document.querySelector('.site-permission-row [data-permission-action="remove"]').click();
      await waitFor(() => document.querySelectorAll(".site-permission-row").length === 1, "Single site permission was not removed");
      const permissionRemove = true;
      document.querySelector("#clear-site-permissions").click();
      await acceptConfirm();
      await waitFor(() => document.querySelectorAll(".site-permission-row").length === 0, "Site permissions were not cleared");
      const permissionClear = document.querySelector("#site-permissions-list").textContent.includes("没有已保存");
      document.querySelector("#import-browser-data").click();
      await waitFor(() => document.querySelector('.browser-source-row [data-profile-id="chrome:Default"]'), "Browser import profile was not discovered");
      const browserImportProfile = document.querySelector('.browser-source-row')?.textContent.includes("Smoke Profile");
      const browserImportBrave = Boolean(document.querySelector('.browser-source-row [data-profile-id="brave:Profile 1"]'));
      document.querySelector("#onboarding-import").click();
      await waitFor(() => document.querySelector("#browser-import-status").textContent.includes("2 个书签、2 条历史记录"), "Browser data was not imported");
      const browserImportResult = !document.querySelector("#browser-import-status").textContent.includes("跳过");
      document.querySelector("#onboarding-close").click();
      document.querySelector('[data-view="library"]').click();
      await waitFor(() => [...document.querySelectorAll(".collection-row")].some((node) => node.textContent.includes("Imported smoke bookmark")), "Imported bookmark was not shown in Library");
      const browserImportLibrary = ![...document.querySelectorAll(".collection-row")].some((node) => node.textContent.includes("Imported smoke history"));
      const browserImportBraveLibrary = [...document.querySelectorAll(".collection-row")].some((node) => node.textContent.includes("Imported Brave bookmark"))
        && ![...document.querySelectorAll(".collection-row")].some((node) => node.textContent.includes("Imported Brave history"));
      const braveBookmarkRow = [...document.querySelectorAll(".collection-row")].find((node) => node.textContent.includes("Imported Brave bookmark"));
      braveBookmarkRow?.querySelector('[title="编辑"]').click();
      document.querySelector("#collection-edit-title").value = "Edited Brave title";
      document.querySelector("#collection-edit-tags").value = "AI, Windows";
      document.querySelector("#collection-edit-text").value = "Edited Brave collection body";
      document.querySelector("#collection-edit-form").requestSubmit();
      await waitFor(() => [...document.querySelectorAll(".collection-row")].some((node) => node.textContent.includes("Edited Brave title") && node.textContent.includes("Edited Brave collection body") && node.textContent.includes("Windows")), "Collection edit was not saved");
      const collectionEdited = true;
      document.querySelector("#collection-tag-filter").value = "Windows";
      document.querySelector("#collection-tag-filter").dispatchEvent(new Event("change", { bubbles: true }));
      const collectionTags = document.querySelectorAll(".collection-row").length === 1 && document.querySelector(".collection-row").textContent.includes("Edited Brave title");
      document.querySelector("#collection-tag-filter").value = "";
      document.querySelector("#collection-tag-filter").dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("#collection-sort").value = "title";
      document.querySelector("#collection-sort").dispatchEvent(new Event("change", { bubbles: true }));
      const sortedTitles = [...document.querySelectorAll(".collection-title-row strong")].map((node) => node.textContent);
      const collectionSorting = sortedTitles.join("|") === [...sortedTitles].sort((left, right) => left.localeCompare(right, "zh-CN")).join("|");
      let bookmarkRow = [...document.querySelectorAll(".collection-row")].find((node) => node.textContent.includes("Imported smoke bookmark"));
      let editedBookmarkRow = [...document.querySelectorAll(".collection-row")].find((node) => node.textContent.includes("Edited Brave title"));
      bookmarkRow?.querySelector('.collection-checkbox').click();
      editedBookmarkRow?.querySelector('.collection-checkbox').click();
      if (!document.querySelector("#collection-batch-move") || document.querySelector("#collection-batch-move").disabled) throw new Error("Collection batch move was not enabled");
      document.querySelector("#collection-batch-move").click();
      document.querySelector("#collection-group-name").value = "Research";
      document.querySelector("#collection-group-form").requestSubmit();
      await waitFor(() => ["Imported smoke bookmark", "Edited Brave title"].every((title) => [...document.querySelectorAll(".collection-row")].some((node) => node.textContent.includes(title) && node.textContent.includes("Research"))), "Collection batch group was not saved");
      const collectionGrouped = [...document.querySelector("#collection-group-filter").options].some((option) => option.value === "Research");
      document.querySelector("#collection-group-filter").value = "Research";
      document.querySelector("#collection-group-filter").dispatchEvent(new Event("change", { bubbles: true }));
      const collectionFiltered = [...document.querySelectorAll(".collection-row")].every((node) => node.textContent.includes("Research"));
      const collectionExportResult = await window.egoDesktop.invoke("collection.export", { format: "markdown", group: "Research", testPath: ${JSON.stringify(collectionExportSmokePath)} });
      const bookmarkExportResult = await window.egoDesktop.invoke("collection.export", { format: "bookmarks-html", group: "Research", testPath: ${JSON.stringify(bookmarkExportSmokePath)} });
      document.querySelector("#collection-group-filter").value = "";
      document.querySelector("#collection-group-filter").dispatchEvent(new Event("change", { bubbles: true }));
      bookmarkRow = [...document.querySelectorAll(".collection-row")].find((node) => node.textContent.includes("Imported smoke bookmark"));
      editedBookmarkRow = [...document.querySelectorAll(".collection-row")].find((node) => node.textContent.includes("Edited Brave title"));
      if (bookmarkRow?.querySelector('.collection-checkbox').checked) bookmarkRow.querySelector('.collection-checkbox').click();
      if (!editedBookmarkRow?.querySelector('.collection-checkbox').checked) editedBookmarkRow?.querySelector('.collection-checkbox').click();
      if (document.querySelector("#collection-batch-delete").disabled) throw new Error("Collection batch delete was not enabled");
      document.querySelector("#collection-batch-delete").click();
      await acceptConfirm();
      await waitFor(() => ![...document.querySelectorAll(".collection-row")].some((node) => node.textContent.includes("Edited Brave title")), "Collection was not deleted");
      const collectionDeleted = true;
      await window.egoDesktop.invoke("collection.save", { text: "Duplicate excerpt one", sourceUrl: "https://duplicate.example/page" });
      await window.egoDesktop.invoke("collection.save", { text: "Duplicate excerpt two", sourceUrl: "https://duplicate.example/page" });
      document.querySelector("#refresh").click();
      await waitFor(() => [...document.querySelectorAll(".collection-row")].filter((node) => node.textContent.includes("Duplicate excerpt")).length === 2, "Duplicate collection fixtures were not rendered");
      document.querySelector("#find-collection-duplicates").click();
      await waitFor(() => document.querySelector("#collection-duplicates-dialog").open && document.querySelector(".duplicate-group"), "Duplicate collection dialog did not find a group");
      document.querySelector("#collection-duplicates-form").requestSubmit();
      await waitFor(() => [...document.querySelectorAll(".collection-row")].filter((node) => node.textContent.includes("Duplicate excerpt")).length === 1, "Duplicate collections were not merged");
      const collectionDuplicates = true;
      const collectionImportResult = await window.egoDesktop.invoke("collection.importFile", { testPath: ${JSON.stringify(collectionImportSmokePath)} });
      document.querySelector("#refresh").click();
      await waitFor(() => [...document.querySelectorAll(".collection-row")].some((node) => node.textContent.includes("Imported file collection") && node.textContent.includes("文件导入")), "Collection file import was not rendered");
      const collectionFileImport = collectionImportResult.added === 1;
      const savedPageRow = [...document.querySelectorAll(".collection-row")].find((node) => node.textContent.includes("Smoke collection excerpt"));
      const openCollectionButton = savedPageRow?.querySelector('[title="打开来源"]');
      if (!openCollectionButton) throw new Error("Collection open-source action was not rendered");
      const duplicateTargetBefore = secondTarget;
      const duplicateUrlBefore = document.querySelector('webview[data-target-id="' + secondTarget + '"]')?.getURL();
      if (!duplicateUrlBefore) throw new Error("Existing page URL could not be resolved for duplicate-open smoke");
      const duplicateTabCountBefore = document.querySelectorAll(".browser-tab").length;
      document.querySelector("#omnibox").value = duplicateUrlBefore;
      document.querySelector("#omnibox-form").requestSubmit();
      try {
        await waitFor(() => document.querySelectorAll(".browser-tab").length === duplicateTabCountBefore
          && document.querySelector('webview:not([hidden])')?.dataset.targetId === duplicateTargetBefore
          && document.querySelector("#toast-stack").textContent.includes("已经打开"), "Existing page was not reused");
      } catch {
        const duplicateState = await window.egoDesktop.invoke("state");
        throw new Error("Duplicate open state: " + JSON.stringify({
          duplicateUrlBefore,
          duplicateTargetBefore,
          activeTarget: document.querySelector('webview:not([hidden])')?.dataset.targetId,
          countBefore: duplicateTabCountBefore,
          countAfter: document.querySelectorAll(".browser-tab").length,
          behavior: document.querySelector("#duplicate-open-behavior").value,
          urls: duplicateState.tabs.map((tab) => ({ targetId: tab.targetId, url: tab.url })),
          toast: document.querySelector("#toast-stack").textContent,
        }));
      }
      const duplicateOpenInterception = true;
      document.querySelector("#duplicate-open-behavior").value = "allow";
      document.querySelector("#duplicate-open-behavior").dispatchEvent(new Event("change", { bubbles: true }));
      const tabCountBeforeCollectionOpen = document.querySelectorAll(".browser-tab").length;
      const targetBeforeCollectionOpen = document.querySelector('webview:not([hidden])')?.dataset.targetId;
      openCollectionButton.click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === tabCountBeforeCollectionOpen + 1
        && document.querySelector('webview:not([hidden])')
        && document.querySelector('webview:not([hidden])').dataset.targetId !== targetBeforeCollectionOpen, "Collection source did not open");
      const collectionOpenSource = true;
      window.__egoSmokeStage = "collection source target";
      const collectionSourceTarget = document.querySelector('webview:not([hidden])').dataset.targetId;
      document.querySelector('.browser-tab[data-target-id="' + collectionSourceTarget + '"] .browser-tab-close').click();
      await waitFor(() => !document.querySelector('.browser-tab[data-target-id="' + collectionSourceTarget + '"]'), "Collection source tab did not close");
      document.querySelector("#duplicate-open-behavior").value = "reuse";
      document.querySelector("#duplicate-open-behavior").dispatchEvent(new Event("change", { bubbles: true }));
      const restoredFirstTab = document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]');
      if (!restoredFirstTab) throw new Error("First tab button disappeared after collection source close");
      restoredFirstTab.click();
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === firstTarget, "First tab was not restored after collection source close");
      document.querySelector('[data-view="library"]').click();
      document.querySelector('[data-view="start"]').click();
      webview = document.querySelector('webview:not([hidden])');
      const extraTabIds = [...document.querySelectorAll(".browser-tab")]
        .map((tab) => tab.dataset.targetId)
        .filter((targetId) => targetId && targetId !== firstTarget);
      for (const targetId of extraTabIds) {
        document.querySelector('.browser-tab[data-target-id="' + targetId + '"] .browser-tab-close')?.click();
        await waitFor(() => !document.querySelector('.browser-tab[data-target-id="' + targetId + '"]'), "Extra tab was not closed: " + targetId);
      }
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 1, "Extra tabs were not closed");
      const closeTab = document.querySelectorAll(".browser-tab").length === 1;
      document.querySelector("#omnibox").value = ${JSON.stringify(historyFixtureUrl)};
      document.querySelector("#omnibox-form").requestSubmit();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 2 && document.querySelector('webview:not([hidden])'), "History fixture tab was not created");
      const historyTarget = document.querySelector('webview:not([hidden])');
      await waitForWebviewReady(historyTarget, "History fixture webview did not become automation-ready");
      window.__egoSmokeStage = "history fixture target";
      await waitFor(() => historyTarget.getURL().startsWith(${JSON.stringify(historyFixtureUrl)}), "History fixture page was not opened");
      if (document.querySelector("#history-panel").hidden) document.querySelector("#browser-history").click();
      await waitFor(() => !document.querySelector("#history-panel").hidden && document.querySelector("#history-list").textContent.includes("127.0.0.1"), "Website visit history was not recorded");
      document.querySelector("#history-close").click();
      await waitFor(() => document.querySelector("#history-panel").hidden, "History close button did not close the panel");
      document.querySelector("#browser-history").click();
      await waitFor(() => !document.querySelector("#history-panel").hidden, "History panel did not reopen after close");
      const historyClose = true;
      document.querySelector("#history-search").value = "127.0.0.1";
      document.querySelector("#history-search").dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => document.querySelectorAll(".history-row").length >= 1, "Website history search did not find the fixture visit");
      const websiteHistory = Boolean(document.querySelector('[data-history-action="open"]') && document.querySelector(".history-day"));
      document.querySelector("#history-search").value = "";
      document.querySelector("#history-search").dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#browser-history").click();
      window.__egoSmokeStage = "history target close";
      document.querySelector('.browser-tab[data-target-id="' + historyTarget.dataset.targetId + '"] .browser-tab-close').click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 1, "History fixture tab was not closed");
      document.querySelector("#browser-history").click();
      document.querySelector('[data-history-mode="closed"]').click();
      await waitFor(() => !document.querySelector("#history-panel").hidden && document.querySelector(".history-row"), "Recently closed panel did not render a closed tab");
      document.querySelector('.history-row [data-history-action="restore"]').click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 2, "Recently closed tab was not restored");
      const historyRestore = true;
      document.querySelector('.browser-tab.active .browser-tab-close').click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 1, "Restored history tab was not closed again");
      document.querySelector("#omnibox").value = "data:text/html," + encodeURIComponent("<title>Replacement tab</title><h1>Replacement</h1>");
      document.querySelector("#omnibox-form").requestSubmit();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 2, "Replacement tab was not created");
      document.querySelectorAll(".browser-tab")[0].click();
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === firstTarget, "First tab was not restored after close");
      webview = document.querySelector('webview:not([hidden])');
      await waitForWebviewReady(webview, "Restored webview did not become automation-ready");
      let firstTabButton = document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]');
      firstTabButton.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 80 }));
      document.querySelector('[data-tab-action="pin"]').click();
      await waitFor(() => document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]')?.classList.contains("pinned"), "Tab was not pinned");
      firstTabButton = document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]');
      firstTabButton.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 80 }));
      document.querySelector('[data-tab-action="mute"]').click();
      await waitFor(() => webview.isAudioMuted() && document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"] .browser-tab-muted'), "Tab was not muted");
      const tabPinned = document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]').classList.contains("pinned");
      const tabMuted = Boolean(document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"] .browser-tab-muted'));
      firstTabButton = document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]');
      firstTabButton.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 80 }));
      document.querySelector('[data-tab-action="duplicate"]').click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 3 && document.querySelector('webview:not([hidden])'), "Tab was not duplicated");
      const tabDuplicate = document.querySelectorAll(".browser-tab").length === 3;
      window.__egoSmokeStage = "duplicate target";
      const duplicateTarget = document.querySelector('webview:not([hidden])').dataset.targetId;
      document.querySelector('.browser-tab[data-target-id="' + duplicateTarget + '"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 150, clientY: 82 }));
      document.querySelector('[data-tab-action="duplicate"]').click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 4, "A second duplicate tab was not created");
      const newestDuplicateTarget = document.querySelector('webview:not([hidden])').dataset.targetId;
      document.querySelector("#manage-browser-tabs").click();
      document.querySelector('[data-tab-overview-mode="duplicates"]').click();
      await waitFor(() => document.querySelectorAll(".tab-overview-row").length === 3 && !document.querySelector("#tab-overview-close-duplicates").hidden, "Duplicate overview did not identify repeated tabs");
      document.querySelector("#tab-overview-close-duplicates").click();
      try {
        await waitFor(() => document.querySelectorAll(".browser-tab").length === 3 && !document.querySelector('.browser-tab[data-target-id="' + duplicateTarget + '"]'), "Duplicate cleanup did not preserve the current and pinned tabs");
      } catch {
        throw new Error("Duplicate cleanup state: " + JSON.stringify({
          duplicateTarget,
          newestDuplicateTarget,
          current: document.querySelector(".browser-tab.active")?.dataset.targetId,
          tabs: [...document.querySelectorAll(".browser-tab")].map((node) => ({ id: node.dataset.targetId, pinned: node.classList.contains("pinned"), title: node.textContent })),
          overviewRows: [...document.querySelectorAll(".tab-overview-row")].map((node) => node.dataset.tabOverviewTarget),
          toasts: document.querySelector("#toast-stack").textContent,
        }));
      }
      const duplicateRecognition = true;
      document.querySelector('.browser-tab[data-target-id="' + newestDuplicateTarget + '"] .browser-tab-close').click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 2, "Newest duplicate tab was not cleaned up");
      const replacementTarget = [...document.querySelectorAll(".browser-tab[data-target-id]")].find((node) => node.dataset.targetId !== firstTarget)?.dataset.targetId;
      if (!replacementTarget) throw new Error("Replacement tab could not be resolved for grouping smoke");
      let replacementButton = document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]');
      replacementButton.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 160, clientY: 84 }));
      document.querySelector('[data-tab-action="group"]').click();
      await waitFor(() => document.querySelector("#tab-group-dialog").open, "Tab group dialog did not open");
      document.querySelector("#tab-group-name").value = "Smoke research";
      document.querySelector('[data-tab-group-color="#668b72"]').click();
      document.querySelector("#tab-group-form").requestSubmit();
      await waitFor(() => document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]')?.classList.contains("grouped"), "Tab was not added to a group");
      const tabGrouping = Boolean(document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"] .browser-tab-group-mark'));
      let groupChip = document.querySelector(".browser-tab-group-chip");
      if (!groupChip) throw new Error("Tab group chip was not rendered");
      groupChip.click();
      await waitFor(() => document.querySelector(".browser-tab-group-chip.collapsed") && !document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]'), "Tab group did not collapse");
      document.querySelector(".browser-tab-group-chip").click();
      await waitFor(() => document.querySelector(".browser-tab-group-chip.expanded") && document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]'), "Tab group did not expand");
      const tabGroupCollapse = true;
      replacementButton = document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]');
      replacementButton.dispatchEvent(new PointerEvent("pointerenter"));
      await waitFor(() => !document.querySelector("#tab-hover-preview").hidden && document.querySelector("#tab-hover-preview strong").textContent.length > 0, "Tab hover preview did not open");
      const tabHoverPreview = true;
      const previewBackend = (await window.egoDesktop.invoke("state")).backend?.kind;
      if (previewBackend === "desktop") {
        await waitFor(() => {
          const image = document.querySelector("#tab-hover-preview img");
          return image && !image.hidden && image.src.startsWith("data:image/");
        }, "Tab hover preview did not capture the Chromium page thumbnail");
      }
      const tabHoverThumbnail = true;
      replacementButton.dispatchEvent(new PointerEvent("pointerleave"));
      document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]').click();
      groupChip = document.querySelector(".browser-tab-group-chip");
      groupChip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 160, clientY: 84 }));
      document.querySelector('[data-tab-action="group-sleep"]').click();
      await waitFor(() => document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]')?.classList.contains("sleeping") && !document.querySelector('webview[data-target-id="' + replacementTarget + '"]'), "Sleeping tab did not release its webview");
      const tabGroupActions = true;
      document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]').click();
      await waitFor(() => !document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]')?.classList.contains("sleeping") && document.querySelector('webview[data-target-id="' + replacementTarget + '"]'), "Sleeping tab did not wake on activation");
      await waitForWebviewReady(document.querySelector('webview[data-target-id="' + replacementTarget + '"]'), "Woken tab did not become ready before automatic sleep smoke");
      const tabSleeping = true;
      document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]').click();
      const realDateNow = Date.now;
      Date.now = () => realDateNow() + 16 * 60 * 1000;
      document.querySelector("#auto-sleep-minutes").value = "15";
      document.querySelector("#auto-sleep-minutes").dispatchEvent(new Event("change", { bubbles: true }));
      try {
        await waitFor(() => document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]')?.classList.contains("sleeping"), "Idle tab was not automatically put to sleep");
      } catch {
        const candidate = (await window.egoDesktop.invoke("state")).tabs.find((tab) => tab.targetId === replacementTarget);
        const candidateWebview = document.querySelector('webview[data-target-id="' + replacementTarget + '"]');
        const formFields = await candidateWebview.executeJavaScript('[...document.querySelectorAll("input, textarea, select")].map((field) => ({ tag: field.tagName, type: field.type, value: field.value, defaultValue: field.defaultValue, checked: field.checked, defaultChecked: field.defaultChecked }))');
        throw new Error("Auto sleep state: " + JSON.stringify({
          replacementTarget,
          currentTarget: document.querySelector(".browser-tab.active")?.dataset.targetId,
          candidate,
          setting: document.querySelector("#auto-sleep-minutes").value,
          status: document.querySelector("#tab-behavior-status").textContent,
          hasWebview: Boolean(document.querySelector('webview[data-target-id="' + replacementTarget + '"]')),
          formFields,
        }));
      }
      Date.now = realDateNow;
      document.querySelector("#auto-sleep-minutes").value = "30";
      document.querySelector("#auto-sleep-minutes").dispatchEvent(new Event("change", { bubbles: true }));
      const automaticTabSleeping = true;
      document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]').click();
      await waitFor(() => !document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]')?.classList.contains("sleeping") && document.querySelector('webview[data-target-id="' + replacementTarget + '"]'), "Automatically sleeping tab did not wake on activation");
      const resources = await window.egoDesktop.invoke("resources.snapshot");
      const adaptiveResourceManagement = Number.isFinite(resources.totalWorkingSetBytes)
        && Array.isArray(resources.tabs)
        && Boolean(document.querySelector("#resource-policy"))
        && Boolean(document.querySelector("#release-idle-memory"));
      document.querySelector('[data-view="tasks"]').click();
      document.querySelector("#save-workspace-snapshot").click();
      await waitFor(() => document.querySelector("#workspace-snapshot-dialog").open, "Workspace snapshot dialog did not open");
      document.querySelector("#workspace-snapshot-name").value = "Smoke workspace snapshot";
      document.querySelector("#workspace-snapshot-form").requestSubmit();
      await waitFor(() => document.querySelector(".workspace-snapshot-card")?.textContent.includes("Smoke workspace snapshot"), "Workspace snapshot was not saved");
      const workspaceSnapshots = true;
      document.querySelector('[data-snapshot-action="delete"]').click();
      await acceptConfirm();
      await waitFor(() => !document.querySelector(".workspace-snapshot-card"), "Workspace snapshot was not deleted");
      document.querySelector('[data-view="start"]').click();
      replacementButton = document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]');
      replacementButton.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 160, clientY: 84 }));
      document.querySelector('[data-tab-action="pin"]').click();
      await waitFor(() => document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]')?.classList.contains("pinned"), "Second tab was not pinned for protection smoke");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }));
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 3, "Protection smoke tab was not created");
      document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 80 }));
      const closeRightButton = document.querySelector('[data-tab-action="close-right"]');
      if (closeRightButton.disabled) throw new Error("Close-right action was unexpectedly disabled");
      closeRightButton.click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 2 && document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]')?.classList.contains("pinned"), "Close-right removed a pinned tab");
      const closeRightPinnedProtection = true;
      document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]').click();
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === firstTarget, "Pinned tab was not restored after duplicate close");
      webview = document.querySelector('webview:not([hidden])');
      await waitForWebviewReady(webview, "Pinned webview did not become automation-ready");
      const directFill = await webview.executeJavaScript("document.querySelector('input').value") === "Ego";
      if (document.querySelector("#history-panel").hidden) document.querySelector("#browser-history").click();
      await waitFor(() => !document.querySelector("#history-panel").hidden && document.querySelector(".history-row"), "Recently closed history did not persist during the session");
      document.querySelector("#history-clear").click();
      await acceptConfirm();
      await waitFor(() => document.querySelector("#history-list").textContent.includes("没有最近关闭"), "Recently closed history was not cleared");
      const historyClear = true;
      replacementButton = document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]');
      replacementButton.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 160, clientY: 84 }));
      document.querySelector('[data-tab-action="pin"]').click();
      await waitFor(() => !document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]')?.classList.contains("pinned"), "Grouped tab was not unpinned before persistence smoke");
      replacementButton = document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]');
      replacementButton.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 160, clientY: 84 }));
      document.querySelector('[data-tab-action="sleep"]').click();
      await waitFor(() => document.querySelector('.browser-tab[data-target-id="' + replacementTarget + '"]')?.classList.contains("sleeping") && !document.querySelector('webview[data-target-id="' + replacementTarget + '"]'), "Grouped sleeping tab was not prepared for restore smoke");
      const sleepingPersistencePrepared = true;

      window.__egoSmokeStage = "credential save and autofill";
      document.querySelector("#omnibox").value = ${JSON.stringify(credentialFixtureUrl)};
      document.querySelector("#omnibox-form").requestSubmit();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 3
        && document.querySelector('webview:not([hidden])')?.getURL() === ${JSON.stringify(credentialFixtureUrl)}, "Credential fixture tab was not opened");
      const credentialWebview = document.querySelector('webview:not([hidden])');
      const credentialTarget = credentialWebview.dataset.targetId;
      await waitForWebviewReady(credentialWebview, "Credential fixture did not become ready");
      await waitFor(() => document.querySelector("#browser-passwords")?.classList.contains("active"), "Credential form was not detected");
      await credentialWebview.executeJavaScript('(() => { const set = (selector, value) => { const field = document.querySelector(selector); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; if (setter) setter.call(field, value); else field.value = value; field.dispatchEvent(new InputEvent("input", { bubbles: true, data: value })); }; set("#login-username", "smoke-user"); set("#login-password", "smoke-password"); document.querySelector("#login-form").requestSubmit(); return true; })()');
      await waitFor(() => document.querySelector("#credential-save-dialog")?.open, "Credential save dialog did not open");
      const credentialPromptCaptured = document.querySelector("#credential-save-username").value === "smoke-user"
        && document.querySelector("#credential-save-password").value === "smoke-password"
        && document.querySelector("#credential-save-origin").textContent === ${JSON.stringify(fixtureOrigin)};
      document.querySelector("#credential-save-form").requestSubmit();
      await waitFor(() => !document.querySelector("#credential-save-dialog")?.open
        && document.querySelector("#settings-credential-count")?.textContent === "1 条", "Credential was not saved");
      await credentialWebview.executeJavaScript('(() => { const set = (selector, value) => { const field = document.querySelector(selector); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; if (setter) setter.call(field, value); else field.value = value; field.dispatchEvent(new InputEvent("input", { bubbles: true, data: value })); }; set("#login-username", ""); set("#login-password", ""); return true; })()');
      await waitForWebviewValue(credentialWebview, 'document.querySelector("#login-username")?.value === "smoke-user" && document.querySelector("#login-password")?.value === "smoke-password"', "Saved credential was not automatically filled");
      const credentialAutoFill = true;

      const credentialReloadReady = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Credential fixture reload timed out")), 8000);
        credentialWebview.addEventListener("dom-ready", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      credentialWebview.reload();
      await credentialReloadReady;
      await waitForWebviewValue(credentialWebview, 'document.querySelector("#login-username")?.value === "smoke-user" && document.querySelector("#login-password")?.value === "smoke-password"', "Saved credential was not automatically filled after reload");
      const credentialReloadAutoFill = true;

      const autofillToggle = document.querySelector("#password-autofill-enabled");
      autofillToggle.checked = false;
      autofillToggle.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => document.querySelector("#password-autofill-label")?.textContent === "已关闭", "Autofill setting did not turn off");
      await credentialWebview.executeJavaScript('(() => { const set = (selector, value) => { const field = document.querySelector(selector); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; if (setter) setter.call(field, value); else field.value = value; field.dispatchEvent(new InputEvent("input", { bubbles: true, data: value })); }; set("#login-username", "smoke-second"); set("#login-password", "second-password"); document.querySelector("#login-form").requestSubmit(); return true; })()');
      await waitFor(() => document.querySelector("#credential-save-dialog")?.open, "Second credential save dialog did not open");
      document.querySelector("#credential-save-form").requestSubmit();
      await waitFor(() => !document.querySelector("#credential-save-dialog")?.open
        && document.querySelector("#settings-credential-count")?.textContent === "2 条", "Second credential was not saved");
      document.querySelector("#browser-passwords").click();
      await waitFor(() => !document.querySelector("#credentials-panel").hidden
        && document.querySelectorAll(".credential-panel-row").length === 2, "Credential picker did not show both accounts");
      const credentialPanelRect = document.querySelector("#credentials-panel").getBoundingClientRect();
      const credentialPanelUi = credentialPanelRect.width > 0 && credentialPanelRect.height > 0
        && credentialPanelRect.left >= 0 && credentialPanelRect.right <= innerWidth
        && [...document.querySelectorAll(".credential-panel-row strong")].some((node) => node.textContent === "smoke-user")
        && [...document.querySelectorAll(".credential-panel-row strong")].some((node) => node.textContent === "smoke-second");
      await credentialWebview.executeJavaScript('(() => { document.querySelector("#login-username").value = ""; document.querySelector("#login-password").value = ""; return true; })()');
      const firstCredentialRow = [...document.querySelectorAll(".credential-panel-row")].find((row) => row.querySelector("strong")?.textContent === "smoke-user");
      firstCredentialRow.querySelector("[data-credential-fill]").click();
      await waitForWebviewValue(credentialWebview, 'document.querySelector("#login-username")?.value === "smoke-user" && document.querySelector("#login-password")?.value === "smoke-password"', "Credential account switch did not fill the selected account");
      const credentialAccountSwitch = true;

      autofillToggle.checked = true;
      autofillToggle.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => document.querySelector("#password-autofill-label")?.textContent === "已开启", "Autofill setting did not turn back on");
      document.querySelector('[data-view="settings"]').click();
      await waitFor(() => document.querySelectorAll("#credential-settings-list .credential-settings-row").length === 2, "Credential settings did not render saved accounts");
      document.querySelector("#credential-settings-list [data-credential-action=edit]").click();
      await waitFor(() => document.querySelector("#credential-save-dialog")?.open
        && Boolean(document.querySelector("#credential-save-password")?.value), "Credential editor did not reveal the selected record");
      const credentialSettingsUi = document.querySelector("#credential-profile-filter").value === "default"
        && document.querySelector("#credential-save-title").textContent === "更新密码";
      document.querySelector("#credential-save-cancel").click();
      const isolatedCredentials = await window.egoDesktop.invoke("credentials.list", { profileId: "credential-isolated-smoke" });
      const credentialProfileIsolation = Array.isArray(isolatedCredentials) && isolatedCredentials.length === 0;
      document.querySelector('[data-view="start"]').click();
      document.querySelector('.browser-tab[data-target-id="' + credentialTarget + '"] .browser-tab-close').click();
      await waitFor(() => document.querySelectorAll(".browser-tab").length === 2
        && !document.querySelector('.browser-tab[data-target-id="' + credentialTarget + '"]'), "Credential fixture tab was not closed");
      document.querySelector('.browser-tab[data-target-id="' + firstTarget + '"]').click();
      await waitFor(() => document.querySelector('webview:not([hidden])')?.dataset.targetId === firstTarget, "Original tab was not restored after credential smoke");

      const requiredControls = ["#workspace-quick-switch", "#titlebar-new-tab", "#browser-address-form", ".assistant-panel", ".assistant-modes"]
        .map((selector) => document.querySelector(selector));
      const controlsInViewport = requiredControls.every((node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      });
      const primaryHitTargets = [...document.querySelectorAll(".rail-button, .icon-button, .mode")].filter((node) => {
        const rect = node.getBoundingClientRect();
        return !node.hidden && getComputedStyle(node).display !== "none" && rect.width > 0 && rect.height > 0;
      });
      const usableHitTargets = primaryHitTargets.every((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width >= 26 && rect.height >= 26;
      });
      window.__egoSmokeStage = "result assembly";
      return {
        connected: document.querySelector("#connection").textContent,
        taskCreated: [...document.querySelectorAll(".task-name")].some((node) => node.textContent === "Desktop smoke"),
        tabOpened: document.querySelector("#current-address").value.startsWith("data:text/html"),
        tasksVisible,
        libraryVisible,
        appMenuNavigation,
        operationOnlyUi,
        assistantCollapse,
        newTabChrome,
        workspaceQuickSwitchUi,
        browserChatRemoved,
        operationRecorded: Boolean(document.querySelector('.mode[data-mode="operations"]')),
        agentHudVisible,
        agentHudName,
        agentHudAction,
        agentHudDuration,
        agentIndicatorIdle,
        agentIndicatorLayoutStable,
        agentIndicatorFixedSize,
        agentIndicatorFailure,
        agentHudTakeover,
        agentHudReturned,
        agentHudStop,
        agentHudThemes,
        agentHudOfflineReturn,
        agentHudPendingOffline,
        agentHudPendingOnline,
        controlHandoffDefaultOff,
        controlHandoffBlocked,
        controlHandoffToggleOff,
        controlHandoffToggleOn,
        controlHandoffRuntimeBlocked,
        controlSecuritySettings,
        agentPolicySettings,
        scanSciSettings,
        scanSciLifecycle,
        smokeTaskId,
        controlPanelVisible,
        operationComposerHidden,
        operationPersisted,
        operationLocalized,
        operationFilter,
        operationJump,
        operationGrouped,
        operationCopy,
        operationRetry,
        operationDiagnosis,
        operationIsolated: isolatedConversation,
        taskRenamed,
        taskClosed,
        taskBatchClose,
        taskReorder,
        sidebarDelete,
        sidebarCollapse,
        browserImportProfile,
        browserImportBrave,
        browserImportResult,
        browserImportLibrary,
        browserImportBraveLibrary,
        collectionEdited,
        collectionTags,
        collectionSorting,
        collectionGrouped,
        collectionFiltered,
        collectionDeleted,
        collectionDuplicates,
        collectionFileImport,
        collectionOpenSource,
        duplicateOpenInterception,
        collectionExport: collectionExportResult.count === 2,
        bookmarkExport: bookmarkExportResult.count === 2,
        browserOnly: document.querySelector("#welcome").hidden && !document.querySelector("#webview-stack").hidden,
        browserToolsUi,
        browserMoreMenu,
        downloadsUi,
        downloadsClose,
        downloadFilter,
        downloadSearch,
        browserPrompt,
        permissionsList,
        permissionRemove,
        permissionClear,
        crashRecovery,
        findInPage,
        zoomControl,
        zoomWheelShortcut,
        printControl: Boolean(document.querySelector("#browser-print")),
        tabPinned,
        tabMuted,
        tabDuplicate,
        tabGrouping,
        tabGroupCollapse,
        tabGroupActions,
        tabHoverPreview,
        tabHoverThumbnail,
        tabSleeping,
        automaticTabSleeping,
        adaptiveResourceManagement,
        workspaceSnapshots,
        sleepingPersistencePrepared,
        credentialPromptCaptured,
        credentialAutoFill,
        credentialReloadAutoFill,
        credentialPanelUi,
        credentialAccountSwitch,
        credentialSettingsUi,
        credentialProfileIsolation,
        duplicateRecognition,
        closeRightPinnedProtection,
        tabBatchPreferences,
        tabBatchClose,
        tabOverviewUi,
        tabOverviewClear,
        tabOverviewShortcut,
        snapshotControls: snapshot.refs.length >= 2,
        directFill,
        directClick: heading === "Automated",
        newTabSkippedWelcome,
        multiTab: document.querySelectorAll(".browser-tab").length === 2 && firstTarget !== secondTarget,
        tabSwitch: document.querySelector('webview:not([hidden])')?.dataset.targetId === firstTarget,
        keyboardAddressFocus,
        keyboardNewTab,
        keyboardTabNumber,
        keyboardOrderedTab,
        newTabButtonFlow,
        keyboardRestoreTab,
        closeUndo,
        closedUndoConsolidated,
        closeTab,
        historyRestore,
        historyClear,
        historyClose,
        websiteHistory,
        browserImportUi: Boolean(document.querySelector("#import-browser-data") && document.querySelector("#onboarding-dialog")),
        controlsInViewport,
        usableHitTargets,
        editableAddressBar: document.querySelector("#current-address") instanceof HTMLInputElement,
        globalTaskSwitcher: document.querySelector("#active-task-select").options.length >= 1,
        firstTarget,
      };
    })()`);

    mainWindow.unmaximize();
    mainWindow.setSize(800, 650, false);
    await delay(150);
    result.compactLayout = await mainWindow.webContents.executeJavaScript(`(() => {
      const selectors = ["#workspace-quick-switch", ".workspace", ".assistant-panel", "#browser-address-form"];
      const inViewport = selectors.every((selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      });
      return inViewport && document.documentElement.scrollWidth <= innerWidth;
    })()`);
    mainWindow.maximize();
    await delay(150);

    await toggleHomeBar();
    await delay(250);
    result.homeBarVisible = Boolean(homeBarWindow?.isVisible());
    result.homeBarBrowseOnly = await homeBarWindow.webContents.executeJavaScript('document.querySelectorAll("[data-mode]").length === 1 && document.querySelector("[data-mode=browse]")?.classList.contains("active")');
    result.homeBarNoEmbeddedChat = await homeBarWindow.webContents.executeJavaScript('!document.querySelector("[data-mode=chat], [data-mode=codex]")');
    result.homeBarContextsHidden = await homeBarWindow.webContents.executeJavaScript('document.querySelector(".homebar-contexts")?.hidden === true');
    result.trayReady = Boolean(tray);
    result.homeBarShortcut = homeBarShortcutRegistered;
    await homeBarWindow.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#homebar-input');
      input.value = 'data:text/html,<title>HomeBar Smoke</title><h1>HomeBar Ready</h1>';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#homebar-submit').click();
    })()`);
    const homeBarDeadline = Date.now() + 8_000;
    while (Date.now() < homeBarDeadline) {
      result.homeBarSubmit = await mainWindow.webContents.executeJavaScript('document.querySelector("#current-address")?.value.includes("HomeBar")');
      if (result.homeBarSubmit) break;
      await delay(80);
    }

    if (process.env.EGO_DESKTOP_EXTENSION_FIXTURE) {
      const extensionPath = JSON.stringify(process.env.EGO_DESKTOP_EXTENSION_FIXTURE);
      const installed = await mainWindow.webContents.executeJavaScript(`window.egoDesktop.invoke("extensions.install", { path: ${extensionPath} })`);
      const installedList = await mainWindow.webContents.executeJavaScript('window.egoDesktop.invoke("extensions.list")');
      const installedRecord = installedList.find((item) => item.name === "EgoLite Smoke Extension");
      result.extensionInstall = installed?.name === "EgoLite Smoke Extension" && installed?.loaded === true;
      result.extensionList = Boolean(installedRecord?.loaded);
      result.extensionActionAvailable = installedRecord?.actionAvailable === true;
      result.extensionToolbarAction = await mainWindow.webContents.executeJavaScript(`(async () => {
        document.querySelector("#refresh").click();
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          if (document.querySelector('[data-pinned-extension="${installed?.id}"]')) return true;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      })()`);
      const openedAction = await mainWindow.webContents.executeJavaScript(`window.egoDesktop.invoke("extensions.openAction", { id: ${JSON.stringify(installed?.id)} })`);
      result.extensionActionOpen = openedAction?.opened === true;
      const unpinned = await mainWindow.webContents.executeJavaScript(`window.egoDesktop.invoke("extensions.setPinned", { id: ${JSON.stringify(installed?.id)}, pinned: false })`);
      const repinned = await mainWindow.webContents.executeJavaScript(`window.egoDesktop.invoke("extensions.setPinned", { id: ${JSON.stringify(installed?.id)}, pinned: true })`);
      result.extensionPinning = unpinned?.pinned === false && repinned?.pinned === true;
      const duplicate = await mainWindow.webContents.executeJavaScript(`window.egoDesktop.invoke("extensions.install", { path: ${extensionPath} })`);
      const duplicateList = await mainWindow.webContents.executeJavaScript('window.egoDesktop.invoke("extensions.list")');
      result.extensionDuplicateInstall = duplicate?.id === installed?.id
        && duplicate?.sourceType === "zip"
        && duplicateList.filter((item) => item.id === installed.id).length === 1;
      const extensionId = JSON.stringify(installed.id);
      await mainWindow.webContents.executeJavaScript(`window.egoDesktop.invoke("extensions.setEnabled", { id: ${extensionId}, enabled: false })`);
      const disabledList = await mainWindow.webContents.executeJavaScript('window.egoDesktop.invoke("extensions.list")');
      result.extensionDisable = disabledList.find((item) => item.id === installed.id)?.loaded === false;
      const enabled = await mainWindow.webContents.executeJavaScript(`window.egoDesktop.invoke("extensions.setEnabled", { id: ${extensionId}, enabled: true })`);
      result.extensionEnable = enabled?.loaded === true;
      const removedList = await mainWindow.webContents.executeJavaScript(`window.egoDesktop.invoke("extensions.remove", { id: ${extensionId} })`);
      result.extensionRemove = !removedList.some((item) => item.id === installed.id);
      result.extensionCleanup = !existsSync(installed.path);
    }

    if (process.env.EGO_DESKTOP_EXTENSION_COMPAT_FIXTURE) {
      const extensionPath = JSON.stringify(process.env.EGO_DESKTOP_EXTENSION_COMPAT_FIXTURE);
      const installed = await mainWindow.webContents.executeJavaScript(`window.egoDesktop.invoke("extensions.install", { path: ${extensionPath} })`);
      const record = (await mainWindow.webContents.executeJavaScript('window.egoDesktop.invoke("extensions.list")'))
        .find((item) => item.id === installed?.id);
      result.compatExtensionLoaded = record?.loaded === true;
      result.compatExtensionReady = record?.ready === true;
      result.compatExtensionAdapted = record?.runtimeAdapted === true && record?.compatibilityLevel === "adapted";
      const opened = await openBrowserExtensionAction({ id: installed.id });
      const actionWindow = browserExtensionActionWindows.get(installed.id);
      const popup = actionWindow && !actionWindow.isDestroyed()
        ? await actionWindow.webContents.executeJavaScript(`(async () => {
          const backgroundReply = await new Promise((resolve) => {
            let settled = false;
            const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
            const timer = setTimeout(() => finish({ timeout: true }), 3000);
            try {
              const pending = chrome.runtime.sendMessage({ cmd: "GetAllOptions" });
              Promise.resolve(pending).then((value) => { clearTimeout(timer); finish({ value, error: "" }); }, (error) => { clearTimeout(timer); finish({ error: error?.message || String(error) }); });
            } catch (error) { clearTimeout(timer); finish({ error: error?.message || String(error) }); }
          });
          return {
            backgroundReply,
            hasDocument: Boolean(document.body),
            rendered: document.body?.childElementCount > 0,
            title: document.title,
            url: location.href,
          };
        })()`)
        : null;
      result.compatExtensionAction = opened?.opened === true
        && popup?.hasDocument === true
        && popup?.rendered === true
        && popup?.url?.includes("/popup/index.html")
        && !popup?.backgroundReply?.timeout
        && !popup?.backgroundReply?.error;
      const fixtureUrl = process.env.EGO_DESKTOP_HISTORY_FIXTURE_URL;
      if (result.compatExtensionAction && fixtureUrl) {
        const code = `// ==UserScript==\n// @name EgoLite compatibility smoke\n// @namespace egolite.test\n// @version 1.0.0\n// @match ${fixtureUrl}/*\n// @inject-into content\n// @grant none\n// ==/UserScript==\ndocument.documentElement.setAttribute("data-ego-violentmonkey", "running");`;
        const installedScript = await actionWindow.webContents.executeJavaScript(`chrome.runtime.sendMessage(${JSON.stringify({
          cmd: "ParseScript",
          data: { code, url: `${fixtureUrl}/egolite-smoke.user.js`, from: "EgoLite smoke", bumpDate: true },
        })})`);
        await delay(250);
        const compatibilityStore = await browserExtensionBackgroundWindows.get(installed.id)?.webContents.executeJavaScript(`chrome.storage.local.get("__egoCompatUserScripts")`);
        result.compatExtensionStore = Array.isArray(compatibilityStore?.__egoCompatUserScripts) ? compatibilityStore.__egoCompatUserScripts.length : 0;
        const active = await mainWindow.webContents.executeJavaScript(`(() => {
          const webview = document.querySelector('webview:not([hidden])');
          webview.__compatErrors = [];
          webview.addEventListener('console-message', event => {
            if (event.level === 3 || event.level === 'error') webview.__compatErrors.push(event.message);
          }, { once: false });
          webview.loadURL(${JSON.stringify(`${fixtureUrl}/vm-test`)});
          return true;
        })()`);
        let injected = false;
        let contentRuntime = false;
        const injectionDeadline = Date.now() + 6_000;
        while (active && Date.now() < injectionDeadline) {
          const marks = await mainWindow.webContents.executeJavaScript(`document.querySelector('webview:not([hidden])')?.executeJavaScript('({ runtime: document.documentElement.getAttribute("data-ego-extension-runtime"), response: document.documentElement.getAttribute("data-ego-extension-response"), userscript: document.documentElement.getAttribute("data-ego-violentmonkey") })').catch(() => ({}))`);
          contentRuntime ||= marks?.runtime === "ready";
          if (marks?.response) result.compatExtensionContentResponse = marks.response;
          injected = marks?.userscript === "running";
          if (injected) break;
          await delay(100);
        }
        result.compatExtensionInjection = Boolean(installedScript) && injected;
        if (!result.compatExtensionInjection) {
          result.compatExtensionInjectionDetail = await mainWindow.webContents.executeJavaScript(`({
            installedScript: ${JSON.stringify(installedScript)},
            contentRuntime: ${JSON.stringify(contentRuntime)},
            errors: document.querySelector('webview:not([hidden])')?.__compatErrors || [],
          })`);
        }
      }
      if (!result.compatExtensionAction) result.compatExtensionActionDetail = popup || { unavailable: true };
      await removeBrowserExtension(installed.id);
    }

    mainWindow.unmaximize();
    mainWindow.setSize(760, 560, false);
    await delay(180);
    const appearanceExtremes = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const theme = document.querySelector("#theme-select");
      const originalAppearance = {
        theme: theme.value,
        opacity: document.querySelector("#glass-opacity").value,
        blur: document.querySelector("#glass-blur").value,
        dim: document.querySelector("#background-dim").value,
      };
      theme.value = "paper";
      theme.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFrame();

      const setRange = async (selector, value) => {
        const input = document.querySelector(selector);
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await waitFrame();
      };
      await setRange("#glass-opacity", 60);
      await setRange("#glass-blur", 8);
      await setRange("#background-dim", 45);
      const minimumTokens = getComputedStyle(document.documentElement);
      const minimumControls = minimumTokens.getPropertyValue("--glass-strength").trim() === "0.6"
        && minimumTokens.getPropertyValue("--glass-blur-px").trim() === "8px"
        && minimumTokens.getPropertyValue("--background-dim").trim() === "0.45";
      await setRange("#glass-opacity", 140);
      await setRange("#glass-blur", 36);
      await setRange("#background-dim", 85);
      const maximumTokens = getComputedStyle(document.documentElement);
      const maximumControls = maximumTokens.getPropertyValue("--glass-strength").trim() === "1.4"
        && maximumTokens.getPropertyValue("--glass-blur-px").trim() === "36px"
        && maximumTokens.getPropertyValue("--background-dim").trim() === "0.85";
      await setRange("#glass-opacity", 100);
      await setRange("#glass-blur", 24);
      await setRange("#background-dim", 66);

      const tabList = document.querySelector("#browser-tab-list");
      const sourceTab = tabList.querySelector(".browser-tab");
      const addedTabs = [];
      if (sourceTab) {
        for (let index = 0; index < 24; index += 1) {
          const tab = sourceTab.cloneNode(true);
          tab.classList.remove("active", "selected");
          tab.dataset.targetId = "visual-stress-" + index;
          const title = tab.querySelector(".browser-tab-title");
          if (title) title.textContent = "超长压力测试标签页 " + (index + 1);
          tabList.append(tab);
          addedTabs.push(tab);
        }
      }
      await waitFrame();
      const tabsOverflow = tabList.scrollWidth > tabList.clientWidth;
      const newTabRect = document.querySelector("#titlebar-new-tab").getBoundingClientRect();
      const newTabClearOfControls = newTabRect.width > 0 && newTabRect.right <= innerWidth - 130;

      document.querySelector('[data-view="settings"]').click();
      await waitFrame();
      const menu = document.querySelector(".settings-navigation");
      const menuRect = menu.getBoundingClientRect();
      const menuStyle = getComputedStyle(menu);
      const menuReadable = menuStyle.display !== "none"
        && menu.textContent.includes("任务空间")
        && menu.textContent.includes("收藏库");
      const menuContained = menuRect.left >= 0 && menuRect.top >= 0
        && menuRect.right <= innerWidth && menuRect.bottom <= innerHeight;
      document.querySelector('[data-view="start"]').click();
      await waitFrame();

      const assistantRect = document.querySelector(".assistant-panel").getBoundingClientRect();
      const toolbarRect = document.querySelector("#browser-address-form").getBoundingClientRect();
      const compactContained = document.documentElement.scrollWidth <= innerWidth
        && assistantRect.left >= 0 && assistantRect.right <= innerWidth
        && toolbarRect.left >= 0 && toolbarRect.right <= innerWidth && toolbarRect.width >= 180;
      const popupSurfaces = ["#browser-more-menu", "#history-panel", "#downloads-panel", "#extensions-panel"]
        .every((selector) => {
          const style = getComputedStyle(document.querySelector(selector));
          return style.color === "rgb(32, 39, 42)" && style.backgroundColor === "rgba(255, 255, 255, 0.96)";
        });

      for (const tab of addedTabs) tab.remove();
      theme.value = originalAppearance.theme;
      theme.dispatchEvent(new Event("change", { bubbles: true }));
      await setRange("#glass-opacity", originalAppearance.opacity);
      await setRange("#glass-blur", originalAppearance.blur);
      await setRange("#background-dim", originalAppearance.dim);
      return { minimumControls, maximumControls, tabsOverflow, newTabClearOfControls, menuReadable, menuContained, compactContained, popupSurfaces };
    })()`);
    Object.assign(result, {
      paperMinimumControls: appearanceExtremes.minimumControls,
      paperMaximumControls: appearanceExtremes.maximumControls,
      paperManyTabsOverflow: appearanceExtremes.tabsOverflow,
      paperNewTabClearOfControls: appearanceExtremes.newTabClearOfControls,
      paperAppMenuReadable: appearanceExtremes.menuReadable,
      paperAppMenuContained: appearanceExtremes.menuContained,
      paperCompactLayout: appearanceExtremes.compactContained,
      paperPopupSurfaces: appearanceExtremes.popupSurfaces,
    });
    if (!process.env.EGO_DESKTOP_CAPTURE_COMPACT) {
      mainWindow.maximize();
      await delay(180);
    }

    if (process.env.EGO_DESKTOP_CAPTURE_VIEW) {
      await mainWindow.webContents.executeJavaScript(`(() => {
        document.querySelector('[data-view="${String(process.env.EGO_DESKTOP_CAPTURE_VIEW).replaceAll('"', '\\"')}"]')?.click();
        document.querySelector("#tab-overview").hidden = true;
        document.querySelector("#downloads-panel").hidden = true;
        document.querySelector("#history-panel").hidden = true;
        document.querySelector("#extensions-panel").hidden = true;
      })()`);
      await delay(180);
    }
    if (process.env.EGO_DESKTOP_CAPTURE_THEME) {
      await mainWindow.webContents.executeJavaScript(`(() => {
        const select = document.querySelector("#theme-select");
        select.value = ${JSON.stringify(process.env.EGO_DESKTOP_CAPTURE_THEME)};
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await delay(180);
    }
    if (process.env.EGO_DESKTOP_CAPTURE_DIALOG) {
      await mainWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`#${process.env.EGO_DESKTOP_CAPTURE_DIALOG}`)})?.showModal()`);
      await delay(120);
    }
    if (process.env.EGO_DESKTOP_CAPTURE_CONTROL_SECURITY) {
      await mainWindow.webContents.executeJavaScript(`(() => {
        document.querySelector('[data-view="settings"]')?.click();
        document.querySelector(".control-security-settings")?.scrollIntoView({ block: "center" });
      })()`);
      await delay(180);
    }
    if (process.env.EGO_DESKTOP_CAPTURE_TAB_OVERVIEW) {
      await mainWindow.webContents.executeJavaScript(`(() => {
        if (!document.querySelector("#tab-batchbar").hidden) document.querySelector("#manage-browser-tabs").click();
        if (document.querySelector("#tab-overview").hidden) document.querySelector("#manage-browser-tabs").click();
        document.querySelector('[data-tab-overview-mode="all"]')?.click();
      })()`);
      await delay(180);
    }
    if (process.env.EGO_DESKTOP_CAPTURE) {
      const image = await mainWindow.webContents.capturePage();
      writeFileSync(process.env.EGO_DESKTOP_CAPTURE, image.toPNG());
    }
    result.collectionExportFile = existsSync(collectionExportSmokePath) && readFileSync(collectionExportSmokePath, "utf8").includes("Imported smoke bookmark");
    result.bookmarkExportFile = existsSync(bookmarkExportSmokePath)
      && readFileSync(bookmarkExportSmokePath, "utf8").includes("<!DOCTYPE NETSCAPE-Bookmark-file-1>")
      && readFileSync(bookmarkExportSmokePath, "utf8").includes("https://import.example/bookmark");
    writeFileSync(process.env.EGO_DESKTOP_SMOKE_RESULT, JSON.stringify(result, null, 2), "utf8");
    const holdMilliseconds = Number(process.env.EGO_DESKTOP_SMOKE_HOLD_MS || 0);
    console.log(`Desktop smoke result written; hold=${holdMilliseconds}ms; window=${Boolean(mainWindow && !mainWindow.isDestroyed())}`);
    if (holdMilliseconds > 0) await delay(holdMilliseconds);
    console.log(`Desktop smoke hold finished; window=${Boolean(mainWindow && !mainWindow.isDestroyed())}`);
    exitDesktopApp(Object.values(result).every(Boolean) ? 0 : 1);
  } catch (error) {
    const smokeStage = await mainWindow?.webContents.executeJavaScript("window.__egoSmokeStage || 'unknown'").catch(() => "window unavailable");
    writeFileSync(
      process.env.EGO_DESKTOP_SMOKE_RESULT,
      JSON.stringify({ error: `[${smokeStage}] ${error?.stack || String(error)}` }, null, 2),
      "utf8",
    );
    exitDesktopApp(1);
  }
}

async function runDesktopRestoreSmoke() {
  try {
    const expectedOldTarget = process.env.EGO_DESKTOP_RESTORE_EXPECTED_TARGET || "";
    const expectedTaskId = process.env.EGO_DESKTOP_RESTORE_EXPECTED_TASK || "";
    const deadline = Date.now() + 20_000;
    let result;
    while (Date.now() < deadline) {
      result = await mainWindow.webContents.executeJavaScript(`(() => {
        const webviews = [...document.querySelectorAll("webview[data-target-id]")];
        const browserTabs = [...document.querySelectorAll(".browser-tab[data-target-id]")];
        const smokeWorkspace = [...document.querySelectorAll(".task-row[data-task-id]")]
          .find((row) => row.dataset.taskId === ${JSON.stringify(expectedTaskId)});
        const workspaceReady = Boolean(smokeWorkspace?.classList.contains("active"));
        if (smokeWorkspace && !workspaceReady && Date.now() - Number(window.__egoRestoreWorkspaceRequestedAt || 0) >= 500) {
          window.__egoRestoreWorkspaceRequestedAt = Date.now();
          smokeWorkspace.click();
        }
        const collapsedGroup = document.querySelector('.browser-tab-group-chip.collapsed');
        if (workspaceReady && collapsedGroup) collapsedGroup.click();
        const pinnedTab = document.querySelector('.browser-tab.pinned');
        if (workspaceReady && pinnedTab && !pinnedTab.classList.contains("active")) pinnedTab.click();
        const operationsMode = document.querySelector('.assistant-head .mode[data-mode="operations"]');
        if (workspaceReady && operationsMode && !operationsMode.classList.contains("active")) operationsMode.click();
        const restored = webviews.map((webview) => {
          let url = webview.src || "";
          let webContentsId = 0;
          try {
            url = webview.getURL() || url;
            webContentsId = webview.getWebContentsId();
          } catch {}
          return { targetId: webview.dataset.targetId || "", url, webContentsId };
        });
        return {
          connected: document.querySelector("#connection")?.textContent === "本地运行中",
          restoredTabs: workspaceReady && browserTabs.length >= 2,
          restoredSmokePage: restored.some((tab) => tab.url.includes("Ego%20Smoke") || tab.url.includes("Updated%20Context")),
          regeneratedTargets: restored.length > 0 && !restored.some((tab) => tab.targetId === ${JSON.stringify(expectedOldTarget)}),
          restoredWebviews: restored.length >= 1 && restored.every((tab) => tab.webContentsId > 0),
          restoredOperations: operationsMode?.classList.contains("active") === true
            && document.querySelector(".composer-wrap")?.hidden === true
            && Boolean(document.querySelector('.operation-record[data-status="completed"]')),
          restoredPinned: Boolean(document.querySelector('.browser-tab.pinned')),
          restoredMuted: Boolean(document.querySelector('.browser-tab .browser-tab-muted')),
          restoredGrouped: Boolean(document.querySelector('.browser-tab.grouped .browser-tab-group-mark')),
          restoredSleeping: Boolean(document.querySelector('.browser-tab.sleeping'))
            && browserTabs.some((tab) => tab.classList.contains("sleeping") && !document.querySelector('webview[data-target-id="' + tab.dataset.targetId + '"]')),
          restoredZoom: document.querySelector("#browser-zoom-reset")?.textContent === "110%",
          restoredDownloads: [...document.querySelectorAll(".download-row")].some((row) => row.textContent.includes("desktop-download.txt") && row.textContent.includes("已完成")),
          restoredControlSettings: document.querySelector("#control-handoff-enabled")?.checked === true
            && document.querySelector("#control-consent-enabled")?.checked === true
            && document.querySelector("#control-consent-level")?.value === "strict"
            && document.querySelector("#control-consent-level")?.disabled === false
            && document.querySelector("#agent-web-access-enabled")?.checked === true
            && document.querySelector("#agent-silent-downloads-enabled")?.checked === true,
          credentialPersisted: document.querySelector("#settings-credential-count")?.textContent === "2 条",
        };
      })()`);
      if (Object.values(result).every(Boolean)) break;
      await delay(100);
    }
    const restorePassed = Boolean(result && Object.values(result).every(Boolean));
    if (!restorePassed) result.diagnostic = await mainWindow.webContents.executeJavaScript(`({
      rows: [...document.querySelectorAll(".task-row")].map(row => ({ id: row.dataset.taskId, active: row.classList.contains("active"), text: row.textContent })),
      toasts: document.querySelector("#toast-stack")?.textContent,
      tabs: [...document.querySelectorAll("webview")].map(view => ({ taskId: view.dataset.taskId, targetId: view.dataset.targetId, url: view.src }))
    })`);
    writeFileSync(process.env.EGO_DESKTOP_RESTORE_RESULT, JSON.stringify(result, null, 2), "utf8");
    exitDesktopApp(restorePassed ? 0 : 1);
  } catch (error) {
    writeFileSync(
      process.env.EGO_DESKTOP_RESTORE_RESULT,
      JSON.stringify({ error: error?.stack || String(error) }, null, 2),
      "utf8",
    );
    exitDesktopApp(1);
  }
}

function registerIpc() {
  ipcMain.handle("ego:cos:invoke", (event, channel, payload) => cosWorkspace.invokeUi(event, channel, payload));
  ipcMain.handle("ego:homebar-submit", async (event, payload = {}) => {
    if (event.sender.id !== homeBarWindow?.webContents.id) throw new Error("Home Bar IPC sender is not authorized");
    const mode = "browse";
    const text = required(payload.text, "text").slice(0, 100_000);
    homeBarWindow.hide();
    sendToMainWindow("ego:homebar-compose", {
      mode,
      text,
      submit: true,
    });
    homeBarContextDraft = null;
    return true;
  });
  ipcMain.handle("ego:homebar-dismiss", (event) => {
    if (event.sender.id !== homeBarWindow?.webContents.id) throw new Error("Home Bar IPC sender is not authorized");
    homeBarWindow.hide();
    return true;
  });
  ipcMain.handle("ego:homebar-open-main", (event) => {
    if (event.sender.id !== homeBarWindow?.webContents.id) throw new Error("Home Bar IPC sender is not authorized");
    homeBarWindow.hide();
    showMainWindow();
    return true;
  });
  ipcMain.on("ego:host-response", (event, response) => {
    if (event.sender.id !== mainWindow?.webContents.id) return;
    const pending = hostPending.get(response.id);
    if (!pending) return;
    hostPending.delete(response.id);
    if (response.error) pending.reject(new Error(response.error));
    else pending.resolve(response.result);
  });
  ipcMain.on("ego:browser-prompt-response", (event, response = {}) => {
    if (event.sender.id !== mainWindow?.webContents.id) return;
    const pending = browserPromptPending.get(response.id);
    if (!pending || response.id !== activeBrowserPromptId) return;
    finishBrowserPrompt(response.id, {
      accepted: response.accepted === true,
      remember: response.remember === true,
      username: typeof response.username === "string" ? response.username : "",
      password: typeof response.password === "string" ? response.password : "",
      credentialId: typeof response.credentialId === "string" ? response.credentialId : "",
    });
  });
  ipcMain.handle("ego:invoke", async (event, method, payload = {}) => {
    if (event.sender.id !== mainWindow?.webContents.id) throw new Error("Desktop IPC sender is not authorized");
    if (method.startsWith("cos.")) {
      if (method === "cos.status") return cosWorkspace.describe();
      if (method === "cos.layout") return cosWorkspace.layout(payload);
      if (method === "cos.openHome") return cosWorkspace.openHome();
      if (method === "cos.enable") {
        if (!rpc || !backendReady) throw new Error("浏览器后台尚未就绪");
        return cosWorkspace.enable(normalizeBrowserProfileId(payload.profileId));
      }
      if (method === "cos.disable") return cosWorkspace.disable();
      if (method === "cos.resumeTasks") return cosWorkspace.resumeTasks();
      if (method === "cos.checkUpdate") return cosMaintenance.check();
      if (method === "cos.agentUpdate") return cosMaintenance.start();
      if (method === "cos.cancelUpdate") return cosMaintenance.cancel();
      if (method === "cos.applyUpdate") return cosMaintenance.apply();
      if (method === "cos.update") {
        const selection = await dialog.showOpenDialog(mainWindow, { title: "选择新版本 CoS 功能包目录", properties: ["openDirectory"] });
        return selection.canceled ? cosWorkspace.describe() : cosWorkspace.update(selection.filePaths[0]);
      }
      if (method === "cos.rollback") {
        const choice = await dialog.showMessageBox(mainWindow, {
          type: "question", title: "回退 CoS",
          message: "恢复更新前的程序和数据？",
          detail: "更新后产生的数据会另行保留。运行中的 CoS 将暂时停止。",
          buttons: ["取消", "恢复旧版"], defaultId: 0, cancelId: 0,
        });
        return choice.response === 1 ? cosWorkspace.rollback() : cosWorkspace.describe();
      }
      if (method === "cos.load") {
        const selection = await dialog.showOpenDialog(mainWindow, { title: "载入 CoS 功能包", properties: ["openDirectory"] });
        return selection.canceled ? cosWorkspace.describe() : cosWorkspace.load(selection.filePaths[0]);
      }
      if (method === "cos.cancelInstall") return cosWorkspace.cancelInstall();
      if (method === "cos.download") {
        try { return await cosWorkspace.installPreset(); }
        catch (error) {
          if (!["EACCES", "EPERM", "EROFS"].includes(error.code)) throw error;
          const destination = await dialog.showOpenDialog(mainWindow, {
            title: "选择 CoS 功能包存储目录", properties: ["openDirectory", "createDirectory"],
          });
          if (destination.canceled) return cosWorkspace.describe();
          return cosWorkspace.installPreset(destination.filePaths[0]);
        }
      }
      if (method === "cos.install") {
        const selection = await dialog.showOpenDialog(mainWindow, {
          title: "安装 CoS 功能包", properties: ["openFile"],
          filters: [{ name: "CoS 功能包", extensions: ["egopack", "zip"] }],
        });
        if (selection.canceled) return cosWorkspace.describe();
        try { return await cosWorkspace.install(selection.filePaths[0]); }
        catch (error) {
          if (!["EACCES", "EPERM", "EROFS"].includes(error.code)) throw error;
          const destination = await dialog.showOpenDialog(mainWindow, {
            title: "选择 CoS 功能包存储目录", properties: ["openDirectory", "createDirectory"],
          });
          if (destination.canceled) return cosWorkspace.describe();
          return cosWorkspace.install(selection.filePaths[0], destination.filePaths[0]);
        }
      }
      throw new Error("未知 CoS 操作");
    }
    if (method.startsWith("automation.")) {
      const profile = normalizeBrowserProfileId(payload.profileId);
      if (method === "automation.settings") return automationSettings.public(profile);
      if (method === "automation.save") return automationSettings.save(profile, payload);
      if (method === "automation.test") return automationDecisions.test(profile);
      if (method === "automation.jobs") return automationDecisions.list();
      if (method === "automation.stop") return automationDecisions.cancel(required(payload.runId, "runId"));
      throw new Error("Unsupported automation settings command");
    }
    if (method.startsWith("translation.")) {
      const tab = desktopTabs.get(required(payload.targetId, "targetId"));
      if (!tab?.webContentsId) throw new Error("请先打开一个网页");
      const target = webContents.fromId(tab.webContentsId);
      if (!target || target.isDestroyed()) throw new Error("页面已关闭");
      const profile = profileIdForWebContents(target);
      if (method === "translation.settings") return translationSettings.public(profile);
      if (method === "translation.describe") return target.executeJavaScriptInIsolatedWorld(TRANSLATION_WORLD, [{ code: translationScript("describe", {}) }]);
      if (method === "translation.saveSettings") {
        const settings = translationSettings.save(profile, payload);
        if (payload.clearKey || payload.key?.trim() || payload.cloudConsent === false) {
          for (const job of pageTranslations.jobs.values()) if (job.profile === profile) pageTranslations.cancel(job.id);
        }
        return settings;
      }
      if (method === "translation.status") return pageTranslations.status(tab.targetId);
      if (method === "translation.cancel") {
        pageTranslations.cancel(tab.targetId);
        return pageTranslations.status(tab.targetId);
      }
      if (!["translation.start", "translation.restore", "translation.resume"].includes(method)) throw new Error("未知翻译操作");
      if (target.id !== activeWebviewId) throw new Error("请先切换到需要翻译的标签页");
      const space = brokerSpaceStates.get(tab.taskId) || desktopSpaces.get(tab.taskId);
      if (!space || !rpc) throw new Error("工作空间尚未连接");
      const authority = await rpc.request("space.controlState", { clientId, id: space.id });
      const context = { targetId: tab.targetId, taskId: tab.taskId, spaceId: space.id, epoch: authority.space.leaseEpoch };
      if (method === "translation.restore") {
        const job = pageTranslations.jobs.get(tab.targetId);
        if (job) job.context = context;
        return pageTranslations.restore(tab.targetId);
      }
      if (payload.consent !== true || !translationSettings.public(profile).cloudConsent) throw new Error("请在翻译服务设置中允许发送页面文字");
      if (method === "translation.resume") return pageTranslations.resume(tab.targetId, context);
      return pageTranslations.start({
        id: tab.targetId, target, profile, context,
        source: payload.source || "", targetLanguage: payload.targetLanguage || translationSettings.public(profile).target,
      });
    }
    if (method === "shell.closeWindow") {
      mainWindow.close();
      return true;
    }
    if (method === "shell.toggleFullscreen") {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      return mainWindow.isFullScreen();
    }
    if (method === "appearance.setNativeTheme") {
      const light = payload.theme === "light" || payload.theme === "paper";
      mainWindow.setTitleBarOverlay({
        color: light ? "#f7f8f8" : "#23343a",
        symbolColor: light ? "#343a3d" : "#eef2f1",
        height: 54,
      });
      mainWindow.setBackgroundColor(light ? "#f7f8f8" : "#18262b");
      return true;
    }
    if (method === "browser.register") {
      const registeredId = requiredNumber(payload.webContentsId, "webContentsId");
      if (payload.active !== false) activeWebviewId = registeredId;
      const tab = desktopTabs.get(payload.targetId);
      if (tab) {
        tab.webContentsId = registeredId;
        if (typeof payload.sleeping === "boolean") tab.sleeping = payload.sleeping;
        if (typeof payload.url === "string" && (!isPlaceholderTabUrl(payload.url) || isPlaceholderTabUrl(tab.url))) {
          tab.url = payload.url;
        }
        if (typeof payload.title === "string" && payload.title) {
          tab.title = isPlaceholderTabUrl(tab.url) ? "新建标签页" : payload.title;
        }
        const target = await waitForRegisteredWebview(registeredId);
        bindDesktopWebview(tab, target);
        notifyDesktopTab(tab);
        persistDesktopTabs();
      }
      return true;
    }
    if (method.startsWith("browser.devtools.")) {
      if (method === "browser.devtools.state") return developerTools.state();
      if (method === "browser.devtools.layout") return developerTools.layout(payload);
      const target = await desktopTarget(payload);
      if (!isEgoGuestContents(target)) throw new Error("请先打开一个网页");
      if (method === "browser.devtools.toggle") return developerTools.toggle(target);
      if (method === "browser.devtools.inspect") return developerTools.open(target, { inspect: true });
      if (method === "browser.devtools.elements") return developerTools.open(target, { panel: "elements" });
      if (method === "browser.devtools.sources") return developerTools.open(target, { panel: "sources" });
      if (method === "browser.devtools.copy") return developerTools.copySelected(target);
      if (method === "browser.devtools.close") { developerTools.close(target); return true; }
      throw new Error("未知的开发者工具操作");
    }
    if (method.startsWith("browser.")) {
      if (method === "browser.prompt.test" && process.env.EGO_DESKTOP_SMOKE_RESULT) {
        return requestBrowserPrompt({
          type: payload.type || "permission",
          title: "Smoke browser prompt",
          message: "Smoke prompt detail",
          rememberAllowed: true,
        });
      }
      if (method === "browser.crash.test" && process.env.EGO_DESKTOP_SMOKE_RESULT) {
        mainWindow.webContents.send("ego:browser-tab-crashed", {
          targetId: required(payload.targetId, "targetId"),
          title: "页面停止运行",
          reason: "smoke-test",
          message: "页面进程已停止，可以重新加载后继续。",
        });
        return true;
      }
      if (method === "browser.find") {
        const target = await desktopTarget(payload);
        const tab = desktopTabs.get(required(payload.targetId, "targetId"));
        if (tab) bindDesktopWebview(tab, target);
        return new Promise((resolve, reject) => {
          const text = required(payload.text, "text");
          const timer = setTimeout(async () => {
            target.removeListener("found-in-page", onResult);
            try {
              const matches = await target.executeJavaScript(`(() => {
                const haystack = (document.body?.innerText || "").toLocaleLowerCase();
                const needle = ${JSON.stringify(text.toLocaleLowerCase())};
                if (!needle) return 0;
                let count = 0;
                let offset = 0;
                while ((offset = haystack.indexOf(needle, offset)) >= 0) { count += 1; offset += needle.length; }
                return count;
              })()`);
              resolve({ matches, activeMatchOrdinal: matches ? 1 : 0, finalUpdate: true, fallback: true });
            } catch (error) {
              reject(error);
            }
          }, 600);
          const onResult = (_event, result) => {
            if (result?.finalUpdate === false) return;
            clearTimeout(timer);
            target.removeListener("found-in-page", onResult);
            resolve(result || { matches: 0, activeMatchOrdinal: 0 });
          };
          target.on("found-in-page", onResult);
          target.findInPage(text, {
            forward: payload.forward !== false,
            findNext: payload.findNext === true,
            matchCase: false,
          });
        });
      }
      if (method === "browser.stopFind") {
        const target = await desktopTarget(payload);
        target.stopFindInPage("clearSelection");
        return true;
      }
      const localMethod = {
        "browser.pageInfo": "page.info",
        "browser.snapshot": "page.snapshot",
        "browser.click": "page.click",
        "browser.fill": "page.fill",
        "browser.evaluate": "page.evaluate",
      }[method];
      if (localMethod) return dispatchDesktopAutomation(localMethod, payload);
    }
    if (method === "downloads.testSeed" && process.env.EGO_DESKTOP_SMOKE_RESULT) {
      const now = Date.now();
      for (const [index, state] of ["inProgress", "completed", "interrupted"].entries()) {
        const id = `smoke-download-${state}`;
        desktopDownloads.set(id, {
          id,
          guid: id,
          taskId: "smoke-task",
          targetId: "smoke-target",
          url: `https://downloads.example/${state}.txt`,
          filename: `${state}-fixture.txt`,
          savePath: join(dirname(downloadsStatePath), `${state}-fixture.txt`),
          state,
          receivedBytes: state === "inProgress" ? 50 : 100,
          totalBytes: 100,
          startedAt: new Date(now - index * 1_000).toISOString(),
        });
      }
      persistDesktopDownloads();
      return true;
    }
    if (method === "downloads.list") return [...desktopDownloads.values()].map(publicDesktopDownload).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (method === "downloads.open") {
      const record = desktopDownloads.get(required(payload.id, "id"));
      if (!record?.savePath || record.state !== "completed") return false;
      return (await shell.openPath(record.savePath)) === "";
    }
    if (method === "downloads.show") {
      const record = desktopDownloads.get(required(payload.id, "id"));
      if (!record?.savePath) return false;
      shell.showItemInFolder(record.savePath);
      return true;
    }
    if (method === "downloads.cancel") {
      const record = desktopDownloads.get(required(payload.id, "id"));
      if (!record || record.state !== "inProgress") return false;
      record.item?.cancel();
      return true;
    }
    if (method === "downloads.clear") {
      for (const [id, record] of desktopDownloads) if (record.state !== "inProgress") desktopDownloads.delete(id);
      persistDesktopDownloads();
      return [...desktopDownloads.values()].map(publicDesktopDownload);
    }
    if (method === "permissions.clear") {
      desktopPreferences.permissions = {};
      desktopSessionPermissions.clear();
      persistDesktopPreferences();
      return true;
    }
    if (method === "permissions.list") return listDesktopPermissions();
    if (method === "permissions.remove") {
      const key = required(payload.id, "id");
      const removed = Object.prototype.hasOwnProperty.call(desktopPreferences.permissions, key) || desktopSessionPermissions.has(key);
      delete desktopPreferences.permissions[key];
      desktopSessionPermissions.delete(key);
      if (removed) persistDesktopPreferences();
      return removed;
    }
    if (method === "permissions.testSeed" && process.env.EGO_DESKTOP_SMOKE_RESULT) {
      const origin = originOf(required(payload.origin, "origin"));
      const permission = required(payload.permission, "permission");
      desktopPreferences.permissions[permissionKey(origin, permission)] = payload.allowed !== false;
      persistDesktopPreferences();
      return true;
    }
    if (method === "credentials.list") {
      return credentialStore.list(payload.profileId);
    }
    if (method === "credentials.find") {
      return credentialStore.find(payload.profileId, payload.origin, payload.realm);
    }
    if (method === "credentials.get") {
      const credential = credentialStore.reveal(payload.profileId, required(payload.id, "id"));
      if (!credential) throw new Error("找不到保存的登录信息");
      return credential;
    }
    if (method === "credentials.save") {
      return credentialStore.save({
        id: payload.id,
        profileId: payload.profileId,
        origin: payload.origin,
        username: payload.username,
        password: payload.password,
        realm: payload.realm,
        formSignature: payload.formSignature,
      });
    }
    if (method === "credentials.remove") {
      return credentialStore.remove(payload.profileId, required(payload.id, "id"));
    }
    if (method === "credentials.check") {
      const profileId = normalizeBrowserProfileId(payload.profileId);
      const credential = credentialStore.reveal(profileId, required(payload.id, "id"));
      const matches = Boolean(credential && typeof payload.password === "string" && credential.password === payload.password);
      if (matches) credentialStore.touch(profileId, credential.id);
      return { matches };
    }
    if (method === "credentials.clear") {
      return credentialStore.clear(payload.profileId);
    }
    if (method === "credentials.fill") {
      const profileId = normalizeBrowserProfileId(payload.profileId);
      const credential = credentialStore.reveal(profileId, required(payload.id, "id"));
      if (!credential) throw new Error("找不到保存的登录信息");
      const target = await desktopTarget(payload);
      if (originOf(target.getURL()) !== credential.origin) throw new Error("保存的登录信息与当前网站不匹配");
      const result = await fillCredentialOnPage(target, credential, payload.formSignature);
      credentialStore.touch(profileId, credential.id);
      return result;
    }
    if (method === "credentials.capture") {
      const target = await desktopTarget(payload);
      return captureCredentialForm(target);
    }
    if (method === "extensions.list") return listBrowserExtensions();
    if (method === "extensions.install") return installBrowserExtension(payload);
    if (method === "extensions.setEnabled") return setBrowserExtensionEnabled(payload);
    if (method === "extensions.setPinned") return setBrowserExtensionPinned(payload);
    if (method === "extensions.reload") return reloadBrowserExtension(required(payload.id, "id"));
    if (method === "extensions.openAction") return openBrowserExtensionAction(payload);
    if (method === "extensions.remove") return removeBrowserExtension(required(payload.id, "id"));
    if (method === "extensions.openFolder") {
      const record = findBrowserExtension(required(payload.id, "id"));
      await shell.openPath(record.path);
      return true;
    }
    if (method.startsWith("scansci.") && process.env.EGO_DESKTOP_SMOKE_RESULT) {
      return scanSciSmokeResponse(method);
    }
    if (method === "scansci.status") return scanSciService.status();
    if (method === "scansci.ensure") return scanSciService.ensure();
    if (method === "scansci.checkAll") return scanSciService.checkAll();
    if (method === "scansci.restart") return scanSciService.restart();
    if (method === "scansci.stop") return scanSciService.stop();
    if (method === "settings.get") {
      return {
        browserBackend: configuredBrowserBackend,
        passwordAutofillEnabled: desktopPreferences.passwordAutofillEnabled !== false,
        credentialCount: credentialStore.list().length,
        agentSilentDownloadsEnabled: agentSilentDownloadsEnabled(),
        agentWebAccessEnabled: agentWebAccessEnabled(),
        agentDownloadDirectory: agentDownloadDirectory(),
        controlMode: controlMode(),
        autoCollaboration: desktopPreferences.autoCollaboration === true,
        controlHandoffEnabled: controlHandoffEnabled(),
        controlConsentEnabled: desktopPreferences.controlConsentEnabled === true,
        controlConsentLevel: normalizeControlConsentLevel(desktopPreferences.controlConsentLevel),
        companion: companionStatus(),
        localAgents: agentIntegrationStatus(),
      };
    }
    if (method === "settings.setPasswordAutofill") {
      desktopPreferences.passwordAutofillEnabled = payload.enabled !== false;
      persistDesktopPreferences();
      return { enabled: desktopPreferences.passwordAutofillEnabled };
    }
    if (method === "agents.integrations.status") return agentIntegrationStatus();
    if (method === "agents.integrations.repair") {
      await initializeBackend();
      return syncAgentIntegrations();
    }
    if (method === "agents.integrations.open") {
      const target = agentIntegrationStatus().integrations.find((item) => item.kind === payload.kind && (!payload.root || item.root === payload.root));
      if (!target) throw new Error("Local Agent integration was not found");
      await shell.openPath(target.root);
      return true;
    }
    if (method === "settings.setBackend") {
      const browserBackend = required(payload.browserBackend, "browserBackend");
      if (!['desktop', 'companion'].includes(browserBackend)) throw new Error("Unsupported browser backend");
      desktopPreferences.browserBackend = browserBackend;
      persistDesktopPreferences();
      return { browserBackend, restartRequired: browserBackend !== configuredBrowserBackend };
    }
    if (method === "settings.setAgentPolicy") {
      const previousWebAccessEnabled = agentWebAccessEnabled();
      if (Object.prototype.hasOwnProperty.call(payload, "silentDownloadsEnabled")) {
        desktopPreferences.agentSilentDownloadsEnabled = payload.silentDownloadsEnabled === true;
      }
      if (Object.prototype.hasOwnProperty.call(payload, "webAccessEnabled")) {
        desktopPreferences.agentWebAccessEnabled = payload.webAccessEnabled === true;
      }
      persistDesktopPreferences();
      if (previousWebAccessEnabled !== agentWebAccessEnabled()) {
        agentIntegrationState = undefined;
        if (process.env.EGO_AGENT_INTEGRATION_DISABLED !== "1") syncAgentIntegrations();
      }
      return {
        silentDownloadsEnabled: agentSilentDownloadsEnabled(),
        webAccessEnabled: agentWebAccessEnabled(),
        downloadDirectory: agentDownloadDirectory(),
        localAgents: agentIntegrationStatus(),
      };
    }
    if (method === "settings.setControlHandoff") {
      desktopPreferences.controlConsentPolicyVersion = CONTROL_CONSENT_POLICY_VERSION;
      desktopPreferences.controlMode = payload.enabled === true ? "collaborative" : "agent";
      desktopPreferences.controlHandoffEnabled = payload.enabled === true;
      if (payload.enabled === true) desktopPreferences.autoCollaboration = true;
      for (const taskId of brokerSpaceStates.keys()) desktopScopedAutomation?.cancelTask(taskId, "Control mode changed");
      persistDesktopPreferences();
      const enabled = controlHandoffEnabled();
      if (rpc) {
        await rpc.request("control.mode.set", { clientId, mode: controlMode() });
        await rpc.request("control.policy.set", { clientId, policy: controlConsentPolicy() });
      }
      return { enabled, mode: controlMode(), autoCollaboration: desktopPreferences.autoCollaboration === true };
    }
    if (method === "settings.setControlMode") {
      const mode = normalizeControlMode(payload.mode);
      desktopPreferences.controlConsentPolicyVersion = CONTROL_CONSENT_POLICY_VERSION;
      desktopPreferences.controlMode = mode;
      desktopPreferences.controlHandoffEnabled = mode !== "agent";
      if (mode === "collaborative") desktopPreferences.autoCollaboration = true;
      for (const taskId of brokerSpaceStates.keys()) desktopScopedAutomation?.cancelTask(taskId, "Control mode changed");
      persistDesktopPreferences();
      if (rpc) {
        await rpc.request("control.mode.set", { clientId, mode });
        await rpc.request("control.policy.set", { clientId, policy: controlConsentPolicy() });
      }
      return { mode, enabled: mode !== "agent", autoCollaboration: desktopPreferences.autoCollaboration === true };
    }
    if (method === "settings.setAutoCollaboration") {
      desktopPreferences.autoCollaboration = payload.enabled === true;
      persistDesktopPreferences();
      return { enabled: desktopPreferences.autoCollaboration };
    }
    if (method === "settings.setControlPolicy") {
      desktopPreferences.controlConsentPolicyVersion = CONTROL_CONSENT_POLICY_VERSION;
      desktopPreferences.controlConsentEnabled = payload.enabled === true;
      desktopPreferences.controlConsentLevel = normalizeControlConsentLevel(payload.level);
      persistDesktopPreferences();
      const policy = controlConsentPolicy();
      if (rpc) await rpc.request("control.policy.set", { clientId, policy });
      return {
        enabled: desktopPreferences.controlConsentEnabled,
        level: desktopPreferences.controlConsentLevel,
        policy,
      };
    }
    if (method === "profiles.list") return listBrowserProfiles();
    if (method === "profiles.create") return createBrowserProfile(payload);
    if (method === "profiles.rename") return renameBrowserProfile(payload);
    if (method === "profiles.remove") return removeBrowserProfile(payload);
    if (method === "settings.restart") {
      isQuitting = true;
      await stopSpawnedBroker();
      app.relaunch();
      exitDesktopApp(0);
      return true;
    }
    if (method === "resources.snapshot") return desktopResourceSnapshot();
    if (method === "companion.install") return startCompanionInstaller();
    if (method === "companion.status") return companionStatus();
    if (!rpc && method === "state") {
      return {
        backend: { kind: "managed", ready: false, message: "正在连接本地 Broker" },
        shell: { homeBarShortcut, homeBarShortcutRegistered, trayReady: Boolean(tray) },
        onboarding: { completed: process.env.EGO_DESKTOP_ONBOARDING === "0" || desktopPreferences.onboardingCompleted },
        spaces: [], tabs: [], groups: [], collections: [], extensions: listBrowserExtensions(),
        profiles: listBrowserProfiles(),
      };
    }
    if (!rpc) throw new Error("Ego Broker is still connecting");
    switch (method) {
      case "state":
        return loadState(payload.query);
      case "control.inspect":
        return rpc.request("space.observe", { clientId, id: Number(payload.id) });
      case "control.assign": {
        const request = await rpc.request("space.requestControl", { clientId, id: Number(payload.id), targetClientId: required(payload.targetClientId, "targetClientId") });
        return rpc.request("space.approveControl", { clientId, id: Number(payload.id), requestId: request.id });
      }
      case "control.approve":
        return rpc.request("space.approveControl", { clientId, id: Number(payload.id), requestId: required(payload.requestId, "requestId") });
      case "desktop.userInteraction": {
        if (!desktopPreferences.autoCollaboration || controlMode() !== "collaborative") return { interactionPending: false };
        const tab = desktopTabs.get(required(payload.targetId, "targetId"));
        if (!tab || tab.webContentsId !== activeWebviewId) return { interactionPending: false };
        if (desktopBrowser.isAutomatedInput(webContents.fromId(tab.webContentsId))) return { interactionPending: false };
        const space = brokerSpaceStates.get(tab.taskId);
        if (!space || space.agentBlocked) return { interactionPending: false };
        return rpc.request("desktop.userInteraction", { clientId, id: space.id });
      }
      case "browserImport.sources":
        return discoverImportSources();
      case "browserImport.extensions.sources":
        return discoverImportExtensionSources();
      case "browserImport.extensions.import":
        return importBrowserExtensions(payload);
      case "extensions.repository.list":
        return listExtensionRepository();
      case "extensions.repository.install":
        return installRepositoryExtension(required(payload.id, "id"));
      case "browserImport.run":
        return runBrowserImport(payload);
      case "onboarding.complete":
        desktopPreferences.onboardingCompleted = true;
        persistDesktopPreferences();
        return true;
      case "task.create": {
        const profileId = normalizeBrowserProfileId(payload.profileId);
        if (!findBrowserProfile(profileId)) throw new Error("找不到指定的浏览器 Profile");
        const task = await rpc.request("space.create", { clientId, name: required(payload.name, "name"), profileId });
        selectedTask = { id: task.id, epoch: task.leaseEpoch };
        return task;
      }
      case "task.rename":
        return rpc.request("space.rename", {
          clientId,
          id: Number(payload.id),
          name: required(payload.name, "name"),
        });
      case "task.reorder":
        return rpc.request("space.reorder", {
          clientId,
          ids: Array.isArray(payload.ids) ? payload.ids.map(Number) : [],
        });
      case "task.select":
      case "task.activate":
        return activateTask(Number(payload.id));
      case "task.close": {
        const id = Number(payload.id);
        if (cosWorkspace.describe().workspace?.id === id) return cosWorkspace.disable();
        await rpc.request("space.forceClose", { clientId, id });
        if (selectedTask?.id === id) selectedTask = undefined;
        return true;
      }
      case "task.handoff":
        await selectTask(Number(payload.id));
        await rpc.request("space.handoff", mutation());
        return true;
      case "task.takeover": {
        requireControlHandoffEnabled();
        const task = await rpc.request("space.userTakeover", { clientId, id: Number(payload.id) });
        selectedTask = { id: task.id, epoch: task.leaseEpoch };
        return task;
      }
      case "task.stop": {
        requireControlHandoffEnabled();
        const task = await rpc.request("space.stop", { clientId, id: Number(payload.id) });
        selectedTask = { id: task.id, epoch: task.leaseEpoch };
        return task;
      }
      case "task.return": {
        requireControlHandoffEnabled();
        const task = await rpc.request("space.returnToAgent", { clientId, id: Number(payload.id) });
        selectedTask = { id: task.id, epoch: task.leaseEpoch };
        return task;
      }
      case "smoke.userInput": {
        if (!process.env.EGO_DESKTOP_SMOKE_RESULT) throw new Error("Smoke-only method");
        const target = webContents.fromId(activeWebviewId);
        if (!target) throw new Error("No active WebView for native input smoke");
        target.focus();
        target.sendInputEvent({ type: "keyDown", keyCode: "F8" });
        target.sendInputEvent({ type: "keyUp", keyCode: "F8" });
        return true;
      }
      case "smoke.agentStart": {
        if (!process.env.EGO_DESKTOP_SMOKE_RESULT) throw new Error("Smoke-only method");
        smokeAgentRpc ||= await PipeRpcClient.connect(pipeName);
        const result = await smokeAgentRpc.request("agent.register", { clientId: "codex-mcp-desktop-smoke", clientKind: "codex", displayName: "Codex Smoke", version: "smoke" });
        const spaces = await smokeAgentRpc.request("space.list", { clientId: "codex-mcp-desktop-smoke" });
        const target = spaces.taskSpaces.find((item) => item.name === "Desktop smoke");
        if (!target) throw new Error("Smoke task was not found for agent");
        const request = await smokeAgentRpc.request("space.requestControl", { clientId: "codex-mcp-desktop-smoke", id: target.id });
        const granted = await rpc.request("space.approveControl", { clientId, id: target.id, requestId: request.id });
        return granted.space;
      }
      case "smoke.agentDisconnect":
        if (!process.env.EGO_DESKTOP_SMOKE_RESULT) throw new Error("Smoke-only method");
        smokeAgentRpc?.socket.destroy();
        smokeAgentRpc = undefined;
        return true;
      case "smoke.agentReconnect":
        if (!process.env.EGO_DESKTOP_SMOKE_RESULT) throw new Error("Smoke-only method");
        smokeAgentRpc = await PipeRpcClient.connect(pipeName);
        return smokeAgentRpc.request("agent.register", { clientId: "codex-mcp-desktop-smoke", clientKind: "codex", displayName: "Codex Smoke", version: "smoke" });
      case "smoke.agentClaim": {
        if (!process.env.EGO_DESKTOP_SMOKE_RESULT || !smokeAgentRpc) throw new Error("Smoke agent is not connected");
        const spaces = await smokeAgentRpc.request("space.list", { clientId: "codex-mcp-desktop-smoke" });
        const target = spaces.taskSpaces.find((item) => item.name === "Desktop smoke");
        if (!target) throw new Error("Smoke task was not found for agent");
        return smokeAgentRpc.request("space.takeover", { clientId: "codex-mcp-desktop-smoke", id: target.id });
      }
      case "smoke.agentRecord": {
        if (!smokeAgentRpc) throw new Error("Smoke agent is not connected");
        return smokeAgentRpc.request("operation.record", { clientId: "codex-mcp-desktop-smoke", id: required(payload.id, "id"), tool: required(payload.tool, "tool"), title: required(payload.title, "title"), status: required(payload.status, "status"), startedAt: required(payload.startedAt, "startedAt"), ...(payload.finishedAt ? { finishedAt: payload.finishedAt } : {}) });
      }
      case "smoke.capture": {
        const capturePath = process.env.EGO_DESKTOP_CAPTURE_NEW_TAB;
        if (!process.env.EGO_DESKTOP_SMOKE_RESULT || !capturePath) return false;
        const image = await mainWindow.webContents.capturePage();
        writeFileSync(capturePath, image.toPNG());
        return true;
      }
      case "tab.open": {
        const url = normalizedUrl(payload.url);
        const releaseVisualIntent = payload.visual === true
          ? queueVisualTabOpenIntent(payload.taskId, url)
          : () => {};
        try {
          return await rpc.request("tab.openUrl", {
            clientId,
            url,
            ...(payload.taskId ? { taskId: payload.taskId } : {}),
          });
        } finally {
          releaseVisualIntent();
        }
      }
      case "tab.activate": {
        const targetId = required(payload.targetId, "targetId");
        if (payload.visual === true) visualActivationTargets.set(targetId, payload.selectionRevision);
        try {
          return await rpc.request("tab.activate", { clientId, targetId });
        } finally {
          visualActivationTargets.delete(targetId);
        }
      }
      case "tab.close":
        return rpc.request("tab.close", { clientId, targetId: required(payload.targetId, "targetId") });
      case "tab.preview":
        return captureTabPreview(required(payload.targetId, "targetId"));
      case "tab.preferences":
        return updateDesktopTabPreferences(payload);
      case "tab.reorder":
        return reorderDesktopTabs(payload);
      case "collection.save":
        return rpc.request("collection.save", {
          clientId,
          text: required(payload.text, "text"),
          ...(payload.sourceUrl ? { sourceUrl: payload.sourceUrl } : {}),
        });
      case "collection.library":
      case "collection.bookmark":
      case "collection.folderSave":
      case "collection.libraryMove":
      case "collection.trash":
      case "collection.restore":
        return rpc.request(method, { ...payload, clientId });
      case "collection.update":
        return rpc.request("collection.update", {
          clientId,
          id: required(payload.id, "id"),
          ...(Object.prototype.hasOwnProperty.call(payload, "group") ? { group: typeof payload.group === "string" ? payload.group : "" } : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, "text") ? { text: required(payload.text, "text") } : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, "pageTitle") ? { pageTitle: typeof payload.pageTitle === "string" ? payload.pageTitle : "" } : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, "tags") ? { tags: Array.isArray(payload.tags) ? payload.tags : [] } : {}),
        });
      case "collection.move":
        return rpc.request("collection.move", {
          clientId,
          ids: requiredArray(payload.ids, "ids"),
          group: typeof payload.group === "string" ? payload.group : "",
        });
      case "collection.delete":
        return Array.isArray(payload.ids)
          ? rpc.request("collection.delete", { clientId, ids: payload.ids })
          : rpc.request("collection.delete", { clientId, id: required(payload.id, "id") });
      case "collection.merge":
        return rpc.request("collection.merge", {
          clientId,
          ids: requiredArray(payload.ids, "ids"),
          ...(payload.primaryId ? { primaryId: payload.primaryId } : {}),
        });
      case "collection.importFile": {
        let filePath = process.env.EGO_DESKTOP_SMOKE_RESULT && typeof payload.testPath === "string" ? payload.testPath : "";
        if (!filePath) {
          const result = await dialog.showOpenDialog(mainWindow, {
            title: "导入收藏内容",
            properties: ["openFile"],
            filters: [
              { name: "收藏文件", extensions: ["json", "html", "htm"] },
              { name: "JSON", extensions: ["json"] },
              { name: "Bookmarks HTML", extensions: ["html", "htm"] },
            ],
          });
          if (result.canceled || !result.filePaths[0]) return { canceled: true, added: 0, skipped: 0 };
          filePath = result.filePaths[0];
        }
        const content = readFileSync(filePath, "utf8");
        const extension = extname(filePath).toLowerCase();
        if (![".json", ".html", ".htm"].includes(extension)) throw new Error("仅支持 JSON 或书签 HTML 文件");
        const { entries, folders } = extension === ".json"
          ? parseLibraryJson(content)
          : await mainWindow.webContents.executeJavaScript(`(${parseBookmarksDocument.toString()})(${JSON.stringify(content)})`);
        const result = await rpc.request("collection.importLibrary", { clientId, entries, folders });
        return { canceled: false, ...result, scanned: entries.length };
      }
      case "collection.export": {
        const library = await rpc.request("collection.library", { clientId });
        let items = await rpc.request("collection.list", {
          clientId,
          ...(typeof payload.query === "string" && payload.query ? { query: payload.query } : {}),
        });
        if (!Array.isArray(items)) items = [];
        if (Array.isArray(payload.ids)) {
          const ids = new Set(payload.ids);
          items = items.filter(item => ids.has(item.id));
        }
        const folderIds = new Set(Array.isArray(payload.folderIds) ? payload.folderIds : library.folders.map(folder => folder.id));
        for (const item of items) folderIds.add(item.folderId || "other");
        for (const id of [...folderIds]) {
          let folder = library.folders.find(entry => entry.id === id);
          const seen = new Set();
          while (folder?.parentId && !seen.has(folder.id)) {
            seen.add(folder.id);
            folderIds.add(folder.parentId);
            folder = library.folders.find(entry => entry.id === folder.parentId);
          }
        }
        const folders = library.folders.filter(folder => !folder.deletedAt && folderIds.has(folder.id));
        if (payload.group === "__ungrouped__") items = items.filter((item) => !item.group);
        else if (typeof payload.group === "string" && payload.group) items = items.filter((item) => item.group === payload.group);
        const format = ["json", "bookmarks-html"].includes(payload.format) ? payload.format : "markdown";
        const exportItems = format === "bookmarks-html" ? items.filter((item) => item.sourceUrl && item.kind !== "excerpt") : items;
        let filePath = process.env.EGO_DESKTOP_SMOKE_RESULT && typeof payload.testPath === "string" ? payload.testPath : "";
        if (!filePath) {
          const result = await dialog.showSaveDialog(mainWindow, {
            title: "导出收藏内容",
            defaultPath: `ego-collections.${format === "json" ? "json" : format === "bookmarks-html" ? "html" : "md"}`,
            filters: format === "json"
              ? [{ name: "JSON", extensions: ["json"] }]
              : format === "bookmarks-html"
                ? [{ name: "Bookmarks HTML", extensions: ["html", "htm"] }]
                : [{ name: "Markdown", extensions: ["md"] }],
          });
          if (result.canceled || !result.filePath) return { canceled: true, count: 0 };
          filePath = result.filePath;
        }
        mkdirSync(dirname(filePath), { recursive: true });
        const content = format === "json"
          ? JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), folders, collections: exportItems }, null, 2)
          : format === "bookmarks-html" ? libraryToBookmarksHtml(exportItems, folders) : collectionsToMarkdown(exportItems);
        writeFileSync(filePath, content, "utf8");
        return { canceled: false, count: exportItems.length, path: filePath };
      }
      case "conversation.load":
        return conversationFor(required(payload.taskId, "taskId"));
      case "conversation.save":
        return saveConversation(required(payload.taskId, "taskId"), payload.conversation);
      case "conversation.clear":
        return clearConversation(required(payload.taskId, "taskId"), payload.mode);
      case "operation.list":
        return rpc.request("operation.list", {
          clientId,
          taskId: required(payload.taskId, "taskId"),
          limit: typeof payload.limit === "number" ? payload.limit : 200,
        });
      case "operation.clear":
        return rpc.request("operation.clear", {
          clientId,
          taskId: required(payload.taskId, "taskId"),
        });
      case "operation.testRecord": {
        if (!process.env.EGO_DESKTOP_SMOKE_RESULT) throw new Error("Test operation recording is unavailable");
        return rpc.request("operation.record", {
          clientId,
          id: required(payload.id, "id"),
          tool: required(payload.tool, "tool"),
          title: required(payload.title, "title"),
          detail: typeof payload.detail === "string" ? payload.detail : "",
          status: required(payload.status, "status"),
          startedAt: payload.startedAt || new Date().toISOString(),
          ...(payload.finishedAt ? { finishedAt: payload.finishedAt } : {}),
        });
      }
      case "clipboard.writeText": {
        if (typeof payload.text !== "string") throw new Error("text is required");
        const text = payload.text;
        clipboard.writeText(text);
        return { written: true };
      }
      case "attachment.pickFiles": {
        const taskId = required(payload.taskId, "taskId");
        let paths;
        if (process.env.EGO_DESKTOP_SMOKE_RESULT && (Array.isArray(payload.testPaths) || process.env.EGO_DESKTOP_SMOKE_ATTACHMENT)) {
          paths = Array.isArray(payload.testPaths) ? payload.testPaths : [process.env.EGO_DESKTOP_SMOKE_ATTACHMENT];
        } else {
          const result = await dialog.showOpenDialog(mainWindow, {
            properties: ["openFile", "multiSelections"],
            filters: [
              { name: "Images and text", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "txt", "md", "json", "csv", "tsv", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "html", "xml", "yaml", "yml", "py", "java", "cs", "cpp", "c", "h", "sql", "log"] },
              { name: "All files", extensions: ["*"] },
            ],
          });
          if (result.canceled) return [];
          paths = result.filePaths;
        }
        return chatAttachments.ingestPaths(taskId, paths);
      }
      case "attachment.capturePage": {
        const taskId = required(payload.taskId, "taskId");
        const target = await desktopTarget({ targetId: payload.targetId });
        const image = await captureDesktopPageImage(target);
        return chatAttachments.saveNativeImage(taskId, image, `${target.getTitle() || "page"}.png`, "page-screenshot");
      }
      case "attachment.clipboardImage": {
        const taskId = required(payload.taskId, "taskId");
        return chatAttachments.saveNativeImage(taskId, clipboard.readImage(), "Clipboard image.png", "clipboard");
      }
      case "chat.pageContent":
        return rpc.request("chat.pageContent", {
          clientId,
          targetId: required(payload.targetId, "targetId"),
        });
      case "chat.stream.start":
        {
        const taskId = required(payload.taskId, "taskId");
        const attachments = chatAttachments.resolve(taskId, payload.attachments || []);
        return rpc.request("chat.stream.start", {
          clientId,
          requestId: required(payload.requestId, "requestId"),
          prompt: required(payload.prompt, "prompt"),
          context: payload.context || "",
          attachments,
        });
        }
      case "chat.stream.cancel":
        return rpc.request("chat.stream.cancel", {
          clientId,
          requestId: required(payload.requestId, "requestId"),
        });
      case "chat.send":
        return rpc.request("chat.send", { clientId, prompt: required(payload.prompt, "prompt"), context: payload.context || "" });
      default:
        throw new Error(`Unsupported desktop method: ${method}`);
    }
  });
}

async function dispatchDesktopAutomation(method, payload = {}) {
  if (method === "package.status") return cosWorkspace.statusService.status(payload);
  if (method === "package.wait") return cosWorkspace.statusService.wait(payload);
  if (method === "agent.knownStatus") return cosWorkspace.statusService.agents(payload);
  if (method === "automation.request") {
    if (!payload[TRUSTED_BRIDGE_REQUEST] || !payload.__egoMutation) throw new Error("Automation requires the authenticated Broker");
    const context = { ...mutationGate.current(), profileId: desktopSpaces.get(payload.taskId)?.profileId || "default" };
    if (!context.clientId || context.taskId !== payload.taskId) throw new Error("Automation scope is unavailable");
    const input = payload.input || {};
    if (payload.operation === "begin") return automationDecisions.begin(context, input);
    if (payload.operation === "end") return automationDecisions.end(context, input.runId);
    if (payload.operation === "cancel") {
      const job = automationDecisions.jobs.get(input.runId);
      if (job?.context.clientId !== context.clientId || job?.context.taskId !== context.taskId) throw new Error("Automation scope changed");
      return automationDecisions.cancel(input.runId);
    }
    if (payload.operation === "check") {
      await automationDecisions.check(context, input.runId, input.targetId);
      return { active: true };
    }
    if (payload.operation === "decide") {
      const tab = desktopTabs.get(input.targetId);
      if (!tab || tab.taskId !== context.taskId) throw new Error("Automation page is unavailable");
      const target = webContents.fromId(tab.webContentsId);
      if (!target || target.isDestroyed()) throw new Error("Automation page closed");
      const url = target.getURL();
      if (url !== input.url) throw Object.assign(new Error("Page changed before decision"), { code: "EGO_REFERENCE_STALE" });
      return automationDecisions.decide(context, { ...input, url });
    }
    throw new Error("Unsupported automation operation");
  }
  if (method === "desktop.status") {
    const ready = Boolean(mainWindow && !mainWindow.isDestroyed());
    const visible = ready
      ? await hostRequest("task.visual-state", {}, 500).catch(() => null)
      : null;
    return {
      kind: "desktop",
      ready,
      connected: ready,
      automation: desktopAutomationCapabilities(Boolean(scopedReferencesEnabled && desktopScopedAutomation), scopedReferenceActionTtlMs),
      ...(scopedReferencesEnabled && desktopScopedAutomation ? {
        capabilities: [SCOPED_REFS_CAPABILITY],
        referenceActionMaxLifetimeMs: scopedReferenceActionTtlMs,
      } : {}),
      ...(activeWebviewId ? { activeWebviewId } : {}),
      ...(visible ? { visible } : {}),
    };
  }
  switch (method) {
    case "space.updateState":
      updateBrokerSpaceState(payload);
      return true;
    case "space.create":
      ensureBrowserProfileSession(payload.profileId);
      desktopSpaces.set(required(payload.taskId, "taskId"), {
        name: required(payload.name, "name"),
        profileId: normalizeBrowserProfileId(payload.profileId),
      });
      markFreshDesktopSpaceRestored(payload.taskId);
      if (payload.visualSync === true) {
        await hostRequest("task.visual-select", { taskId: payload.taskId });
      }
      return true;
    case "space.select":
      if (payload.visualSync === true) {
        await hostRequest("task.visual-select", { taskId: required(payload.taskId, "taskId") });
      }
      return true;
    case "space.close": {
      const taskId = required(payload.taskId, "taskId");
      for (const tab of [...desktopTabs.values()].filter((item) => item.taskId === taskId)) {
        await closeDesktopTab(tab.targetId);
      }
      desktopSpaces.delete(taskId);
      restoredDesktopTasks.add(taskId);
      persistDesktopTabs();
      if (payload.visualSync === true) {
        await hostRequest("task.visual-close", { taskId });
      }
      return true;
    }
    case "tabs.list": {
      const taskId = payload.taskId || activeDesktopTab()?.taskId;
      if (!taskId) return [];
      await ensureDesktopTabsRestored(taskId);
      return [...desktopTabs.values()].filter((tab) => tab.taskId === taskId).map(publicDesktopTab);
    }
    case "tabs.create": {
      const taskId = payload.taskId || required(activeDesktopTab()?.taskId, "taskId");
      return createDesktopTab(taskId, normalizedUrl(payload.url || "about:blank"));
    }
    case "tabs.activate":
      return activateDesktopTab(required(payload.targetId, "targetId"));
    case "tabs.close":
      return closeDesktopTab(payload.targetId || required(activeDesktopTab()?.targetId, "targetId"));
    case "page.info": return desktopBrowser.pageInfo(await desktopTarget(payload));
    case "page.snapshot": {
      const requestContext = payload.__egoRequestContext;
      if (requestContext?.refFormat === "scoped-v1") {
        if (!payload[TRUSTED_BRIDGE_REQUEST] || !scopedReferencesEnabled) {
          throw Object.assign(new Error("Scoped references require the authenticated Broker bridge"), { code: "EGO_ACTION_CONTEXT_INVALID" });
        }
        const tab = payload.targetId
          ? desktopTabs.get(payload.targetId)
          : [...desktopTabs.values()].find((item) => item.taskId === payload.taskId && item.active);
        if (!tab || tab.taskId !== payload.taskId) throw Object.assign(new Error("Scoped snapshot page is unavailable"), { code: "EGO_REFERENCE_STALE" });
        await ensureDesktopScopedPage(tab);
        try {
          return await desktopScopedAutomation.snapshot({
            pageScope: scopedPageScope(tab),
            clientId: required(requestContext.clientId, "requestContext.clientId"),
            options: payload.options,
          });
        } finally {
          await drainDesktopScopedRouterEffects();
        }
      }
      return desktopBrowser.snapshot(await desktopTarget(payload), payload.options);
    }
    case "page.click": return desktopBrowser.click(await desktopTarget(payload), requiredNumber(payload.backendNodeId, "backendNodeId"));
    case "page.fill": return desktopBrowser.fill(await desktopTarget(payload), requiredNumber(payload.backendNodeId, "backendNodeId"), required(payload.value, "value"));
    case "page.hover": return desktopBrowser.hover(await desktopTarget(payload), requiredNumber(payload.backendNodeId, "backendNodeId"));
    case "page.press": return desktopBrowser.press(await desktopTarget(payload), required(payload.key, "key"));
    case "page.type": return desktopBrowser.typeText(await desktopTarget(payload), required(payload.text, "text"));
    case "page.scroll": return desktopBrowser.scroll(await desktopTarget(payload), payload.deltaX, payload.deltaY);
    case "page.wait": return desktopBrowser.waitFor(await desktopTarget(payload), payload);
    case "page.evaluate": return desktopBrowser.evaluate(await desktopTarget(payload), required(payload.expression, "expression"));
    case "page.goto": return desktopBrowser.goto(await desktopTarget(payload), normalizedUrl(payload.url));
    case "page.navigate": return desktopBrowser.navigate(await desktopTarget(payload), required(payload.action, "action"));
    case "page.screenshot": return desktopBrowser.screenshot(await desktopTarget(payload));
    case "ref.bind":
    case "ref.bindGroup": {
      if (!payload[TRUSTED_BRIDGE_REQUEST] || !scopedReferencesEnabled) {
        throw Object.assign(new Error("Scoped references require the authenticated Broker bridge"), { code: "EGO_ACTION_CONTEXT_INVALID" });
      }
      const request = payload.request;
      const tab = desktopTabs.get(request?.expectedScope?.pageId);
      if (!tab || tab.taskId !== payload.taskId) throw Object.assign(new Error("Reference page is unavailable"), { code: "EGO_REFERENCE_STALE" });
      let registered = false;
      try {
        desktopFrameRouter.stats(scopedPageScope(tab));
        registered = true;
      } catch (error) {
        if (error?.code !== "UNKNOWN_PAGE") throw error;
      }
      if (!registered) await ensureDesktopScopedPage(tab);
      try {
        const bind = method === "ref.bindGroup" ? desktopScopedAutomation.bindReferenceActionGroup.bind(desktopScopedAutomation)
          : desktopScopedAutomation.bindReferenceAction.bind(desktopScopedAutomation);
        const binding = await bind({
          pageScope: scopedPageScope(tab),
          clientId: required(payload.__egoRequestContext?.clientId || payload.__egoMutation?.clientId, "clientId"),
          mutation: payload.__egoMutation,
          request,
        });
        if (binding.sessionId) {
          desktopScopedAliasPages.set(binding.sessionId, scopedPageScope(tab));
          desktopScopedRetiredAliases.delete(binding.sessionId);
        }
        return binding;
      } finally {
        await drainDesktopScopedRouterEffects();
      }
    }
    case "ref.release": {
      if (!payload[TRUSTED_BRIDGE_REQUEST] || !scopedReferencesEnabled) {
        throw Object.assign(new Error("Scoped references require the authenticated Broker bridge"), { code: "EGO_ACTION_CONTEXT_INVALID" });
      }
      return desktopScopedAutomation.releaseReferenceAction({
        taskId: required(payload.taskId, "taskId"),
        clientId: required(payload.__egoRequestContext?.clientId || payload.__egoMutation?.clientId, "clientId"),
        mutation: payload.__egoMutation,
        wire: payload.refAction,
      });
    }
    case "cdp.send": {
      const requestContext = payload.__egoRequestContext;
      if (requestContext?.refFormat === "scoped-v1") {
        if (!payload[TRUSTED_BRIDGE_REQUEST] || !scopedReferencesEnabled) {
          throw Object.assign(new Error("Scoped references require the authenticated Broker bridge"), { code: "EGO_ACTION_CONTEXT_INVALID" });
        }
        const request = JSON.parse(required(payload.payload, "payload"));
        if (!requestContext.refAction) {
          return sendDesktopScopedRawCdp(required(payload.taskId, "taskId"), request, requestContext);
        }
        try {
          const result = await desktopScopedAutomation.dispatchCdp({
            taskId: required(payload.taskId, "taskId"),
            mutation: payload.__egoMutation,
            requestContext,
            payload: request,
          });
          return JSON.stringify({ id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
        } finally {
          await drainDesktopScopedRouterEffects();
        }
      }
      return sendDesktopCdp(required(payload.taskId, "taskId"), required(payload.payload, "payload"), requestContext);
    }
    default: throw new Error(`Unsupported desktop automation method: ${method}`);
  }
}

async function dispatchDesktopPluginAutomation(method, payload = {}) {
  if (method === "package.update" || method === "package.rollback") {
    cosWorkspace.authorizeMaintenance(payload.__cosMaintenanceToken);
    return method === "package.update" ? cosWorkspace.update(required(payload.directory, "directory")) : cosWorkspace.rollback();
  }
  const suppliedToken = typeof payload.__egoBridgeToken === "string" ? Buffer.from(payload.__egoBridgeToken) : Buffer.alloc(0);
  const expectedToken = Buffer.from(desktopControlToken || "");
  const trustedBridge = expectedToken.length >= 32 && suppliedToken.length === expectedToken.length && timingSafeEqual(suppliedToken, expectedToken);
  if (trustedBridge) payload = { ...payload, [TRUSTED_BRIDGE_REQUEST]: true };
  if (method === "automation.request" && (!trustedBridge || !payload.__egoMutation)) throw new Error("Automation requires an authenticated Agent lease");
  const scopedBridgeRequest = payload.__egoRequestContext?.refFormat === "scoped-v1"
    || Boolean(payload.__egoRequestContext?.refAction)
    || method === "ref.bind"
    || method === "ref.bindGroup"
    || method === "ref.release";
  if (scopedBridgeRequest && !trustedBridge) {
    throw Object.assign(new Error("Scoped references require Broker bridge authentication"), { code: "EGO_ACTION_CONTEXT_INVALID" });
  }
  if (method.startsWith("space.")) {
    if (!trustedBridge) throw new Error("Desktop lifecycle requests require Broker authentication");
    return dispatchDesktopAutomation(method, payload);
  }
  const readOnly = ["desktop.status", "package.status", "package.wait", "agent.knownStatus", "tabs.list", "page.info", "page.snapshot", "page.screenshot", "page.wait"].includes(method);
  if (readOnly) return dispatchDesktopAutomation(method, payload);
  // Broker-only UI commands carry no Agent lease. Their RPC entrypoints require
  // the desktop token; ordinary Agent calls always carry __egoMutation.
  if (trustedBridge && !payload.__egoMutation) return dispatchDesktopAutomation(method, payload);
  const taskId = desktopTaskIdFromPayload(payload);
  if (!taskId) throw new Error("No workspace selected for automation");
  if (method === "control.request") {
    const actor = required(payload.__egoClientId, "Agent identity");
    if (actor.startsWith("desktop-")) throw new Error("Desktop MCP cannot impersonate the user");
    const state = await rpc.request("space.list", { clientId });
    const space = state.taskSpaces.find((item) => item.taskId === taskId);
    if (!space) throw new Error("Workspace is unavailable");
    return rpc.request("space.requestControl", { clientId, id: space.id, targetClientId: actor });
  }
  const supplied = payload.__egoMutation;
  const actor = trustedBridge ? supplied?.clientId : required(payload.__egoClientId, "Agent identity");
  if (!trustedBridge && actor.startsWith("desktop-")) throw new Error("Desktop MCP cannot impersonate the user");
  if (method !== "mutation.context" && (!supplied || !Number.isInteger(supplied.leaseEpoch))) throw new Error("Mutation requires a versioned Agent lease");
  const context = await rpc.request("mutation.assert", { clientId, taskId, actorClientId: actor, leaseEpoch: supplied?.leaseEpoch, renew: method === "mutation.context" });
  updateBrokerSpaceState({ space: context.space });
  if (method === "mutation.context") return context;
  return mutationGate.run(context, () => dispatchLoggedDesktopAutomation(method, payload));
}

async function dispatchLoggedDesktopAutomation(method, payload) {
  mutationGate.assertMutationAllowed(desktopTaskIdFromPayload(payload));
  if (payload.__egoSource !== "desktop-mcp") return dispatchDesktopAutomation(method, payload);
  markRecentDesktopAgentTask(payload);
  const operation = desktopPluginOperation(method, payload);
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  await recordDesktopPluginOperation({ id, ...operation, status: "running", startedAt });
  try {
    const result = await dispatchDesktopAutomation(method, payload);
    await recordDesktopPluginOperation({ id, ...operation, status: "completed", startedAt, finishedAt: new Date().toISOString() });
    return result;
  } catch (error) {
    await recordDesktopPluginOperation({
      id,
      ...operation,
      detail: `${operation.detail ? `${operation.detail}\n` : ""}${error instanceof Error ? error.message : String(error)}`,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    throw error;
  }
}

function activeDesktopTab() {
  return [...desktopTabs.values()].find((tab) => tab.webContentsId === activeWebviewId)
    || [...desktopTabs.values()].find((tab) => tab.active);
}

function extensionHostTab(tab) {
  return { id: tab.webContentsId, targetId: tab.targetId, windowId: mainWindow?.id || 1, active: tab.webContentsId === activeWebviewId, url: tab.url, title: tab.title, index: tab.order || 0, incognito: false };
}

function markRecentDesktopAgentTask(payload) {
  const taskId = desktopTaskIdFromPayload(payload);
  if (taskId) recentDesktopAgentTasks.set(taskId, Date.now());
}

function desktopTaskIdFromPayload(payload = {}) {
  if (typeof payload.taskId === "string" && payload.taskId) return payload.taskId;
  if (typeof payload.targetId === "string" && payload.targetId) return desktopTabs.get(payload.targetId)?.taskId || "";
  if (Number.isInteger(payload.webContentsId)) {
    return [...desktopTabs.values()].find((tab) => tab.webContentsId === payload.webContentsId)?.taskId || "";
  }
  return activeDesktopTab()?.taskId || "";
}

function desktopPluginOperation(method, payload) {
  const definitions = {
    "desktop.status": ["ego_desktop_status", "检查浏览器状态"],
    "page.info": ["ego_desktop_page_info", "读取当前页面"],
    "page.goto": ["ego_desktop_open", "打开网页"],
    "page.navigate": ["ego_desktop_navigate", "执行页面导航"],
    "page.snapshot": ["ego_desktop_snapshot", "读取页面结构"],
    "page.click": ["ego_desktop_click", "点击页面元素"],
    "page.fill": ["ego_desktop_fill", "填写输入框"],
    "page.hover": ["ego_desktop_hover", "悬停页面元素"],
    "page.press": ["ego_desktop_press", "发送键盘按键"],
    "page.type": ["ego_desktop_type", "输入文本"],
    "page.scroll": ["ego_desktop_scroll", "滚动页面"],
    "page.wait": ["ego_desktop_wait", "等待页面状态"],
    "page.evaluate": ["ego_desktop_evaluate", "执行页面脚本"],
    "page.screenshot": ["ego_desktop_screenshot", "截取页面画面"],
    "tabs.list": ["ego_desktop_tabs", "读取标签页列表"],
    "tabs.create": ["ego_desktop_new_tab", "新建标签页"],
    "tabs.activate": ["ego_desktop_switch_tab", "切换标签页"],
    "tabs.close": ["ego_desktop_close_tab", "关闭标签页"],
  };
  const [tool, title] = definitions[method] || [method, "操作浏览器"];
  const detail = method === "page.goto" || method === "tabs.create" ? String(payload.url || "about:blank")
    : method === "page.navigate" ? String(payload.action || "")
      : method === "page.press" ? String(payload.key || "")
        : "";
  return { tool, title, detail: detail.length > 500 ? `${detail.slice(0, 497)}...` : detail };
}

async function recordDesktopPluginOperation(record) {
  const taskId = activeDesktopTab()?.taskId;
  if (!rpc || !taskId) return;
  await rpc.request("operation.record", { clientId, taskId, ...record }).catch(() => {});
}

async function createDesktopTab(taskId, url, options = {}) {
  mutationGate.assertMutationAllowed(taskId);
  if (!options.restoreRecord && !restoredDesktopTasks.has(taskId)) await ensureDesktopTabsRestored(taskId);
  const targetId = `desktop-target-${randomUUID()}`;
  const queuedVisual = consumeVisualTabOpenIntent(taskId, url);
  const visual = options.visual === true || queuedVisual;
  const restoreRecord = options.restoreRecord && typeof options.restoreRecord === "object" ? options.restoreRecord : null;
  const sleeping = restoreRecord?.sleeping === true;
  const cosBrowser = cosWorkspace.enabled && cosWorkspace.taskId === taskId ? cosWorkspace.browser : null;
  const active = restoreRecord ? restoreRecord.active === true && !sleeping : options.active !== false;
  if (active) for (const tab of desktopTabs.values()) if (tab.taskId === taskId) tab.active = false;
  const order = Math.max(-1, ...[...desktopTabs.values()].filter((item) => item.taskId === taskId).map((item) => Number(item.order ?? -1))) + 1;
  const tab = {
    targetId,
    taskId,
    title: restoreRecord?.title || (isPlaceholderTabUrl(url) ? "新建标签页" : url),
    url: cosBrowser && !sleeping ? "about:blank" : url,
    active,
    order: Number.isFinite(restoreRecord?.order) ? restoreRecord.order : order,
    zoomFactor: Number.isFinite(restoreRecord?.zoomFactor) ? restoreRecord.zoomFactor : 1,
    lastActiveAt: restoreRecord?.lastActiveAt || new Date().toISOString(),
    ...(restoreRecord?.faviconUrl ? { faviconUrl: restoreRecord.faviconUrl } : {}),
    ...(restoreRecord?.pinned === true ? { pinned: true } : {}),
    ...(restoreRecord?.muted === true ? { muted: true } : {}),
    ...(sleeping ? { sleeping: true } : {}),
    ...(restoreRecord?.groupId ? { groupId: restoreRecord.groupId } : {}),
    ...(restoreRecord?.groupTitle ? { groupTitle: restoreRecord.groupTitle } : {}),
    ...(restoreRecord?.groupColor ? { groupColor: restoreRecord.groupColor } : {}),
    ...(restoreRecord?.groupCollapsed === true ? { groupCollapsed: true } : {}),
    webContentsId: undefined,
  };
  desktopTabs.set(targetId, tab);
  try {
    if (sleeping) {
      persistDesktopTabs();
      return publicDesktopTab(tab);
    }
    const created = await hostRequest("tab.create", {
      ...publicDesktopRecord(tab),
      workspace: brokerSpaceStates.get(taskId),
      profiles: listBrowserProfiles(),
      ...(visual ? { visual: true } : {}),
    });
    tab.webContentsId = requiredNumber(created.webContentsId, "webContentsId");
    if (cosBrowser) {
      await cosBrowser.prepareTab(tab);
      if (url !== "about:blank") await webviewContents(tab.webContentsId).loadURL(url);
    }
    // browser.register owns the visible selection. Background creation must not change it.
    persistDesktopTabs();
    return publicDesktopTab(tab);
  } catch (error) {
    desktopTabs.delete(targetId);
    throw error;
  }
}

function queueVisualTabOpenIntent(taskId, url) {
  if (!taskId) return () => {};
  const intent = { url, consumed: false };
  const intents = visualTabOpenIntents.get(taskId) || [];
  intents.push(intent);
  visualTabOpenIntents.set(taskId, intents);
  return () => {
    if (intent.consumed) return;
    const current = visualTabOpenIntents.get(taskId);
    if (!current) return;
    const index = current.indexOf(intent);
    if (index >= 0) current.splice(index, 1);
    if (current.length) visualTabOpenIntents.set(taskId, current);
    else visualTabOpenIntents.delete(taskId);
  };
}

function consumeVisualTabOpenIntent(taskId, url) {
  const intents = visualTabOpenIntents.get(taskId);
  if (!intents?.length) return false;
  const index = intents.findIndex((intent) => intent.url === url);
  if (index < 0) return false;
  const [intent] = intents.splice(index, 1);
  intent.consumed = true;
  if (intents.length) visualTabOpenIntents.set(taskId, intents);
  else visualTabOpenIntents.delete(taskId);
  return true;
}

async function activateDesktopTab(targetId, options = {}) {
  mutationGate.assertMutationAllowed(desktopTabs.get(targetId)?.taskId);
  const selected = desktopTabs.get(targetId);
  if (!selected) throw new Error(`Unknown desktop target: ${targetId}`);
  const selectionRevision = visualActivationTargets.get(targetId);
  const queuedVisual = visualActivationTargets.delete(targetId);
  const visual = options.visual === true || queuedVisual;
  const activated = await hostRequest("tab.activate", {
    ...publicDesktopRecord({ ...selected, active: true }),
    ...(visual ? { visual: true } : {}),
    ...(Number.isInteger(selectionRevision) ? { selectionRevision } : {}),
  });
  if (activated?.skipped || desktopTabs.get(targetId) !== selected) return false;
  for (const tab of desktopTabs.values()) {
    if (tab.taskId !== selected.taskId) continue;
    const active = tab.targetId === targetId;
    if (tab.active !== active) {
      tab.active = active;
      notifyDesktopTab(tab);
    }
  }
  selected.lastActiveAt = new Date().toISOString();
  if (activated?.webContentsId) selected.webContentsId = requiredNumber(activated.webContentsId, "webContentsId");
  if (visual && activeWebviewId === selected.webContentsId) targetedExtensionHost?.notifyTab('tabs.onActivated', { tabId: selected.webContentsId, windowId: mainWindow.id });
  if (options.persist !== false) persistDesktopTabs();
  return true;
}

const desktopTabCloser = new DesktopTabCloseCoordinator({
  getTab: (targetId) => desktopTabs.get(targetId),
  assertAllowed: (taskId) => mutationGate.assertMutationAllowed(taskId),
  closeHost: (tab) => hostRequest("tab.close", publicDesktopRecord(tab)),
  finalizeClosed: (tab) => {
    clearDesktopSessions(tab.targetId);
    desktopDownloadPaths.delete(tab.targetId);
    if (tab.webContentsId) desktopWebviewBindings.get(tab.webContentsId)?.dispose();
    desktopTabs.delete(tab.targetId);
    if (activeWebviewId === tab.webContentsId) activeWebviewId = undefined;
  },
  findReplacement: (taskId) => [...desktopTabs.values()]
    .filter((tab) => tab.taskId === taskId && tab.sleeping !== true)
    .sort((left, right) => Number(left.order ?? 0) - Number(right.order ?? 0))
    .at(-1),
  activate: (targetId) => activateDesktopTab(targetId, { persist: false }),
  persist: () => persistDesktopTabs(),
});

function closeDesktopTab(targetId) {
  return desktopTabCloser.close(targetId);
}

function updateDesktopTabPreferences(payload) {
  const targetId = required(payload.targetId, "targetId");
  const tab = desktopTabs.get(targetId);
  if (!tab) {
    if (typeof payload.muted === "boolean" && payload.webContentsId) {
      webviewContents(requiredNumber(payload.webContentsId, "webContentsId")).setAudioMuted(payload.muted);
    }
    return { targetId, pinned: payload.pinned === true, muted: payload.muted === true, zoomFactor: payload.zoomFactor };
  }
  if (typeof payload.pinned === "boolean") tab.pinned = payload.pinned;
  if (typeof payload.autoDiscardable === "boolean") tab.autoDiscardable = payload.autoDiscardable;
  if (typeof payload.sleeping === "boolean") tab.sleeping = payload.sleeping;
  if (typeof payload.groupId === "string") tab.groupId = payload.groupId || undefined;
  if (typeof payload.groupTitle === "string") tab.groupTitle = payload.groupTitle || undefined;
  if (typeof payload.groupColor === "string") tab.groupColor = payload.groupColor || undefined;
  if (typeof payload.groupCollapsed === "boolean") tab.groupCollapsed = payload.groupCollapsed;
  if (typeof payload.lastActiveAt === "string") tab.lastActiveAt = payload.lastActiveAt;
  if (typeof payload.muted === "boolean") {
    tab.muted = payload.muted;
    if (tab.webContentsId) webviewContents(tab.webContentsId).setAudioMuted(tab.muted);
  }
  if (typeof payload.zoomFactor === "number" && Number.isFinite(payload.zoomFactor)) {
    tab.zoomFactor = Math.min(2, Math.max(0.5, payload.zoomFactor));
  }
  notifyDesktopTab(tab);
  persistDesktopTabs();
  return publicDesktopTab(tab);
}

function reorderDesktopTabs(payload) {
  const taskId = required(payload.taskId, "taskId");
  if (!Array.isArray(payload.targetIds)) throw new Error("targetIds must be an array");
  const known = new Set([...desktopTabs.values()].filter((tab) => tab.taskId === taskId).map((tab) => tab.targetId));
  const ordered = payload.targetIds.filter((targetId) => typeof targetId === "string" && known.delete(targetId));
  ordered.push(...known);
  ordered.forEach((targetId, order) => {
    const tab = desktopTabs.get(targetId);
    if (tab) tab.order = order;
  });
  persistDesktopTabs();
  return ordered;
}

async function ensureDesktopTabsRestored(taskId) {
  if (restoredDesktopTasks.has(taskId)) return;
  const pending = desktopRestorePromises.get(taskId);
  if (pending) return pending;
  const restore = (async () => {
    const records = persistedDesktopTabs.filter((tab) => tab.taskId === taskId);
    if (!records.length) {
      restoredDesktopTasks.add(taskId);
      return;
    }
    let activeTargetId;
    for (const record of records) {
      const created = await createDesktopTab(taskId, normalizedUrl(record.url || "about:blank"), { restoreRecord: record });
      const tab = desktopTabs.get(created.targetId);
      if (!tab) continue;
      if (record.active && !record.sleeping) activeTargetId = tab.targetId;
    }
    restoredDesktopTasks.add(taskId);
    if (activeTargetId) await activateDesktopTab(activeTargetId);
    persistDesktopTabs();
  })();
  desktopRestorePromises.set(taskId, restore);
  try {
    await restore;
  } finally {
    desktopRestorePromises.delete(taskId);
  }
}

function bindDesktopWebview(tab, target) {
  const webContentsId = target.id;
  const existing = desktopWebviewBindings.get(target.id);
  if (existing?.targetId === tab.targetId && desktopBrowser.isObserving(target)) return;
  existing?.dispose();

  const disposeCdp = desktopBrowser.observe(target, (method, params, nestedSessionId) => {
    if (!nestedSessionId) notifyDesktopCdp(tab, method, params || {});
    if (scopedReferencesEnabled) void routeDesktopScopedDebuggerEvent(tab, method, params || {}, nestedSessionId);
  }, {
    onDetach: (reason) => closeDesktopScopedPage(tab, reason || "debugger_detached"),
  });
  bindDesktopDownloads(target.session);
  configureWebviewSession(target.session);
  target.setWindowOpenHandler(({ url, disposition }) => {
    void createDesktopTab(tab.taskId, normalizedPopupUrl(url), popupOpenPolicy({ sourceVisible: target.id === activeWebviewId, disposition })).catch((error) => {
      writeDiagnostic("desktop-popup-error.log", error);
      if (target.id === activeWebviewId) mainWindow?.webContents.send('ego:browser-open-error', { message: error.message });
    });
    return { action: "deny" };
  });
  const update = () => {
    if (target.isDestroyed()) return;
    tab.url = target.getURL() || tab.url;
    tab.title = isPlaceholderTabUrl(tab.url) ? "新建标签页" : target.getTitle() || tab.title;
    targetedExtensionHost?.notifyTab('tabs.onUpdated', target.id, { status: target.isLoading() ? 'loading' : 'complete', url: tab.url }, extensionHostTab(tab));
    notifyDesktopTab(tab);
    persistDesktopTabs();
  };
  const onFavicons = (_event, favicons) => {
    tab.faviconUrl = Array.isArray(favicons) && typeof favicons[0] === "string" ? favicons[0] : undefined;
    notifyDesktopTab(tab);
    persistDesktopTabs();
  };
  const onContextMenu = (_event, params) => showWebviewContextMenu(tab, target, params);
  const onTranslationNavigation = (_event, _url, inPlace, mainFrame) => {
    if (mainFrame) pageTranslations.cancel(tab.targetId, !inPlace);
  };
  const onBeforeInput = (event, input) => {
    const key = String(input?.key || "").toLowerCase();
    if (["keyDown", "rawKeyDown"].includes(input?.type) && key === "escape" && target.isLoading()) {
      event.preventDefault();
      target.stop();
      return;
    }
    routeBrowserShortcut(event, input, tab.targetId);
  };
  const onFoundInPage = (_event, result) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ego:browser-find-result", { targetId: tab.targetId, result });
  };
  const onRenderProcessGone = (_event, details) => {
    closeDesktopScopedPage(tab, details?.reason || "renderer_gone");
    notifyBrowserTabCrashed(tab, {
      reason: details?.reason || "crashed",
      message: "页面进程已停止，可以重新加载后继续。",
    });
  };
  const onUnresponsive = () => notifyBrowserTabCrashed(tab, {
    reason: "unresponsive",
    message: "页面暂时没有响应，可以等待或重新加载。",
  });
  const onResponsive = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ego:browser-tab-responsive", { targetId: tab.targetId });
  };
  let disposed = false;
  const onDestroyed = () => {
    pageTranslations.cancel(tab.targetId, true);
    targetedExtensionHost?.notifyTab('tabs.onRemoved', target.id, { windowId: mainWindow?.id || 1, isWindowClosing: false });
    cancelBrowserPrompts(target.id);
    closeDesktopScopedPage(tab, "webcontents_destroyed");
    dispose();
    clearDesktopSessions(tab.targetId);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeCdp();
    target.removeListener("did-navigate", update);
    target.removeListener("did-navigate-in-page", update);
    target.removeListener("did-stop-loading", update);
    target.removeListener("page-title-updated", update);
    target.removeListener("page-favicon-updated", onFavicons);
    target.removeListener("context-menu", onContextMenu);
    target.removeListener("did-start-navigation", onTranslationNavigation);
    target.removeListener("before-input-event", onBeforeInput);
    target.removeListener("found-in-page", onFoundInPage);
    target.removeListener("render-process-gone", onRenderProcessGone);
    target.removeListener("unresponsive", onUnresponsive);
    target.removeListener("responsive", onResponsive);
    target.removeListener("destroyed", onDestroyed);
    if (desktopWebviewBindings.get(webContentsId)?.dispose === dispose) desktopWebviewBindings.delete(webContentsId);
  };
  target.on("did-navigate", update);
  target.on("did-navigate-in-page", update);
  target.on("did-stop-loading", update);
  target.on("page-title-updated", update);
  target.on("page-favicon-updated", onFavicons);
  target.on("context-menu", onContextMenu);
  target.on("did-start-navigation", onTranslationNavigation);
  target.on("before-input-event", onBeforeInput);
  target.on("found-in-page", onFoundInPage);
  target.on("render-process-gone", onRenderProcessGone);
  target.on("unresponsive", onUnresponsive);
  target.on("responsive", onResponsive);
  target.once("destroyed", onDestroyed);
  desktopWebviewBindings.set(target.id, { targetId: tab.targetId, dispose });
}

function showWebviewContextMenu(tab, target, params) {
  const template = [
    { label: "翻译此页", enabled: /^https?:\/\//.test(target.getURL()), click: () => mainWindow?.webContents.send("ego:browser-command", { command: "translate-page", targetId: tab.targetId }) },
    { label: "后退", enabled: target.canGoBack(), click: () => target.goBack() },
    { label: "前进", enabled: target.canGoForward(), click: () => target.goForward() },
    { label: "刷新", click: () => target.reload() },
    { type: "separator" },
  ];
  const extensionItems = targetedExtensionHost?.contextMenu(extensionHostTab(tab), params) || [];
  if (extensionItems.length) template.push(...extensionItems, { type: 'separator' });
  if (params.linkURL) {
    template.push(
      { label: "在新标签中打开链接", click: () => void createDesktopTab(tab.taskId, normalizedPopupUrl(params.linkURL), { visual: true }).catch(error => mainWindow?.webContents.send('ego:browser-open-error', { message: error.message })) },
      { label: "复制链接地址", click: () => clipboard.writeText(params.linkURL) },
      { type: "separator" },
    );
  }
  if (params.isEditable) {
    template.push(
      { role: "cut", label: "剪切" },
      { role: "copy", label: "复制" },
      { role: "paste", label: "粘贴" },
      { type: "separator" },
    );
  } else if (params.selectionText) {
    template.push(
      { label: "复制", click: () => clipboard.writeText(params.selectionText) },
      { label: "将选中文本保存到 Library", click: () => void rpc?.request("collection.save", { clientId, text: params.selectionText, sourceUrl: target.getURL() }) },
      { type: "separator" },
    );
  }
  template.push(
    { label: "收藏当前页面", click: () => void rpc?.request("collection.bookmark", { clientId, title: target.getTitle() || target.getURL(), url: target.getURL() }).catch(error => { void dialog.showMessageBox(mainWindow, { type: "error", message: "收藏失败", detail: error.message }); }) },
    { label: "打印", click: () => target.print({ printBackground: true }) },
    { type: "separator" },
    { label: "检查", click: () => void inspectContextMenuTarget(target, params).catch(error => mainWindow?.webContents.send("ego:browser-open-error", { message: error.message })) },
  );
  Menu.buildFromTemplate(template).popup({ window: mainWindow });
}

async function inspectContextMenuTarget(target, params) {
  const host = mainWindow?.webContents;
  if (!host || host.isDestroyed() || target.isDestroyed()) throw new Error("该页面已经关闭");
  const bounds = await host.executeJavaScript(`(() => {
    const view = [...document.querySelectorAll("webview")].find(view => {
      try { return view.getWebContentsId() === ${JSON.stringify(target.id)}; } catch { return false; }
    });
    return view && !view.hidden ? view.getBoundingClientRect().toJSON() : null;
  })()`);
  const point = contextMenuInspectionPoint(params, bounds, host.getZoomFactor(), target.getZoomFactor());
  return developerTools.open(target, { point });
}

async function captureCredentialForm(target) {
  return target.executeJavaScript(`(() => {
    const visible = (element) => Boolean(element && !element.disabled && !element.readOnly && element.getClientRects().length);
    const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
    if (!passwords.length) return null;
    const filledPasswords = passwords.filter((field) => field.value);
    const password = filledPasswords.at(-1) || passwords[0];
    const form = password.form || password.closest('form');
    const scope = form || document;
    const textInputs = [...scope.querySelectorAll('input')].filter((field) => visible(field)
      && !['password', 'hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(String(field.type || '').toLowerCase()));
    const username = textInputs.find((field) => field.value && /email|user|login|account|phone|name/i.test([field.autocomplete, field.name, field.id, field.type, field.placeholder].join(' ')))
      || textInputs.find((field) => field.value)
      || textInputs.find((field) => /email|user|login|account|phone|name/i.test([field.autocomplete, field.name, field.id, field.type, field.placeholder].join(' ')))
      || textInputs[0];
    const selectorPart = (field) => [field?.name, field?.id, field?.autocomplete, field?.type, field?.placeholder].map((value) => String(value || '').slice(0, 120)).join('|');
    const formIndex = form ? [...document.forms].indexOf(form) : -1;
    return {
      origin: location.origin,
      username: String(username?.value || '').slice(0, 1000),
      password: String(password.value || '').slice(0, 20000),
      formSignature: [formIndex, selectorPart(username), selectorPart(password)].join('::').slice(0, 2000),
    };
  })()`);
}

async function fillCredentialOnPage(target, credential, requestedSignature = "") {
  const payload = JSON.stringify({
    username: credential.username || "",
    password: credential.password || "",
    formSignature: requestedSignature || credential.formSignature || "",
  });
  return target.executeJavaScript(`(() => {
    const credential = ${payload};
    const visible = (element) => Boolean(element && !element.disabled && !element.readOnly && element.getClientRects().length);
    const passwordFields = [...document.querySelectorAll('input[type="password"]')].filter(visible);
    if (!passwordFields.length) return { filled: false, reason: 'no-password-field' };
    const identity = (field) => [field?.name, field?.id, field?.autocomplete, field?.type, field?.placeholder].map((value) => String(value || '').slice(0, 120)).join('|');
    const signature = (field) => {
      const candidateForm = field.form || field.closest('form');
      const candidateScope = candidateForm || document;
      const candidateInputs = [...candidateScope.querySelectorAll('input')].filter((item) => visible(item)
        && !['password', 'hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(String(item.type || '').toLowerCase()));
      const candidateUsername = candidateInputs.find((item) => /email|user|login|account|phone|name/i.test(identity(item))) || candidateInputs[0];
      const formIndex = candidateForm ? [...document.forms].indexOf(candidateForm) : -1;
      return [formIndex, identity(candidateUsername), identity(field)].join('::').slice(0, 2000);
    };
    const password = passwordFields.find((field) => credential.formSignature && signature(field) === credential.formSignature) || passwordFields[0];
    const form = password.form || password.closest('form');
    const scope = form || document;
    const textInputs = [...scope.querySelectorAll('input')].filter((field) => visible(field)
      && !['password', 'hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(String(field.type || '').toLowerCase()));
    const username = textInputs.find((field) => /email|user|login|account|phone|name/i.test([field.autocomplete, field.name, field.id, field.type, field.placeholder].join(' '))) || textInputs[0];
    const setValue = (field, value) => {
      if (!field) return false;
      field.focus();
      const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(field, value); else field.value = value;
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const usernameFilled = credential.username ? setValue(username, credential.username) : false;
    const passwordFilled = setValue(password, credential.password);
    return { filled: passwordFilled, usernameFilled, passwordFilled, formSignature: credential.formSignature };
  })()`);
}

function notifyDesktopTab(tab) {
  desktopRpcServer?.notify("tab.changed", { taskId: tab.taskId, tab: publicDesktopTab(tab) });
}

function markFreshDesktopSpaceRestored(taskId) {
  if (!persistedDesktopTabs.some((tab) => tab.taskId === taskId)) restoredDesktopTasks.add(taskId);
}

function dedupeDesktopTabRecords(tabs) {
  return [...new Map(tabs.map((tab) => [JSON.stringify(tab), tab])).values()];
}

function loadPersistedDesktopTabs() {
  if (!existsSync(desktopStatePath)) return [];
  try {
    const value = JSON.parse(readFileSync(desktopStatePath, "utf8"));
    if (!Array.isArray(value?.tabs)) return [];
    return dedupeDesktopTabRecords(value.tabs.filter((tab) => tab && typeof tab.taskId === "string" && typeof tab.url === "string"));
  } catch {
    return [];
  }
}

function persistDesktopTabs() {
  const pending = persistedDesktopTabs.filter((tab) => !restoredDesktopTasks.has(tab.taskId));
  const live = [...desktopTabs.values()].map((tab) => ({
    taskId: tab.taskId,
    title: tab.title,
      url: tab.url,
      active: tab.active,
      ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
      ...(tab.pinned ? { pinned: true } : {}),
      ...(tab.muted ? { muted: true } : {}),
      ...(tab.sleeping ? { sleeping: true } : {}),
      ...(tab.groupId ? { groupId: tab.groupId } : {}),
      ...(tab.groupTitle ? { groupTitle: tab.groupTitle } : {}),
      ...(tab.groupColor ? { groupColor: tab.groupColor } : {}),
      ...(tab.groupCollapsed === true ? { groupCollapsed: true } : {}),
      ...(tab.lastActiveAt ? { lastActiveAt: tab.lastActiveAt } : {}),
      order: Number(tab.order ?? 0),
      zoomFactor: Number(tab.zoomFactor ?? 1),
  }));
  const tabs = dedupeDesktopTabRecords([...pending, ...live]);
  desktopTabsWriter.write({ version: 1, tabs });
}

function loadPersistedConversations() {
  if (!existsSync(conversationStatePath)) return {};
  try {
    const value = JSON.parse(readFileSync(conversationStatePath, "utf8"));
    return value && typeof value.conversations === "object" && value.conversations ? value.conversations : {};
  } catch {
    return {};
  }
}

function loadDesktopPreferences() {
  if (!existsSync(preferencesStatePath)) return { onboardingCompleted: false, permissions: {}, browserBackend: "desktop", passwordAutofillEnabled: true, agentSilentDownloadsEnabled: true, agentWebAccessEnabled: true, controlConsentPolicyVersion: CONTROL_CONSENT_POLICY_VERSION, controlMode: "agent", controlHandoffEnabled: false, controlConsentEnabled: false, controlConsentLevel: "balanced", browserExtensions: [], profiles: [structuredClone(DEFAULT_BROWSER_PROFILE)] };
  try {
    const value = JSON.parse(readFileSync(preferencesStatePath, "utf8"));
    const currentControlPolicy = value?.controlConsentPolicyVersion === CONTROL_CONSENT_POLICY_VERSION;
    if (!currentControlPolicy) desktopPreferencesNeedsMigration = true;
    return {
      onboardingCompleted: value?.onboardingCompleted === true,
      permissions: value?.permissions && typeof value.permissions === "object" ? value.permissions : {},
      browserBackend: value?.browserBackend === "companion" ? "companion" : "desktop",
      passwordAutofillEnabled: value?.passwordAutofillEnabled !== false,
      agentSilentDownloadsEnabled: value?.agentSilentDownloadsEnabled !== false,
      agentWebAccessEnabled: value?.agentWebAccessEnabled !== false,
      controlConsentPolicyVersion: CONTROL_CONSENT_POLICY_VERSION,
      autoCollaboration: value?.autoCollaboration === true,
      controlMode: normalizeControlMode(value?.controlMode ?? (currentControlPolicy && value?.controlHandoffEnabled === true ? "collaborative" : "agent")),
      controlHandoffEnabled: currentControlPolicy && value?.controlHandoffEnabled === true,
      controlConsentEnabled: currentControlPolicy && value?.controlConsentEnabled === true,
      controlConsentLevel: normalizeControlConsentLevel(value?.controlConsentLevel),
      profiles: normalizeBrowserProfiles(value?.profiles),
      browserExtensions: Array.isArray(value?.browserExtensions)
        ? value.browserExtensions.filter((record) => record && typeof record.id === "string" && typeof record.path === "string").map((record) => ({
          id: record.id,
          path: record.path,
          sourceType: ["zip", "browser-profile", "repository"].includes(record.sourceType) ? record.sourceType : "directory",
          sourceHash: typeof record.sourceHash === "string" ? record.sourceHash : "",
          sourcePath: typeof record.sourcePath === "string" ? record.sourcePath : record.path,
          managedPath: typeof record.managedPath === "string" ? record.managedPath : "",
          name: typeof record.name === "string" ? record.name : "浏览器扩展",
          version: typeof record.version === "string" ? record.version : "未知版本",
          description: typeof record.description === "string" ? record.description : "",
          manifestVersion: Number(record.manifestVersion) || 3,
          repositoryId: typeof record.repositoryId === "string" ? record.repositoryId : "",
          repositoryUrl: typeof record.repositoryUrl === "string" ? record.repositoryUrl : "",
          enabled: record.enabled !== false,
          pinned: record.pinned !== false,
          error: typeof record.error === "string" ? record.error : "",
        }))
        : [],
    };
  } catch (error) {
    throw new Error("无法读取浏览器配置，请修复配置文件后重试", { cause: error });
  }
}

function normalizeControlConsentLevel(value) {
  return value === "strict" ? "strict" : "balanced";
}

function controlHandoffEnabled() {
  return controlMode() !== "agent";
}

function controlMode() {
  return normalizeControlMode(desktopPreferences.controlMode);
}

function agentSilentDownloadsEnabled() {
  return desktopPreferences.agentSilentDownloadsEnabled !== false;
}

function agentWebAccessEnabled() {
  return desktopPreferences.agentWebAccessEnabled !== false;
}

function agentDownloadDirectory() {
  const configured = String(process.env.EGO_DESKTOP_AGENT_DOWNLOADS || "").trim();
  return configured && isAbsolute(configured) ? configured : app.getPath("downloads");
}

function enabledAgentSkillNames() {
  return Object.keys(agentSkillSources).filter((name) => name !== "web-access-ego" || agentWebAccessEnabled());
}

function controlConsentPolicy() {
  return controlHandoffEnabled() && desktopPreferences.controlConsentEnabled === true
    ? normalizeControlConsentLevel(desktopPreferences.controlConsentLevel)
    : "strict";
}

function normalizeControlMode(value) {
  return value === "collaborative" || value === "manual" ? value : "agent";
}

function requireControlHandoffEnabled() {
  if (!controlHandoffEnabled()) throw new Error("控制权交接功能已关闭");
}

function normalizeBrowserProfiles(value) {
  if (value != null && !Array.isArray(value)) throw new Error("浏览器 Profile 列表格式无效");
  if (Array.isArray(value) && value.some((item) => !item || typeof item !== "object" || Array.isArray(item) || !item.id)) {
    throw new Error("浏览器 Profile 记录无效，请修复配置后重试");
  }
  const profiles = Array.isArray(value) ? value.filter((item) => item && typeof item === "object").map((item) => ({
    id: normalizeBrowserProfileId(item.id),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 80) : "浏览器 Profile",
    color: normalizeBrowserProfileColor(item.color),
    partition: typeof item.partition === "string" && /^persist:ego-(?:desktop|profile-[a-z0-9._-]+)$/.test(item.partition)
      ? item.partition
      : browserProfilePartition(item.id),
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
    ...(typeof item.sourceBrowser === "string" ? { sourceBrowser: item.sourceBrowser } : {}),
    ...(typeof item.sourceProfile === "string" ? { sourceProfile: item.sourceProfile } : {}),
  })) : [];
  const unique = new Map();
  const partitions = new Set();
  for (const profile of profiles) {
    if (profile.id !== "default" && profile.partition === browserExtensionPartition) {
      throw new Error("独立 Profile 不能使用默认会话分区");
    }
    if (unique.has(profile.id)) throw new Error(`Profile 标识重复 ${profile.id}`);
    if (partitions.has(profile.partition)) throw new Error(`Profile 会话分区重复 ${profile.partition}`);
    unique.set(profile.id, profile);
    partitions.add(profile.partition);
  }
  unique.set("default", { ...structuredClone(DEFAULT_BROWSER_PROFILE), ...(unique.get("default") || {}), id: "default", partition: browserExtensionPartition });
  return [...unique.values()];
}

function normalizeBrowserProfileId(value) {
  if (value === undefined || value === null) return "default";
  const clean = typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(clean)) throw new Error("浏览器 Profile 标识无效");
  return clean;
}

function normalizeBrowserProfileColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).toLocaleLowerCase() : "#5b7c86";
}

function browserProfilePartition(profileId) {
  const id = normalizeBrowserProfileId(profileId);
  return id === "default" ? browserExtensionPartition : `persist:ego-profile-${id}`;
}

function listBrowserProfiles() {
  if (!Array.isArray(desktopPreferences.profiles)) desktopPreferences.profiles = normalizeBrowserProfiles([]);
  return desktopPreferences.profiles.map((profile) => ({ ...profile }));
}

function findBrowserProfile(profileId) {
  const id = normalizeBrowserProfileId(profileId);
  return listBrowserProfiles().find((profile) => profile.id === id);
}

function ensureBrowserProfileSession(profileId) {
  const profile = findBrowserProfile(profileId);
  if (!profile) throw new Error(`找不到浏览器 Profile ${profileId}，请重新选择`);
  let electronSession = browserProfileSessions.get(profile.id);
  if (electronSession) return electronSession;
  electronSession = session.fromPartition(profile.partition || browserProfilePartition(profile.id));
  configureWebviewSession(electronSession);
  browserProfileSessions.set(profile.id, electronSession);
  return electronSession;
}

function profileIdForWebContents(target) {
  const tab = [...desktopTabs.values()].find((candidate) => candidate.webContentsId === target?.id);
  if (!tab) return "default";
  const space = desktopSpaces.get(tab.taskId) || brokerSpaceStates.get(tab.taskId);
  return normalizeBrowserProfileId(space?.profileId || "default");
}

function createBrowserProfile(payload = {}) {
  const name = required(payload.name, "name").slice(0, 80);
  const requestedId = typeof payload.id === "string" ? payload.id : name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const id = normalizeBrowserProfileId(requestedId || `profile-${Date.now().toString(36)}`);
  if (findBrowserProfile(id)) throw new Error("这个 Profile 标识已存在");
  const profile = {
    id,
    name,
    color: normalizeBrowserProfileColor(payload.color),
    partition: browserProfilePartition(id),
    createdAt: new Date().toISOString(),
    ...(typeof payload.sourceBrowser === "string" ? { sourceBrowser: payload.sourceBrowser.slice(0, 80) } : {}),
    ...(typeof payload.sourceProfile === "string" ? { sourceProfile: payload.sourceProfile.slice(0, 80) } : {}),
  };
  desktopPreferences.profiles.push(profile);
  ensureBrowserProfileSession(profile.id);
  persistDesktopPreferences();
  return { ...profile };
}

function renameBrowserProfile(payload = {}) {
  const profile = findBrowserProfile(required(payload.id, "id"));
  if (!profile) throw new Error("找不到这个 Profile");
  const stored = desktopPreferences.profiles.find((item) => item.id === profile.id);
  stored.name = required(payload.name, "name").slice(0, 80);
  if (payload.color) stored.color = normalizeBrowserProfileColor(payload.color);
  persistDesktopPreferences();
  return { ...stored };
}

async function removeBrowserProfile(payload = {}) {
  const id = normalizeBrowserProfileId(required(payload.id, "id"));
  if (id === "default") throw new Error("默认 Profile 不能删除");
  if (!rpc) throw new Error("无法检查工作空间引用，请等待 Broker 连接后重试");
  {
    const spaces = (await rpc.request("space.list", { clientId })).taskSpaces || [];
    if (spaces.some((space) => normalizeBrowserProfileId(space.profileId) === id)) throw new Error("仍有工作空间正在使用这个 Profile");
  }
  const index = desktopPreferences.profiles.findIndex((profile) => profile.id === id);
  if (index < 0) throw new Error("找不到这个 Profile");
  desktopPreferences.profiles.splice(index, 1);
  credentialStore.removeProfile(id);
  translationSettings.remove(id);
  browserProfileSessions.delete(id);
  persistDesktopPreferences();
  return true;
}

function loadPersistedDownloads() {
  if (!existsSync(downloadsStatePath)) return [];
  try {
    const value = JSON.parse(readFileSync(downloadsStatePath, "utf8"));
    if (!Array.isArray(value?.downloads)) return [];
    return value.downloads.slice(0, 500).filter((record) => record && typeof record.id === "string").map((record) => ({
      ...record,
      state: record.state === "inProgress" ? "interrupted" : record.state,
      item: undefined,
    }));
  } catch {
    return [];
  }
}

function persistDesktopDownloads() {
  const directory = dirname(downloadsStatePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${downloadsStatePath}.tmp`;
  const downloads = [...desktopDownloads.values()]
    .map(publicDesktopDownload)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 500);
  writeFileSync(temporaryPath, JSON.stringify({ version: 1, downloads }, null, 2), "utf8");
  renameSync(temporaryPath, downloadsStatePath);
}

function persistDesktopPreferences() {
  const directory = dirname(preferencesStatePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${preferencesStatePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ version: 1, ...desktopPreferences }, null, 2), "utf8");
  renameSync(temporaryPath, preferencesStatePath);
}

function browserExtensionRecords() {
  if (!Array.isArray(desktopPreferences.browserExtensions)) desktopPreferences.browserExtensions = [];
  return desktopPreferences.browserExtensions;
}

function findBrowserExtension(id) {
  const record = browserExtensionRecords().find((item) => item.id === id);
  if (!record) throw new Error("找不到这个浏览器扩展");
  return record;
}

function listBrowserExtensions() {
  return browserExtensionRecords().map(publicBrowserExtensionState);
}

function publicBrowserExtensionState(record) {
  const extension = loadedBrowserExtensions.get(record.id);
  const runtimeState = browserExtensionRuntimeStates.get(record.id);
  const compatibility = runtimeState?.compatibility || browserExtensionCompatibility(record);
  return publicBrowserExtension(record, {
    loaded: Boolean(extension),
    ready: runtimeState?.ready === true,
    extensionId: extension?.id,
    compatibilityLevel: compatibility.level,
    compatibilityLabel: compatibility.label,
    compatibilityDetail: compatibility.detail,
    unsupportedPermissions: compatibility.unsupportedPermissions,
    requiredCapabilities: compatibility.requiredCapabilities,
    missingCapabilities: compatibility.missingCapabilities,
    runtimeCapabilities: compatibility.capabilities,
    diagnostics: runtimeState?.diagnostics || [],
    runtimeAdapted: Boolean(compatibility.adapter),
    actionAvailable: Boolean(browserExtensionActionPath(extension)),
    optionsAvailable: Boolean(browserExtensionOptionsPath(extension)),
    iconDataUrl: browserExtensionIconDataUrl(record, extension),
  });
}

function browserExtensionActionPath(extension) {
  const manifest = extension?.manifest;
  const path = manifest?.action?.default_popup || manifest?.browser_action?.default_popup;
  return typeof path === "string" && path.trim() ? path.trim() : "";
}

function browserExtensionOptionsPath(extension) {
  const manifest = extension?.manifest;
  const path = manifest?.options_ui?.page || manifest?.options_page;
  return typeof path === "string" && path.trim() ? path.trim() : "";
}

function browserExtensionIconPath(extension) {
  const manifest = extension?.manifest;
  const candidates = manifest?.action?.default_icon || manifest?.browser_action?.default_icon || manifest?.icons;
  if (typeof candidates === "string") return candidates.trim();
  if (!candidates || typeof candidates !== "object") return "";
  return Object.entries(candidates)
    .filter(([, value]) => typeof value === "string" && value.trim())
    .sort(([left], [right]) => Number(right) - Number(left))[0]?.[1]?.trim() || "";
}

function browserExtensionIconDataUrl(record, extension) {
  const iconPath = browserExtensionIconPath(extension);
  if (!iconPath) return "";
  const absolutePath = resolve(record.path, iconPath);
  const relativePath = relative(record.path, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || !existsSync(absolutePath)) return "";
  try {
    const data = readFileSync(absolutePath);
    if (data.length > 1024 * 1024) return "";
    const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" })[extname(absolutePath).toLowerCase()];
    return mime ? `data:${mime};base64,${data.toString("base64")}` : "";
  } catch {
    return "";
  }
}

async function openBrowserExtensionAction(payload = {}) {
  const record = findBrowserExtension(required(payload.id, "id"));
  const extension = loadedBrowserExtensions.get(record.id);
  if (!extension) throw new Error("扩展尚未成功加载，无法打开操作面板");
  targetedExtensionHost?.grantActiveTab(extension.id);
  const actionPath = browserExtensionActionPath(extension) || browserExtensionOptionsPath(extension);
  if (!actionPath) throw new Error("这个扩展没有可打开的操作面板");

  const existing = browserExtensionActionWindows.get(record.id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return { opened: true, reused: true };
  }

  const parentBounds = mainWindow.getBounds();
  const width = 420;
  const height = Math.max(420, Math.min(640, parentBounds.height - 90));
  const anchor = payload.anchor && typeof payload.anchor === "object" ? payload.anchor : null;
  const anchoredX = anchor && Number.isFinite(anchor.right) ? parentBounds.x + Number(anchor.right) - width : parentBounds.x + parentBounds.width - width - 18;
  const anchoredY = anchor && Number.isFinite(anchor.bottom) ? parentBounds.y + Number(anchor.bottom) + 6 : parentBounds.y + 62;
  const actionWindow = new BrowserWindow({
    parent: mainWindow,
    width,
    height,
    x: Math.max(parentBounds.x + 12, Math.min(anchoredX, parentBounds.x + parentBounds.width - width - 12)),
    y: Math.max(parentBounds.y + 48, Math.min(anchoredY, parentBounds.y + parentBounds.height - height - 12)),
    minWidth: 340,
    minHeight: 360,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: "#182022",
    webPreferences: {
      session: browserExtensionSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  browserExtensionActionWindows.set(record.id, actionWindow);
  actionWindow.on("closed", () => browserExtensionActionWindows.delete(record.id));
  actionWindow.on("blur", () => {
    setTimeout(() => {
      if (!actionWindow.isDestroyed() && !actionWindow.webContents.isDevToolsOpened()) actionWindow.close();
    }, 120);
  });
  await actionWindow.loadURL(new URL(actionPath, extension.url).toString());
  actionWindow.show();
  return { opened: true, reused: false };
}

async function restoreBrowserExtensions() {
  for (const record of browserExtensionRecords()) {
    try {
      const current = createBrowserExtensionRecord(record.path, record);
      Object.assign(record, current);
      record.error = "";
      if (record.enabled) await loadBrowserExtension(record, { deferBackground: true });
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
  }
  // Loading another native extension can reset Chromium API bindings in existing
  // extension pages. Start adapted backgrounds only after all registrations finish.
  for (const record of browserExtensionRecords()) {
    const extension = loadedBrowserExtensions.get(record.id);
    const runtime = browserExtensionRuntimeStates.get(record.id);
    if (!extension || !runtime?.backgroundPending) continue;
    try {
      const background = await startBrowserExtensionBackground(record, extension, runtime.compatibility);
      Object.assign(runtime, { ready: background.ready === true, diagnostics: background.diagnostics, backgroundPending: false });
    } catch (error) {
      unloadBrowserExtension(record);
      record.error = error instanceof Error ? error.message : String(error);
    }
  }
  persistDesktopPreferences();
}

async function loadBrowserExtension(record, { deferBackground = false } = {}) {
  if (!browserExtensionSession) throw new Error("浏览器扩展运行环境尚未准备好");
  if (loadedBrowserExtensions.has(record.id)) return loadedBrowserExtensions.get(record.id);
  const prepared = prepareExtensionRuntime(record.path, browserExtensionRuntimeRoot);
  const current = browserExtensionSession.extensions.getAllExtensions().find((extension) => extension.path === prepared.path);
  const readyPromise = current ? Promise.resolve(true) : waitForBrowserExtensionReady(prepared.path);
  const extension = current || await browserExtensionSession.extensions.loadExtension(prepared.path, { allowFileAccess: false });
  if (prepared.compatibility.targeted) targetedExtensionHost.register(extension, JSON.parse(readFileSync(join(record.path, 'manifest.json'), 'utf8')));
  let ready = await readyPromise;
  let diagnostics = [];
  const hasBackgroundPage = existsSync(join(prepared.path, "electron-background.html"));
  const backgroundPending = Boolean(prepared.compatibility.adapter && hasBackgroundPage && deferBackground);
  if (backgroundPending) ready = false;
  if (prepared.compatibility.adapter && hasBackgroundPage && !deferBackground) {
    try {
      const background = await startBrowserExtensionBackground(record, extension, prepared.compatibility);
      ready = background.ready === true;
      diagnostics = background.diagnostics;
    } catch (error) {
      targetedExtensionHost?.unregister(extension.id);
      browserExtensionSession.extensions.removeExtension(extension.id);
      throw error;
    }
  }
  loadedBrowserExtensions.set(record.id, extension);
  browserExtensionRuntimeStates.set(record.id, {
    path: prepared.path,
    ready,
    compatibility: prepared.compatibility,
    diagnostics,
    backgroundPending,
  });
  record.enabled = true;
  record.name = extension.name || record.name;
  record.version = extension.version || record.version;
  record.error = "";
  return extension;
}

function unloadBrowserExtension(record) {
  const actionWindow = browserExtensionActionWindows.get(record.id);
  if (actionWindow && !actionWindow.isDestroyed()) actionWindow.close();
  browserExtensionActionWindows.delete(record.id);
  const backgroundWindow = browserExtensionBackgroundWindows.get(record.id);
  if (backgroundWindow && !backgroundWindow.isDestroyed()) {
    backgroundWindow.__egoIntentionalClose = true;
    backgroundWindow.destroy();
  }
  browserExtensionBackgroundWindows.delete(record.id);
  const recoveryTimer = browserExtensionBackgroundRecovery.get(record.id)?.timer;
  if (recoveryTimer) clearTimeout(recoveryTimer);
  browserExtensionBackgroundRecovery.delete(record.id);
  const runtimePath = browserExtensionRuntimeStates.get(record.id)?.path || record.path;
  const extension = loadedBrowserExtensions.get(record.id)
    || browserExtensionSession?.extensions.getAllExtensions().find((item) => item.path === runtimePath);
  if (extension && browserExtensionSession) browserExtensionSession.extensions.removeExtension(extension.id);
  if (extension) targetedExtensionHost?.unregister(extension.id);
  loadedBrowserExtensions.delete(record.id);
  browserExtensionRuntimeStates.delete(record.id);
}

async function startBrowserExtensionBackground(record, extension, compatibility = {}) {
  const existing = browserExtensionBackgroundWindows.get(record.id);
  if (existing && !existing.isDestroyed()) return { ready: true, diagnostics: [] };
  const backgroundWindow = new BrowserWindow({
    width: 480,
    height: 320,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      session: browserExtensionSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const diagnostics = [];
  backgroundWindow.webContents.on("console-message", (_event, details, legacyMessage) => {
    const level = typeof details === "object" ? details.level : details;
    const message = typeof details === "object" ? details.message : legacyMessage;
    if (level === "error" || level === 3) diagnostics.push(String(message || "扩展后台控制台错误"));
  });
  backgroundWindow.webContents.on("did-fail-load", (_event, code, description) => diagnostics.push(`页面加载失败 ${code}: ${description}`));
  browserExtensionBackgroundWindows.set(record.id, backgroundWindow);
  backgroundWindow.on("closed", () => {
    if (browserExtensionBackgroundWindows.get(record.id) === backgroundWindow) browserExtensionBackgroundWindows.delete(record.id);
    if (!backgroundWindow.__egoIntentionalClose) scheduleBrowserExtensionBackgroundRecovery(record.id);
  });
  backgroundWindow.webContents.on("render-process-gone", () => {
    if (!backgroundWindow.__egoIntentionalClose) scheduleBrowserExtensionBackgroundRecovery(record.id);
  });
  try {
    await backgroundWindow.loadURL(new URL("electron-background.html", extension.url).toString());
    const health = await backgroundWindow.webContents.executeJavaScript(`({
      runtimeId: globalThis.chrome?.runtime?.id || "",
      browserReady: Boolean(globalThis.browser),
      messageListeners: Boolean(globalThis.chrome?.runtime?.onMessage?.hasListeners?.()),
      storageLocal: Boolean(globalThis.chrome?.storage?.local),
      storageSession: Boolean(globalThis.chrome?.storage?.session),
      scripting: Boolean(globalThis.chrome?.scripting),
      userScripts: Boolean(globalThis.chrome?.userScripts),
      targeted: Boolean(globalThis.__egoTargetedExtension),
      initializationErrors: globalThis.__egoExtensionErrors || [],
    })`);
    const requireListeners = compatibility.adapter === "violentmonkey-mv3";
    if (!health.runtimeId || (requireListeners && (!health.browserReady || !health.messageListeners))
      || (compatibility.targeted && (!health.targeted || !health.messageListeners || health.initializationErrors.length))) {
      throw new Error(`扩展兼容后台没有完成初始化 (${JSON.stringify({ health, diagnostics: diagnostics.slice(-5) })})`);
    }
    if (requireListeners && compatibility.targeted) {
      const data = await targetedExtensionHost.invoke(targetedExtensionHost.extensions.get(extension.id), "violentmonkey.initialData", ["options"]);
      if (!data?.options) throw new Error("扩展后台数据尚未初始化");
    }
    return { ready: true, diagnostics: diagnostics.slice(-20) };
  } catch (error) {
    backgroundWindow.__egoIntentionalClose = true;
    if (!backgroundWindow.isDestroyed()) backgroundWindow.destroy();
    browserExtensionBackgroundWindows.delete(record.id);
    throw new Error(`扩展兼容后台启动失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function scheduleBrowserExtensionBackgroundRecovery(id) {
  const previous = browserExtensionBackgroundRecovery.get(id) || { attempts: [], timer: null };
  if (previous.timer) return;
  const now = Date.now();
  previous.attempts = previous.attempts.filter((time) => now - time < 60_000);
  if (previous.attempts.length >= 3) {
    const record = browserExtensionRecords().find((item) => item.id === id);
    if (record) record.error = "扩展后台连续停止，已暂停自动恢复；请手动重新加载扩展";
    const runtimeState = browserExtensionRuntimeStates.get(id);
    if (runtimeState) runtimeState.ready = false;
    persistDesktopPreferences();
    return;
  }
  previous.attempts.push(now);
  previous.timer = setTimeout(async () => {
    previous.timer = null;
    const record = browserExtensionRecords().find((item) => item.id === id);
    const extension = loadedBrowserExtensions.get(id);
    if (!record?.enabled || !extension || browserExtensionBackgroundWindows.has(id)) return;
    try {
      const runtimeState = browserExtensionRuntimeStates.get(id);
      await startBrowserExtensionBackground(record, extension, runtimeState?.compatibility);
      if (runtimeState) runtimeState.ready = true;
      record.error = "";
      persistDesktopPreferences();
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      scheduleBrowserExtensionBackgroundRecovery(id);
    }
  }, 500);
  browserExtensionBackgroundRecovery.set(id, previous);
}

function waitForBrowserExtensionReady(path, timeoutMilliseconds = 8_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browserExtensionSession?.extensions.off("extension-ready", onReady);
      resolve(ready);
    };
    const onReady = (_event, extension) => {
      if (extension?.path === path) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMilliseconds);
    browserExtensionSession.extensions.on("extension-ready", onReady);
  });
}

function browserExtensionCompatibility(record) {
  try {
    return analyzeExtensionCompatibility(JSON.parse(readFileSync(join(record.path, "manifest.json"), "utf8")));
  } catch {
    return {
      level: "limited",
      adapter: "",
      label: "无法检测",
      detail: "无法读取扩展清单，重新加载后会再次检测。",
      unsupportedPermissions: [],
      requiredCapabilities: [],
      missingCapabilities: [],
      capabilities: {},
      diagnostics: ["无法读取扩展清单，兼容性报告不可用"],
    };
  }
}

async function installBrowserExtension(payload = {}) {
  let inputPath = typeof payload.path === "string" ? payload.path : "";
  const requestedKind = payload.kind === "directory" ? "directory" : "zip";
  if (!inputPath) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: requestedKind === "directory" ? "加载已解压浏览器扩展" : "安装 ZIP 浏览器扩展",
      properties: requestedKind === "directory" ? ["openDirectory"] : ["openFile"],
      ...(requestedKind === "directory" ? {} : { filters: [{ name: "ZIP 扩展包", extensions: ["zip"] }] }),
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    inputPath = result.filePaths[0];
  }
  const records = browserExtensionRecords();
  const isArchive = extname(inputPath).toLocaleLowerCase() === ".zip";
  let record;
  let updated = false;

  if (isArchive) {
    const archivePath = resolve(inputPath);
    const sourceHash = hashBrowserExtensionArchive(archivePath);
    record = records.find((item) => item.sourceType === "zip" && item.sourceHash === sourceHash);
    updated = Boolean(record);
    if (!record) {
      const extracted = await extractBrowserExtensionArchive(archivePath, sourceHash);
      record = createBrowserExtensionRecord(extracted.path);
      Object.assign(record, {
        sourceType: "zip",
        sourceHash,
        sourcePath: archivePath,
        managedPath: extracted.managedPath,
      });
      records.push(record);
    } else if (!existsSync(join(record.path, "manifest.json"))) {
      const extracted = await extractBrowserExtensionArchive(archivePath, sourceHash);
      Object.assign(record, createBrowserExtensionRecord(extracted.path, record), {
        sourceType: "zip",
        sourceHash,
        sourcePath: record.sourcePath || archivePath,
        managedPath: extracted.managedPath,
      });
    } else {
      Object.assign(record, createBrowserExtensionRecord(record.path, record));
      record.sourceType = "zip";
      record.sourceHash = sourceHash;
      record.sourcePath ||= archivePath;
      if (!record.managedPath) {
        const expectedManagedPath = join(browserExtensionManagedRoot, sourceHash);
        if (isManagedBrowserExtensionPath(expectedManagedPath)) record.managedPath = expectedManagedPath;
      }
    }
  } else {
    const path = normalizeBrowserExtensionPath(inputPath);
    record = records.find((item) => item.path === path);
    updated = Boolean(record);
    if (record) Object.assign(record, createBrowserExtensionRecord(path, record));
    else {
      record = createBrowserExtensionRecord(path);
      records.push(record);
    }
  }

  try {
    await loadBrowserExtension(record);
    persistDesktopPreferences();
    return { ...publicBrowserExtensionState(record), updated };
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    persistDesktopPreferences();
    throw error;
  }
}

async function extractBrowserExtensionArchive(archivePath, sourceHash) {
  if (!sourceHash) throw new Error("缺少 ZIP 扩展包指纹");
  const extractionRoot = join(browserExtensionManagedRoot, sourceHash);
  rmSync(extractionRoot, { recursive: true, force: true });
  mkdirSync(extractionRoot, { recursive: true });
  try {
    const command = `Expand-Archive -LiteralPath ${powershellLiteral(archivePath)} -DestinationPath ${powershellLiteral(extractionRoot)} -Force`;
    await runHiddenCommand(process.platform === "win32" ? "powershell.exe" : "pwsh", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ]);
    const extensionDirectory = findExtractedExtensionDirectory(extractionRoot);
    if (!extensionDirectory) throw new Error("ZIP 中没有找到包含 manifest.json 的扩展目录");
    return {
      path: normalizeBrowserExtensionPath(extensionDirectory),
      managedPath: realpathSync(extractionRoot),
    };
  } catch (error) {
    rmSync(extractionRoot, { recursive: true, force: true });
    throw error;
  }
}

function findExtractedExtensionDirectory(directory, depth = 0) {
  if (existsSync(join(directory, "manifest.json"))) return directory;
  if (depth >= 4) return "";
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = findExtractedExtensionDirectory(join(directory, entry.name), depth + 1);
    if (candidate) return candidate;
  }
  return "";
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runHiddenCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(stderr.trim() || `扩展 ZIP 解压失败，退出码 ${code}`));
    });
  });
}

async function setBrowserExtensionEnabled(payload = {}) {
  const record = findBrowserExtension(required(payload.id, "id"));
  const enabled = payload.enabled === true;
  try {
    if (enabled) await loadBrowserExtension(record);
    else unloadBrowserExtension(record);
    record.enabled = enabled;
    record.error = "";
    persistDesktopPreferences();
    return publicBrowserExtensionState(record);
  } catch (error) {
    record.enabled = false;
    record.error = error instanceof Error ? error.message : String(error);
    persistDesktopPreferences();
    throw error;
  }
}

function setBrowserExtensionPinned(payload = {}) {
  const record = findBrowserExtension(required(payload.id, "id"));
  record.pinned = payload.pinned === true;
  persistDesktopPreferences();
  return publicBrowserExtensionState(record);
}

async function reloadBrowserExtension(id) {
  const record = findBrowserExtension(id);
  try {
    unloadBrowserExtension(record);
    await loadBrowserExtension(record);
    persistDesktopPreferences();
    return publicBrowserExtensionState(record);
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    persistDesktopPreferences();
    throw error;
  }
}

function isManagedBrowserExtensionPath(inputPath) {
  if (typeof inputPath !== "string" || !inputPath) return false;
  const root = resolve(browserExtensionManagedRoot);
  const candidate = resolve(inputPath);
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return false;
  if (!existsSync(root) || !existsSync(candidate)) return false;
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const realRelativePath = relative(realRoot, realCandidate);
    return Boolean(realRelativePath) && !realRelativePath.startsWith("..") && !isAbsolute(realRelativePath);
  } catch {
    return false;
  }
}

function removeManagedBrowserExtension(record) {
  const managedPath = typeof record?.managedPath === "string" ? record.managedPath : "";
  if (!managedPath || !existsSync(managedPath)) return;
  if (!isManagedBrowserExtensionPath(managedPath)) throw new Error("扩展托管目录不安全，已拒绝删除");
  rmSync(managedPath, { recursive: true, force: true });
}

async function removeBrowserExtension(id) {
  const records = browserExtensionRecords();
  const index = records.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("找不到这个浏览器扩展");
  const record = records[index];
  unloadBrowserExtension(record);
  removeManagedBrowserExtension(record);
  records.splice(index, 1);
  persistDesktopPreferences();
  return listBrowserExtensions();
}

function discoverImportSources() {
  const profiles = discoverBrowserProfiles(process.env.EGO_BROWSER_IMPORT_LOCALAPPDATA || process.env.LOCALAPPDATA || "");
  browserImportProfiles = new Map(profiles.map((profile) => [profile.id, profile]));
  return profiles.map(({ path: _path, ...profile }) => profile);
}

function discoverImportExtensionSources() {
  if (!browserImportProfiles.size) discoverImportSources();
  const extensions = [];
  for (const profile of browserImportProfiles.values()) {
    for (const extension of discoverBrowserExtensions(profile)) extensions.push(extension);
  }
  browserImportExtensions = new Map(extensions.map((extension) => [extension.id, extension]));
  return extensions.map(({ path: _path, ...extension }) => extension);
}

async function importBrowserExtensions(payload = {}) {
  if (!browserImportExtensions.size) discoverImportExtensionSources();
  const ids = Array.isArray(payload.extensionIds) ? payload.extensionIds.slice(0, 100) : [];
  const imported = [];
  const errors = [];
  for (const id of ids) {
    const source = browserImportExtensions.get(id);
    if (!source) continue;
    try {
      const safeName = `${source.browserId}-${source.profileId}-${source.extensionId}-${source.version}`.replace(/[^a-z0-9._-]+/gi, "_");
      const managedPath = join(browserExtensionManagedRoot, "imported", safeName);
      rmSync(managedPath, { recursive: true, force: true });
      mkdirSync(dirname(managedPath), { recursive: true });
      cpSync(source.path, managedPath, { recursive: true, force: true });
      const records = browserExtensionRecords();
      const existing = records.find((record) => record.sourcePath === source.path || record.path === managedPath);
      const record = createBrowserExtensionRecord(managedPath, existing || {});
      Object.assign(record, {
        sourceType: "browser-profile",
        sourcePath: source.path,
        managedPath: realpathSync(managedPath),
        enabled: payload.enable !== false,
      });
      if (existing) Object.assign(existing, record);
      else records.push(record);
      if (record.enabled) await loadBrowserExtension(record);
      imported.push(publicBrowserExtensionState(record));
    } catch (error) {
      errors.push(`${source.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  persistDesktopPreferences();
  return { imported, errors, count: imported.length };
}

async function loadExtensionRepository() {
  const items = bundledExtensionRepository();
  const repositoryUrl = String(process.env.EGO_EXTENSION_REPOSITORY_URL || "").trim();
  if (!repositoryUrl) return items;
  if (!/^https:\/\//i.test(repositoryUrl)) throw new Error("扩展仓库地址必须使用 HTTPS");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(repositoryUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`扩展仓库返回 HTTP ${response.status}`);
    const remote = await response.json();
    return [...items, ...normalizeExtensionRepository(remote.items || remote.extensions || [])];
  } finally {
    clearTimeout(timer);
  }
}

async function listExtensionRepository() {
  const records = browserExtensionRecords();
  const installedIds = new Set(records.filter((record) => record.sourceType === "repository").map((record) => record.repositoryId));
  return normalizeExtensionRepository(await loadExtensionRepository(), installedIds);
}

async function installRepositoryExtension(id) {
  const item = (await loadExtensionRepository()).find((candidate) => candidate.id === id);
  if (!item) throw new Error("找不到这个仓库扩展");
  let path = "";
  if (item.source === "companion") {
    path = companionPaths().extensionDirectory;
  } else {
    if (!/^https:\/\//i.test(item.url || "")) throw new Error("仓库扩展下载地址必须使用 HTTPS");
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`扩展下载失败，HTTP ${response.status}`);
    const downloadsRoot = join(browserExtensionManagedRoot, "repository-downloads");
    mkdirSync(downloadsRoot, { recursive: true });
    const fileName = `${item.id.replace(/[^a-z0-9._-]+/gi, "_")}.zip`;
    path = join(downloadsRoot, fileName);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const result = await installBrowserExtension({ path });
  const record = browserExtensionRecords().find((candidate) => candidate.id === result.id);
  if (record) {
    record.sourceType = "repository";
    record.repositoryId = item.id;
    record.repositoryUrl = item.url || "bundled";
    persistDesktopPreferences();
  }
  return { ...result, repositoryId: item.id };
}

async function runBrowserImport(payload = {}) {
  const ids = Array.isArray(payload.profileIds) ? payload.profileIds.slice(0, 20) : [];
  if (!browserImportProfiles.size) discoverImportSources();
  const entries = [];
  const historyEntries = [];
  const errors = [];
  for (const id of ids) {
    const profile = browserImportProfiles.get(id);
    if (!profile) continue;
    const imported = importBrowserProfile(profile, {
      bookmarks: payload.bookmarks !== false,
      history: payload.history !== false,
      historyLimit: Math.max(0, Math.min(Number(payload.historyLimit) || 500, 2_000)),
    });
    entries.push(...imported.entries);
    historyEntries.push(...imported.historyEntries);
    errors.push(...imported.errors.map((message) => `${profile.browserName} / ${profile.profileName}：${message}`));
  }
  const result = entries.length
    ? await rpc.request("collection.import", { clientId, entries })
    : { added: 0, skipped: 0 };
  return { ...result, scanned: entries.length + historyEntries.length, historyEntries, errors };
}

function conversationFor(taskId) {
  return sanitizeConversation(persistedConversations[taskId]);
}

function saveConversation(taskId, value) {
  persistedConversations[taskId] = sanitizeConversation(value);
  persistConversations();
  return persistedConversations[taskId];
}

function clearConversation(taskId, mode) {
  const conversation = conversationFor(taskId);
  if (mode === "chat") conversation.chat = [];
  else if (mode === "codex") {
    conversation.codex = [];
    conversation.codexThreadId = "";
  } else {
    conversation.chat = [];
    conversation.codex = [];
    conversation.codexThreadId = "";
  }
  return saveConversation(taskId, conversation);
}

function sanitizeConversation(value) {
  const sanitizeMessages = (messages) => Array.isArray(messages) ? messages.slice(-500).flatMap((message) => {
    if (!message || !["user", "assistant", "error"].includes(message.role) || typeof message.text !== "string") return [];
    return [{
      id: typeof message.id === "string" ? message.id.slice(0, 100) : randomUUID(),
      role: message.role,
      text: message.text.slice(0, 200_000),
      meta: typeof message.meta === "string" ? message.meta.slice(0, 2_000) : "",
      durationLabel: typeof message.durationLabel === "string" ? message.durationLabel.slice(0, 100) : "",
      status: ["streaming", "complete", "cancelled", "error"].includes(message.status) ? message.status : "complete",
      requestPrompt: typeof message.requestPrompt === "string" ? message.requestPrompt.slice(0, 100_000) : "",
      requestContext: typeof message.requestContext === "string" ? message.requestContext.slice(0, 500_000) : "",
      attachments: sanitizeAttachmentMetadata(message.attachments),
      requestAttachments: sanitizeAttachmentMetadata(message.requestAttachments),
      activities: sanitizeCodexActivities(message.activities),
      createdAt: typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString(),
    }];
  }) : [];
  return {
    chat: sanitizeMessages(value?.chat),
    codex: sanitizeMessages(value?.codex),
    codexThreadId: typeof value?.codexThreadId === "string" ? value.codexThreadId.slice(0, 500) : "",
    updatedAt: new Date().toISOString(),
  };
}

function sanitizeCodexActivities(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).flatMap((activity) => {
    if (!activity || typeof activity.id !== "string" || typeof activity.type !== "string") return [];
    return [{
      id: activity.id.slice(0, 200),
      type: activity.type.slice(0, 80),
      status: typeof activity.status === "string" ? activity.status.slice(0, 40) : "completed",
      title: typeof activity.title === "string" ? activity.title.slice(0, 8_000) : activity.type.slice(0, 80),
      ...(typeof activity.detail === "string" ? { detail: activity.detail.slice(-32_000) } : {}),
    }];
  });
}

function sanitizeAttachmentMetadata(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((attachment) => {
    if (!attachment || typeof attachment.id !== "string" || !["image", "text"].includes(attachment.kind)) return [];
    return [{
      id: attachment.id.slice(0, 100),
      kind: attachment.kind,
      name: typeof attachment.name === "string" ? attachment.name.slice(0, 260) : "Attachment",
      mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType.slice(0, 100) : "application/octet-stream",
      size: typeof attachment.size === "number" && Number.isFinite(attachment.size) ? attachment.size : 0,
      source: typeof attachment.source === "string" ? attachment.source.slice(0, 40) : "file",
      ...(typeof attachment.previewDataUrl === "string" && attachment.previewDataUrl.length < 200_000
        ? { previewDataUrl: attachment.previewDataUrl }
        : {}),
    }];
  });
}

function persistConversations() {
  const directory = dirname(conversationStatePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${conversationStatePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ version: 1, conversations: persistedConversations }, null, 2), "utf8");
  renameSync(temporaryPath, conversationStatePath);
}

function initializeDesktopScopedAutomation() {
  if (desktopScopedAutomation || !scopedReferencesEnabled) return;
  desktopFrameRouter = new DesktopFrameRouter({
    createId: (kind) => `${kind}-${randomUUID()}`,
    nativeSend: ({ webContentsId, runtimeId, taskId, pageId, electronSessionId, method, params }) => {
      const target = scopedNativeWebviewContents(webContentsId, { runtimeId, taskId, pageId });
      return desktopBrowser.sendNativeCommand(target, method, params, electronSessionId);
    },
  });
  desktopReferenceRegistry = new DesktopReferenceRegistry({
    allocator: new DurableReferenceIdAllocator(scopedReferenceCounterPath),
    isCurrentDocument: (identity) => desktopFrameRouter.isCurrentDocument(identity),
    revalidateAction: async ({ identity }) => {
      mutationGate.assertMutationAllowed(identity.taskId);
      if (!desktopFrameRouter.isCurrentDocument(identity)) {
        throw Object.assign(new Error("Reference document is no longer current"), { code: "REFERENCE_DOCUMENT_NOT_CURRENT" });
      }
    },
    maxActionContextTtlMs: scopedReferenceActionTtlMs,
  });
  desktopScopedAutomation = new DesktopScopedAutomation({
    router: desktopFrameRouter,
    registry: desktopReferenceRegistry,
    mutationGate,
    diagnose: process.env.EGO_SCOPED_DIAGNOSTICS === "1" ? (record) => console.log("scoped-action", JSON.stringify(record)) : undefined,
    resolveRootFrameId: (pageScope) => desktopFrameRouter.listFrameRoutes(pageScope)
      .find((route) => route.transportState === "root")?.identity.frameId,
    captureRootCandidates: async ({ pageScope, stamp, options }) => {
      const target = await desktopTarget({ taskId: pageScope.taskId, targetId: pageScope.pageId });
      return desktopBrowser.captureSnapshotCandidates(target, options, stamp.identity.frameId);
    },
    captureFrameCandidates: ({ pageScope, route, stamp, options, candidateLimit }) => desktopBrowser.captureRoutedFrameCandidates(
      (method, params) => desktopFrameRouter.sendFrameCommand({
        pageScope,
        expectedIdentity: stamp.identity,
        expectedNativeSessionGeneration: stamp.nativeSessionGeneration,
      }, method, params),
      route,
      options,
      candidateLimit,
    ),
    validateBoundCommand: validateDesktopScopedCommand,
    resolveBoundObjectIdentity: async ({ pageScope, binding, objectId }) => {
      const described = await desktopFrameRouter.sendFrameCommand({ pageScope, expectedIdentity: binding.identity,
        expectedNativeSessionGeneration: binding.nativeSessionGeneration }, "DOM.describeNode", { objectId });
      return described?.node?.backendNodeId;
    },
    sendFrameCommand: (input, method, params) => {
      const route = desktopFrameRouter.resolveFrameCommand({
        pageScope: input.pageScope,
        frameId: input.expectedIdentity.frameId,
        expectedIdentity: input.expectedIdentity,
      });
      if (route.nativeSessionGeneration !== input.expectedNativeSessionGeneration) {
        throw Object.assign(new Error("Native session route changed"), { code: "STALE_SESSION_ROUTE" });
      }
      if (["Input.insertText", "Input.dispatchKeyEvent"].includes(method)
        && (route.transportState === "root" || (route.transportState === "same_process" && route.electronSessionId === undefined))) {
        return desktopBrowser.sendNativeCommand(
          scopedNativeWebviewContents(route.webContentsId, input.pageScope),
          method,
          params,
          undefined,
          { allowRootElectronInsert: true, allowRootElectronKey: true },
        );
      }
      if (method === "Page.reload" && route.transportState === "root") {
        return desktopBrowser.sendNativeCommand(
          scopedNativeWebviewContents(route.webContentsId, input.pageScope),
          method,
          params,
          undefined,
          { allowRootElectronReload: true },
        );
      }
      return desktopFrameRouter.sendFrameCommand(input, method, params);
    },
    isPageSelected: (pageScope) => desktopTabs.get(pageScope.pageId)?.taskId === pageScope.taskId
      && desktopTabs.get(pageScope.pageId)?.active === true,
    maxActionTtlMs: scopedReferenceActionTtlMs,
  });
}

function scopedPageScope(tab) {
  return Object.freeze({ runtimeId: desktopRuntimeId, taskId: tab.taskId, pageId: tab.targetId });
}

async function ensureDesktopScopedPage(tab, target) {
  if (!scopedReferencesEnabled) throw Object.assign(new Error("Scoped references are disabled"), { code: "EGO_ACTION_CONTEXT_INVALID" });
  initializeDesktopScopedAutomation();
  target ||= await desktopTarget({ targetId: tab.targetId });
  const key = `${tab.taskId}\u0000${tab.targetId}`;
  const existing = desktopScopedPagePromises.get(key);
  if (existing) {
    const pageScope = await existing;
    await resumeDesktopScopedNativeConfigurations(pageScope);
    return pageScope;
  }
  const setup = (async () => {
    bindDesktopWebview(tab, target);
    const frameTree = await desktopBrowser.sendNativeCommand(target, "Page.getFrameTree", {});
    const rootFrameId = required(frameTree?.frameTree?.frame?.id, "rootFrameId");
    try {
      desktopFrameRouter.registerPage({
        ...scopedPageScope(tab),
        profileId: tab.profileId || "default",
        webContentsId: target.id,
        rootTargetId: tab.targetId,
        rootFrameId,
      });
    } catch (error) {
      if (error?.code !== "PAGE_ALREADY_REGISTERED") throw error;
      const existing = desktopFrameRouter.stats(scopedPageScope(tab));
      if (existing.state === "closed") {
        desktopFrameRouter.replacePage({
          ...scopedPageScope(tab),
          profileId: tab.profileId || "default",
          webContentsId: target.id,
          rootTargetId: tab.targetId,
          rootFrameId,
        });
      }
    }
    await configureDesktopScopedNativeSession(scopedPageScope(tab), target);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const root = desktopFrameRouter.listFrameRoutes(scopedPageScope(tab))
        .find((route) => route.identity.frameId === rootFrameId);
      if (root) return scopedPageScope(tab);
      await delay(20);
    }
    throw Object.assign(new Error("Root frame execution context did not become available"), { code: "EGO_FRAME_UNAVAILABLE" });
  })().catch((error) => {
    desktopScopedPagePromises.delete(key);
    throw error;
  });
  desktopScopedPagePromises.set(key, setup);
  return setup;
}

function assertDesktopScopedNativeSession(stamp, current) {
  if (["nativeSessionKey", "nativeSessionGeneration", "webContentsId", "pageIncarnationId", "parentNativeSessionKey"].some((key) => stamp[key] !== current[key])) {
    throw Object.assign(new Error("Native session changed during frame initialization"), { code: "STALE_SESSION_ROUTE" });
  }
}

function bootstrapDesktopScopedFrameTree(pageScope, electronSessionId, tree, stamp) {
  let current = desktopFrameRouter.captureNativeSession(pageScope, electronSessionId);
  assertDesktopScopedNativeSession(stamp, current);
  if (!tree?.frame?.id) throw Object.assign(new Error("Native frame tree is unavailable"), { code: "FRAME_CONTEXT_UNAVAILABLE" });
  if (electronSessionId === undefined && tree.frame.id !== current.frameId) {
    throw Object.assign(new Error("Native root frame changed during initialization"), { code: "STALE_DOCUMENT" });
  }
  const apply = (method, params) => {
    desktopFrameRouter.applyDebuggerEvent({ pageScope, sourceElectronSessionId: electronSessionId,
      expectedNativeSessionKey: current.nativeSessionKey,
      expectedNativeSessionGeneration: current.nativeSessionGeneration, method, params });
    // These synchronous bootstrap events can themselves rebind the source to
    // its real frame, incrementing its generation. No native await intervenes.
    current = desktopFrameRouter.captureNativeSession(pageScope, electronSessionId);
  };
  apply("Page.frameNavigated", { frame: tree.frame });
  const attachChildren = (parentTree) => {
    for (const child of parentTree.childFrames || []) {
      apply("Page.frameAttached", { frameId: child.frame.id, parentFrameId: parentTree.frame.id });
      attachChildren(child);
    }
  };
  attachChildren(tree);
  return current;
}

function sameDesktopScopedNativeAuthority(stamp, current) {
  return ["nativeSessionKey", "webContentsId", "pageIncarnationId", "parentNativeSessionKey"].every((key) => stamp[key] === current[key])
    && (stamp.frameId === undefined || stamp.frameId === current.frameId);
}

function pruneDesktopScopedNativeConfigurations() {
  for (const [key, state] of desktopScopedNativeConfigurations) {
    try {
      const current = desktopFrameRouter.captureNativeSession(state.source, state.source.electronSessionId);
      if (sameDesktopScopedNativeAuthority(state.source, current)) continue;
    } catch {}
    if (desktopScopedNativeConfigurations.get(key) === state) desktopScopedNativeConfigurations.delete(key);
  }
}

async function awaitDesktopScopedInitialization(invoke, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Object.assign(new Error("Native frame initialization deadline expired"), { code: "FRAME_CONTEXT_UNAVAILABLE" });
  let timer;
  try {
    const result = await Promise.race([invoke(), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Native frame initialization deadline expired"), { code: "FRAME_CONTEXT_UNAVAILABLE" })), remaining);
    })]);
    if (Date.now() >= deadline) throw Object.assign(new Error("Native frame initialization deadline expired"), { code: "FRAME_CONTEXT_UNAVAILABLE" });
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function configureDesktopScopedNativeSession(pageScope, target, electronSessionId, savedState) {
  const state = savedState || { source: desktopFrameRouter.captureNativeSession(pageScope, electronSessionId), pageEnabled: false };
  if (state.activePromise) return state.activePromise;
  const pending = (async () => {
    const deadline = Date.now() + 3_000;
    const beforeEnable = desktopFrameRouter.captureNativeSession(pageScope, electronSessionId);
    if (!sameDesktopScopedNativeAuthority(state.source, beforeEnable)) throw Object.assign(new Error("Native configuration source changed"), { code: "STALE_SESSION_ROUTE" });
    if (!state.pageEnabled) {
      state.pageEnabled = true;
      await awaitDesktopScopedInitialization(() => desktopBrowser.sendNativeCommand(target, "Page.enable", {}, electronSessionId), deadline);
    }
    let current = desktopFrameRouter.captureNativeSession(pageScope, electronSessionId);
    if (!sameDesktopScopedNativeAuthority(beforeEnable, current)) throw Object.assign(new Error("Native session changed while enabling Page"), { code: "STALE_SESSION_ROUTE" });
    let initialized = false;
    for (let read = 0; read < 3; read += 1) {
      const stamp = desktopFrameRouter.captureNativeSession(pageScope, electronSessionId);
      const result = await awaitDesktopScopedInitialization(() => desktopBrowser.sendNativeCommand(target, "Page.getFrameTree", {}, electronSessionId), deadline);
      const next = desktopFrameRouter.captureNativeSession(pageScope, electronSessionId);
      if (stamp.nativeSessionGeneration !== next.nativeSessionGeneration && sameDesktopScopedNativeAuthority(stamp, next)
        && next.nativeSessionGeneration > stamp.nativeSessionGeneration && read < 2 && Date.now() < deadline) continue;
      assertDesktopScopedNativeSession(stamp, next);
      current = bootstrapDesktopScopedFrameTree(pageScope, electronSessionId, result?.frameTree, stamp);
      state.source = current;
      initialized = true;
      break;
    }
    if (!initialized) throw Object.assign(new Error("Native frame tree did not stabilize"), { code: "STALE_SESSION_ROUTE" });
    for (const method of ["Runtime.enable", "DOM.enable", "Accessibility.enable", "Target.setAutoAttach"]) {
      const params = method === "Target.setAutoAttach" ? { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
        filter: [{ type: "iframe", exclude: false }, { exclude: true }] } : {};
      await awaitDesktopScopedInitialization(() => desktopBrowser.sendNativeCommand(target, method, params, electronSessionId), deadline);
      const next = desktopFrameRouter.captureNativeSession(pageScope, electronSessionId);
      assertDesktopScopedNativeSession(current, next);
      current = next;
    }
    return current;
  })();
  state.activePromise = pending;
  try {
    const result = await pending;
    if (savedState && desktopScopedNativeConfigurations.get(state.source.nativeSessionKey) === state) {
      desktopScopedNativeConfigurations.delete(state.source.nativeSessionKey);
    }
    return result;
  } finally {
    if (state.activePromise === pending) state.activePromise = undefined;
    if (savedState) pruneDesktopScopedNativeConfigurations();
  }
}

async function resumeDesktopScopedNativeConfigurations(pageScope) {
  pruneDesktopScopedNativeConfigurations();
  for (const state of [...desktopScopedNativeConfigurations.values()]) {
    if (["runtimeId", "taskId", "pageId"].some((key) => state.source[key] !== pageScope[key])) continue;
    try {
      const target = await desktopTarget({ taskId: pageScope.taskId, targetId: pageScope.pageId });
      await configureDesktopScopedNativeSession(pageScope, target, state.source.electronSessionId, state);
    } catch (error) {
      writeDiagnostic("scoped-reference-error.log", error);
    }
  }
}

async function validateDesktopScopedCommand({ pageScope, binding, route, method, params, pointerPolicy }) {
  const stamp = await desktopFrameRouter.captureFrameIdentity({ pageScope, frameId: binding.identity.frameId });
  const target = webviewContents(route.webContentsId);
  const send = (nextMethod, nextParams) => desktopBrowser.sendNativeCommand(
    target,
    nextMethod,
    nextParams,
    route.electronSessionId,
  );
  let resolved;
  try {
    resolved = await send("DOM.resolveNode", {
      backendNodeId: binding.identity.backendNodeId,
      executionContextId: route.executionContextId,
    });
  } catch (error) {
    await desktopFrameRouter.validateFrameIdentity(stamp);
    throw Object.assign(new Error("Bound node is detached from the current document", { cause: error }), {
      code: "REFERENCE_NODE_DETACHED",
    });
  }
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    await desktopFrameRouter.validateFrameIdentity(stamp);
    throw Object.assign(new Error("Bound node is detached from the current document"), { code: "REFERENCE_NODE_DETACHED" });
  }
  try {
    const state = await send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        const rect = this.getBoundingClientRect?.();
        const style = this instanceof Element ? getComputedStyle(this) : null;
        return {
          connected: this.isConnected === true,
          active: this.ownerDocument?.activeElement === this,
          visible: Boolean(rect && rect.width > 0 && rect.height > 0 && style?.visibility !== "hidden" && style?.display !== "none"),
          rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
        };
      }`,
      returnByValue: true,
    });
    const value = state?.result?.value;
    await desktopFrameRouter.validateFrameIdentity(stamp);
    if (!value?.connected) {
      throw Object.assign(new Error("Bound node is detached from the current document"), { code: "REFERENCE_NODE_DETACHED" });
    }
    if (scopedCommandRequiresExactObject(method, params)) {
      const described = await send("DOM.describeNode", { objectId: params.objectId });
      if (described?.node?.backendNodeId !== binding.identity.backendNodeId) {
        throw Object.assign(new Error("Runtime receiver is not the bound node"), { code: "REFERENCE_SCOPE_MISMATCH" });
      }
    }
    if (scopedCommandRequiresBoundFocus(method, params) && !value.active) {
      throw Object.assign(new Error("Bound node is not focused"), { code: "REFERENCE_SCOPE_MISMATCH" });
    }
    if (scopedCommandRequiresBoundFocus(method, params)) {
      await validateDesktopFrameOwnerFocus(pageScope, route);
    }
    if (method === "Input.dispatchMouseEvent" && ["mousePressed", "mouseReleased", "mouseMoved"].includes(params?.type)) {
      const [box, metrics] = await Promise.all([
        send("DOM.getBoxModel", { backendNodeId: binding.identity.backendNodeId }),
        send("Page.getLayoutMetrics", {}),
      ]);
      const quad = box?.model?.border || box?.model?.content;
      const viewport = metrics?.cssVisualViewport || metrics?.cssLayoutViewport;
      if (!Array.isArray(quad) || quad.length < 8 || !(Number(viewport?.clientWidth) > 0) || !(Number(viewport?.clientHeight) > 0)) {
        throw Object.assign(new Error("Bound node geometry is unavailable in its frame realm"), { code: "FRAME_CONTEXT_UNAVAILABLE" });
      }
      const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
      const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
      const rect = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= Number(viewport.clientWidth) || rect.top >= Number(viewport.clientHeight)) {
        throw Object.assign(new Error("Bound node is outside its native viewport"), { code: "REFERENCE_SCOPE_MISMATCH" });
      }
      const x = Number(params.x);
      const y = Number(params.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)
        || (pointerPolicy !== "path" && (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom))) {
        throw Object.assign(new Error("Pointer coordinates miss the bound node"), { code: "REFERENCE_SCOPE_MISMATCH" });
      }
      const probe = await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: desktopScopedPointerProbe.toString(),
        arguments: [{ value: x }, { value: y }, { value: quad }],
        returnByValue: true,
      });
      if (probe?.result?.value?.unsupported) {
        throw Object.assign(new Error("Transformed frame pointer geometry is unsupported"), { code: "FRAME_CONTEXT_UNAVAILABLE" });
      }
      if (pointerPolicy === "path" && !(probe?.result?.value?.localX >= 0 && probe?.result?.value?.localY >= 0
        && probe.result.value.localX < probe.result.value.width && probe.result.value.localY < probe.result.value.height)) {
        throw Object.assign(new Error("Drag path is outside its frame viewport"), { code: "REFERENCE_SCOPE_MISMATCH" });
      }
      if (pointerPolicy !== "path" && probe?.result?.value?.hit !== true) {
        throw Object.assign(new Error("Pointer hit test misses the bound node in its frame"), { code: "REFERENCE_SCOPE_MISMATCH" });
      }
      await validateDesktopFrameOwnerPointer(pageScope, route, probe.result.value);
    }
  } finally {
    await send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

function desktopScopedPointerProbe(x, y, quad) {
  const rect = this.getBoundingClientRect();
  for (let node = this; node instanceof Element; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.transform !== "none" || style.perspective !== "none"
      || (style.scale && style.scale !== "none") || (style.rotate && style.rotate !== "none")
      || (style.translate && style.translate !== "none") || (style.zoom && Number(style.zoom) !== 1)) return { unsupported: true };
  }
  if (quad.length !== 8 || Math.abs(quad[1] - quad[3]) > 0.5 || Math.abs(quad[3] - quad[5]) < 0.1
    || Math.abs(quad[0] - quad[6]) > 0.5 || Math.abs(quad[2] - quad[4]) > 0.5
    || Math.abs(quad[5] - quad[7]) > 0.5
    || Math.abs((quad[2] - quad[0]) - rect.width) > 0.5
    || Math.abs((quad[5] - quad[3]) - rect.height) > 0.5) return { unsupported: true };
  // Same-process CDP geometry uses the containing target's viewport. The DOM
  // rect and hit test belong to this exact frame's execution context.
  const localX = x - (quad[0] - rect.left);
  const localY = y - (quad[1] - rect.top);
  const hit = this.ownerDocument.elementFromPoint(localX, localY);
  return { hit: this.isConnected === true && Boolean(hit && (hit === this || this.contains(hit))),
    localX, localY, width: innerWidth, height: innerHeight };
}

function desktopScopedFrameOwnerPointerProbe(point) {
  const rect = this.getBoundingClientRect();
  for (let node = this; node instanceof Element; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.transform !== "none" || style.perspective !== "none"
      || (style.scale && style.scale !== "none") || (style.rotate && style.rotate !== "none")
      || (style.translate && style.translate !== "none") || (style.zoom && Number(style.zoom) !== 1)) return { unsupported: true };
  }
  if (Math.abs(rect.width - this.offsetWidth) > 1 || Math.abs(rect.height - this.offsetHeight) > 1) return { unsupported: true };
  const localX = rect.left + this.clientLeft + point.localX;
  const localY = rect.top + this.clientTop + point.localY;
  const hit = this.ownerDocument.elementFromPoint(localX, localY);
  return { hit: this.isConnected === true && point.localX >= 0 && point.localY >= 0
    && point.localX < this.clientWidth && point.localY < this.clientHeight && hit === this,
    localX, localY, width: innerWidth, height: innerHeight };
}

async function validateDesktopFrameOwnerPointer(pageScope, route, point) {
  let childRoute = route;
  while (childRoute.parentFrameId) {
    const parentRoute = desktopFrameRouter.resolveFrameCommand({ pageScope, frameId: childRoute.parentFrameId });
    const sendParent = (method, params) => desktopFrameRouter.sendFrameCommand({
      pageScope, expectedIdentity: parentRoute.identity,
      expectedNativeSessionGeneration: parentRoute.nativeSessionGeneration,
    }, method, params);
    const owner = await sendParent("DOM.getFrameOwner", { frameId: childRoute.identity.frameId });
    const resolved = await sendParent("DOM.resolveNode", {
      backendNodeId: owner.backendNodeId, executionContextId: parentRoute.executionContextId,
    });
    const objectId = resolved?.object?.objectId;
    if (!objectId) throw Object.assign(new Error("Frame owner object cannot be resolved"), { code: "FRAME_CONTEXT_UNAVAILABLE" });
    try {
      const probe = await sendParent("Runtime.callFunctionOn", {
        objectId, functionDeclaration: desktopScopedFrameOwnerPointerProbe.toString(),
        arguments: [{ value: point }], returnByValue: true,
      });
      if (probe?.result?.value?.unsupported) throw Object.assign(new Error("Transformed frame owner is unsupported"), { code: "FRAME_CONTEXT_UNAVAILABLE" });
      if (probe?.result?.value?.hit !== true) throw Object.assign(new Error("Frame owner is hidden, clipped, or covered"), { code: "REFERENCE_SCOPE_MISMATCH" });
      point = probe.result.value;
    } finally {
      await sendParent("Runtime.releaseObject", { objectId }).catch(() => {});
    }
    childRoute = parentRoute;
  }
}

async function validateDesktopFrameOwnerFocus(pageScope, route) {
  let childRoute = route;
  while (childRoute.parentFrameId) {
    const parentRoute = desktopFrameRouter.resolveFrameCommand({ pageScope, frameId: childRoute.parentFrameId });
    const sendParent = (method, params) => desktopFrameRouter.sendFrameCommand({
      pageScope,
      expectedIdentity: parentRoute.identity,
      expectedNativeSessionGeneration: parentRoute.nativeSessionGeneration,
    }, method, params);
    const owner = await sendParent("DOM.getFrameOwner", { frameId: childRoute.identity.frameId });
    const ownerBackendNodeId = owner?.backendNodeId;
    if (!Number.isSafeInteger(ownerBackendNodeId)) {
      throw Object.assign(new Error("Frame owner cannot be resolved"), { code: "FRAME_CONTEXT_UNAVAILABLE" });
    }
    const resolved = await sendParent("DOM.resolveNode", {
      backendNodeId: ownerBackendNodeId,
      executionContextId: parentRoute.executionContextId,
    });
    const objectId = resolved?.object?.objectId;
    if (!objectId) throw Object.assign(new Error("Frame owner object cannot be resolved"), { code: "FRAME_CONTEXT_UNAVAILABLE" });
    try {
      const active = await sendParent("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(){return this.ownerDocument?.activeElement===this;}",
        returnByValue: true,
      });
      if (active?.result?.value !== true) {
        throw Object.assign(new Error("Frame owner focus chain is no longer active"), { code: "REFERENCE_SCOPE_MISMATCH" });
      }
    } finally {
      await sendParent("Runtime.releaseObject", { objectId }).catch(() => {});
    }
    childRoute = parentRoute;
  }
}

async function drainDesktopScopedRouterEffects() {
  if (!desktopFrameRouter || !desktopScopedAutomation) return;
  const effects = desktopFrameRouter.takeEffects();
  const remaining = desktopScopedAutomation.consumeRouterEffects(effects);
  for (const effect of remaining) {
    if (effect.type === "alias_retired") {
      desktopScopedAliasPages.delete(effect.alias);
      desktopScopedRetiredAliases.set(effect.alias, effect.reason || "alias_retired");
      while (desktopScopedRetiredAliases.size > 100) desktopScopedRetiredAliases.delete(desktopScopedRetiredAliases.keys().next().value);
      continue;
    }
    if (effect.type !== "configure_native_session") continue;
    const tab = desktopTabs.get(effect.pageScope.pageId);
    if (!tab) continue;
    try {
      const session = desktopFrameRouter.captureNativeSession(effect.pageScope, effect.electronSessionId);
      if (session.nativeSessionKey !== effect.nativeSessionKey) throw Object.assign(new Error("Native session configuration effect is stale"), { code: "STALE_SESSION_ROUTE" });
      const state = desktopScopedNativeConfigurations.get(session.nativeSessionKey) || { source: session, pageEnabled: false };
      desktopScopedNativeConfigurations.set(session.nativeSessionKey, state);
      const target = await desktopTarget({ taskId: tab.taskId, targetId: tab.targetId });
      await configureDesktopScopedNativeSession(effect.pageScope, target, effect.electronSessionId, state);
    } catch (error) {
      writeDiagnostic("scoped-reference-error.log", error);
    }
  }
  pruneDesktopScopedNativeConfigurations();
}

async function routeDesktopScopedDebuggerEvent(tab, method, params, electronSessionId) {
  if (process.env.EGO_SCOPED_DIAGNOSTICS === "1" && method.startsWith("Page.javascriptDialog")) {
    console.log("scoped-event", JSON.stringify({ at: Date.now(), method, childSession: Boolean(electronSessionId) }));
  }
  if (process.env.EGO_SCOPED_DIAGNOSTICS === "1" && method === "Target.attachedToTarget") {
    console.log("scoped-target", JSON.stringify({ at: Date.now(), type: params?.targetInfo?.type, childParentSession: Boolean(electronSessionId) }));
  }
  if (!desktopFrameRouter || !desktopScopedAutomation) return;
  try {
    if (SCOPED_ROUTER_LIFECYCLE_METHODS.has(method)) {
      desktopFrameRouter.applyDebuggerEvent({
        pageScope: scopedPageScope(tab),
        sourceElectronSessionId: electronSessionId,
        method,
        params,
      });
    }
    if (isScopedClientEvent(method)) {
      const events = desktopFrameRouter.routeNativeEvent({
        pageScope: scopedPageScope(tab),
        sourceElectronSessionId: electronSessionId,
        method,
        params,
      });
      for (const routed of events) {
        desktopRpcServer?.notify("cdp.event", {
          taskId: routed.taskId,
          clientId: routed.clientId,
          payload: JSON.stringify({ method: routed.method, params: routed.params, sessionId: routed.alias }),
        });
      }
    }
    await drainDesktopScopedRouterEffects();
  } catch (error) {
    if (!["UNKNOWN_PAGE", "PAGE_CLOSED", "FOREIGN_SESSION"].includes(error?.code)) {
      writeDiagnostic("scoped-reference-error.log", error);
    }
  }
}

function isScopedClientEvent(method) {
  return method.startsWith("Network.")
    || method.startsWith("Browser.download")
    || method.startsWith("Page.javascriptDialog")
    || [
      "Page.loadEventFired", "Page.domContentEventFired", "Page.lifecycleEvent",
      "Page.frameStartedLoading", "Page.frameStoppedLoading", "Runtime.bindingCalled",
    ].includes(method);
}

function closeDesktopScopedPage(tab, reason) {
  if (!desktopFrameRouter || !desktopScopedAutomation) return;
  const key = `${tab.taskId}\u0000${tab.targetId}`;
  desktopScopedPagePromises.delete(key);
  for (const [sessionKey, state] of desktopScopedNativeConfigurations) {
    if (state.source.taskId === tab.taskId && state.source.pageId === tab.targetId) desktopScopedNativeConfigurations.delete(sessionKey);
  }
  for (const [alias, pageScope] of desktopScopedAliasPages) {
    if (pageScope.taskId === tab.taskId && pageScope.pageId === tab.targetId) {
      desktopScopedAliasPages.delete(alias);
      desktopScopedRetiredAliases.set(alias, `page_closed:${reason}`);
      desktopScopedRetiredAliasPages.set(alias, pageScope);
    }
  }
  while (desktopScopedRetiredAliasPages.size > 100) {
    const oldest = desktopScopedRetiredAliasPages.keys().next().value;
    desktopScopedRetiredAliasPages.delete(oldest);
    desktopScopedRetiredAliases.delete(oldest);
  }
  try {
    desktopFrameRouter.closePage(scopedPageScope(tab), reason);
    void drainDesktopScopedRouterEffects().catch((error) => writeDiagnostic("scoped-reference-error.log", error));
  } catch (error) {
    if (error?.code !== "UNKNOWN_PAGE") writeDiagnostic("scoped-reference-error.log", error);
  }
}

async function sendDesktopCdp(taskId, rawPayload, requestContext, downloadTab) {
  mutationGate.assertMutationAllowed(taskId);
  const request = JSON.parse(rawPayload);
  const params = request.params || {};
  try {
    let result;
    if (request.method === "Target.getTargets") {
      result = { targetInfos: [...desktopTabs.values()].filter((tab) => tab.taskId === taskId).map((tab) => ({ targetId: tab.targetId, type: "page", title: tab.title, url: tab.url, attached: false })) };
    } else if (request.method === "Target.activateTarget") {
      result = { success: await activateDesktopTab(required(params.targetId, "targetId")) };
    } else if (request.method === "Target.closeTarget") {
      result = { success: await closeDesktopTab(required(params.targetId, "targetId")) };
    } else if (request.method === "Target.createTarget") {
      result = { targetId: (await createDesktopTab(taskId, normalizedUrl(params.url || "about:blank"))).targetId };
    } else if (request.method === "Target.attachToTarget") {
      const targetId = required(params.targetId, "targetId");
      const tab = desktopTabs.get(targetId);
      if (!tab || tab.taskId !== taskId) throw new Error(`Unknown desktop target: ${targetId}`);
      clearDesktopSessions(targetId);
      const sessionId = `desktop-session-${randomUUID()}`;
      desktopSessions.set(sessionId, {
        taskId,
        targetId,
        ...(typeof requestContext?.clientId === "string" ? { clientId: requestContext.clientId } : {}),
      });
      desktopTargetSessions.set(targetId, sessionId);
      result = { sessionId };
    } else if (request.method === "Target.detachFromTarget") {
      const sessionId = required(params.sessionId, "sessionId");
      const session = desktopSessions.get(sessionId);
      if (!session || session.taskId !== taskId) throw new Error(`Unknown desktop session: ${sessionId}`);
      desktopSessions.delete(sessionId);
      if (desktopTargetSessions.get(session.targetId) === sessionId) desktopTargetSessions.delete(session.targetId);
      result = {};
    } else if (["Target.setDiscoverTargets", "Target.setAutoAttach"].includes(request.method)) {
      result = {};
    } else if (request.method === "Ego.setDownloadPath") {
      const guid = required(params.guid, "guid");
      const savePath = required(params.path, "path");
      if (!isAbsolute(savePath)) throw new Error("Download save path must be absolute");
      const sourcePath = typeof params.sourcePath === "string" && isAbsolute(params.sourcePath) ? params.sourcePath : "";
      const record = desktopDownloads.get(guid) || (sourcePath
        ? [...desktopDownloads.values()].find((item) => item.taskId === taskId && item.savePath === sourcePath)
        : undefined);
      if (!record || record.taskId !== taskId || (downloadTab && record.targetId !== downloadTab.targetId)) {
        const known = [...desktopDownloads.values()].slice(-5).map((item) => ({ guid: item.guid, taskId: item.taskId }));
        throw new Error(`Unknown desktop download: ${guid} for task ${taskId}; sourcePath=${sourcePath}; known=${JSON.stringify(known)}`);
      }
      record.savePath = savePath;
      record.filename = basename(savePath);
      persistDesktopDownloads();
      notifyDesktopDownload(record);
      result = { updated: true };
    } else if (["Browser.setDownloadBehavior", "Page.setDownloadBehavior"].includes(request.method)) {
      const session = request.sessionId ? desktopSessions.get(request.sessionId) : undefined;
      const tab = downloadTab || (session
        ? desktopTabs.get(session.targetId)
        : [...desktopTabs.values()].find((item) => item.taskId === taskId && item.active));
      if (!tab) throw new Error("Ego desktop has no active download target");
      if (params.behavior === "allow" && typeof params.downloadPath === "string" && params.downloadPath) {
        mkdirSync(params.downloadPath, { recursive: true });
        desktopDownloadPaths.set(tab.targetId, params.downloadPath);
      } else if (params.behavior !== "allow") {
        desktopDownloadPaths.delete(tab.targetId);
      }
      result = {};
    } else {
      const session = request.sessionId ? desktopSessions.get(request.sessionId) : undefined;
      if (request.sessionId && (!session || session.taskId !== taskId)) {
        throw new Error(`Unknown desktop session: ${request.sessionId}`);
      }
      result = await desktopBrowser.sendCommand(await desktopTarget({ taskId, targetId: session?.targetId }), request.method, params);
    }
    return JSON.stringify({ id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
  } catch (error) {
    return JSON.stringify({ id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) }, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
  }
}

async function sendDesktopScopedRawCdp(taskId, request, requestContext) {
  const diagnostic = (phase, code) => {
    if (process.env.EGO_SCOPED_DIAGNOSTICS === "1") console.log("scoped-raw", JSON.stringify({ at: Date.now(), method: request.method, phase, code }));
  };
  diagnostic("start");
  mutationGate.assertMutationAllowed(taskId);
  const params = request.params || {};
  try {
    let result;
    if (request.method === "Target.getTargets") {
      result = {
        targetInfos: [...desktopTabs.values()]
          .filter((tab) => tab.taskId === taskId)
          .map((tab) => ({ targetId: tab.targetId, type: "page", title: tab.title, url: tab.url, attached: false })),
      };
    } else if (request.method === "Target.attachToTarget") {
      const tab = desktopTabs.get(required(params.targetId, "targetId"));
      if (!tab || tab.taskId !== taskId) throw Object.assign(new Error("Target is unavailable"), { code: "EGO_REFERENCE_STALE" });
      await ensureDesktopScopedPage(tab);
      const attached = desktopFrameRouter.attachClient({
        pageScope: scopedPageScope(tab),
        clientId: required(requestContext.clientId, "requestContext.clientId"),
        targetId: tab.targetId,
      });
      desktopScopedAliasPages.set(attached.alias, scopedPageScope(tab));
      desktopScopedRetiredAliases.delete(attached.alias);
      result = { sessionId: attached.alias };
    } else if (request.method === "Target.detachFromTarget") {
      const alias = required(params.sessionId || request.sessionId, "sessionId");
      const pageScope = desktopScopedAliasPages.get(alias);
      if (!pageScope || pageScope.taskId !== taskId) throw Object.assign(new Error("Session alias is unavailable"), { code: "EGO_ACTION_SCOPE_MISMATCH" });
      desktopFrameRouter.detachClient({ pageScope, clientId: requestContext.clientId, alias });
      desktopScopedAliasPages.delete(alias);
      await drainDesktopScopedRouterEffects();
      result = {};
    } else if (request.method === "Ego.getPageSessions") {
      const alias = required(request.sessionId, "sessionId");
      const pageScope = desktopScopedAliasPages.get(alias);
      if (!pageScope || pageScope.taskId !== taskId) throw Object.assign(new Error("Page alias is unavailable"), { code: "EGO_ACTION_SCOPE_MISMATCH" });
      const rootRoute = desktopFrameRouter.resolveCommand({ pageScope, clientId: requestContext.clientId, alias });
      if (rootRoute.transportState !== "root") throw Object.assign(new Error("Page sessions require a root page alias"), { code: "EGO_ACTION_SCOPE_MISMATCH" });
      const nativeSessions = new Set();
      const sessions = [];
      for (const route of desktopFrameRouter.listFrameRoutes(pageScope)) {
        if (nativeSessions.has(route.nativeSessionKey)) continue;
        nativeSessions.add(route.nativeSessionKey);
        const attached = desktopFrameRouter.attachClient({ pageScope, clientId: requestContext.clientId, targetId: route.targetId });
        desktopScopedAliasPages.set(attached.alias, pageScope);
        sessions.push({ sessionId: attached.alias, frameId: route.identity.frameId });
      }
      result = { pageId: pageScope.pageId, sessions };
    } else if (["Ego.setDownloadPath", "Browser.setDownloadBehavior", "Page.setDownloadBehavior"].includes(request.method)) {
      const alias = required(request.sessionId, "sessionId");
      const pageScope = desktopScopedAliasPages.get(alias);
      if (!pageScope || pageScope.taskId !== taskId) throw Object.assign(new Error("Download page alias is unavailable"), { code: "EGO_ACTION_SCOPE_MISMATCH" });
      desktopFrameRouter.resolveCommand({ pageScope, clientId: requestContext.clientId, alias });
      const tab = desktopTabs.get(pageScope.pageId);
      if (!tab || tab.taskId !== taskId) throw Object.assign(new Error("Download page is unavailable"), { code: "EGO_REFERENCE_STALE" });
      const response = await invokeCurrentScopedMutation(taskId, () => {
        desktopFrameRouter.resolveCommand({ pageScope, clientId: requestContext.clientId, alias });
        return sendDesktopCdp(taskId, JSON.stringify({ ...request, sessionId: undefined }), requestContext, tab);
      });
      return JSON.stringify({ ...JSON.parse(response), sessionId: alias });
    } else if (["Target.setDiscoverTargets", "Target.setAutoAttach"].includes(request.method)) {
      result = {};
    } else if (["Target.activateTarget", "Target.closeTarget", "Target.createTarget"].includes(request.method)) {
      result = await invokeCurrentScopedMutation(taskId, async () => {
          if (request.method === "Target.activateTarget") {
            return { success: await activateDesktopTab(required(params.targetId, "targetId")) };
          }
          if (request.method === "Target.closeTarget") {
            return { success: await closeDesktopTab(required(params.targetId, "targetId")) };
          }
          return { targetId: (await createDesktopTab(taskId, normalizedUrl(params.url || "about:blank"))).targetId };
      });
    } else {
      let pageScope;
      let route;
      if (request.sessionId) {
        pageScope = desktopScopedAliasPages.get(request.sessionId);
        if (!pageScope || pageScope.taskId !== taskId) {
          const reason = desktopScopedRetiredAliases.get(request.sessionId) || "unknown_alias";
          const code = reason.startsWith("page_closed:") ? "DETACHED_SESSION" : "EGO_ACTION_SCOPE_MISMATCH";
          throw Object.assign(new Error(`Session alias is unavailable (${reason})`), { code });
        }
        if (!route) {
          route = desktopFrameRouter.resolveCommand({
            pageScope,
            clientId: requestContext.clientId,
            alias: request.sessionId,
          });
        }
      } else {
        const tab = [...desktopTabs.values()].find((item) => item.taskId === taskId && item.webContentsId === activeWebviewId)
          || [...desktopTabs.values()].find((item) => item.taskId === taskId && item.active);
        if (!tab) throw Object.assign(new Error("No selected page"), { code: "EGO_REFERENCE_STALE" });
        pageScope = await ensureDesktopScopedPage(tab);
        route = desktopFrameRouter.listFrameRoutes(pageScope).find((candidate) => candidate.transportState === "root");
        if (!route) throw Object.assign(new Error("Root frame is unavailable"), { code: "EGO_FRAME_UNAVAILABLE" });
      }
      const commandParams = params;
      if (request.method === "Runtime.evaluate" && route.transportState === "root") {
        await desktopBrowser.waitForNativeReady(webviewContents(route.webContentsId));
      }
      const invoke = () => request.method === "Page.reload" && route.transportState === "root"
        ? desktopBrowser.sendNativeCommand(
          webviewContents(route.webContentsId),
          request.method,
          commandParams,
          undefined,
          { allowRootElectronReload: true },
        )
        : request.method === "Runtime.evaluate" && route.transportState === "root"
          ? desktopBrowser.sendNativeCommand(
            webviewContents(route.webContentsId),
            request.method,
            commandParams,
            undefined,
            { allowRootElectronEvaluate: true },
          )
          : desktopFrameRouter.sendFrameCommand({
          pageScope,
          expectedIdentity: route.identity,
          expectedNativeSessionGeneration: route.nativeSessionGeneration,
          }, request.method, commandParams);
      result = await invokeCurrentScopedMutation(taskId, invoke);
    }
    diagnostic("done");
    return JSON.stringify({ id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
  } catch (error) {
    diagnostic("error", error?.code || error?.message);
    const rawCode = [
      "PAGE_CLOSED", "UNKNOWN_PAGE", "DETACHED_SESSION", "UNKNOWN_ALIAS", "STALE_SESSION_ROUTE",
      "FRAME_CONTEXT_UNAVAILABLE", "FRAME_UNRESOLVED", "NATIVE_DOCUMENT_UNAVAILABLE",
    ].includes(error?.code)
      ? "EGO_FRAME_UNAVAILABLE"
      : error?.code === "STALE_DOCUMENT"
        ? "EGO_REFERENCE_STALE"
        : typeof error?.code === "string"
          ? error.code
          : -32000;
    return JSON.stringify({
      id: request.id,
      error: {
        code: rawCode,
        message: error instanceof Error ? error.message : String(error),
      },
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });
  } finally {
    await drainDesktopScopedRouterEffects();
  }
}

async function revalidateCurrentMutation(taskId) {
  const context = mutationGate.current();
  if (!context) throw Object.assign(new Error("Mutation context is unavailable"), { code: "EGO_ACTION_CONTEXT_INVALID" });
  const checked = await rpc.request("mutation.assert", {
    clientId,
    taskId,
    actorClientId: context.clientId,
    leaseEpoch: context.leaseEpoch,
  });
  updateBrokerSpaceState({ space: checked.space });
}

function invokeCurrentScopedMutation(taskId, invoke) {
  return invokeAfterFinalAuthorization({
    authorize: () => revalidateCurrentMutation(taskId),
    assertAllowed: () => mutationGate.assertMutationAllowed(taskId),
    invoke,
  });
}

function clearDesktopSessions(targetId) {
  const activeSessionId = desktopTargetSessions.get(targetId);
  if (activeSessionId) desktopSessions.delete(activeSessionId);
  desktopTargetSessions.delete(targetId);
  for (const [sessionId, session] of desktopSessions) {
    if (session.targetId === targetId) desktopSessions.delete(sessionId);
  }
}

function notifyDesktopCdp(tab, method, params) {
  const sessionId = desktopTargetSessions.get(tab.targetId);
  if (sessionId) {
    const desktopSession = desktopSessions.get(sessionId);
    desktopRpcServer?.notify("cdp.event", {
      taskId: tab.taskId,
      ...(desktopSession?.clientId ? { clientId: desktopSession.clientId } : {}),
      payload: JSON.stringify({ method, params, sessionId }),
    });
  }
  if (scopedReferencesEnabled && desktopFrameRouter && method.startsWith("Page.download")) {
    try {
      const routed = desktopFrameRouter.routeNativeEvent({ pageScope: scopedPageScope(tab), method, params, scope: "page" });
      for (const event of routed) {
        desktopRpcServer?.notify("cdp.event", { taskId: event.taskId, clientId: event.clientId,
          payload: JSON.stringify({ method: event.method, params: event.params, sessionId: event.alias }) });
      }
    } catch (error) {
      if (!["UNKNOWN_PAGE", "PAGE_CLOSED"].includes(error?.code)) writeDiagnostic("scoped-reference-error.log", error);
    }
  }
}

function bindDesktopDownloads(electronSession) {
  if (observedDownloadSessions.has(electronSession)) return;
  observedDownloadSessions.add(electronSession);
  electronSession.on("will-download", (_event, item, sourceWebContents) => {
    const tab = [...desktopTabs.values()].find((candidate) => candidate.webContentsId === sourceWebContents?.id);
    if (!tab) return;
    const guid = typeof item.getGUID === "function" && item.getGUID() ? item.getGUID() : randomUUID();
    const suggestedFilename = item.getFilename() || guid;
    const configuredDownloadPath = desktopDownloadPaths.get(tab.targetId);
    const silentAgentDownloadPath = !configuredDownloadPath && agentSilentDownloadsEnabled() && isAgentControlledTask(tab.taskId)
      ? agentDownloadDirectory()
      : "";
    const downloadPath = configuredDownloadPath || silentAgentDownloadPath;
    const reservedSavePath = downloadPath ? reserveDesktopDownloadPath(downloadPath, suggestedFilename) : "";
    if (reservedSavePath) item.setSavePath(reservedSavePath);
    const record = {
      id: guid,
      guid,
      taskId: tab.taskId,
      targetId: tab.targetId,
      filename: suggestedFilename,
      url: item.getURL(),
      state: "inProgress",
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      savePath: item.getSavePath(),
      reservedSavePath,
      startedAt: new Date().toISOString(),
      item,
    };
    desktopDownloads.set(guid, record);
    persistDesktopDownloads();
    notifyDesktopDownload(record);
    notifyDesktopCdp(tab, "Page.downloadWillBegin", {
      frameId: "",
      guid,
      url: item.getURL(),
      suggestedFilename,
    });
    item.on("updated", () => {
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.savePath = item.getSavePath() || record.savePath;
      notifyDesktopDownload(record);
      notifyDesktopCdp(tab, "Page.downloadProgress", {
        guid,
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        state: "inProgress",
      });
    });
    item.once("done", (_downloadEvent, state) => {
      releaseDesktopDownloadPath(record.reservedSavePath);
      record.state = state === "completed" ? "completed" : state === "cancelled" ? "canceled" : "interrupted";
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.savePath = item.getSavePath() || record.savePath;
      record.item = undefined;
      persistDesktopDownloads();
      notifyDesktopDownload(record);
      notifyDesktopCdp(tab, "Page.downloadProgress", {
        guid,
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        state: state === "completed" ? "completed" : "canceled",
      });
    });
  });
}

function reserveDesktopDownloadPath(directory, suggestedFilename) {
  mkdirSync(directory, { recursive: true });
  const filename = basename(String(suggestedFilename || "download")) || "download";
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  for (let index = 0; index < 10_000; index += 1) {
    const candidateName = index === 0 ? filename : `${stem} (${index})${extension}`;
    const candidate = join(directory, candidateName);
    const reservationKey = resolve(candidate).toLocaleLowerCase();
    if (existsSync(candidate) || reservedDesktopDownloadPaths.has(reservationKey)) continue;
    reservedDesktopDownloadPaths.add(reservationKey);
    return candidate;
  }
  throw new Error(`无法为下载文件生成唯一名称：${filename}`);
}

function releaseDesktopDownloadPath(path) {
  if (path) reservedDesktopDownloadPaths.delete(resolve(path).toLocaleLowerCase());
}

function isAgentControlledTask(taskId) {
  if (!taskId) return false;
  const space = brokerSpaceStates.get(taskId);
  if (space && space.ownership !== "agent") return false;
  for (const agent of brokerAgentStates.values()) {
    if (agent?.clientKind === "desktop-ui") continue;
    if (agent?.currentTaskId === taskId && agent.status !== "offline" && agent.status !== "user-control") return true;
  }
  const lastActivity = recentDesktopAgentTasks.get(taskId) || 0;
  if (Date.now() - lastActivity <= 5 * 60_000) return true;
  recentDesktopAgentTasks.delete(taskId);
  return false;
}

function configureWebviewSession(electronSession) {
  if (configuredWebviewSessions.has(electronSession)) return;
  configuredWebviewSessions.add(electronSession);
  electronSession.setPermissionCheckHandler((target, permission, requestingOrigin, details = {}) => {
    if (!isEgoGuestContents(target)) return false;
    const key = permissionKey(requestingOrigin || target.getURL(), permissionScope(permission, details));
    return desktopPreferences.permissions?.[key] === true || desktopSessionPermissions.get(key) === true;
  });
  electronSession.setPermissionRequestHandler((target, permission, callback, details = {}) => {
    if (!isEgoGuestContents(target)) return callback(false);
    const origin = originOf(details.requestingUrl || details.securityOrigin || target.getURL());
    const scopedPermission = permissionScope(permission, details);
    const key = permissionKey(origin, scopedPermission);
    const remembered = desktopPreferences.permissions?.[key];
    if (typeof remembered === "boolean") return callback(remembered);
    void requestBrowserPrompt({
      type: "permission",
      title: "网站权限",
      message: `${origin || "当前网站"} 请求使用：${permissionLabel(scopedPermission)}`,
      origin,
      permission,
      webContentsId: target.id,
      rememberAllowed: true,
    }).then((response) => {
      if (response.remember) {
        desktopPreferences.permissions[key] = response.accepted;
        persistDesktopPreferences();
      } else if (response.accepted) {
        desktopSessionPermissions.set(key, true);
      }
      callback(response.accepted);
    });
  });
}

function requestBrowserPrompt(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve({ accepted: false });
  const id = randomUUID();
  return new Promise((resolve) => {
    browserPromptPending.set(id, { id, payload, resolve, timer: null });
    browserPromptQueue.push(id);
    pumpBrowserPromptQueue();
  });
}

function pumpBrowserPromptQueue() {
  if (activeBrowserPromptId || !mainWindow || mainWindow.isDestroyed()) return;
  while (browserPromptQueue.length) {
    const id = browserPromptQueue.shift();
    const pending = browserPromptPending.get(id);
    if (!pending) continue;
    activeBrowserPromptId = id;
    pending.timer = setTimeout(() => finishBrowserPrompt(id, { accepted: false }, true), 60_000);
    mainWindow.webContents.send("ego:browser-prompt", { id, ...pending.payload });
    showMainWindow();
    return;
  }
}

function finishBrowserPrompt(id, response, expired = false) {
  const pending = browserPromptPending.get(id);
  if (!pending) return;
  browserPromptPending.delete(id);
  if (pending.timer) clearTimeout(pending.timer);
  if (activeBrowserPromptId === id) activeBrowserPromptId = "";
  else {
    const index = browserPromptQueue.indexOf(id);
    if (index >= 0) browserPromptQueue.splice(index, 1);
  }
  if (expired && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ego:browser-prompt-expired", { id });
  pending.resolve(response);
  pumpBrowserPromptQueue();
}

function cancelBrowserPrompts(webContentsId) {
  for (const [id, pending] of [...browserPromptPending]) {
    if (webContentsId && pending.payload.webContentsId !== webContentsId) continue;
    finishBrowserPrompt(id, { accepted: false }, id === activeBrowserPromptId);
  }
}

function notifyDesktopDownload(record) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ego:download", publicDesktopDownload(record));
}

function publicDesktopDownload(record) {
  return {
    id: record.id,
    targetId: record.targetId,
    filename: record.filename,
    url: record.url,
    state: record.state,
    receivedBytes: record.receivedBytes,
    totalBytes: record.totalBytes,
    savePath: record.savePath || "",
    startedAt: record.startedAt,
  };
}

function notifyBrowserTabCrashed(tab, detail) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ego:browser-tab-crashed", {
    targetId: tab.targetId,
    title: detail.reason === "unresponsive" ? "页面没有响应" : "页面停止运行",
    ...detail,
  });
}

function isEgoGuestContents(target) {
  if (!target || target.isDestroyed?.()) return false;
  if ([...desktopTabs.values()].some((tab) => tab.webContentsId === target.id)) return true;
  return target.hostWebContents?.id === mainWindow?.webContents.id;
}

function originOf(value) {
  try { return new URL(value).origin; } catch { return String(value || ""); }
}

function permissionKey(origin, permission) {
  return `${originOf(origin)}|${permission}`;
}

function listDesktopPermissions() {
  const rows = new Map();
  for (const [id, allowed] of Object.entries(desktopPreferences.permissions || {})) {
    rows.set(id, publicDesktopPermission(id, allowed === true, "remembered"));
  }
  for (const [id, allowed] of desktopSessionPermissions) {
    if (!rows.has(id)) rows.set(id, publicDesktopPermission(id, allowed === true, "session"));
  }
  return [...rows.values()].sort((left, right) => left.origin.localeCompare(right.origin) || left.permission.localeCompare(right.permission));
}

function publicDesktopPermission(id, allowed, scope) {
  const separator = id.lastIndexOf("|");
  const origin = separator >= 0 ? id.slice(0, separator) : "";
  const permission = separator >= 0 ? id.slice(separator + 1) : id;
  return { id, origin, permission, label: permissionLabel(permission), allowed, scope };
}

function permissionScope(permission, details = {}) {
  if (permission !== "media") return permission;
  const mediaTypes = Array.isArray(details.mediaTypes)
    ? details.mediaTypes
    : details.mediaType ? [details.mediaType] : [];
  return mediaTypes.length ? `media:${[...new Set(mediaTypes)].sort().join("+")}` : permission;
}

function permissionLabel(permission) {
  return ({
    geolocation: "位置信息",
    media: "摄像头或麦克风",
    "media:audio": "麦克风",
    "media:video": "摄像头",
    "media:audio+video": "摄像头和麦克风",
    notifications: "通知",
    midi: "MIDI 设备",
    pointerLock: "鼠标指针锁定",
    fullscreen: "全屏显示",
    clipboardRead: "读取剪贴板",
    clipboardSanitizedWrite: "写入剪贴板",
    displayCapture: "屏幕共享",
  })[permission] || permission;
}

function collectionsToMarkdown(items) {
  const lines = ["# Ego Collections", ""];
  const groups = new Map();
  for (const item of items) {
    const group = item.group || "Ungrouped";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  for (const [group, groupItems] of groups) {
    lines.push(`## ${group}`, "");
    for (const item of groupItems) {
      lines.push(`### ${item.pageTitle || item.sourceUrl || "Collection"}`, "", item.text, "");
      if (item.tags?.length) lines.push(`Tags: ${item.tags.join(", ")}`, "");
      if (item.sourceUrl) lines.push(`Source: ${item.sourceUrl}`, "");
      lines.push(`Saved: ${item.createdAt}`, "");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

async function desktopTarget(payload) {
  if (payload.webContentsId) return webviewContents(payload.webContentsId);
  let tab = payload.targetId ? desktopTabs.get(payload.targetId) : undefined;
  if (payload.targetId && (!tab || (payload.taskId && tab.taskId !== payload.taskId))) {
    throw Object.assign(new Error("Requested desktop target is unavailable"), { code: "EGO_FRAME_UNAVAILABLE" });
  }
  if (!tab && payload.taskId) tab = [...desktopTabs.values()].find((item) => item.taskId === payload.taskId && item.active);
  if (!tab && activeWebviewId) return webviewContents(activeWebviewId);
  if (!tab) throw new Error("Ego desktop has no active webview");
  const deadline = Date.now() + 5_000;
  const registrationGraceDeadline = Date.now() + 750;
  let lastError;
  let resolvedFromHost = false;
  while (Date.now() < deadline) {
    if (tab.webContentsId) {
      try {
        return webviewContents(tab.webContentsId);
      } catch (error) {
        lastError = error;
      }
    }
    if (!resolvedFromHost && Date.now() >= registrationGraceDeadline) {
      resolvedFromHost = true;
      try {
        const remaining = Math.max(100, deadline - Date.now());
        const expectedWebContentsId = tab.webContentsId;
        const resolved = await hostRequest("tab.resolve", publicDesktopRecord(tab), Math.min(2_000, remaining));
        const currentTab = desktopTabs.get(tab.targetId);
        if (!currentTab || currentTab.taskId !== tab.taskId) {
          throw Object.assign(new Error("Requested desktop target disappeared"), { code: "EGO_FRAME_UNAVAILABLE" });
        }
        if (currentTab === tab && currentTab.webContentsId === expectedWebContentsId) {
          currentTab.webContentsId = requiredNumber(resolved.webContentsId, "webContentsId");
        }
        tab = currentTab;
        continue;
      } catch (error) {
        lastError = error;
      }
    }
    await delay(25);
  }
  throw lastError || new Error("Ego desktop has no active webview");
}

async function waitForRegisteredWebview(webContentsId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return webviewContents(webContentsId);
    } catch (error) {
      lastError = error;
      await delay(10);
    }
  }
  throw lastError || new Error(`Desktop webview ${webContentsId} did not register`);
}

async function captureDesktopPageImage(target) {
  const screenshot = await desktopBrowser.screenshot(target);
  const image = nativeImage.createFromBuffer(Buffer.from(screenshot.data, "base64"));
  if (image.isEmpty()) throw new Error("Page screenshot returned an empty image");
  return image;
}

async function captureVisibleDesktopPage(target) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Ego window is unavailable for visible page capture");
  if (target.id !== activeWebviewId) throw new Error("A read-only screenshot cannot activate a background tab");
  const tab = [...desktopTabs.values()].find((candidate) => candidate.webContentsId === target.id);
  if (!tab) throw new Error(`Visible page capture cannot resolve WebContents ${target.id}`);
  const bounds = await hostRequest("tab.visual-bounds", { targetId: tab.targetId }, 2_000);
  const rect = {
    x: Math.max(0, Math.round(Number(bounds.x) || 0)),
    y: Math.max(0, Math.round(Number(bounds.y) || 0)),
    width: Math.max(1, Math.round(Number(bounds.width) || 0)),
    height: Math.max(1, Math.round(Number(bounds.height) || 0)),
  };
  return mainWindow.webContents.capturePage(rect);
}

function publicDesktopTab(tab) {
  return {
    targetId: tab.targetId,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
    pinned: tab.pinned === true,
    muted: tab.muted === true,
    sleeping: tab.sleeping === true,
    autoDiscardable: tab.autoDiscardable !== false,
    groupId: tab.groupId || "",
    groupTitle: tab.groupTitle || "",
    groupColor: tab.groupColor || "",
    ...(tab.lastActiveAt ? { lastActiveAt: tab.lastActiveAt } : {}),
    order: Number(tab.order ?? 0),
    zoomFactor: Number(tab.zoomFactor ?? 1),
  };
}

function publicDesktopRecord(tab) {
  return { ...publicDesktopTab(tab), taskId: tab.taskId };
}

function hostRequest(method, payload, timeoutMs = 15_000) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Ego desktop window is unavailable");
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    hostPending.set(id, { resolve, reject });
    mainWindow.webContents.send("ego:host-request", { id, method, payload });
    setTimeout(() => {
      const pending = hostPending.get(id);
      if (!pending) return;
      hostPending.delete(id);
      pending.reject(new Error(`Desktop host request timed out: ${method}`));
    }, timeoutMs);
  });
}

function scheduleBackendRecovery() {
  if (isQuitting || backendRecoveryTimer) return;
  backendRecoveryTimer = setTimeout(() => {
    backendRecoveryTimer = undefined;
    void initializeBackend();
  }, 2_000);
  backendRecoveryTimer.unref?.();
}

function initializeBackend() {
  if (backendInitialization) return backendInitialization;
  backendInitialization = connectBackend().finally(() => { backendInitialization = undefined; });
  return backendInitialization;
}

async function connectBackend() {
  let connectionRpc;
  let connectionGeneration;
  try {
    if (rpc && !rpc.closed) {
      const status = await rpc.request("backend.status", { clientId });
      backendReady = status.ready === true;
      backendError = backendReady ? "" : status.message || "Browser backend is not ready";
      if (!backendReady) scheduleBackendRecovery();
      return;
    }
    await ensureBroker();
    rpc = await PipeRpcClient.connect(pipeName);
    connectionRpc = rpc;
    connectionGeneration = ++backendConnectionGeneration;
    rpc.onDisconnect((error) => {
      if (rpc !== connectionRpc || backendConnectionGeneration !== connectionGeneration) return;
      backendConnectionGeneration += 1;
      backendReady = false;
      cosMaintenance.disconnected();
      backendError = error.message;
      scheduleBackendRecovery();
    });
    await rpc.request("agent.register", {
      clientId,
      clientKind: "desktop-ui",
      displayName: "EgoLite",
      version: app.getVersion(),
      controlToken: desktopControlToken,
    });
    await rpc.request("control.mode.set", { clientId, mode: controlMode() });
    await rpc.request("control.policy.set", { clientId, policy: controlConsentPolicy() });
    rpc.onEvent((method, params) => {
      if (rpc !== connectionRpc || backendConnectionGeneration !== connectionGeneration) return;
      if (method.startsWith("codex.stream.") && params.clientId === clientId) {
        void cosMaintenance.event(method, params).catch(error => cosMaintenance.save({ phase: "failed", error: error.message }));
      }
      const ownStream = method.startsWith("chat.stream.") && params?.clientId === clientId;
      const operationEvent = method.startsWith("operation.");
      const agentEvent = method === "agent.changed" || method === "agent.disconnected";
      const spaceEvent = method === "space.changed";
      const tabEvent = method === "tab.changed";
      if (method === "space.controlChanged") {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ego:event", method, params);
        return;
      }
      if (agentEvent) {
        brokerAgentStateRevision += 1;
        updateBrokerAgentState(params?.agent);
      }
      if (spaceEvent) {
        updateBrokerSpaceState(params);
      }
      if (!ownStream && !operationEvent && !agentEvent && !spaceEvent && !tabEvent && method !== "collection.changed") return;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ego:event", method, params);
    });
    const spaceRevision = brokerSpaceStateRevision;
    const agentRevision = brokerAgentStateRevision;
    const [spacesSnapshot, agentsSnapshot] = await Promise.all([
      connectionRpc.request("space.list", { clientId }),
      connectionRpc.request("agent.list", { clientId }),
    ]);
    if (rpc !== connectionRpc || backendConnectionGeneration !== connectionGeneration) return;
    if (brokerSpaceStateRevision === spaceRevision) replaceBrokerSpaceStates(spacesSnapshot?.taskSpaces || []);
    if (brokerAgentStateRevision === agentRevision) replaceBrokerAgentStates(agentsSnapshot?.agents || []);
    const status = await connectionRpc.request("backend.status", { clientId });
    if (rpc !== connectionRpc || backendConnectionGeneration !== connectionGeneration) return;
    backendReady = status.ready === true;
    backendError = backendReady ? "" : status.message || "Browser backend is not ready";
    if (backendReady) await cosWorkspace.restore();
    if (!backendReady) scheduleBackendRecovery();
  } catch (error) {
    if (connectionRpc && (rpc !== connectionRpc || backendConnectionGeneration !== connectionGeneration)) return;
    backendReady = false;
    backendError = error.message || String(error);
    await rpc?.close();
    writeDiagnostic("desktop-error.log", error);
    scheduleBackendRecovery();
  } finally {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ego:event", "agent.integrations.changed", agentIntegrationStatus());
  }
}

async function loadState(query = "") {
  const connectionRpc = rpc;
  const connectionGeneration = backendConnectionGeneration;
  const agentRevision = brokerAgentStateRevision;
  const spaceRevision = brokerSpaceStateRevision;
  const [backend, spacesResult, tabs, groups, collections, agentsResult] = await Promise.all([
    connectionRpc.request("backend.status", { clientId }),
    connectionRpc.request("space.list", { clientId }),
    connectionRpc.request("tab.listAll", { clientId }).catch(() => []),
    connectionRpc.request("tab.groupList", { clientId }).catch(() => []),
    connectionRpc.request("collection.list", { clientId, query }).catch(() => []),
    connectionRpc.request("agent.list", { clientId }).catch(() => ({ agents: [] })),
  ]);
  const sameConnection = rpc === connectionRpc && backendConnectionGeneration === connectionGeneration;
  const spaces = sameConnection && brokerSpaceStateRevision === spaceRevision
    ? spacesResult?.taskSpaces || []
    : [...brokerSpaceStates.values()];
  const agents = sameConnection && brokerAgentStateRevision === agentRevision
    ? agentsResult?.agents || []
    : [...brokerAgentStates.values()];
  if (sameConnection && brokerSpaceStateRevision === spaceRevision) replaceBrokerSpaceStates(spaces);
  if (sameConnection && brokerAgentStateRevision === agentRevision) replaceBrokerAgentStates(agents);
  return {
    backend,
    shell: { homeBarShortcut, homeBarShortcutRegistered, trayReady: Boolean(tray) },
    onboarding: {
      completed: process.env.EGO_DESKTOP_ONBOARDING === "0" || desktopPreferences.onboardingCompleted,
    },
    spaces: spaces.filter(space => cosWorkspace.enabled || space.taskId !== cosWorkspace.taskId),
    tabs: tabs.filter(tab => cosWorkspace.enabled || tab.taskId !== cosWorkspace.taskId),
    cos: cosWorkspace.describe(),
    groups,
    collections,
    agents,
    extensions: listBrowserExtensions(),
    profiles: listBrowserProfiles(),
  };
}

function replaceBrokerAgentStates(agents) {
  brokerAgentStates.clear();
  for (const agent of agents) updateBrokerAgentState(agent);
}

function updateBrokerAgentState(agent) {
  if (agent?.clientId) brokerAgentStates.set(agent.clientId, agent);
}

function replaceBrokerSpaceStates(spaces) {
  const previous = new Map(brokerSpaceStates);
  brokerSpaceStates.clear();
  for (const space of spaces) {
    if (!space?.taskId) continue;
    const authority = previous.get(space.taskId);
    brokerSpaceStates.set(space.taskId, authority ? { ...authority, ...space,
      leaseEpoch: authority.leaseEpoch, lifecycle: authority.lifecycle, agentBlocked: space.agentBlocked === true,
    } : space);
  }
}

function updateBrokerSpaceState(payload) {
  const space = payload?.space;
  if (!space?.taskId) return;
  brokerSpaceStateRevision += 1;
  const previous = brokerSpaceStates.get(space.taskId);
  automationDecisions.invalidate(space.taskId, payload.removed || space.ownership !== "agent" || space.agentBlocked ? -1 : space.leaseEpoch);
  for (const job of pageTranslations.jobs.values()) {
    if (job.context.taskId === space.taskId && (payload.removed || job.context.epoch !== space.leaseEpoch)) {
      pageTranslations.cancel(job.id, false, "页面控制权已变化，翻译已暂停");
    }
  }
  if (payload.removed) brokerSpaceStates.delete(space.taskId);
  else brokerSpaceStates.set(space.taskId, space);
  if (desktopScopedAutomation && (payload.removed
    || previous?.leaseEpoch !== space.leaseEpoch
    || previous?.ownership !== space.ownership
    || previous?.lifecycle !== space.lifecycle
    || Boolean(previous?.agentBlocked) !== Boolean(space.agentBlocked))) {
    if (process.env.EGO_SCOPED_DIAGNOSTICS === "1") {
      const fields = ["leaseEpoch", "ownership", "lifecycle", "agentBlocked"];
      console.log("scoped-control", JSON.stringify({ at: Date.now(), removed: payload.removed === true,
        changes: fields.filter((key) => previous?.[key] !== space[key]).map((key) => ({ key, previous: previous?.[key], current: space[key] })) }));
    }
    desktopScopedAutomation.cancelTask(space.taskId, "Task control changed");
  }
  if (payload.removed || space.ownership !== "agent") recentDesktopAgentTasks.delete(space.taskId);
}

async function selectTask(id) {
  const result = await rpc.request("space.select", { clientId, id });
  selectedTask = { id, epoch: result.leaseEpoch };
  return true;
}

async function activateTask(id) {
  try {
    return await selectTask(id);
  } catch (error) {
    if (error?.code === "EGO_TASK_SPACE_INACTIVE") {
      const task = await rpc.request("space.claim", { clientId, id });
      selectedTask = { id, epoch: task.leaseEpoch };
      return true;
    }
    if (error?.code === "EGO_TASK_SPACE_USER_IN_CONTROL") {
      await rpc.request("space.authorizeTakeover", { clientId, id });
      const task = await rpc.request("space.takeover", { clientId, id });
      selectedTask = { id, epoch: task.leaseEpoch };
      return true;
    }
    throw error;
  }
}

function mutation() {
  if (!selectedTask) throw new Error("No task selected");
  return { clientId, taskSpaceId: selectedTask.id, leaseEpoch: selectedTask.epoch };
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is required`);
  return value;
}

function requiredArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} is required`);
  return value;
}

function resolveDesktopWebviewContents(id) {
  const webContentsId = requiredNumber(id, "webContentsId");
  const target = webContents.fromId(webContentsId);
  const hostId = target?.hostWebContents?.id;
  const expectedHostId = mainWindow?.webContents.id;
  if (!target || hostId !== expectedHostId) {
    throw new Error(`Unknown desktop webview: id=${webContentsId}, exists=${Boolean(target)}, host=${hostId ?? "none"}, expected=${expectedHostId ?? "none"}`);
  }
  return target;
}

function scopedNativeWebviewContents(id, expectedScope) {
  const target = resolveDesktopWebviewContents(id);
  const tab = desktopTabs.get(expectedScope.pageId);
  if (expectedScope.runtimeId !== desktopRuntimeId || !tab || tab.taskId !== expectedScope.taskId || tab.webContentsId !== target.id) {
    throw Object.assign(new Error("Scoped native webview ownership changed"), { code: "EGO_ACTION_SCOPE_MISMATCH" });
  }
  // This internal primitive is called after the scoped action's final gate.
  // Keep ownership checks synchronous and do not add another asynchronous gate.
  return target;
}

function webviewContents(id) {
  const target = resolveDesktopWebviewContents(id);
  const taskId = [...desktopTabs.values()].find((tab) => tab.webContentsId === target.id)?.taskId;
  return mutationGate.guardTarget(target, taskId);
}

async function captureTabPreview(targetId) {
  const tab = desktopTabs.get(targetId);
  if (!tab?.webContentsId || tab.sleeping) return { image: "" };
  const target = webviewContents(tab.webContentsId);
  const captured = await captureDesktopPageImage(target);
  if (captured.isEmpty()) return { image: "" };
  const preview = captured.resize({ width: 360, quality: "good" });
  return { image: preview.toDataURL(), width: preview.getSize().width, height: preview.getSize().height };
}

function desktopResourceSnapshot() {
  const metricsByPid = new Map(app.getAppMetrics().map((metric) => [metric.pid, metric]));
  const tabs = [];
  const tabProcessCounts = new Map();
  for (const tab of desktopTabs.values()) {
    if (!tab.webContentsId || tab.sleeping) continue;
    try {
      const target = webviewContents(tab.webContentsId);
      const processId = target.getOSProcessId();
      tabProcessCounts.set(processId, (tabProcessCounts.get(processId) || 0) + 1);
    } catch {}
  }
  const browserProcessIds = new Set();
  for (const tab of desktopTabs.values()) {
    let processId = 0;
    let workingSetBytes = 0;
    let cpuPercent = 0;
    if (tab.webContentsId && !tab.sleeping) {
      try {
        const target = webviewContents(tab.webContentsId);
        processId = target.getOSProcessId();
        const metric = metricsByPid.get(processId);
        workingSetBytes = Math.max(0, Number(metric?.memory?.workingSetSize || 0) * 1024);
        cpuPercent = Math.max(0, Number(metric?.cpu?.percentCPUUsage || 0));
        browserProcessIds.add(processId);
      } catch {}
    }
    const sharedTabCount = Math.max(1, tabProcessCounts.get(processId) || 1);
    tabs.push({
      targetId: tab.targetId,
      taskId: tab.taskId,
      title: tab.title,
      url: tab.url,
      sleeping: tab.sleeping === true,
      processId,
      workingSetBytes,
      estimatedBytes: Math.round(workingSetBytes / sharedTabCount),
      cpuPercent,
      sharedTabCount,
    });
  }
  const totalWorkingSetBytes = [...browserProcessIds].reduce((sum, processId) => {
    return sum + Math.max(0, Number(metricsByPid.get(processId)?.memory?.workingSetSize || 0) * 1024);
  }, 0);
  return {
    capturedAt: new Date().toISOString(),
    totalWorkingSetBytes,
    awakeTabs: tabs.filter((tab) => !tab.sleeping).length,
    sleepingTabs: tabs.filter((tab) => tab.sleeping).length,
    tabs,
  };
}

function normalizedUrl(value) {
  const text = required(value, "url");
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  if (text.includes(".") && !text.includes(" ")) return `https://${text}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

function isPlaceholderTabUrl(value) {
  return !value || value === "about:blank" || value === "ego://start";
}

function normalizedPopupUrl(value) {
  if (typeof value !== "string" || !value.trim() || value === "about:blank#blocked") return "about:blank";
  return normalizedUrl(value);
}

async function ensureBroker() {
  if (await canConnect(pipeName)) return;
  const brokerEntry = app.isPackaged
    ? join(runtimeRoot, "runtime", "broker.mjs")
    : join(developmentRoot, "apps", "broker", "src", "main.ts");
  const brokerExecutable = app.isPackaged ? process.execPath : process.env.EGO_NODE_PATH || "node";
  const broker = spawn(brokerExecutable, [brokerEntry], {
    cwd: app.isPackaged ? join(runtimeRoot, "runtime") : developmentRoot,
    detached: false,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      EGO_COMPAT_PIPE: pipeName,
      EGO_COMPAT_BACKEND: process.env.EGO_DESKTOP_BROKER_BACKEND || configuredBrowserBackend,
      EGO_DESKTOP_AUTOMATION_PIPE: automationPipeName,
      EGO_DESKTOP_CONTROL_TOKEN: desktopControlToken,
      EGO_CONTROL_HANDOFF_ENABLED: controlHandoffEnabled() ? "1" : "0",
      ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  });
  let spawnError;
  broker.once("error", error => { spawnError = error; });
  spawnedBrokerProcess = broker;
  broker.once("exit", () => {
    if (spawnedBrokerProcess === broker) {
      spawnedBrokerProcess = undefined;
      backendReady = false;
      scheduleBackendRecovery();
    }
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (broker.exitCode !== null) throw new Error(`Broker exited with code ${broker.exitCode}`);
    if (await canConnect(pipeName)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stopSpawnedBroker();
  throw new Error("Ego desktop Broker did not start");
}

async function stopSpawnedBroker() {
  const broker = spawnedBrokerProcess;
  spawnedBrokerProcess = undefined;
  if (!broker || broker.exitCode !== null || broker.killed) return;
  const exited = new Promise((resolve) => broker.once("exit", resolve));
  broker.kill();
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

function syncAgentIntegrations() {
  const options = { enabledSkills: enabledAgentSkillNames() };
  try {
    agentIntegrationState = agentIntegrations.sync(options);
  } catch (error) {
    agentIntegrationState = {
      ...agentIntegrations.status(options),
      error: error?.message || String(error),
    };
    writeDiagnostic("agent-integration-error.log", error);
  }
  const status = agentIntegrationStatus();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ego:event", "agent.integrations.changed", status);
  return status;
}

function userCommandDirectory() {
  const pathEntries = new Set(String(process.env.PATH || "").split(";").filter(Boolean).map((value) => resolve(value).toLocaleLowerCase()));
  const candidates = [
    process.env.APPDATA ? join(process.env.APPDATA, "npm") : "",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps") : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate) && pathEntries.has(resolve(candidate).toLocaleLowerCase())) || "";
}

function agentIntegrationStatus() {
  const status = agentIntegrationState || agentIntegrations.status({ enabledSkills: enabledAgentSkillNames() });
  return {
    ...status,
    browserReady: backendReady && Boolean(rpc && !rpc.closed),
    error: status.error || status.integrations?.find(item => item.error)?.error || backendError,
    localOnly: true,
  };
}

function companionStatus() {
  const paths = companionPaths();
  const extensionSource = join(paths.extensionDirectory, "manifest.json");
  const nativeDirectory = paths.nativeDirectory;
  const nativeManifest = join(nativeDirectory, "com.egocompat.bridge.json");
  const nativeExecutable = join(nativeDirectory, "ego-native-host.exe");
  const config = join(process.env.LOCALAPPDATA || dataRoot, "EgoCompat", "companion.json");
  return {
    installSupported: existsSync(paths.nativeInstaller),
    extensionSource: existsSync(extensionSource),
    nativeHost: existsSync(nativeExecutable) && existsSync(nativeManifest),
    configured: existsSync(config),
    edgeRegistered: registryKeyExists("HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.egocompat.bridge"),
    chromeRegistered: registryKeyExists("HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.egocompat.bridge"),
  };
}

function companionPaths() {
  if (app.isPackaged) {
    const root = join(dataRoot, "companion");
    const versionFile = join(root, "bundle-version.txt");
    if (!existsSync(versionFile) || readFileSync(versionFile, "utf8") !== app.getVersion()) {
      cpSync(join(agentRuntimeDirectory, "companion"), root, { recursive: true });
      writeFileSync(versionFile, app.getVersion(), "utf8");
    }
    return {
      extensionDirectory: join(root, "extension"),
      nativeDirectory: join(root, "native", "publish"),
      nativeInstaller: join(root, "native", "install.ps1"),
    };
  }
  return {
    extensionDirectory: join(developmentRoot, "apps", "companion-extension"),
    nativeDirectory: join(developmentRoot, "apps", "native-host", "publish"),
    nativeInstaller: join(developmentRoot, "apps", "native-host", "install.ps1"),
  };
}

function registryKeyExists(key) {
  try {
    return spawnSync("reg.exe", ["query", key, "/ve"], { windowsHide: true, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

async function startCompanionInstaller(showSetup = true) {
  const paths = companionPaths();
  if (!existsSync(paths.nativeInstaller) || !existsSync(join(paths.extensionDirectory, "manifest.json"))) {
    throw new Error("未找到 Companion 安装组件");
  }
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", paths.nativeInstaller, "-Browser", "Both"], {
    cwd: dirname(paths.nativeInstaller),
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Companion 安装失败 (${code})`)));
  });
  if (showSetup) {
    clipboard.writeText(paths.extensionDirectory);
    void shell.openPath(paths.extensionDirectory);
    void shell.openExternal("edge://extensions/").catch(() => {});
  }
  return { started: true };
}

function scanSciSmokeResponse(method) {
  const status = {
    configured: true,
    online: method !== "scansci.stop",
    managed: method !== "scansci.stop",
    state: method === "scansci.stop" ? "stopped" : "running",
    pid: method === "scansci.stop" ? null : 8765,
    baseUrl: "http://127.0.0.1:8765",
    settingsUrl: "data:text/html,<title>ScanSci PDF</title><main><h1>ScanSci PDF</h1><p>8 个下载通道已检查</p></main>",
    projectDirectory: "A:\\Project\\ScanSci PDF",
    startedAt: "2026-09-01T00:00:00.000Z",
    checkedAt: "2026-09-01T00:00:00.000Z",
    error: "",
    recentLogs: [],
  };
  if (method !== "scansci.checkAll") return status;
  return {
    service: status,
    startedAt: status.startedAt,
    finishedAt: status.checkedAt,
    checked: 8,
    passed: 8,
    failed: [],
    channels: Object.fromEntries(["egolite", "webvpn", "carsi", "ezproxy", "elsevier", "oa", "tor", "grey"].map((channel) => [channel, { ok: true, result: {} }])),
    dashboard: { status: "ok" },
  };
}

function writeDiagnostic(name, error) {
  try {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(join(dataRoot, name), error?.stack || String(error), "utf8");
  } catch {
    // Diagnostics must not prevent the desktop app from shutting down.
  }
}

function canConnect(pipe) {
  return new Promise((resolve) => {
    const socket = connect(pipe);
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(400, () => done(false));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
