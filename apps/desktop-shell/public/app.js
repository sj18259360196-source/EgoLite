import { browserCommandForInput } from "./browser-shortcuts.js";
import { bindDeveloperTools } from "./developer-tools.js";
import { createBookmarkLibrary } from "./bookmark-library.js";
import { bindTranslation } from "./translation.js";
import { bindAutomationSettings } from "./automation-settings.js";
import { bindWorkspacePacks } from "./workspace-packs.js";

const $ = (selector) => document.querySelector(selector);
const invoke = (method, payload) => window.egoDesktop.invoke(method, payload);
const bookmarkLibrary = createBookmarkLibrary({
  invoke, refresh, open: openCollectionSource, editExcerpt: openCollectionEditDialog,
  confirm: confirmAction, toast: showToast,
  manage: () => switchView("library"), browse: () => switchView("start"),
  currentPage: () => currentTab,
});
const pendingTabPreferences = new Map();
const queueTabPreferences = async (targetId, changes = {}) => {
  const previous = pendingTabPreferences.get(targetId) || {};
  const token = {};
  const pending = { ...previous, ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, { value, token }])) };
  pendingTabPreferences.set(targetId, pending);
  refreshRevision += 1;
  try { return await invoke("tab.preferences", { targetId, ...changes }); }
  finally {
    refreshRevision += 1;
    const latest = pendingTabPreferences.get(targetId) || {};
    for (const [key, item] of Object.entries(latest)) if (item.token === token) delete latest[key];
    if (!Object.keys(latest).length) pendingTabPreferences.delete(targetId);
  }
};
function retainPendingTabPreferences(tab) {
  for (const [key, item] of Object.entries(pendingTabPreferences.get(tab.targetId) || {})) tab[key] = item.value;
  return tab;
}
const WEBVIEW_PRELOAD_URL = new URL("../webview-preload.cjs", import.meta.url).href;

let state = { backend: {}, shell: {}, onboarding: { completed: true }, spaces: [], tabs: [], groups: [], collections: [], profiles: [], agents: [] };
let activeTaskId = "";
let controlPanelId = null;
let controlPanelRevision = -1;
const interactionPrompts = new Set();
let currentTab = null;
let chatMode = "operations";
let contextSource = "tabs";
const attachments = new Map();
const attachmentRequests = new Map();
const fileAttachments = new Map();
const conversations = new Map();
const operationRecords = new Map();
const operationStateRevisions = new Map();
const operationClearRevisions = new Map();
const operationRefreshes = new Map();
const webviews = new Map();
const cosWorkspace = bindWorkspacePacks({
  invoke, getState: () => state, activeTask: () => activeTaskId,
  openHome: showCosHome, refresh, toast: showToast,
});
let visualTabActivationTail = Promise.resolve();
let visualTaskMutationTail = Promise.resolve();
let agentUiRenderTimer = 0;
let operationUiRenderTimer = 0;
const pendingOperationUiTaskIds = new Set();
let activeGeneration = null;
let scanSciLoadPromise = null;
let scanSciSettingsUrl = "";
let onboardingShown = false;
let importDialogIsOnboarding = false;
let tabMenuTarget = null;
let tabMenuGroupId = "";
let tabGroupTarget = null;
let selectedTabGroupColor = "#5b7c86";
let collectionGroupTarget = null;
let collectionEditTarget = null;
let duplicateCollectionGroups = [];
let librarySort = localStorage.getItem("ego-desktop-library-sort") || "newest";
const selectedCollectionIds = new Set();
let visibleCollectionIds = [];
const selectedTaskIds = new Set();
let visibleTaskIds = [];
const selectedTabIds = new Set();
let tabManagementMode = false;
let tabOverviewMode = "all";
let recentTabIds = loadRecentTabIds();
let recentSwitcherTimer = null;
const closedTabs = loadClosedTabs();
const websiteHistory = loadWebsiteHistory();
let historyMode = "visits";
let generationTimer = null;
const downloads = new Map();
const crashedTargets = new Map();
const browserPromptQueue = [];
let activeBrowserPrompt = null;
const credentialStates = new Map();
let savedCredentials = [];
let pendingCredentialSave = null;
let credentialSettingsProfileId = "default";
let confirmResolver = null;
let taskRenameTarget = null;
let browserProfileEditTarget = null;
let selectedBrowserProfileColor = "#5b7c86";
let sidebarCollapsed = true;
let workspaceSidebarQuickMode = false;
let legacyHistoryMigrationRunning = false;
let assistantCollapsed = localStorage.getItem("ego-desktop-assistant-collapsed") === "1";
let assistantWidth = Math.max(340, Math.min(560, Number(localStorage.getItem("ego-desktop-assistant-width")) || 410));
let browserLoading = false;
let zoomWheelRemainder = 0;
let zoomWheelResetTimer = null;
let promptDraftTaskId = "";
let promptDraftSaveTimer = null;
let browserSettings = { browserBackend: "desktop", passwordAutofillEnabled: true, controlMode: "agent", controlHandoffEnabled: false, controlConsentEnabled: false, controlConsentLevel: "balanced", companion: {} };
let appliedNativeTheme = "";
let taskObservationRevision = 0;
let refreshRevision = 0;
let tabSelectionRevision = 0;
const DEFAULT_BACKGROUND = 'url("./assets/travel-workbench-bg.png")';
const DEFAULT_WELCOME_BACKGROUND = DEFAULT_BACKGROUND;
const THEME_BACKGROUNDS = {
  night: DEFAULT_BACKGROUND,
  slate: 'url("./assets/theme-coast-light.png")',
  ember: 'url("./assets/theme-ember-valley.png")',
  light: 'url("./assets/theme-coast-light.png")',
  paper: 'url("./assets/theme-paper-mist.png")',
};
const TAB_GROUP_COLORS = ["#5b7c86", "#668b72", "#a07856", "#8a6f91", "#b06d6d", "#777f8c"];
const BROWSER_PROFILE_COLORS = [...TAB_GROUP_COLORS];
const collapsedTabGroups = loadCollapsedTabGroups();
const mediaPlayingTargets = new Set();
const tabActivityTimes = new Map();
const tabPreviewCache = new Map();
let tabPreviewShowTimer = null;
let tabPreviewHideTimer = null;
let tabPreviewTargetId = "";
let autoSleepRunning = false;
let resourceManagementRunning = false;
let resourceSnapshot = null;
const workspaceSnapshots = loadWorkspaceSnapshots();
const tabBehaviorPreferences = {
  autoSleepMinutes: normalizeAutoSleepMinutes(localStorage.getItem("ego-desktop-auto-sleep-minutes") ?? "30"),
  duplicateOpenBehavior: localStorage.getItem("ego-desktop-duplicate-open-behavior") === "allow" ? "allow" : "reuse",
  neverSleepSites: loadNeverSleepSites(),
  resourcePolicy: normalizeResourcePolicy(localStorage.getItem("ego-desktop-resource-policy") || "balanced"),
};
const visualPreferences = {
  theme: localStorage.getItem("ego-desktop-theme") || "paper",
  background: localStorage.getItem("ego-desktop-background") || "",
  glassOpacity: Number(localStorage.getItem("ego-desktop-glass-opacity")) || 100,
  glassBlur: Number(localStorage.getItem("ego-desktop-glass-blur")) || 24,
  backgroundDim: Number(localStorage.getItem("ego-desktop-background-dim")) || 66,
};

window.lucide.createIcons();
applyVisualPreferences();
applySidebarState();
applyAssistantState();
syncTabBehaviorControls();
window.egoDesktop.onHostRequest(handleHostRequest);
window.egoDesktop.onEvent(handleRuntimeEvent);
window.egoDesktop.onHomeBarCompose(handleHomeBarCompose);
window.egoDesktop.onBrowserOpenError(({ message }) => showToast(message || "页面打开失败，请重试"));
window.egoDesktop.onBrowserFindResult(({ targetId, result }) => {
  if (currentTab?.targetId !== targetId) return;
  $("#find-result").textContent = result?.matches ? `${result.activeMatchOrdinal}/${result.matches}` : "0/0";
});
window.egoDesktop.onBrowserCommand(({ command, targetId }) => {
  if (targetId && currentTab?.targetId !== targetId) return;
  if (command === "translate-page") { void translation.open(); return; }
  void runBrowserCommand(command);
});
window.egoDesktop.onDownload((download) => {
  if (!download?.id) return;
  downloads.set(download.id, download);
  renderDownloads();
});
window.egoDesktop.onBrowserPrompt((prompt) => {
  browserPromptQueue.push(prompt);
  showNextBrowserPrompt();
});
window.egoDesktop.onBrowserPromptExpired(({ id }) => expireBrowserPrompt(id));
window.egoDesktop.onBrowserTabCrashed((detail) => markTabCrashed(detail));
window.egoDesktop.onBrowserTabResponsive(({ targetId }) => clearTabCrash(targetId));
bindEvents();
const translation = bindTranslation({ invoke, currentTab: () => currentTab, onError: error => showToast(error.message, true) });
const automationSettingsPanel = bindAutomationSettings({
  invoke,
  currentProfile: () => state.spaces.find(space => space.taskId === activeTaskId)?.profileId || "default",
  onError: error => showToast(error.message, true),
});
bindDeveloperTools({ invoke, currentWebview: activeWebview, onError: error => showToast(localizedError(error), true) });
await loadBrowserSettings();
await refresh();
await loadCredentials();
restoreInitialBrowserTab();
await migrateLegacyImportedHistory();
await loadDownloads();
await refreshResourceSnapshot();
setMode("operations");
setInterval(() => { if (!state.backend?.ready) void refresh(); }, 1500);
setInterval(() => { if (chatMode === "operations" && activeTaskId) void refreshOperations(activeTaskId); }, 1000);
setInterval(() => updateAgentHud(), 1000);
setInterval(() => void runAutoSleep(), 30_000);
setInterval(() => void runAdaptiveResourceManagement(), 60_000);

function bindEvents() {
  $("#browser-devtools").addEventListener("click", () => void runBrowserCommand("toggle-devtools"));
  $("#browser-inspect").addEventListener("click", () => void runBrowserCommand("inspect-element"));
  $("#browser-copy-element").addEventListener("click", () => void runBrowserCommand("copy-element-context"));
  $("#control-panel-open").addEventListener("click", () => {
    const task = state.spaces.find((space) => space.taskId === activeTaskId);
    if (!task) return showToast("请先选择工作区");
    controlPanelId = task.id;
    controlPanelRevision = -1;
    $("#control-panel-title").textContent = `${task.name} · 工作区控制权`;
    $("#control-panel-mode").textContent = `全局模式 · ${controlModeLabel(browserSettings.controlMode)}`;
    $("#control-panel-reason").textContent = "";
    $("#control-panel-status").textContent = "正在读取控制状态";
    $("#control-panel-agents").replaceChildren();
    $("#control-panel-target").replaceChildren();
    $("#control-panel-requests").replaceChildren();
    $("#control-panel-assign").disabled = true;
    $("#control-auto-collaboration").checked = browserSettings.autoCollaboration === true;
    $("#control-auto-collaboration").disabled = browserSettings.controlMode !== "collaborative";
    $("#control-panel").showModal();
    void refreshControlPanel();
  });
  $("#control-panel-close").addEventListener("click", () => $("#control-panel").close());
  $("#control-panel-assign").addEventListener("click", async () => {
    const id = controlPanelId;
    const targetClientId = $("#control-panel-target").value;
    if (!targetClientId) return;
    try {
      await invoke("control.assign", { id, targetClientId });
      await refreshControlPanel();
    } catch (error) { showToast(error.message, true); }
  });
  $("#control-auto-collaboration").addEventListener("change", async (event) => {
    const enabled = event.target.checked;
    try {
      await invoke("settings.setAutoCollaboration", { enabled });
      browserSettings.autoCollaboration = enabled;
    } catch (error) {
      event.target.checked = !enabled;
      showToast(error.message, true);
    }
  });
  for (const button of document.querySelectorAll(".rail-button")) button.addEventListener("click", () => switchView(button.dataset.view));
  for (const button of document.querySelectorAll(".assistant-head .mode")) button.addEventListener("click", () => setMode(button.dataset.mode));
  $("#refresh")?.addEventListener("click", refresh);
  $("#new-task").addEventListener("click", openTaskDialog);
  $("#workspace-quick-switch").addEventListener("click", toggleWorkspaceSidebar);
  $("#titlebar-new-task")?.addEventListener("click", openTaskDialog);
  $("#titlebar-toggle-sidebar")?.addEventListener("click", toggleWorkspaceSidebar);
  $("#titlebar-toggle-assistant").addEventListener("click", toggleAssistantPanel);
  $("#assistant-collapse").addEventListener("click", toggleAssistantPanel);
  $("#agent-hud-takeover").addEventListener("click", () => void takeOverCurrentTask());
  $("#agent-hud-stop").addEventListener("click", () => void stopCurrentTask());
  $("#agent-hud-return").addEventListener("click", () => void returnCurrentTaskToAgent());
  for (const button of document.querySelectorAll("[data-control-mode]")) {
    button.addEventListener("click", () => void saveControlMode(button.dataset.controlMode));
  }
  $("#workspace-sidebar-backdrop")?.addEventListener("click", closeWorkspaceSidebar);
  bindAssistantResizer();
  $("#sidebar-collapse")?.addEventListener("click", toggleWorkspaceSidebar);
  $("#active-task-select").addEventListener("change", () => void activateTaskById(Number($("#active-task-select").value)));
  $("#task-form").addEventListener("submit", createTask);
  $("#task-dialog-close").addEventListener("click", closeTaskDialog);
  $("#task-dialog-cancel").addEventListener("click", closeTaskDialog);
  $("#task-rename-form").addEventListener("submit", saveTaskRename);
  $("#task-rename-close").addEventListener("click", closeTaskRenameDialog);
  $("#task-rename-cancel").addEventListener("click", closeTaskRenameDialog);
  $("#create-browser-profile").addEventListener("click", () => openBrowserProfileDialog());
  $("#browser-profile-form").addEventListener("submit", saveBrowserProfile);
  $("#browser-profile-close").addEventListener("click", closeBrowserProfileDialog);
  $("#browser-profile-cancel").addEventListener("click", closeBrowserProfileDialog);
  $("#browser-profile-colors").addEventListener("click", selectBrowserProfileColor);
  $("#browser-profile-list").addEventListener("click", (event) => void runBrowserProfileAction(event));
  $("#task-search").addEventListener("input", debounce(renderTaskBoard, 100));
  $("#task-select-all").addEventListener("change", toggleAllTasks);
  $("#task-batch-close").addEventListener("click", () => void closeSelectedTasks());
  $("#save-workspace-snapshot").addEventListener("click", openWorkspaceSnapshotDialog);
  $("#workspace-snapshot-form").addEventListener("submit", saveWorkspaceSnapshot);
  $("#workspace-snapshot-close").addEventListener("click", closeWorkspaceSnapshotDialog);
  $("#workspace-snapshot-cancel").addEventListener("click", closeWorkspaceSnapshotDialog);
  $("#workspace-snapshot-list").addEventListener("click", (event) => void runWorkspaceSnapshotAction(event));
  $("#omnibox-form").addEventListener("submit", openAddress);
  $("#browser-address-form").addEventListener("submit", navigateCurrentTab);
  $("#titlebar-new-tab").addEventListener("click", () => void openBlankTab());
  $("#manage-browser-tabs").addEventListener("click", toggleTabOverview);
  $("#tab-overview-close").addEventListener("click", closeTabOverview);
  $("#tab-overview-query").addEventListener("input", renderTabOverview);
  $("#tab-overview-query").addEventListener("keydown", handleTabOverviewSearchKeydown);
  $("#tab-overview-query-clear").addEventListener("click", clearTabOverviewQuery);
  for (const button of document.querySelectorAll("[data-tab-overview-mode]")) button.addEventListener("click", () => {
    tabOverviewMode = button.dataset.tabOverviewMode;
    renderTabOverview();
  });
  $("#tab-overview-list").addEventListener("click", handleTabOverviewClick);
  $("#tab-overview-list").addEventListener("auxclick", handleTabOverviewAuxClick);
  $("#tab-overview-list").addEventListener("keydown", handleTabOverviewKeydown);
  $("#tab-overview-close-duplicates").addEventListener("click", () => void closeDuplicateTabs());
  $("#tab-overview-batch").addEventListener("click", () => {
    closeTabOverview();
    if (!tabManagementMode) toggleTabManagement();
  });
  $("#tab-select-all").addEventListener("change", toggleAllBrowserTabs);
  $("#tab-batch-pin").addEventListener("click", () => void batchUpdateTabs("pinned"));
  $("#tab-batch-mute").addEventListener("click", () => void batchUpdateTabs("muted"));
  $("#tab-batch-close").addEventListener("click", () => void batchCloseTabs());
  $("#tab-group-form").addEventListener("submit", saveTabGroup);
  $("#tab-group-close").addEventListener("click", closeTabGroupDialog);
  $("#tab-group-cancel").addEventListener("click", closeTabGroupDialog);
  $("#tab-group-existing").addEventListener("change", selectExistingTabGroup);
  $("#tab-group-color-options").addEventListener("click", selectTabGroupColor);
  $("#browser-back").addEventListener("click", () => activeWebview()?.canGoBack() && activeWebview().goBack());
  $("#browser-forward").addEventListener("click", () => activeWebview()?.canGoForward() && activeWebview().goForward());
  $("#browser-reload").addEventListener("click", () => {
    if (browserLoading) activeWebview()?.stop();
    else reloadCurrentPage();
  });
  $("#browser-more").addEventListener("click", toggleBrowserMoreMenu);
  $("#browser-find").addEventListener("click", () => { closeBrowserMoreMenu(); openFindBar(); });
  $("#browser-zoom-out").addEventListener("click", () => void changeZoom(-0.1));
  $("#browser-zoom-reset").addEventListener("click", () => void changeZoom(0, true));
  $("#browser-zoom-in").addEventListener("click", () => void changeZoom(0.1));
  $("#browser-print").addEventListener("click", () => { closeBrowserMoreMenu(); printCurrentPage(); });
  $("#browser-passwords").addEventListener("click", () => void toggleCredentialPanel());
  $("#browser-history").addEventListener("click", toggleHistoryPanel);
  $("#browser-extensions").addEventListener("click", toggleExtensionsPanel);
  $("#extensions-panel-close").addEventListener("click", () => { $("#extensions-panel").hidden = true; });
  $("#extensions-panel-list").addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-extension-quick-toggle]");
    if (toggle) void setBrowserExtensionEnabled(toggle.dataset.extensionQuickToggle, toggle.checked);
  });
  $("#extensions-panel-list").addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-extension-quick-action]");
    if (actionButton) void openBrowserExtensionAction(actionButton.dataset.extensionQuickAction, actionButton);
    const pinButton = event.target.closest("[data-extension-quick-pin]");
    if (pinButton) void setBrowserExtensionPinned(pinButton.dataset.extensionQuickPin, pinButton.dataset.pinned !== "true");
  });
  $("#browser-extension-actions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-pinned-extension]");
    if (button) void openBrowserExtensionAction(button.dataset.pinnedExtension, button);
  });
  $("#manage-extensions").addEventListener("click", () => { $("#extensions-panel").hidden = true; switchView("extensions"); });
  $("#credentials-panel-close").addEventListener("click", closeCredentialPanel);
  $("#credentials-panel-list").addEventListener("click", (event) => void runCredentialPanelAction(event));
  $("#save-current-credential").addEventListener("click", () => void saveCurrentPageCredential());
  $("#manage-credentials").addEventListener("click", openCredentialSettings);
  $("#browser-codex").addEventListener("click", () => void openCodexForCurrentPage());
  $("#theme-select").addEventListener("change", (event) => {
    visualPreferences.theme = event.currentTarget.value;
    localStorage.setItem("ego-desktop-theme", visualPreferences.theme);
    applyVisualPreferences();
    $("#appearance-status").textContent = "主题已切换";
  });
  $("#glass-opacity").addEventListener("input", (event) => updateVisualNumber("glassOpacity", event.currentTarget.value));
  $("#glass-blur").addEventListener("input", (event) => updateVisualNumber("glassBlur", event.currentTarget.value));
  $("#background-dim").addEventListener("input", (event) => updateVisualNumber("backgroundDim", event.currentTarget.value));
  $("#background-url").addEventListener("change", (event) => setCustomBackground(event.currentTarget.value.trim()));
  $("#background-url").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); setCustomBackground(event.currentTarget.value.trim()); }
  });
  $("#choose-background").addEventListener("click", () => $("#background-file").click());
  $("#background-file").addEventListener("change", (event) => void readBackgroundFile(event.currentTarget.files?.[0]));
  $("#reset-background").addEventListener("click", resetCustomBackground);
  $("#auto-sleep-minutes").addEventListener("change", (event) => {
    tabBehaviorPreferences.autoSleepMinutes = normalizeAutoSleepMinutes(event.currentTarget.value);
    localStorage.setItem("ego-desktop-auto-sleep-minutes", String(tabBehaviorPreferences.autoSleepMinutes));
    updateTabBehaviorStatus();
    void runAutoSleep({ report: true });
  });
  $("#duplicate-open-behavior").addEventListener("change", (event) => {
    tabBehaviorPreferences.duplicateOpenBehavior = event.currentTarget.value === "allow" ? "allow" : "reuse";
    localStorage.setItem("ego-desktop-duplicate-open-behavior", tabBehaviorPreferences.duplicateOpenBehavior);
    updateTabBehaviorStatus("重复页面打开方式已保存");
  });
  $("#never-sleep-sites").addEventListener("change", (event) => {
    tabBehaviorPreferences.neverSleepSites = parseNeverSleepSites(event.currentTarget.value);
    localStorage.setItem("ego-desktop-never-sleep-sites", JSON.stringify(tabBehaviorPreferences.neverSleepSites));
    event.currentTarget.value = tabBehaviorPreferences.neverSleepSites.join(", ");
    updateTabBehaviorStatus("保持唤醒网站已保存");
  });
  $("#resource-policy").addEventListener("change", (event) => {
    tabBehaviorPreferences.resourcePolicy = normalizeResourcePolicy(event.currentTarget.value);
    localStorage.setItem("ego-desktop-resource-policy", tabBehaviorPreferences.resourcePolicy);
    renderResourceSnapshot();
    void runAdaptiveResourceManagement({ report: true });
  });
  $("#release-idle-memory").addEventListener("click", () => void runAdaptiveResourceManagement({ force: true, report: true }));
  $("#tab-hover-preview").addEventListener("pointerenter", cancelTabPreviewHide);
  $("#tab-hover-preview").addEventListener("pointerleave", scheduleTabPreviewHide);
  $("#new-tab-codex").addEventListener("click", openCodexComposer);
  $("#new-tab-import").addEventListener("click", () => void openBrowserImport(false));
  $("#new-tab-extensions").addEventListener("click", () => switchView("extensions"));
  $("#assistant-attach-page").addEventListener("click", () => void openCodexForCurrentPage());
  $("#favorites-workspaces").addEventListener("click", toggleWorkspaceSidebar);
  $("#favorites-all").addEventListener("click", () => bookmarkLibrary.openOtherFavorites());
  $("#browser-favorites").addEventListener("click", () => bookmarkLibrary.togglePanel());
  $("#browser-tab-list").addEventListener("dblclick", (event) => {
    if (event.target.closest(".browser-tab")) return;
    void openBlankTab();
  });
  $(".titlebar-tabs").addEventListener("dblclick", (event) => {
    if (event.target.closest(".browser-tab, button")) return;
    void openBlankTab();
  });
  $("#browser-tab-list").addEventListener("wheel", (event) => {
    if (event.ctrlKey) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (event.cancelable) event.preventDefault();
    event.currentTarget.scrollLeft += event.deltaY;
  }, { passive: false });
  document.addEventListener("wheel", (event) => {
    if (!event.ctrlKey || event.altKey || !currentTab) return;
    if (!event.target.closest("#start-view, .titlebar-tabs")) return;
    event.preventDefault();
    handleZoomWheel({ deltaY: event.deltaY, deltaMode: event.deltaMode });
  }, { capture: true, passive: false });
  for (const button of document.querySelectorAll("[data-open-view]")) button.addEventListener("click", () => { closeBrowserMoreMenu(); switchView(button.dataset.openView); });
  $("#scansci-refresh").addEventListener("click", () => void openScanSciSettings({ forceCheck: true }));
  $("#scansci-restart").addEventListener("click", () => void openScanSciSettings({ restart: true, forceCheck: true }));
  $("#scansci-stop").addEventListener("click", () => void stopScanSciService());
  $("#scansci-settings-webview").addEventListener("dom-ready", () => {
    $("#scansci-loading").hidden = true;
    $("#scansci-settings-webview").hidden = false;
  });
  $("#scansci-settings-webview").addEventListener("did-fail-load", (event) => {
    if (event.errorCode === -3) return;
    showScanSciError(`ScanSci 设置页加载失败 ${event.errorDescription || event.errorCode}`);
  });
  $("#browser-downloads").addEventListener("click", toggleDownloadsPanel);
  $("#downloads-close").addEventListener("click", () => { $("#downloads-panel").hidden = true; });
  $("#history-close").addEventListener("click", () => { $("#history-panel").hidden = true; });
  $("#history-clear").addEventListener("click", () => void clearClosedTabs());
  $("#history-search").addEventListener("input", debounce(renderHistory, 100));
  for (const button of document.querySelectorAll("[data-history-mode]")) button.addEventListener("click", () => setHistoryMode(button.dataset.historyMode));
  $("#history-list").addEventListener("click", (event) => void runHistoryAction(event));
  $("#downloads-clear").addEventListener("click", clearFinishedDownloads);
  $("#downloads-search").addEventListener("input", renderDownloads);
  $("#downloads-filter").addEventListener("change", renderDownloads);
  $("#downloads-list").addEventListener("click", runDownloadAction);
  $("#find-input").addEventListener("input", () => findInPage(true, false));
  $("#find-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    findInPage(!event.shiftKey, true);
  });
  $("#find-previous").addEventListener("click", () => findInPage(false, true));
  $("#find-next").addEventListener("click", () => findInPage(true, true));
  $("#find-close").addEventListener("click", closeFindBar);
  $("#attach-tab").addEventListener("click", toggleContextPicker);
  $("#add-attachment").addEventListener("click", toggleAttachmentMenu);
  for (const button of document.querySelectorAll("[data-attachment-action]")) button.addEventListener("click", () => void addExternalAttachment(button.dataset.attachmentAction));
  $("#attach-current-tab").addEventListener("click", attachCurrentTab);
  for (const button of document.querySelectorAll(".context-source-tab")) button.addEventListener("click", () => setContextSource(button.dataset.source));
  $("#context-search").addEventListener("input", renderContextSources);
  $("#send-message").addEventListener("click", sendMessage);
  $("#prompt").addEventListener("keydown", (event) => {
    if (event.key === "@" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const prompt = event.currentTarget;
      const before = prompt.value.slice(0, prompt.selectionStart);
      if (!before || /\s$/.test(before)) {
        event.preventDefault();
        openContextPicker();
      }
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void sendMessage();
  });
  $("#prompt").addEventListener("input", savePromptDraftSoon);
  $("#current-address").addEventListener("focus", (event) => event.currentTarget.select());
  document.addEventListener("keydown", (event) => {
    if (document.querySelector("dialog[open]") && event.key !== "Escape") return;
    const command = browserCommandForInput(event);
    if (command) {
      event.preventDefault();
      if (event.repeat && ["toggle-devtools", "inspect-element"].includes(command)) return;
      void runBrowserCommand(command);
      return;
    }
    if (event.key !== "Escape") return;
    if (!$("#find-bar").hidden) closeFindBar();
    hideTabContextMenu();
    closeContextPicker();
    closeAttachmentMenu();
    $("#downloads-panel").hidden = true;
    $("#history-panel").hidden = true;
    $("#extensions-panel").hidden = true;
    closeBrowserMoreMenu();
    closeTabOverview();
    $("#recent-tab-switcher").hidden = true;
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#tab-context-menu")) hideTabContextMenu();
    if (!$("#downloads-panel").hidden && !event.target.closest("#downloads-panel") && !event.target.closest("#browser-downloads")) $("#downloads-panel").hidden = true;
    if (!$("#history-panel").hidden && !event.target.closest("#history-panel") && !event.target.closest("#browser-history")) $("#history-panel").hidden = true;
    if (!$("#extensions-panel").hidden && !event.target.closest("#extensions-panel") && !event.target.closest("#browser-extensions")) $("#extensions-panel").hidden = true;
    if (!$("#browser-more-menu").hidden && !event.target.closest("#browser-more-menu") && !event.target.closest("#browser-more")) closeBrowserMoreMenu();
    if (!$("#tab-overview").hidden && !event.target.closest("#tab-overview") && !event.target.closest("#manage-browser-tabs")) closeTabOverview();
    if ($("#context-picker").hidden || event.target.closest(".composer-wrap")) return;
    closeContextPicker();
  });
  window.addEventListener("resize", () => {
    if (innerWidth <= 820 && !sidebarCollapsed) closeWorkspaceSidebar();
    if (!$("#tab-overview").hidden) positionTabOverview();
  });
  for (const button of document.querySelectorAll("[data-tab-action]")) {
    button.addEventListener("click", () => void runTabAction(button.dataset.tabAction));
  }
  $("#clear-chat").addEventListener("click", clearConversation);
  $("#operation-search").addEventListener("input", debounce(renderConversation, 100));
  $("#operation-status-filter").addEventListener("change", renderConversation);
  $("#library-search").addEventListener("input", debounce(renderCollections, 120));
  $("#collection-group-filter").addEventListener("change", renderCollections);
  $("#collection-tag-filter").addEventListener("change", renderCollections);
  $("#collection-sort").addEventListener("change", () => {
    librarySort = $("#collection-sort").value;
    localStorage.setItem("ego-desktop-library-sort", librarySort);
    renderCollections();
  });
  $("#collection-select-all").addEventListener("change", toggleAllCollections);
  $("#collection-batch-move").addEventListener("click", openBatchCollectionGroupDialog);
  $("#collection-batch-delete").addEventListener("click", () => void deleteSelectedCollections());
  $("#export-collections").addEventListener("click", exportCollections);
  $("#import-collections").addEventListener("click", () => void importCollectionsFile());
  $("#find-collection-duplicates").addEventListener("click", openCollectionDuplicates);
  $("#collection-duplicates-form").addEventListener("submit", mergeSelectedDuplicates);
  $("#collection-duplicates-close").addEventListener("click", () => $("#collection-duplicates-dialog").close());
  $("#collection-duplicates-cancel").addEventListener("click", () => $("#collection-duplicates-dialog").close());
  $("#collection-group-form").addEventListener("submit", saveCollectionGroup);
  $("#collection-group-close").addEventListener("click", () => $("#collection-group-dialog").close());
  $("#collection-group-clear").addEventListener("click", () => { $("#collection-group-name").value = ""; $("#collection-group-form").requestSubmit(); });
  $("#collection-edit-form").addEventListener("submit", saveCollectionEdit);
  $("#collection-edit-close").addEventListener("click", () => $("#collection-edit-dialog").close());
  $("#collection-edit-cancel").addEventListener("click", () => $("#collection-edit-dialog").close());
  $("#save-page").addEventListener("click", saveCurrentAddress);
  $("#import-browser-data").addEventListener("click", () => void openBrowserImport(false));
  $("#install-browser-extension-dir").addEventListener("click", () => void installBrowserExtension("directory"));
  $("#install-browser-extension-zip").addEventListener("click", () => void installBrowserExtension("zip"));
  $("#import-browser-extensions").addEventListener("click", () => void openBrowserExtensionImport());
  $("#extension-import-close").addEventListener("click", closeBrowserExtensionImport);
  $("#extension-import-cancel").addEventListener("click", closeBrowserExtensionImport);
  $("#extension-import-run").addEventListener("click", () => void runBrowserExtensionImport());
  $("#open-extension-repository").addEventListener("click", () => void openExtensionRepository());
  $("#extension-repository-close").addEventListener("click", closeExtensionRepository);
  $("#extension-repository-cancel").addEventListener("click", closeExtensionRepository);
  $("#extension-repository-list").addEventListener("click", (event) => void installRepositoryExtensionFromUi(event));
  $("#extension-list").addEventListener("click", (event) => void runBrowserExtensionAction(event));
  $("#apply-browser-backend").addEventListener("click", () => void applyBrowserBackend());
  $("#agent-web-access-enabled").addEventListener("change", () => void saveAgentPolicySettings());
  $("#agent-silent-downloads-enabled").addEventListener("change", () => void saveAgentPolicySettings());
  $("#control-handoff-enabled").addEventListener("change", () => void saveControlHandoffSettings());
  $("#control-consent-enabled").addEventListener("change", () => void saveControlConsentSettings());
  $("#control-consent-level").addEventListener("change", () => void saveControlConsentSettings());
  $("#refresh-companion-status").addEventListener("click", () => void loadBrowserSettings());
  $("#install-companion").addEventListener("click", () => void installCompanion());
  $("#repair-agent-integrations").addEventListener("click", () => void repairAgentIntegrations());
  $("#agent-integration-list").addEventListener("click", (event) => void openAgentIntegrationFolder(event));
  $("#clear-site-permissions").addEventListener("click", clearSitePermissions);
  $("#site-permissions-list").addEventListener("click", removeSitePermission);
  $("#password-autofill-enabled").addEventListener("change", () => void savePasswordAutofillSetting());
  $("#credential-profile-filter").addEventListener("change", (event) => {
    credentialSettingsProfileId = event.currentTarget.value || "default";
    renderCredentialSettings();
  });
  $("#credential-settings-list").addEventListener("click", (event) => void runCredentialSettingsAction(event));
  $("#clear-saved-credentials").addEventListener("click", () => void clearSavedCredentials());
  $("#crash-reload").addEventListener("click", reloadCrashedTab);
  $("#crash-close").addEventListener("click", () => currentTab && void closeBrowserTab(currentTab));
  $("#browser-prompt-form").addEventListener("submit", (event) => { event.preventDefault(); resolveBrowserPrompt(true); });
  $("#browser-auth-credential").addEventListener("change", () => void loadBrowserAuthCredential());
  $("#browser-prompt-deny").addEventListener("click", () => resolveBrowserPrompt(false));
  $("#browser-prompt-close").addEventListener("click", () => resolveBrowserPrompt(false));
  $("#credential-save-form").addEventListener("submit", (event) => void saveCredentialDialog(event));
  $("#credential-save-close").addEventListener("click", closeCredentialSaveDialog);
  $("#credential-save-cancel").addEventListener("click", closeCredentialSaveDialog);
  $("#credential-save-dialog").addEventListener("close", () => {
    pendingCredentialSave = null;
    $("#credential-save-password").value = "";
  });
  $("#credential-password-visible").addEventListener("change", (event) => {
    $("#credential-save-password").type = event.currentTarget.checked ? "text" : "password";
  });
  $("#onboarding-close").addEventListener("click", closeBrowserImport);
  $("#onboarding-skip").addEventListener("click", skipBrowserImport);
  $("#onboarding-import").addEventListener("click", runBrowserImport);
  $("#onboarding-dialog").addEventListener("cancel", (event) => {
    if (importDialogIsOnboarding) event.preventDefault();
  });
  $("#confirm-form").addEventListener("submit", (event) => {
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve?.(event.submitter?.value === "default");
  });
  $("#confirm-dialog").addEventListener("close", () => {
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve?.($("#confirm-dialog").returnValue === "default");
  });
}

async function handleHomeBarCompose(payload) {
  if (payload.action === "new-task") {
    showMainWindowView();
    openTaskDialog();
    return;
  }
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return;
  showMainWindowView();
  $("#omnibox").value = text;
  await ensureQuickTask();
  await openNewTab(text);
}

async function applyHomeBarContext(tab, context) {
  if (context.page) await addTabAttachment(tab, `homebar-page-${tab.targetId}`);
  if (context.selection) {
    const id = `homebar-selection-${crypto.randomUUID()}`;
    setAttachment({
      id,
      type: "collection",
      title: `选中文本 · ${tab.title || domainOf(tab.url)}`,
      sourceUrl: tab.url,
      state: "success",
      content: `<context type="selected-text" source="${escapeAttribute(tab.url || "")}" title="${escapeAttribute(tab.title || "")}">\n${context.selection}\n</context>`,
    });
  }
  if (context.screenshotAttachment?.id) {
    if (fileAttachments.size < 8) fileAttachments.set(context.screenshotAttachment.id, context.screenshotAttachment);
    renderAttachments();
  }
}

function showMainWindowView() {
  switchView("start");
}

async function ensureQuickTask() {
  if (activeTaskId) return;
  const existing = state.spaces.find((task) => task.name === "快速任务");
  if (existing) {
    activeTaskId = existing.taskId;
    await invoke("task.activate", { id: existing.id });
  } else {
    const task = await invoke("task.create", { name: "快速任务" });
    activeTaskId = task.taskId;
  }
  await refresh();
}

async function refresh(query = "") {
  const revision = ++refreshRevision;
  try {
    const previousTabs = new Map(state.tabs.map((tab) => [tab.targetId, tab]));
    const [nextState, library] = await Promise.all([invoke("state", { query }), invoke("collection.library")]);
    if (revision !== refreshRevision) return false;
    bookmarkLibrary.setData(library);
    for (const tab of nextState.tabs || []) {
      const previous = previousTabs.get(tab.targetId);
      if (!previous) continue;
      for (const key of ["pinned", "muted", "sleeping", "groupId", "groupTitle", "groupColor", "lastActiveAt", "zoomFactor"]) {
        if (!Object.prototype.hasOwnProperty.call(tab, key) && Object.prototype.hasOwnProperty.call(previous, key)) tab[key] = previous[key];
      }
    }
    state = nextState;
    cosWorkspace.render();
    state.tabs.forEach(retainPendingTabPreferences);
    for (const tab of state.tabs) {
      if (tabActivityTimes.has(tab.targetId)) continue;
      const restoredAt = Date.parse(tab.lastActiveAt || "");
      tabActivityTimes.set(tab.targetId, Number.isFinite(restoredAt) ? restoredAt : Date.now());
    }
    if (currentTab) currentTab = state.tabs.find((tab) => tab.targetId === currentTab.targetId) || currentTab;
    $("#connection").textContent = state.backend.ready ? "本地运行中" : state.backend.message || "未连接";
    $("#backend-label").textContent = `${backendName(state.backend.kind)} · ${state.backend.ready ? "已连接" : "离线"}`;
    $("#settings-backend").textContent = `${backendName(state.backend.kind)}（${state.backend.ready ? "已就绪" : "离线"}）`;
    $("#settings-homebar").textContent = state.shell?.homeBarShortcutRegistered
      ? String(state.shell.homeBarShortcut || "Ctrl+Shift+Space").replace("CommandOrControl", "Ctrl")
      : "快捷键不可用";
    $("#settings-tray").textContent = state.shell?.trayReady ? "已就绪" : "不可用";
    if (!activeTaskId && state.spaces[0]) activeTaskId = state.spaces[0].taskId;
    if (activeTaskId && !state.spaces.some((task) => task.taskId === activeTaskId)) activeTaskId = state.spaces[0]?.taskId || "";
    if (activeTaskId) await ensureConversation(activeTaskId);
    if (revision !== refreshRevision) return false;
    restorePromptDraft();
    renderActiveTaskSelect();
    renderTasks();
    renderTaskBoard();
    renderWorkspaceSnapshots();
    renderBrowserProfiles();
    syncCredentialProfileFilter();
    syncTaskProfileOptions();
    renderCollections();
    renderExtensions();
    renderFavoritesBar();
    renderRecentTabs();
    renderBrowserTabs();
    reconcileAttachments();
    if (!$("#context-picker").hidden) renderContextSources();
    if (!state.onboarding?.completed && !onboardingShown) {
      onboardingShown = true;
      void openBrowserImport(true);
    }
    if (state.backend?.ready && localStorage.getItem("ego-desktop-history-import-migration") !== "1" && !legacyHistoryMigrationRunning) {
      queueMicrotask(() => void migrateLegacyImportedHistory());
    }
    return true;
  } catch (error) {
    if (revision !== refreshRevision) return false;
    $("#connection").textContent = error.message;
    showToast(localizedError(error), true);
    return false;
  }
}

function renderActiveTaskSelect() {
  const select = $("#active-task-select");
  const quickName = $("#workspace-quick-name");
  const currentValue = activeTaskId;
  select.replaceChildren();
  if (!state.spaces.length) {
    select.append(new Option("尚未创建任务", ""));
    select.disabled = true;
    quickName.textContent = "创建工作空间";
  } else {
    for (const task of state.spaces) select.append(new Option(task.name, String(task.id)));
    const active = state.spaces.find((task) => task.taskId === currentValue) || state.spaces[0];
    activeTaskId = active.taskId;
    select.value = String(active.id);
    select.disabled = false;
    quickName.textContent = active.name;
  }
  $("#workspace-quick-switch").title = state.spaces.length
    ? `当前工作空间：${quickName.textContent}。点击进入工作空间设置`
    : "创建第一个工作空间";
  updateAssistantContext();
}

async function activateTaskById(id, options = {}) {
  const task = state.spaces.find((item) => item.id === id);
  if (!task) return false;
  if (task.taskId === activeTaskId) {
    if (cosWorkspace.owns(task)) await showCosHome(false);
    return true;
  }
  if (options.observe === true || taskAgentRunning(task)) {
    return observeTaskByTaskId(task.taskId, options);
  }
  const previousTaskId = activeTaskId;
  try {
    await invoke("task.activate", { id: task.id });
    fileAttachments.clear();
    renderAttachments();
    activeTaskId = task.taskId;
    restorePromptDraft();
    await ensureConversation(activeTaskId);
    if (chatMode === "operations") await ensureOperations(activeTaskId);
    await refresh();
    renderConversation();
    const selectedTabs = tabsForTask(task.taskId);
    if (cosWorkspace.owns(task)) {
      await showCosHome(false);
      return true;
    }
    const selectedTab = automaticTabForTask(selectedTabs);
    if (selectedTab) showTab(selectedTab);
    else showWelcome();
    if (!options.quiet) showToast(`已切换到“${task.name}”`);
    return true;
  } catch (error) {
    activeTaskId = previousTaskId;
    renderActiveTaskSelect();
    showToast(localizedError(error), true);
    return false;
  }
}

async function observeTaskByTaskId(taskId, options = {}) {
  if (!taskId || taskId === activeTaskId) return true;
  const revision = ++taskObservationRevision;
  let task = state.spaces.find((item) => item.taskId === taskId);
  if (!task) {
    await refresh();
    if (revision !== taskObservationRevision) return false;
    task = state.spaces.find((item) => item.taskId === taskId);
  }
  if (!task) return false;
  fileAttachments.clear();
  renderAttachments();
  activeTaskId = task.taskId;
  restorePromptDraft();
  await ensureConversation(activeTaskId);
  if (chatMode === "operations") await ensureOperations(activeTaskId);
  if (revision !== taskObservationRevision) return false;
  renderActiveTaskSelect();
  renderTasks();
  renderTaskBoard();
  renderConversation();
  renderBrowserTabs();
  const selectedTabs = tabsForTask(activeTaskId);
  if (cosWorkspace.owns(task)) {
    await showCosHome(false);
    return true;
  }
  const selectedTab = automaticTabForTask(selectedTabs);
  if (selectedTab) showTab(selectedTab, false);
  else showWelcome();
  if (!options.quiet) showToast(`正在查看“${task.name}”`);
  return true;
}

async function openBrowserImport(onboarding) {
  importDialogIsOnboarding = onboarding;
  $("#onboarding-title").textContent = onboarding ? "导入浏览器资料" : "导入浏览器数据";
  $("#onboarding-copy").textContent = onboarding
    ? "选择要加入收藏库的浏览器资料。原浏览器数据保持不变。"
    : "从本机 Chrome、Edge 或 Brave 用户配置重新导入书签和最近历史。";
  $("#onboarding-skip").textContent = onboarding ? "跳过" : "取消";
  $("#onboarding-import").textContent = onboarding ? "导入并继续" : "导入";
  $("#browser-import-status").textContent = "正在扫描浏览器资料";
  $("#browser-import-sources").replaceChildren();
  if (!$("#onboarding-dialog").open) $("#onboarding-dialog").showModal();
  try {
    const profiles = await invoke("browserImport.sources");
    renderBrowserImportSources(profiles);
    $("#browser-import-status").textContent = profiles.length ? `发现 ${profiles.length} 个浏览器用户配置` : "没有发现可导入的 Chrome、Edge 或 Brave 用户配置";
  } catch (error) {
    $("#browser-import-status").textContent = error.message;
    renderBrowserImportSources([]);
  }
}

function renderBrowserImportSources(profiles) {
  const list = $("#browser-import-sources");
  list.replaceChildren();
  if (!profiles.length) {
    const empty = document.createElement("div");
    empty.className = "browser-source-empty";
    empty.textContent = "没有找到浏览器用户配置";
    list.append(empty);
    return;
  }
  for (const profile of profiles) {
    const row = document.createElement("label");
    row.className = "browser-source-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.profileId = profile.id;
    const copy = document.createElement("span");
    copy.className = "browser-source-copy";
    const title = document.createElement("strong");
    title.textContent = `${profile.browserName} · ${profile.profileName}`;
    const subtitle = document.createElement("span");
    subtitle.textContent = profile.profileId;
    copy.append(title, subtitle);
    const capabilities = document.createElement("span");
    capabilities.className = "browser-source-capabilities";
    capabilities.textContent = [profile.bookmarks ? "书签" : "", profile.history ? "历史记录" : ""].filter(Boolean).join(" · ");
    row.append(checkbox, copy, capabilities);
    list.append(row);
  }
}

async function runBrowserImport() {
  const button = $("#onboarding-import");
  const profileIds = [...document.querySelectorAll("[data-profile-id]:checked")].map((input) => input.dataset.profileId);
  button.disabled = true;
  $("#browser-import-status").textContent = profileIds.length ? "正在导入" : "没有选择用户配置";
  try {
    const result = await invoke("browserImport.run", {
      profileIds,
      bookmarks: $("#import-bookmarks").checked,
      history: $("#import-history").checked,
      historyLimit: Number($("#import-history-limit").value),
    });
    const historyResult = mergeImportedWebsiteHistory(result.historyEntries);
    const errorText = result.errors?.length ? ` · ${result.errors.join("；")}` : "";
    const parts = [];
    if ($("#import-bookmarks").checked) parts.push(`${result.added || 0} 个书签`);
    if ($("#import-history").checked) parts.push(`${historyResult.added} 条历史记录`);
    const skipped = (result.skipped || 0) + historyResult.skipped;
    $("#browser-import-status").textContent = `已导入 ${parts.join("、") || "0 条内容"}${skipped ? `，跳过 ${skipped} 条重复内容` : ""}${errorText}`;
    if (importDialogIsOnboarding) {
      await completeOnboarding();
      closeBrowserImport();
    }
    await refresh();
  } catch (error) {
    $("#browser-import-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function skipBrowserImport() {
  if (importDialogIsOnboarding) await completeOnboarding();
  closeBrowserImport();
}

async function completeOnboarding() {
  await invoke("onboarding.complete");
  state.onboarding = { completed: true };
  importDialogIsOnboarding = false;
}

function closeBrowserImport() {
  if (importDialogIsOnboarding) return;
  $("#onboarding-dialog").close();
}

function agentSummaryHtml(task) {
  const agent = agentForTask(task);
  if (!agent) return "";
  const userControl = browserSettings.controlHandoffEnabled === true && task.ownership === "agentDelegatedToUser";
  const status = userControl ? agentStatusText(agent.status, task.agentBlocked) : agentStatusText(agent.status === "user-control" ? "offline" : agent.status);
  const action = agentActionForTask(task, agent);
  const duration = elapsedText(agent.activityStartedAt || agent.taskStartedAt || agent.connectedAt);
  return `<span class="task-agent-summary ${agent.status}"><span class="task-agent-dot"></span><strong>${escapeHtml(agent.displayName || "Agent")}</strong><span>${escapeHtml(status)}</span><span>${escapeHtml(action)}</span><span>${escapeHtml(duration)}</span></span>`;
}

function renderTasks() {
  const list = $("#task-list");
  list.replaceChildren();
  for (const task of state.spaces) {
    const tabs = tabsForTask(task.taskId);
    const profile = browserProfileForTask(task);
    const row = document.createElement("div");
    row.className = `task-row ${task.taskId === activeTaskId ? "active" : ""}`;
    row.dataset.taskId = task.taskId;
    row.draggable = true;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.innerHTML = `<span class="task-color" style="--task-profile-color:${escapeAttribute(profile.color)}"></span><span class="task-copy"><span class="task-name">${escapeHtml(task.name)}</span><span class="task-meta">${tabs.length} 个标签 · ${escapeHtml(profile.name)} · ${escapeHtml(ownershipName(task.ownership))}</span>${agentSummaryHtml(task)}</span><span class="task-row-actions"><button class="icon-button rename-task" type="button" title="重命名任务"><i data-lucide="pencil"></i></button><button class="icon-button delete-task" type="button" title="删除任务"><i data-lucide="trash-2"></i></button></span>`;
    if (cosWorkspace.owns(task)) {
      const mark = row.querySelector(".task-color");
      const icon = document.createElement("img");
      icon.src = state.cos.logo;
      icon.alt = "";
      icon.width = 22;
      icon.height = 22;
      mark.replaceWith(icon);
      row.classList.add("cos-workspace");
      row.querySelector(".rename-task").hidden = true;
      row.querySelector(".delete-task").title = "停用 CoS";
    }
    for (const label of row.querySelectorAll(".task-name, .task-meta")) label.title = label.textContent;
    row.addEventListener("click", async () => {
      await activateTaskById(task.id, { quiet: true });
      if (workspaceSidebarQuickMode) closeWorkspaceSidebar();
    });
    row.addEventListener("keydown", (event) => {
      if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        void moveTaskByKeyboard(task.id, event.key === "ArrowUp" ? -1 : 1);
        return;
      }
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      void activateTaskById(task.id, { quiet: true }).then(() => {
        if (workspaceSidebarQuickMode) closeWorkspaceSidebar();
      });
    });
    row.querySelector(".rename-task").addEventListener("click", (event) => {
      event.stopPropagation();
      openTaskRenameDialog(task);
    });
    row.querySelector(".delete-task").addEventListener("click", (event) => {
      event.stopPropagation();
      void closeTask(task);
    });
    bindTaskDrag(row, task);
    list.append(row);
  }
  window.lucide.createIcons({ root: list });
}

function bindTaskDrag(row, task) {
  row.addEventListener("dragstart", (event) => {
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/x-ego-task", String(task.id));
  });
  row.addEventListener("dragend", clearTaskDragIndicators);
  row.addEventListener("dragover", (event) => {
    const sourceId = Number(event.dataTransfer.getData("text/x-ego-task"));
    if (!sourceId || sourceId === task.id) return;
    event.preventDefault();
    clearTaskDragIndicators();
    const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
    row.classList.add(after ? "drag-after" : "drag-before");
  });
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    const sourceId = Number(event.dataTransfer.getData("text/x-ego-task"));
    const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
    clearTaskDragIndicators();
    void reorderTaskSpaces(sourceId, task.id, after);
  });
}

function clearTaskDragIndicators() {
  for (const row of document.querySelectorAll(".task-row")) row.classList.remove("dragging", "drag-before", "drag-after");
}

async function moveTaskByKeyboard(id, direction) {
  const index = state.spaces.findIndex((task) => task.id === id);
  const target = state.spaces[index + direction];
  if (index < 0 || !target) return;
  await reorderTaskSpaces(id, target.id, direction > 0);
  document.querySelector(`.task-row[data-task-id="${state.spaces[index + direction]?.taskId || ""}"]`)?.focus();
}

async function reorderTaskSpaces(sourceId, targetId, after = false) {
  if (!sourceId || sourceId === targetId) return;
  const previous = [...state.spaces];
  const ordered = state.spaces.filter((task) => task.id !== sourceId);
  let targetIndex = ordered.findIndex((task) => task.id === targetId);
  const source = state.spaces.find((task) => task.id === sourceId);
  if (!source || targetIndex < 0) return;
  if (after) targetIndex += 1;
  ordered.splice(targetIndex, 0, source);
  state.spaces = ordered.map((task, index) => ({ ...task, order: index }));
  renderActiveTaskSelect();
  renderTasks();
  renderTaskBoard();
  try {
    await invoke("task.reorder", { ids: state.spaces.map((task) => task.id) });
    showToast("任务顺序已保存");
  } catch (error) {
    state.spaces = previous;
    renderActiveTaskSelect();
    renderTasks();
    renderTaskBoard();
    showToast(localizedError(error), true);
  }
}

function renderTaskBoard() {
  const board = $("#task-board");
  board.replaceChildren();
  const needle = $("#task-search").value.trim().toLocaleLowerCase();
  const tasks = state.spaces.filter((task) => !needle || `${task.name} ${ownershipName(task.ownership)}`.toLocaleLowerCase().includes(needle));
  visibleTaskIds = tasks.map((task) => task.id);
  for (const id of [...selectedTaskIds]) if (!state.spaces.some((task) => task.id === id)) selectedTaskIds.delete(id);
  updateTaskBatchControls();
  if (!tasks.length) {
    board.innerHTML = `<div class="collection-empty"><strong>${state.spaces.length ? "没有匹配任务" : "还没有任务空间"}</strong><span>${state.spaces.length ? "调整搜索文字后重试。" : "点击窗口顶部的 + 创建第一个任务。"}</span></div>`;
    return;
  }
  for (const task of tasks) {
    const tabs = tabsForTask(task.taskId);
    const profile = browserProfileForTask(task);
    const card = document.createElement("article");
    card.className = "task-card";
    card.innerHTML = `<div class="task-card-head"><input class="task-checkbox" type="checkbox" title="选择任务" ${selectedTaskIds.has(task.id) ? "checked" : ""}><div><strong>${escapeHtml(task.name)}</strong><div class="collection-meta"><span class="task-profile-badge"><i style="--task-profile-color:${escapeAttribute(profile.color)}"></i>${escapeHtml(profile.name)}</span> · ${tabs.length} 个标签 · ${escapeHtml(ownershipName(task.ownership))}</div>${agentSummaryHtml(task)}</div><div class="task-actions"><button class="secondary-button open-task"><i data-lucide="folder-open"></i><span>打开</span></button><button class="icon-button rename-task" title="重命名任务"><i data-lucide="pencil"></i></button><button class="icon-button close-task" title="删除任务"><i data-lucide="trash-2"></i></button></div></div><div class="collection-meta">${tabs.map((tab) => escapeHtml(tab.title || tab.url)).join(" · ") || "尚未打开网页"}</div>`;
    card.querySelector(".task-checkbox").addEventListener("change", (event) => {
      if (event.currentTarget.checked) selectedTaskIds.add(task.id);
      else selectedTaskIds.delete(task.id);
      updateTaskBatchControls();
    });
    card.querySelector(".open-task").addEventListener("click", async () => { if (await activateTaskById(task.id)) switchView("start"); });
    card.querySelector(".rename-task").addEventListener("click", () => openTaskRenameDialog(task));
    card.querySelector(".close-task").addEventListener("click", () => void closeTask(task));
    board.append(card);
  }
  window.lucide.createIcons({ root: board });
}

function browserProfiles() {
  return state.profiles?.length ? state.profiles : [{ id: "default", name: "默认 Profile", color: "#5b7c86", partition: "persist:ego-desktop" }];
}

function browserProfileForTask(task) {
  const id = task?.profileId ?? "default";
  return browserProfiles().find((profile) => profile.id === id)
    || { id, name: `Profile 已缺失 ${id}`, color: "#bd3d32", missing: true };
}

function syncTaskProfileOptions() {
  const select = $("#task-profile");
  if (!select) return;
  const previous = select.value;
  select.replaceChildren(...browserProfiles().map((profile) => new Option(profile.name, profile.id)));
  select.value = browserProfiles().some((profile) => profile.id === previous) ? previous : "default";
}

function renderBrowserProfiles() {
  const list = $("#browser-profile-list");
  if (!list) return;
  list.replaceChildren();
  for (const profile of browserProfiles()) {
    const spaces = state.spaces.filter((task) => (task.profileId || "default") === profile.id);
    const row = document.createElement("article");
    row.className = "browser-profile-row";
    row.innerHTML = `<span class="browser-profile-avatar" style="--browser-profile-color:${escapeAttribute(profile.color)}"><i data-lucide="user-round"></i></span><span class="browser-profile-copy"><strong>${escapeHtml(profile.name)}</strong><span>${spaces.length} 个工作空间 · ${profile.id === "default" ? "保留原有浏览数据" : "独立浏览数据"}</span></span><span class="browser-profile-actions"><button class="icon-button" type="button" data-profile-action="edit" data-profile-id="${escapeAttribute(profile.id)}" title="编辑 Profile"><i data-lucide="pencil"></i></button><button class="icon-button danger-icon" type="button" data-profile-action="delete" data-profile-id="${escapeAttribute(profile.id)}" title="删除 Profile" ${profile.id === "default" || spaces.length ? "disabled" : ""}><i data-lucide="trash-2"></i></button></span>`;
    list.append(row);
  }
  window.lucide.createIcons({ root: list });
}

function openBrowserProfileDialog(profile = null) {
  browserProfileEditTarget = profile;
  selectedBrowserProfileColor = profile?.color || BROWSER_PROFILE_COLORS[Math.min(browserProfiles().length, BROWSER_PROFILE_COLORS.length - 1)];
  $("#browser-profile-dialog-title").textContent = profile ? "编辑浏览器 Profile" : "新建浏览器 Profile";
  $("#browser-profile-name").value = profile?.name || "";
  renderBrowserProfileColors();
  $("#browser-profile-dialog").showModal();
  queueMicrotask(() => $("#browser-profile-name").focus());
}

function closeBrowserProfileDialog() {
  browserProfileEditTarget = null;
  $("#browser-profile-dialog").close();
}

function renderBrowserProfileColors() {
  $("#browser-profile-colors").innerHTML = BROWSER_PROFILE_COLORS.map((color) => `<button class="profile-color-option ${color === selectedBrowserProfileColor ? "active" : ""}" type="button" data-profile-color="${color}" style="--browser-profile-color:${color}" title="选择颜色" aria-label="选择颜色" aria-pressed="${color === selectedBrowserProfileColor}"></button>`).join("");
}

function selectBrowserProfileColor(event) {
  const button = event.target.closest("[data-profile-color]");
  if (!button) return;
  selectedBrowserProfileColor = button.dataset.profileColor;
  renderBrowserProfileColors();
}

async function saveBrowserProfile(event) {
  event.preventDefault();
  const name = $("#browser-profile-name").value.trim();
  if (!name) return;
  const button = event.currentTarget.querySelector(".primary-button");
  button.disabled = true;
  try {
    if (browserProfileEditTarget) {
      await invoke("profiles.rename", { id: browserProfileEditTarget.id, name, color: selectedBrowserProfileColor });
      showToast(`已更新“${name}”`);
    } else {
      await invoke("profiles.create", { name, color: selectedBrowserProfileColor });
      showToast(`已创建“${name}”`);
    }
    closeBrowserProfileDialog();
    await refresh();
  } catch (error) {
    showToast(localizedError(error), true);
  } finally {
    button.disabled = false;
  }
}

async function runBrowserProfileAction(event) {
  const button = event.target.closest("[data-profile-action]");
  if (!button) return;
  const profile = browserProfiles().find((item) => item.id === button.dataset.profileId);
  if (!profile) return;
  if (button.dataset.profileAction === "edit") {
    openBrowserProfileDialog(profile);
    return;
  }
  if (!await confirmAction("删除浏览器 Profile", `确定删除“${profile.name}”吗？独立浏览数据会保留在本机，后续版本会提供清理工具。`, "删除 Profile")) return;
  try {
    await invoke("profiles.remove", { id: profile.id });
    await refresh();
    await loadCredentials();
    showToast(`已删除“${profile.name}”`);
  } catch (error) {
    showToast(localizedError(error), true);
  }
}

function loadWorkspaceSnapshots() {
  try {
    const value = JSON.parse(localStorage.getItem("ego-desktop-workspace-snapshots") || "[]");
    return Array.isArray(value) ? value.filter((item) => item && typeof item.id === "string" && Array.isArray(item.tabs)).slice(0, 24) : [];
  } catch {
    return [];
  }
}

function persistWorkspaceSnapshots() {
  localStorage.setItem("ego-desktop-workspace-snapshots", JSON.stringify(workspaceSnapshots.slice(0, 24)));
}

function openWorkspaceSnapshotDialog() {
  const task = state.spaces.find((item) => item.taskId === activeTaskId);
  if (!task) {
    showToast("请先创建或选择工作空间");
    return;
  }
  $("#workspace-snapshot-name").value = `${task.name} · ${new Date().toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}`;
  $("#workspace-snapshot-dialog").showModal();
  queueMicrotask(() => { $("#workspace-snapshot-name").focus(); $("#workspace-snapshot-name").select(); });
}

function closeWorkspaceSnapshotDialog() {
  $("#workspace-snapshot-dialog").close();
}

function saveWorkspaceSnapshot(event) {
  event.preventDefault();
  const task = state.spaces.find((item) => item.taskId === activeTaskId);
  const name = $("#workspace-snapshot-name").value.trim();
  if (!task || !name) return;
  const taskTabs = tabsForTask(task.taskId).map((tab, order) => ({
    url: tab.url || "about:blank",
    title: tab.title || "新标签页",
    order,
    active: tab.targetId === currentTab?.targetId,
    pinned: tab.pinned === true,
    muted: tab.muted === true,
    sleeping: tab.sleeping === true,
    zoomFactor: Number(tab.zoomFactor || 1),
    groupId: tab.groupId || "",
    groupTitle: tab.groupTitle || "",
    groupColor: tab.groupColor || "",
    lastActiveAt: tab.lastActiveAt || new Date().toISOString(),
  }));
  const collapsedGroups = [...new Set(taskTabs.filter((tab) => tab.groupId && isTabGroupCollapsed(task.taskId, tab.groupId)).map((tab) => tab.groupId))];
  workspaceSnapshots.unshift({ id: crypto.randomUUID(), name, taskName: task.name, profileId: task.profileId || "default", createdAt: new Date().toISOString(), tabs: taskTabs, collapsedGroups });
  workspaceSnapshots.splice(24);
  persistWorkspaceSnapshots();
  closeWorkspaceSnapshotDialog();
  renderWorkspaceSnapshots();
  showToast(`已保存“${name}”`);
}

function renderWorkspaceSnapshots() {
  const list = $("#workspace-snapshot-list");
  $("#workspace-snapshot-count").textContent = `${workspaceSnapshots.length} 个快照`;
  list.replaceChildren();
  if (!workspaceSnapshots.length) {
    list.innerHTML = '<div class="workspace-snapshot-empty"><i data-lucide="camera"></i><span>保存一次当前现场，之后可以恢复为新的工作空间。</span></div>';
    window.lucide.createIcons({ root: list });
    return;
  }
  for (const snapshot of workspaceSnapshots) {
    const card = document.createElement("article");
    card.className = "workspace-snapshot-card";
    const sleeping = snapshot.tabs.filter((tab) => tab.sleeping).length;
    const groups = new Set(snapshot.tabs.map((tab) => tab.groupId).filter(Boolean)).size;
    card.innerHTML = `<div class="workspace-snapshot-icon"><i data-lucide="camera"></i></div><div class="workspace-snapshot-copy"><strong>${escapeHtml(snapshot.name)}</strong><span>${snapshot.tabs.length} 个标签${groups ? ` · ${groups} 个标签组` : ""}${sleeping ? ` · ${sleeping} 个休眠` : ""} · ${escapeHtml(formatSnapshotTime(snapshot.createdAt))}</span></div><div class="workspace-snapshot-actions"><button class="secondary-button" type="button" data-snapshot-action="restore" data-snapshot-id="${escapeAttribute(snapshot.id)}"><i data-lucide="history"></i><span>恢复</span></button><button class="icon-button" type="button" data-snapshot-action="delete" data-snapshot-id="${escapeAttribute(snapshot.id)}" title="删除快照"><i data-lucide="trash-2"></i></button></div>`;
    list.append(card);
  }
  window.lucide.createIcons({ root: list });
}

async function runWorkspaceSnapshotAction(event) {
  const button = event.target.closest("[data-snapshot-action]");
  if (!button) return;
  const snapshot = workspaceSnapshots.find((item) => item.id === button.dataset.snapshotId);
  if (!snapshot) return;
  if (button.dataset.snapshotAction === "delete") {
    if (!await confirmAction("删除工作空间快照", `确定删除“${snapshot.name}”吗？`, "删除快照")) return;
    workspaceSnapshots.splice(workspaceSnapshots.indexOf(snapshot), 1);
    persistWorkspaceSnapshots();
    renderWorkspaceSnapshots();
    showToast("快照已删除");
    return;
  }
  await restoreWorkspaceSnapshot(snapshot, button);
}

async function restoreWorkspaceSnapshot(snapshot, button) {
  button.disabled = true;
  try {
    const profileId = snapshot.profileId ?? "default";
    if (!state.profiles.some((profile) => profile.id === profileId)) {
      throw new Error(`找不到快照使用的 Profile ${profileId}，请先恢复该 Profile`);
    }
    const task = await invoke("task.create", { name: snapshot.name, profileId });
    activeTaskId = task.taskId;
    const restored = [];
    for (const record of [...snapshot.tabs].sort((left, right) => left.order - right.order)) {
      const tab = await invoke("tab.open", { url: record.url || "about:blank", taskId: task.taskId });
      restored.push({ ...record, targetId: tab.targetId });
      await queueTabPreferences(tab.targetId, {
        pinned: record.pinned === true,
        muted: record.muted === true,
        sleeping: record.sleeping === true,
        zoomFactor: Number(record.zoomFactor || 1),
        groupId: record.groupId || "",
        groupTitle: record.groupTitle || "",
        groupColor: record.groupColor || "",
        lastActiveAt: record.lastActiveAt || new Date().toISOString(),
      });
    }
    for (const groupId of snapshot.collapsedGroups || []) setTabGroupCollapsed(task.taskId, groupId, true);
    await refresh();
    for (const record of restored.filter((item) => item.sleeping)) {
      const tab = state.tabs.find((item) => item.targetId === record.targetId);
      if (tab) await setTabSleeping(tab, true, { silent: true });
    }
    const active = restored.find((item) => item.active && !item.sleeping) || restored.find((item) => !item.sleeping) || restored[0];
    const activeTab = active && state.tabs.find((item) => item.targetId === active.targetId);
    if (activeTab) showTab(activeTab);
    else showWelcome();
    switchView("start");
    showToast(`已恢复“${snapshot.name}”`);
  } catch (error) {
    showToast(`恢复快照失败：${localizedError(error)}`, true);
  } finally {
    button.disabled = false;
  }
}

function formatSnapshotTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "刚刚" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function toggleAllTasks() {
  const checked = $("#task-select-all").checked;
  for (const id of visibleTaskIds) {
    if (checked) selectedTaskIds.add(id);
    else selectedTaskIds.delete(id);
  }
  renderTaskBoard();
}

function updateTaskBatchControls() {
  const visibleSelected = visibleTaskIds.filter((id) => selectedTaskIds.has(id)).length;
  const checkbox = $("#task-select-all");
  checkbox.checked = visibleTaskIds.length > 0 && visibleSelected === visibleTaskIds.length;
  checkbox.indeterminate = visibleSelected > 0 && visibleSelected < visibleTaskIds.length;
  $("#task-selection-count").textContent = selectedTaskIds.size ? `已选 ${selectedTaskIds.size} 项` : "选择全部";
  $("#task-batch-close").disabled = selectedTaskIds.size === 0;
}

function taskAgentRunning(task) {
  const agent = agentForTask(task);
  return Boolean(agent?.status === "executing" || (operationRecords.get(task?.taskId) || []).some((record) => record.status === "running"));
}

async function closeSelectedTasks() {
  const tasks = state.spaces.filter((task) => selectedTaskIds.has(task.id));
  if (!tasks.length) return;
  const agentTasks = tasks.filter((task) => taskAgentRunning(task) || task.ownership === "agent");
  const message = agentTasks.length
    ? `将删除所选 ${tasks.length} 个任务空间。其中 ${agentTasks.length} 个任务仍有 Agent 执行或持有控制权，删除后会立即终止这些任务中的 Agent 操作，并关闭所有任务空间中的全部标签页。固定标签也会一并关闭。此操作无法撤销。`
    : `将删除所选 ${tasks.length} 个任务空间及其中的全部标签页。固定标签也会一并关闭。此操作无法撤销。`;
  if (!await confirmAction("删除多个任务空间", message, "仍要删除")) return;
  const failures = [];
  for (const task of tasks) {
    try {
      await invoke("task.close", { id: task.id });
      selectedTaskIds.delete(task.id);
      operationRecords.delete(task.taskId);
      conversations.delete(task.taskId);
      if (activeTaskId === task.taskId) {
        activeTaskId = "";
        currentTab = null;
      }
    } catch (error) {
      failures.push(`${task.name}：${localizedError(error)}`);
    }
  }
  await refresh();
  if (!activeTaskId) showWelcome();
  showToast(failures.length ? `已删除 ${tasks.length - failures.length} 项；${failures.join("；")}` : `已删除 ${tasks.length} 个任务空间`, failures.length > 0);
}

function openTaskRenameDialog(task) {
  taskRenameTarget = task;
  $("#task-rename-name").value = task.name;
  $("#task-rename-dialog").showModal();
  queueMicrotask(() => { $("#task-rename-name").focus(); $("#task-rename-name").select(); });
}

function closeTaskRenameDialog() {
  taskRenameTarget = null;
  $("#task-rename-dialog").close();
}

async function saveTaskRename(event) {
  event.preventDefault();
  const name = $("#task-rename-name").value.trim();
  if (!taskRenameTarget || !name) return;
  try {
    const previousName = taskRenameTarget.name;
    await invoke("task.rename", { id: taskRenameTarget.id, name });
    closeTaskRenameDialog();
    await refresh();
    showToast(previousName === name ? "任务名称未变化" : `已重命名为“${name}”`);
  } catch (error) {
    showToast(localizedError(error), true);
  }
}

async function closeTask(task) {
  if (cosWorkspace.owns(task)) {
    await invoke("cos.disable");
    cosWorkspace.hide();
    await refresh();
    showWelcome();
    return;
  }
  const message = taskAgentRunning(task) || task.ownership === "agent"
    ? `将删除“${task.name}”。Agent 正在执行或仍持有控制权，删除后会立即终止该任务中的 Agent 操作，并关闭全部标签页。固定标签也会一并关闭。此操作无法撤销。`
    : `将删除“${task.name}”及其中的全部标签页。固定标签也会一并关闭。此操作无法撤销。`;
  const accepted = await confirmAction("删除任务空间", message, "仍要删除");
  if (!accepted) return;
  try {
    await invoke("task.close", { id: task.id });
    if (activeTaskId === task.taskId) {
      activeTaskId = "";
      currentTab = null;
      showWelcome();
    }
    operationRecords.delete(task.taskId);
    conversations.delete(task.taskId);
    selectedTaskIds.delete(task.id);
    await refresh();
    showToast(`已删除“${task.name}”`);
  } catch (error) {
    showToast(localizedError(error), true);
  }
}

function renderCollections() {
  bookmarkLibrary.render();
  updateBrowserToolbar();
}

function renderExtensions() {
  const list = $("#extension-list");
  list.replaceChildren();
  const extensions = Array.isArray(state.extensions) ? state.extensions : [];
  if (!extensions.length) {
    list.innerHTML = '<div class="extension-empty"><i data-lucide="puzzle"></i><strong>还没有浏览器扩展</strong><span>添加已解压的 Chromium 扩展目录或 ZIP 包，就能让它作用于 EgoLite 的标签页。</span></div>';
    window.lucide.createIcons({ root: list });
    renderExtensionsPanel();
    renderPinnedExtensionActions();
    return;
  }
  for (const extension of extensions) {
    const row = document.createElement("article");
    row.className = `extension-row${extension.loaded ? " loaded" : ""}${extension.error ? " has-error" : ""}`;
    const health = extensionHealth(extension);
    const sourceLabel = extension.sourceType === "zip" ? "ZIP 包" : extension.sourceType === "browser-profile" ? "浏览器迁移" : "本地目录";
    const description = extension.description ? `<p class="extension-description">${escapeHtml(extension.description)}</p>` : "";
    const actionTitle = extension.actionAvailable ? "打开扩展面板" : extension.loaded ? "此扩展没有操作面板" : "扩展尚未加载";
    row.innerHTML = `<div class="extension-icon"><i data-lucide="puzzle"></i></div><div class="extension-copy"><div class="extension-title-row"><strong>${escapeHtml(extension.name || "浏览器扩展")}</strong><span class="extension-status ${health.tone}" title="${escapeAttribute(health.detail)}">${escapeHtml(health.label)}</span></div>${description}<div class="extension-meta"><span>版本 ${escapeHtml(extension.version || "未知")}</span><span>Manifest V${escapeHtml(extension.manifestVersion || "3")}</span><span>${sourceLabel}</span></div><span class="extension-path" title="${escapeAttribute(extension.path || "")}">${escapeHtml(extension.path || "未记录路径")}</span>${extension.error ? `<p class="extension-error" title="${escapeAttribute(extension.error)}">${escapeHtml(extension.error)}</p>` : `<p class="extension-runtime-note ${health.tone}">${escapeHtml(health.detail)}</p>`}</div><div class="extension-actions"><button class="icon-button" type="button" data-extension-action="pin" data-extension-id="${escapeAttribute(extension.id)}" data-pinned="${extension.pinned}" title="${extension.pinned ? "从工具栏取消固定" : "固定到工具栏"}"><i data-lucide="${extension.pinned ? "pin-off" : "pin"}"></i></button><button class="icon-button extension-launch-button" type="button" data-extension-action="launch" data-extension-id="${escapeAttribute(extension.id)}" title="${escapeAttribute(actionTitle)}" ${extension.actionAvailable ? "" : "disabled"}><i data-lucide="panel-top-open"></i></button><label class="extension-toggle" title="${extension.enabled ? "停用扩展" : "启用扩展"}"><input type="checkbox" data-extension-toggle="${escapeAttribute(extension.id)}" ${extension.enabled ? "checked" : ""}><span></span></label><button class="icon-button" type="button" data-extension-action="reload" data-extension-id="${escapeAttribute(extension.id)}" title="重新加载"><i data-lucide="refresh-cw"></i></button><button class="icon-button" type="button" data-extension-action="open" data-extension-id="${escapeAttribute(extension.id)}" title="打开扩展目录"><i data-lucide="folder-open"></i></button><button class="icon-button danger-icon" type="button" data-extension-action="remove" data-extension-id="${escapeAttribute(extension.id)}" title="移除扩展"><i data-lucide="trash-2"></i></button></div>`;
    list.append(row);
  }
  for (const toggle of list.querySelectorAll("[data-extension-toggle]")) {
    toggle.addEventListener("change", () => void setBrowserExtensionEnabled(toggle.dataset.extensionToggle, toggle.checked));
  }
  window.lucide.createIcons({ root: list });
  renderExtensionsPanel();
  renderPinnedExtensionActions();
}

function extensionHealth(extension) {
  if (extension.error) return { label: "需要处理", tone: "error", detail: localizedError(extension.error) };
  if (extension.loaded && extension.ready && extension.runtimeAdapted) {
    return { label: "兼容运行", tone: "enabled", detail: extension.compatibilityDetail || "扩展后台、弹窗和内容脚本已由 EgoLite 兼容运行层托管" };
  }
  if (extension.loaded && !extension.ready) return { label: "后台未就绪", tone: "warning", detail: "扩展文件已加载，但后台运行环境尚未完成初始化" };
  if (extension.loaded) return { label: "已启用", tone: "enabled", detail: extension.actionAvailable ? "扩展已加载，可从拼图菜单打开操作面板" : "扩展已经加载到 EgoLite 内置浏览器" };
  if (extension.enabled) return { label: "等待加载", tone: "warning", detail: "扩展已启用，将在浏览器会话重载后再次尝试" };
  const companionRecommended = /violentmonkey|暴力猴|immersive translate|沉浸式翻译/i.test(extension.name || "");
  return {
    label: companionRecommended ? "建议在 Edge 中使用" : "已停用",
    tone: companionRecommended ? "warning" : "disabled",
    detail: companionRecommended ? "该扩展依赖 Electron 尚未完整实现的 Chromium API，使用 Companion 可保留完整能力" : "扩展不会注入网页",
  };
}

function renderExtensionsPanel() {
  const panelList = $("#extensions-panel-list");
  if (!panelList) return;
  const extensions = Array.isArray(state.extensions) ? state.extensions : [];
  panelList.replaceChildren();
  const loaded = extensions.filter((item) => item.loaded).length;
  const needsAttention = extensions.filter((item) => item.error || (item.enabled && !item.loaded)).length;
  $("#extensions-panel-summary").textContent = extensions.length
    ? `${loaded} 个可用${needsAttention ? ` · ${needsAttention} 个需处理` : ""}`
    : "尚未安装扩展";
  const badge = $("#extension-badge");
  badge.hidden = needsAttention === 0;
  badge.textContent = needsAttention ? String(Math.min(needsAttention, 9)) : "";
  if (!extensions.length) {
    panelList.innerHTML = '<div class="extension-panel-empty"><i data-lucide="puzzle"></i><span>安装或从 Edge 导入扩展后，会在这里快速启停。</span></div>';
    window.lucide.createIcons({ root: panelList });
    return;
  }
  for (const extension of extensions) {
    const health = extensionHealth(extension);
    const row = document.createElement("div");
    row.className = "extension-panel-row";
    row.title = health.detail;
    const canLaunch = extension.enabled && extension.actionAvailable;
    row.innerHTML = `<span class="extension-panel-icon">${extension.iconDataUrl ? `<img src="${escapeAttribute(extension.iconDataUrl)}" alt="">` : '<i data-lucide="puzzle"></i>'}</span><span class="extension-panel-copy"><strong>${escapeHtml(extension.name || "浏览器扩展")}</strong><span class="${health.tone}">${escapeHtml(health.label)}</span></span><button class="icon-button extension-panel-pin" type="button" data-extension-quick-pin="${escapeAttribute(extension.id)}" data-pinned="${extension.pinned}" title="${extension.pinned ? "从工具栏取消固定" : "固定到工具栏"}"><i data-lucide="${extension.pinned ? "pin-off" : "pin"}"></i></button><button class="icon-button extension-panel-launch" type="button" data-extension-quick-action="${escapeAttribute(extension.id)}" title="${canLaunch ? "打开扩展面板" : extension.enabled ? "扩展操作面板不可用" : "请先启用扩展"}" ${canLaunch ? "" : "disabled"}><i data-lucide="panel-top-open"></i></button><label class="extension-toggle" title="${extension.enabled ? "停用扩展" : "启用扩展"}"><input type="checkbox" data-extension-quick-toggle="${escapeAttribute(extension.id)}" ${extension.enabled ? "checked" : ""}><span></span></label>`;
    panelList.append(row);
  }
  window.lucide.createIcons({ root: panelList });
}

function renderPinnedExtensionActions() {
  const container = $("#browser-extension-actions");
  container.replaceChildren();
  const extensions = (Array.isArray(state.extensions) ? state.extensions : [])
    .filter((extension) => extension.pinned && extension.enabled && extension.loaded && extension.actionAvailable);
  for (const extension of extensions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button pinned-extension-action";
    button.dataset.pinnedExtension = extension.id;
    button.title = extension.name || "打开扩展";
    button.innerHTML = extension.iconDataUrl
      ? `<img src="${escapeAttribute(extension.iconDataUrl)}" alt="">`
      : '<i data-lucide="puzzle"></i>';
    container.append(button);
  }
  container.hidden = extensions.length === 0;
  window.lucide.createIcons({ root: container });
}

function renderFavoritesBar() {
  bookmarkLibrary.renderBar();
}

async function installBrowserExtension(kind) {
  const buttons = [$("#install-browser-extension-dir"), $("#install-browser-extension-zip")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await invoke("extensions.install", { kind });
    if (result?.canceled) return;
    await refresh();
    switchView("extensions");
    showToast(result?.updated ? `已更新扩展“${result?.name || "浏览器扩展"}”` : `已添加扩展“${result?.name || "浏览器扩展"}”`);
  } catch (error) {
    showToast(`添加浏览器扩展失败：${localizedError(error)}`, true);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function openBrowserExtensionImport() {
  const dialog = $("#extension-import-dialog");
  const list = $("#browser-extension-import-list");
  const status = $("#browser-extension-import-status");
  list.replaceChildren();
  status.textContent = "正在扫描 Edge、Chrome 和 Brave 的已安装扩展";
  if (!dialog.open) dialog.showModal();
  try {
    const extensions = await invoke("browserImport.extensions.sources");
    renderBrowserExtensionImportSources(extensions);
    status.textContent = extensions.length ? `发现 ${extensions.length} 个可迁移扩展` : "没有发现可迁移的 Chromium 扩展";
  } catch (error) {
    status.textContent = localizedError(error);
  }
}

function renderBrowserExtensionImportSources(extensions) {
  const list = $("#browser-extension-import-list");
  list.replaceChildren();
  if (!extensions.length) {
    const empty = document.createElement("div");
    empty.className = "browser-source-empty";
    empty.textContent = "没有找到已安装的扩展";
    list.append(empty);
    return;
  }
  for (const extension of extensions) {
    const row = document.createElement("label");
    row.className = "browser-extension-source-row";
    row.innerHTML = `<input type="checkbox" checked data-extension-import-id="${escapeAttribute(extension.id)}"><span class="browser-extension-source-copy"><strong>${escapeHtml(extension.name)}</strong><span>${escapeHtml(extension.browserName)} · ${escapeHtml(extension.profileName)} · v${escapeHtml(extension.version)}</span>${extension.description ? `<small>${escapeHtml(extension.description)}</small>` : ""}</span><span class="browser-extension-permissions" title="权限摘要">${escapeHtml((extension.permissions || []).slice(0, 3).join(" · ") || "未声明额外权限")}</span>`;
    list.append(row);
  }
}

async function runBrowserExtensionImport() {
  const button = $("#extension-import-run");
  const ids = [...document.querySelectorAll("[data-extension-import-id]:checked")].map((input) => input.dataset.extensionImportId);
  button.disabled = true;
  $("#browser-extension-import-status").textContent = ids.length ? "正在复制并加载所选扩展" : "没有选择扩展";
  try {
    const result = await invoke("browserImport.extensions.import", { extensionIds: ids, enable: $("#import-extension-enable").checked });
    const errorText = result.errors?.length ? `，${result.errors.join("；")}` : "";
    $("#browser-extension-import-status").textContent = `已导入 ${result.count || 0} 个扩展${errorText}`;
    await refresh();
    if (result.count) showToast(`已迁移 ${result.count} 个浏览器扩展`);
    setTimeout(closeBrowserExtensionImport, 450);
  } catch (error) {
    $("#browser-extension-import-status").textContent = localizedError(error);
  } finally {
    button.disabled = false;
  }
}

function closeBrowserExtensionImport() {
  const dialog = $("#extension-import-dialog");
  if (dialog.open) dialog.close();
}

async function openExtensionRepository() {
  const dialog = $("#extension-repository-dialog");
  const list = $("#extension-repository-list");
  list.replaceChildren();
  $("#extension-repository-status").textContent = "正在读取扩展仓库";
  if (!dialog.open) dialog.showModal();
  try {
    const items = await invoke("extensions.repository.list");
    renderExtensionRepository(items);
    $("#extension-repository-status").textContent = items.length ? `发现 ${items.length} 个扩展` : "仓库暂时没有可用扩展";
  } catch (error) {
    $("#extension-repository-status").textContent = localizedError(error);
  }
}

function renderExtensionRepository(items) {
  const list = $("#extension-repository-list");
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "extension-empty";
    empty.innerHTML = '<i data-lucide="store"></i><strong>仓库暂时为空</strong><span>可以继续使用本地目录、ZIP 或浏览器迁移。</span>';
    list.append(empty);
    window.lucide.createIcons({ root: list });
    return;
  }
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "extension-repository-row";
    const permissions = item.permissions?.length ? item.permissions.slice(0, 4).join(" · ") : "未声明额外权限";
    row.innerHTML = `<div class="extension-icon"><i data-lucide="puzzle"></i></div><div class="extension-copy"><div class="extension-title-row"><strong>${escapeHtml(item.name)}</strong><span class="extension-status ${item.installed ? "enabled" : "disabled"}">${item.installed ? "已安装" : escapeHtml(item.category || "精选")}</span></div><p class="extension-description">${escapeHtml(item.description || "")}</p><div class="extension-meta"><span>版本 ${escapeHtml(item.version || "未知")}</span><span title="${escapeAttribute(permissions)}">权限 ${escapeHtml(permissions)}</span></div></div><button class="${item.installed ? "secondary-button" : "primary-button"} repository-install-button" type="button" data-repository-id="${escapeAttribute(item.id)}" ${item.installed ? "disabled" : ""}>${item.installed ? "已安装" : "安装"}</button>`;
    list.append(row);
  }
  window.lucide.createIcons({ root: list });
}

async function installRepositoryExtensionFromUi(event) {
  const button = event.target.closest("[data-repository-id]");
  if (!button || button.disabled) return;
  button.disabled = true;
  $("#extension-repository-status").textContent = "正在安装扩展";
  try {
    const result = await invoke("extensions.repository.install", { id: button.dataset.repositoryId });
    await refresh();
    showToast(`已安装扩展“${result?.name || "浏览器扩展"}”`);
    await openExtensionRepository();
  } catch (error) {
    button.disabled = false;
    $("#extension-repository-status").textContent = localizedError(error);
  }
}

function closeExtensionRepository() {
  const dialog = $("#extension-repository-dialog");
  if (dialog.open) dialog.close();
}

async function setBrowserExtensionEnabled(id, enabled) {
  try {
    await invoke("extensions.setEnabled", { id, enabled });
    await refresh();
    showToast(enabled ? "扩展已启用，新页面会自动生效。" : "扩展已停用。");
  } catch (error) {
    await refresh();
    showToast(`切换扩展状态失败：${localizedError(error)}`, true);
  }
}

async function setBrowserExtensionPinned(id, pinned) {
  try {
    await invoke("extensions.setPinned", { id, pinned });
    await refresh();
    showToast(pinned ? "扩展已固定到地址栏右侧。" : "扩展已从工具栏取消固定。");
  } catch (error) {
    showToast(`更新扩展固定状态失败：${localizedError(error)}`, true);
  }
}

async function openBrowserExtensionAction(id, anchorElement) {
  try {
    const rect = anchorElement?.getBoundingClientRect();
    await invoke("extensions.openAction", {
      id,
      ...(rect ? { anchor: { right: rect.right, bottom: rect.bottom } } : {}),
    });
    $("#extensions-panel").hidden = true;
  } catch (error) {
    showToast(`打开扩展面板失败：${localizedError(error)}`, true);
  }
}

async function runBrowserExtensionAction(event) {
  const button = event.target.closest("[data-extension-action]");
  if (!button) return;
  const id = button.dataset.extensionId;
  try {
    if (button.dataset.extensionAction === "pin") {
      await invoke("extensions.setPinned", { id, pinned: button.dataset.pinned !== "true" });
    } else if (button.dataset.extensionAction === "launch") {
      const rect = button.getBoundingClientRect();
      await invoke("extensions.openAction", { id, anchor: { right: rect.right, bottom: rect.bottom } });
    } else if (button.dataset.extensionAction === "remove") {
      const extension = state.extensions?.find((item) => item.id === id);
      if (!extension || !await confirmAction("移除浏览器扩展", `将停用并从 EgoLite 中移除“${extension.name}”。原始扩展目录不会删除，ZIP 的 EgoLite 解压副本会一并清理。`, "移除")) return;
      await invoke("extensions.remove", { id });
      showToast(`已移除扩展“${extension.name}”`);
    } else if (button.dataset.extensionAction === "reload") {
      await invoke("extensions.reload", { id });
      showToast("扩展已重新加载。");
    } else if (button.dataset.extensionAction === "open") {
      await invoke("extensions.openFolder", { id });
    }
    await refresh();
    switchView("extensions");
  } catch (error) {
    await refresh();
    showToast(`操作浏览器扩展失败：${localizedError(error)}`, true);
  }
}

function collectionAction(iconName, title, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.title = title;
  button.innerHTML = `<i data-lucide="${iconName}"></i>`;
  button.addEventListener("click", action);
  return button;
}

async function openCollectionSource(item) {
  if (!item.sourceUrl) return;
  await ensureQuickTask();
  switchView("start");
  await openNewTab(item.sourceUrl);
}

function openCollectionGroupDialog(item) {
  collectionGroupTarget = [item.id];
  $("#collection-group-name").value = item.group || "";
  const suggestions = $("#collection-group-suggestions");
  suggestions.replaceChildren();
  const groups = [...new Set(state.collections.map((candidate) => candidate.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const group of groups) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = group;
    button.addEventListener("click", () => { $("#collection-group-name").value = group; });
    suggestions.append(button);
  }
  $("#collection-group-dialog").showModal();
  $("#collection-group-name").focus();
  $("#collection-group-name").select();
}

async function saveCollectionGroup(event) {
  event.preventDefault();
  if (!collectionGroupTarget) return;
  await invoke("collection.move", { ids: collectionGroupTarget, group: $("#collection-group-name").value.trim() });
  collectionGroupTarget = null;
  $("#collection-group-dialog").close();
  await refresh();
}

function openBatchCollectionGroupDialog() {
  if (!selectedCollectionIds.size) return;
  collectionGroupTarget = [...selectedCollectionIds];
  $("#collection-group-name").value = "";
  const suggestions = $("#collection-group-suggestions");
  suggestions.replaceChildren();
  for (const group of [...new Set(state.collections.map((item) => item.group).filter(Boolean))].sort((a, b) => a.localeCompare(b))) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = group;
    button.addEventListener("click", () => { $("#collection-group-name").value = group; });
    suggestions.append(button);
  }
  $("#collection-group-dialog").showModal();
  $("#collection-group-name").focus();
}

function toggleAllCollections() {
  const checked = $("#collection-select-all").checked;
  for (const id of visibleCollectionIds) {
    if (checked) selectedCollectionIds.add(id);
    else selectedCollectionIds.delete(id);
  }
  renderCollections();
}

function updateCollectionBatchControls() {
  const visibleSelected = visibleCollectionIds.filter((id) => selectedCollectionIds.has(id)).length;
  const checkbox = $("#collection-select-all");
  checkbox.checked = visibleCollectionIds.length > 0 && visibleSelected === visibleCollectionIds.length;
  checkbox.indeterminate = visibleSelected > 0 && visibleSelected < visibleCollectionIds.length;
  $("#collection-selection-count").textContent = selectedCollectionIds.size ? `已选 ${selectedCollectionIds.size} 项` : "全选当前结果";
  $("#collection-batch-actions").hidden = !selectedCollectionIds.size;
  $("#collection-batch-move").disabled = !selectedCollectionIds.size;
  $("#collection-batch-delete").disabled = !selectedCollectionIds.size;
}

async function deleteSelectedCollections() {
  const ids = [...selectedCollectionIds];
  if (!ids.length) return;
  if (!await confirmAction("删除收藏内容", `确定删除已选择的 ${ids.length} 项收藏吗？此操作无法撤销。`, "删除")) return;
  await invoke("collection.delete", { ids });
  for (const id of ids) {
    selectedCollectionIds.delete(id);
    removeAttachment(`collection-${id}`);
  }
  await refresh();
}

async function deleteCollection(item) {
  if (!await confirmAction("删除收藏内容", `确定删除“${item.pageTitle || item.text || "这条收藏"}”吗？`, "删除")) return;
  await invoke("collection.delete", { id: item.id });
  removeAttachment(`collection-${item.id}`);
  await refresh();
}

function openCollectionEditDialog(item) {
  collectionEditTarget = item;
  $("#collection-edit-title").value = item.pageTitle || "";
  $("#collection-edit-tags").value = (item.tags || []).join(", ");
  $("#collection-edit-text").value = item.text || "";
  $("#collection-edit-dialog").showModal();
  $("#collection-edit-title").focus();
  $("#collection-edit-title").select();
}

async function saveCollectionEdit(event) {
  event.preventDefault();
  if (!collectionEditTarget) return;
  const text = $("#collection-edit-text").value.trim();
  if (!text) {
    $("#collection-edit-text").focus();
    return;
  }
  await invoke("collection.update", {
    id: collectionEditTarget.id,
    pageTitle: $("#collection-edit-title").value.trim(),
    tags: parseCollectionTags($("#collection-edit-tags").value),
    text,
  });
  collectionEditTarget = null;
  $("#collection-edit-dialog").close();
  await refresh();
}

function collectionSortComparator(mode) {
  if (mode === "oldest") return (left, right) => String(left.createdAt).localeCompare(String(right.createdAt));
  if (mode === "title") return (left, right) => String(left.pageTitle || left.text).localeCompare(String(right.pageTitle || right.text), "zh-CN");
  if (mode === "domain") return (left, right) => domainOf(left.sourceUrl || "").localeCompare(domainOf(right.sourceUrl || ""), "zh-CN") || String(left.pageTitle || left.text).localeCompare(String(right.pageTitle || right.text), "zh-CN");
  return (left, right) => String(right.createdAt).localeCompare(String(left.createdAt));
}

function collectionDisplay(item) {
  const legacyHistory = legacyImportedHistory(item);
  if (legacyHistory) {
    return {
      title: item.text || item.sourceUrl || "历史记录",
      body: "",
      source: `${domainOf(item.sourceUrl || "") || "网页"} · ${legacyHistory.browser} · ${legacyHistory.profile} · ${legacyHistory.visits} 次访问`,
    };
  }
  const legacyBookmark = legacyImportedBookmark(item);
  if (legacyBookmark) {
    return {
      title: item.text || item.sourceUrl || "书签",
      body: "",
      source: `${domainOf(item.sourceUrl || "") || "网页"} · ${legacyBookmark.browser} · ${legacyBookmark.folder}`,
    };
  }
  const title = item.pageTitle || item.text || item.sourceUrl || "收藏内容";
  return {
    title,
    body: item.text && item.text.trim() !== title.trim() ? item.text : "",
    source: domainOf(item.sourceUrl || "") || "笔记",
  };
}

function legacyImportedHistory(item) {
  const match = /^(.+?) · (.+?) · History \((\d+) visits\)$/.exec(String(item?.pageTitle || ""));
  return match ? { browser: match[1], profile: match[2], visits: Number(match[3]) || 1 } : null;
}

function legacyImportedBookmark(item) {
  const match = /^(Microsoft Edge|Google Chrome|Brave) · ([^·]+) · (.+)$/.exec(String(item?.pageTitle || ""));
  return match && !match[3].startsWith("History (") ? { browser: match[1], profile: match[2].trim(), folder: match[3] } : null;
}

function formatCollectionDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "保存时间未知" : date.toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function parseCollectionTags(value) {
  return [...new Set(String(value || "").split(/[,，;；\n]/).map((tag) => tag.trim()).filter(Boolean))].slice(0, 30);
}

function openCollectionDuplicates() {
  duplicateCollectionGroups = findDuplicateCollectionGroups(state.collections);
  const dialog = $("#collection-duplicates-dialog");
  const list = $("#collection-duplicates-list");
  list.replaceChildren();
  $("#collection-duplicates-summary").textContent = duplicateCollectionGroups.length
    ? `发现 ${duplicateCollectionGroups.length} 组可能重复的收藏。合并会保留一条主记录，并合并正文和标签。`
    : "没有发现重复收藏。";
  for (const [index, group] of duplicateCollectionGroups.entries()) {
    const row = document.createElement("label");
    row.className = "duplicate-group";
    row.innerHTML = `<input type="checkbox" data-duplicate-index="${index}" checked><div class="duplicate-group-copy"><strong>${escapeHtml(group[0].pageTitle || group[0].sourceUrl || "重复收藏")}</strong><span>${group.length} 条 · ${escapeHtml(group[0].sourceUrl || "相同正文")}</span><div class="duplicate-items">${group.map((item) => `<span>${escapeHtml(item.text.slice(0, 100))}${item.tags?.length ? ` · ${escapeHtml(item.tags.join(", "))}` : ""}</span>`).join("")}</div></div>`;
    list.append(row);
  }
  $("#collection-duplicates-merge").disabled = duplicateCollectionGroups.length === 0;
  dialog.showModal();
}

function findDuplicateCollectionGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const url = canonicalCollectionUrl(item.sourceUrl || "");
    const text = item.text.trim().toLocaleLowerCase().replace(/\s+/g, " ");
    const key = `${item.kind || "legacy"}:${item.folderId || "other"}:${url ? `url:${url}` : `text:${text}`}`;
    if (!key || key === "text:") continue;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function canonicalCollectionUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return "";
    return url.href;
  } catch {
    return "";
  }
}

async function mergeSelectedDuplicates(event) {
  event.preventDefault();
  const indexes = [...document.querySelectorAll("[data-duplicate-index]:checked")].map((input) => Number(input.dataset.duplicateIndex));
  if (!indexes.length) return;
  let removed = 0;
  for (const index of indexes) {
    const group = duplicateCollectionGroups[index];
    if (!group?.length) continue;
    const result = await invoke("collection.merge", { ids: group.map((item) => item.id), primaryId: group[0].id });
    removed += result.removed?.length || 0;
  }
  $("#collection-duplicates-dialog").close();
  selectedCollectionIds.clear();
  await refresh();
  showToast(`已合并 ${indexes.length} 组重复项，移除 ${removed} 条重复记录`);
}

async function importCollectionsFile() {
  const button = $("#import-collections");
  button.disabled = true;
  try {
    const result = await invoke("collection.importFile");
    if (result.canceled) return;
    await refresh();
    showToast(`已导入 ${result.added} 条，跳过 ${result.skipped} 条`);
  } catch (error) {
    showToast(localizedError(error), true);
  } finally {
    button.disabled = false;
  }
}

async function exportCollections() {
  const button = $("#export-collections");
  button.disabled = true;
  try {
    const result = await invoke("collection.export", {
      ...bookmarkLibrary.exportSelection(),
      format: $("#collection-export-format").value,
    });
    button.title = result.canceled ? "导出已取消" : `已导出 ${result.count} 条`;
  } catch (error) {
    button.title = error.message;
  } finally {
    button.disabled = false;
  }
}

function renderRecentTabs() {
  const list = $("#recent-tabs");
  list.replaceChildren();
  const tabs = (activeTaskId ? recentTabsForTask(activeTaskId) : state.tabs)
    .filter((tab) => !isStartPageUrl(tab.url))
    .slice(0, 4);
  for (const tab of tabs) {
    const button = document.createElement("button");
    button.className = "recent-tab";
    button.type = "button";
    button.textContent = recentTabLabel(tab);
    button.title = tab.url;
    button.addEventListener("click", () => showTab(tab));
    list.append(button);
  }
}

function automaticTabForTask(tabs) {
  return tabs.find((item) => item.active && !item.sleeping)
    || tabs.find((item) => !item.sleeping && !isStartPageUrl(item.url))
    || tabs.find((item) => !item.sleeping);
}

function restoreInitialBrowserTab() {
  const selectedView = $(".view.active");
  if (selectedView && selectedView.id !== "start-view") return;
  if (cosWorkspace.owns(state.spaces.find(task => task.taskId === activeTaskId))) {
    void showCosHome(false);
    return;
  }
  const tabs = tabsForTask(activeTaskId);
  const tab = automaticTabForTask(tabs);
  if (tab) showTab(tab, !tab.active);
  else showWelcome();
}

function renderBrowserTabs() {
  syncWindowTitle();
  const list = $("#browser-tab-list");
  const newTabButton = $("#titlebar-new-tab");
  list.replaceChildren();
  cosWorkspace.appendHomeTab(list);
  const taskTabs = tabsForTask(activeTaskId);
  const allTabCount = state.tabs.length;
  $("#titlebar-tab-count").textContent = allTabCount ? (allTabCount > 99 ? "99+" : String(allTabCount)) : "";
  const companionMode = state.backend?.kind === "companion";
  newTabButton.disabled = companionMode;
  newTabButton.title = companionMode
    ? "请在 Edge 或 Chrome 中新建标签，然后在 Companion 内授权"
    : "新建标签页（Ctrl+T）";
  const tabManager = $("#manage-browser-tabs");
  tabManager.disabled = companionMode;
  tabManager.title = companionMode
    ? "外部浏览器标签不支持批量管理"
    : tabManagementMode ? `退出批量管理（${taskTabs.length} 个标签）` : `查看全部 ${allTabCount} 个标签`;
  tabManager.setAttribute("aria-label", tabManager.title);
  tabManager.classList.toggle("active", tabManagementMode || !$("#tab-overview").hidden);
  tabManager.setAttribute("aria-pressed", String(tabManagementMode || !$("#tab-overview").hidden));
  tabManager.setAttribute("aria-expanded", String(!$("#tab-overview").hidden));
  for (const id of [...selectedTabIds]) if (!taskTabs.some((tab) => tab.targetId === id)) selectedTabIds.delete(id);
  if (!taskTabs.length && !companionMode && !cosWorkspace.owns(state.spaces.find(task => task.taskId === activeTaskId))) {
    const placeholder = document.createElement("div");
    placeholder.className = "browser-tab browser-tab-placeholder active";
    placeholder.setAttribute("role", "tab");
    placeholder.setAttribute("aria-selected", "true");
    placeholder.tabIndex = 0;
    placeholder.innerHTML = '<i class="browser-tab-fallback" data-lucide="file"></i><span class="browser-tab-title">新建标签页</span>';
    placeholder.addEventListener("click", () => $("#omnibox").focus());
    placeholder.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      $("#omnibox").focus();
    });
    list.append(placeholder);
  }
  const renderedGroups = new Set();
  for (const tab of taskTabs) {
    if (tab.groupId && !renderedGroups.has(tab.groupId)) {
      renderedGroups.add(tab.groupId);
      const groupTabs = taskTabs.filter((item) => item.groupId === tab.groupId);
      list.append(createTabGroupChip(tab, groupTabs));
    }
    if (tab.groupId && isTabGroupCollapsed(tab.taskId || activeTaskId, tab.groupId)) continue;
    const button = document.createElement("div");
    button.className = `browser-tab ${currentTab?.targetId === tab.targetId ? "active" : ""} ${tab.pinned ? "pinned" : ""} ${tab.sleeping ? "sleeping" : ""} ${tab.groupId ? "grouped" : ""} ${selectedTabIds.has(tab.targetId) ? "selected" : ""}`;
    button.dataset.targetId = tab.targetId;
    button.title = `${browserTabTitle(tab)}\n${isStartPageUrl(tab.url) ? "ego://start" : tab.url}${tab.sleeping ? "\n已休眠，点击后重新加载" : ""}${tab.groupTitle ? `\n标签组：${tab.groupTitle}` : ""}`;
    if (tab.groupId) button.style.setProperty("--tab-group-color", safeTabGroupColor(tab.groupColor));
    button.tabIndex = 0;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", currentTab?.targetId === tab.targetId ? "true" : "false");
    button.draggable = !tabManagementMode;
    const leading = tab.faviconUrl
      ? `<img class="browser-tab-favicon" src="${escapeAttribute(tab.faviconUrl)}" alt="">`
      : `<i class="browser-tab-fallback" data-lucide="${tab.sleeping ? "moon" : tab.pinned ? "pin" : "globe-2"}"></i>`;
    const groupMark = tab.groupId ? '<span class="browser-tab-group-mark" aria-hidden="true"></span>' : "";
    const muted = tab.muted ? '<i class="browser-tab-muted" data-lucide="volume-x"></i>' : "";
    const checkbox = tabManagementMode ? `<input class="browser-tab-checkbox" type="checkbox" title="选择标签" ${selectedTabIds.has(tab.targetId) ? "checked" : ""}>` : "";
    const close = tabManagementMode ? "" : '<span class="browser-tab-close" title="关闭标签"><i data-lucide="x"></i></span>';
    button.innerHTML = `${checkbox}${groupMark}${leading}<span class="browser-tab-title">${escapeHtml(browserTabTitle(tab))}</span>${muted}${close}`;
    button.addEventListener("click", (event) => {
      if (tabManagementMode) {
        if (!event.target.closest(".browser-tab-checkbox")) toggleTabSelection(tab.targetId);
        return;
      }
      showTab(tab);
    });
    button.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      if (tabManagementMode) toggleTabSelection(tab.targetId);
      else showTab(tab);
    });
    button.querySelector(".browser-tab-checkbox")?.addEventListener("change", (event) => {
      if (event.currentTarget.checked) selectedTabIds.add(tab.targetId);
      else selectedTabIds.delete(tab.targetId);
      updateTabBatchControls();
      button.classList.toggle("selected", event.currentTarget.checked);
    });
    button.addEventListener("contextmenu", (event) => openTabContextMenu(event, tab));
    button.addEventListener("pointerenter", () => scheduleTabPreview(button, tab));
    button.addEventListener("pointerleave", scheduleTabPreviewHide);
    button.addEventListener("auxclick", (event) => {
      if (event.button !== 1 || tabManagementMode) return;
      event.preventDefault();
      void closeBrowserTab(tab);
    });
    button.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/x-ego-tab", tab.targetId);
    });
    button.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; });
    button.addEventListener("drop", (event) => { event.preventDefault(); void reorderTab(event.dataTransfer.getData("text/x-ego-tab"), tab.targetId); });
    button.querySelector(".browser-tab-close")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      await closeBrowserTab(tab);
    });
    list.append(button);
  }
  window.lucide.createIcons({ root: list });
  updateTabBatchControls();
  requestAnimationFrame(() => {
    const active = list.querySelector(".browser-tab.active, .browser-tab-group-chip.active");
    if (!active) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
  });
  if (!$("#tab-overview").hidden) renderTabOverview();

  // WebView 的生命周期由显式的 tab.close/tab.sleep 主机请求管理。
  // state 是 Broker 的异步快照，可能暂时看不到刚由桌面自动化创建的后台标签。
  // 不能因为一次快照缺行就移除 WebView，否则会把仍在使用的 CDP target 关闭。
}

function createTabGroupChip(groupTab, groupTabs) {
  const collapsed = isTabGroupCollapsed(groupTab.taskId || activeTaskId, groupTab.groupId);
  const currentInGroup = groupTabs.some((tab) => tab.targetId === currentTab?.targetId);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `browser-tab-group-chip ${collapsed ? "collapsed" : "expanded"} ${currentInGroup ? "active" : ""}`;
  button.style.setProperty("--tab-group-color", safeTabGroupColor(groupTab.groupColor));
  button.title = `${collapsed ? "展开" : "折叠"}“${groupTab.groupTitle || "标签组"}”`;
  button.setAttribute("aria-expanded", String(!collapsed));
  button.innerHTML = `<span class="browser-tab-group-dot"></span><span class="browser-tab-group-title">${escapeHtml(groupTab.groupTitle || "标签组")}</span><span class="browser-tab-group-count">${groupTabs.length}</span><i data-lucide="${collapsed ? "chevron-right" : "chevron-left"}"></i>`;
  button.addEventListener("click", () => toggleTabGroupCollapsed(groupTab.taskId || activeTaskId, groupTab.groupId));
  button.addEventListener("contextmenu", (event) => openTabContextMenu(event, groupTab, true));
  return button;
}

function toggleTabOverview() {
  if (tabManagementMode) {
    toggleTabManagement();
    return;
  }
  if (!$("#tab-overview").hidden) {
    closeTabOverview();
    return;
  }
  closeWorkspaceSidebar();
  closeBrowserMoreMenu();
  $("#downloads-panel").hidden = true;
  $("#history-panel").hidden = true;
  $("#extensions-panel").hidden = true;
  $("#tab-overview").hidden = false;
  $("#manage-browser-tabs").classList.add("active");
  $("#manage-browser-tabs").setAttribute("aria-pressed", "true");
  $("#manage-browser-tabs").setAttribute("aria-expanded", "true");
  renderTabOverview();
  positionTabOverview();
  queueMicrotask(() => {
    $("#tab-overview-query").focus();
    $("#tab-overview-query").select();
  });
}

function closeTabOverview() {
  const panel = $("#tab-overview");
  if (panel.hidden) return;
  panel.hidden = true;
  $("#manage-browser-tabs").classList.toggle("active", tabManagementMode);
  $("#manage-browser-tabs").setAttribute("aria-pressed", String(tabManagementMode));
  $("#manage-browser-tabs").setAttribute("aria-expanded", "false");
}

function positionTabOverview() {
  const panel = $("#tab-overview");
  if (panel.hidden) return;
  const anchor = $("#manage-browser-tabs").getBoundingClientRect();
  const titlebarBottom = $(".titlebar")?.getBoundingClientRect().bottom || 54;
  const workspace = $(".workspace")?.getBoundingClientRect();
  const leftBoundary = Math.max(10, workspace?.left ?? 10);
  const rightBoundary = Math.min(innerWidth - 10, workspace?.right ?? innerWidth - 10);
  const width = Math.min(410, Math.max(280, rightBoundary - leftBoundary - 20));
  panel.style.width = `${width}px`;
  panel.style.left = `${Math.max(leftBoundary + 10, Math.min(rightBoundary - width - 10, anchor.right - width))}px`;
  panel.style.top = `${Math.max(titlebarBottom + 6, anchor.bottom + 6)}px`;
}

function renderTabOverview() {
  const list = $("#tab-overview-list");
  const query = $("#tab-overview-query").value.trim().toLocaleLowerCase();
  $(".tab-overview-search").classList.toggle("has-value", Boolean(query));
  const liveIds = new Set(state.tabs.map((tab) => tab.targetId));
  recentTabIds = recentTabIds.filter((id) => liveIds.has(id));
  persistRecentTabIds();
  const recentRank = new Map(recentTabIds.map((id, index) => [id, index]));
  const duplicateGroups = duplicateTabGroups(state.tabs);
  const duplicateIds = new Set(duplicateGroups.flatMap((group) => group.tabs.map((tab) => tab.targetId)));
  let tabs = [...state.tabs];
  if (tabOverviewMode === "recent") tabs.sort((left, right) => (recentRank.get(left.targetId) ?? 1e9) - (recentRank.get(right.targetId) ?? 1e9));
  else tabs.sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || (recentRank.get(left.targetId) ?? 1e9) - (recentRank.get(right.targetId) ?? 1e9));
  if (tabOverviewMode === "pinned") tabs = tabs.filter((tab) => tab.pinned);
  if (tabOverviewMode === "duplicates") tabs = tabs.filter((tab) => duplicateIds.has(tab.targetId));
  if (query) tabs = tabs.filter((tab) => {
    const task = state.spaces.find((item) => item.taskId === tab.taskId);
    return [tab.title, tab.url, domainOf(tab.url || ""), task?.name].some((value) => String(value || "").toLocaleLowerCase().includes(query));
  });

  for (const button of document.querySelectorAll("[data-tab-overview-mode]")) {
    button.classList.toggle("active", button.dataset.tabOverviewMode === tabOverviewMode);
    button.setAttribute("aria-selected", String(button.dataset.tabOverviewMode === tabOverviewMode));
  }
  const isFiltered = Boolean(query) || tabOverviewMode !== "all";
  $("#tab-overview-summary").textContent = `${isFiltered ? `${tabs.length} / ` : ""}${state.tabs.length} 个标签 · ${state.spaces.length} 个工作空间`;
  $("#tab-overview-close-duplicates").hidden = duplicateTabsToClose().length === 0;
  list.replaceChildren();
  if (!tabs.length) {
    const emptyTitle = query ? "没有匹配的标签"
      : tabOverviewMode === "pinned" ? "还没有固定标签"
        : tabOverviewMode === "duplicates" ? "没有重复标签"
          : "没有打开的标签";
    const emptyDetail = query ? "换个标题、网址或工作空间名称试试"
      : tabOverviewMode === "duplicates" ? "相同地址的页面会集中显示在这里"
        : "新建标签后会显示在这里";
    list.innerHTML = `<div class="tab-overview-empty"><i data-lucide="${tabOverviewMode === "duplicates" ? "copy-check" : "search-x"}"></i><strong>${emptyTitle}</strong><span>${emptyDetail}</span></div>`;
    window.lucide.createIcons({ root: list });
    return;
  }

  if (tabOverviewMode === "duplicates") {
    for (const group of duplicateGroups) {
      const visible = group.tabs.filter((tab) => tabs.some((candidate) => candidate.targetId === tab.targetId));
      if (visible.length) appendTabOverviewSection(list, duplicateGroupTitle(group.key, visible[0]), visible);
    }
  } else if (tabOverviewMode === "recent") {
    appendTabOverviewSection(list, "最近使用", tabs);
  } else {
    for (const task of state.spaces) {
      const taskTabs = tabs.filter((tab) => tab.taskId === task.taskId);
      if (taskTabs.length) appendTabOverviewSection(list, task.name, taskTabs);
    }
    const unassigned = tabs.filter((tab) => !state.spaces.some((task) => task.taskId === tab.taskId));
    if (unassigned.length) appendTabOverviewSection(list, "其他标签", unassigned);
  }
  window.lucide.createIcons({ root: list });
}

function appendTabOverviewSection(list, title, tabs) {
  const section = document.createElement("section");
  section.className = "tab-overview-section";
  section.innerHTML = `<div class="tab-overview-section-head"><strong>${escapeHtml(title)}</strong><span>${tabs.length}</span></div>`;
  for (const tab of tabs) {
    const row = document.createElement("div");
    const task = state.spaces.find((item) => item.taskId === tab.taskId);
    const favicon = tab.faviconUrl
      ? `<img class="tab-overview-favicon" src="${escapeAttribute(tab.faviconUrl)}" alt="">`
      : `<span class="tab-overview-favicon fallback"><i data-lucide="globe-2"></i></span>`;
    row.className = `tab-overview-row ${tab.targetId === currentTab?.targetId ? "active" : ""}`;
    row.dataset.tabOverviewTarget = tab.targetId;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `切换到 ${tab.title || tab.url || "新标签页"}`);
    const groupBadge = tab.groupId ? `<span class="tab-overview-group" style="--tab-group-color:${safeTabGroupColor(tab.groupColor)}">${escapeHtml(tab.groupTitle || "标签组")}</span>` : "";
    row.innerHTML = `${favicon}<span class="tab-overview-copy"><strong>${escapeHtml(tab.title || tab.url || "新标签页")}</strong><span>${escapeHtml(domainOf(tab.url || "") || "本地页面")}${task ? ` · ${escapeHtml(task.name)}` : ""}${groupBadge}</span></span><span class="tab-overview-flags">${tab.sleeping ? '<i data-lucide="moon"></i>' : ""}${tab.pinned ? '<i data-lucide="pin"></i>' : ""}${tab.muted ? '<i data-lucide="volume-x"></i>' : ""}</span><button class="tab-overview-row-close" type="button" data-tab-overview-close="${escapeAttribute(tab.targetId)}" title="关闭标签" aria-label="关闭标签"><i data-lucide="x"></i></button>`;
    section.append(row);
  }
  list.append(section);
}

function handleTabOverviewClick(event) {
  const closeButton = event.target.closest("[data-tab-overview-close]");
  if (closeButton) {
    event.stopPropagation();
    void closeTabFromOverview(closeButton.dataset.tabOverviewClose);
    return;
  }
  const row = event.target.closest("[data-tab-overview-target]");
  if (row) void activateTabFromOverview(row.dataset.tabOverviewTarget);
}

function handleTabOverviewAuxClick(event) {
  if (event.button !== 1) return;
  const row = event.target.closest("[data-tab-overview-target]");
  if (!row) return;
  event.preventDefault();
  void closeTabFromOverview(row.dataset.tabOverviewTarget);
}

function handleTabOverviewKeydown(event) {
  const row = event.target.closest("[data-tab-overview-target]");
  if (!row) return;
  if (["Enter", " "].includes(event.key)) {
    event.preventDefault();
    void activateTabFromOverview(row.dataset.tabOverviewTarget);
  } else if (event.key === "Delete") {
    event.preventDefault();
    void closeTabFromOverview(row.dataset.tabOverviewTarget);
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const rows = [...$("#tab-overview-list").querySelectorAll("[data-tab-overview-target]")];
    const index = rows.indexOf(row);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? rows.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows[nextIndex]?.focus();
  }
}

function handleTabOverviewSearchKeydown(event) {
  if (event.key === "Escape" && event.currentTarget.value) {
    event.preventDefault();
    event.stopPropagation();
    clearTabOverviewQuery();
    return;
  }
  if (!["ArrowDown", "Enter"].includes(event.key)) return;
  const first = $("#tab-overview-list").querySelector("[data-tab-overview-target]");
  if (!first) return;
  event.preventDefault();
  if (event.key === "Enter") void activateTabFromOverview(first.dataset.tabOverviewTarget);
  else first.focus();
}

function clearTabOverviewQuery() {
  const input = $("#tab-overview-query");
  input.value = "";
  renderTabOverview();
  input.focus();
}

async function activateTabFromOverview(targetId) {
  const tab = state.tabs.find((item) => item.targetId === targetId);
  if (!tab) return;
  if (tab.taskId !== activeTaskId) {
    const task = state.spaces.find((item) => item.taskId === tab.taskId);
    if (!task || !await activateTaskById(task.id, { quiet: true })) return;
  }
  const fresh = state.tabs.find((item) => item.targetId === targetId);
  if (fresh) showTab(fresh);
  closeTabOverview();
}

async function closeTabFromOverview(targetId) {
  const tab = state.tabs.find((item) => item.targetId === targetId);
  if (!tab) return;
  try {
    if (tab.taskId === activeTaskId) await closeBrowserTab(tab);
    else {
      await invoke("tab.close", { targetId });
      const closed = rememberClosedTab(tab);
      persistClosedTabs();
      renderHistory();
      removeWebview(targetId);
      recentTabIds = recentTabIds.filter((id) => id !== targetId);
      persistRecentTabIds();
      await refresh();
      showClosedTabsUndo([closed.id]);
    }
    if (!$("#tab-overview").hidden) renderTabOverview();
  } catch (error) {
    showToast(`关闭标签失败：${localizedError(error)}`, true);
  }
}

function toggleTabManagement() {
  tabManagementMode = !tabManagementMode;
  closeTabOverview();
  if (!tabManagementMode) selectedTabIds.clear();
  $(".browser-surface").classList.toggle("tab-management", tabManagementMode);
  $("#tab-batchbar").hidden = !tabManagementMode;
  $("#manage-browser-tabs").classList.toggle("active", tabManagementMode);
  $("#manage-browser-tabs").setAttribute("aria-pressed", String(tabManagementMode));
  $("#manage-browser-tabs").title = tabManagementMode ? "退出批量管理" : "批量管理标签";
  renderBrowserTabs();
}

function toggleTabSelection(targetId) {
  if (selectedTabIds.has(targetId)) selectedTabIds.delete(targetId);
  else selectedTabIds.add(targetId);
  renderBrowserTabs();
}

function toggleAllBrowserTabs() {
  const tabs = tabsForTask(activeTaskId);
  if ($("#tab-select-all").checked) for (const tab of tabs) selectedTabIds.add(tab.targetId);
  else for (const tab of tabs) selectedTabIds.delete(tab.targetId);
  renderBrowserTabs();
}

function updateTabBatchControls() {
  const tabs = tabsForTask(activeTaskId);
  const selected = tabs.filter((tab) => selectedTabIds.has(tab.targetId));
  const checkbox = $("#tab-select-all");
  checkbox.checked = tabs.length > 0 && selected.length === tabs.length;
  checkbox.indeterminate = selected.length > 0 && selected.length < tabs.length;
  $("#tab-selection-count").textContent = selected.length ? `已选 ${selected.length} 项` : "选择全部";
  for (const selector of ["#tab-batch-pin", "#tab-batch-mute", "#tab-batch-close"]) $(selector).disabled = selected.length === 0;
  const shouldPin = selected.some((tab) => !tab.pinned);
  const shouldMute = selected.some((tab) => !tab.muted);
  $("#tab-batch-pin span").textContent = shouldPin ? "固定" : "取消固定";
  $("#tab-batch-mute span").textContent = shouldMute ? "静音" : "取消静音";
}

async function batchUpdateTabs(property) {
  const tabs = tabsForTask(activeTaskId).filter((tab) => selectedTabIds.has(tab.targetId));
  if (!tabs.length) return;
  const value = tabs.some((tab) => !tab[property]);
  const failures = [];
  const controls = ["#tab-batch-pin", "#tab-batch-mute", "#tab-batch-close"].map($);
  for (const control of controls) control.disabled = true;
  document.body.dataset.lastBatchUpdate = `${property}:running`;
  try {
    for (const tab of tabs) {
      const previous = tab[property] === true;
      tab[property] = value;
      let webContentsId = 0;
      try { webContentsId = webviews.get(tab.targetId)?.getWebContentsId() || 0; } catch {}
      try {
        await queueTabPreferences(tab.targetId, { webContentsId, [property]: value });
      } catch (error) {
        failures.push(tab.title || tab.url);
        tab[property] = previous;
        const stateTab = state.tabs.find((item) => item.targetId === tab.targetId);
        if (stateTab) stateTab[property] = previous;
      }
    }
    document.body.dataset.lastBatchUpdate = `${property}:${failures.length ? "partial" : "success"}`;
    renderBrowserTabs();
    showToast(failures.length ? `${property === "pinned" ? "固定" : "静音"}完成，${failures.length} 个标签失败` : `已${value ? "批量设置" : "批量取消"}${property === "pinned" ? "固定" : "静音"}`, failures.length > 0);
  } finally {
    updateTabBatchControls();
  }
}

async function batchCloseTabs() {
  const tabs = tabsForTask(activeTaskId).filter((tab) => selectedTabIds.has(tab.targetId));
  if (!tabs.length) return;
  if (!await confirmAction("关闭多个标签页", `确定关闭已选择的 ${tabs.length} 个标签页吗？`, "关闭所选")) return;
  const button = $("#tab-batch-close");
  button.disabled = true;
  document.body.dataset.lastBatchClose = "running";
  try {
    await closeBrowserTabs(tabs);
    document.body.dataset.lastBatchClose = "success";
  } catch (error) {
    document.body.dataset.lastBatchClose = `error:${error instanceof Error ? error.message : String(error)}`;
    showToast(`关闭标签页失败：${localizedError(error)}`, true);
  } finally {
    updateTabBatchControls();
  }
}

async function createTask(event) {
  event.preventDefault();
  const name = $("#task-name").value.trim();
  if (!name) return;
  const task = await invoke("task.create", { name, profileId: $("#task-profile").value || "default" });
  fileAttachments.clear();
  activeTaskId = task.taskId;
  $("#task-name").value = "";
  $("#task-dialog").close();
  showWelcome();
  await refresh();
}

function openTaskDialog() {
  syncTaskProfileOptions();
  $("#task-dialog").showModal();
  queueMicrotask(() => $("#task-name").focus());
}

function closeTaskDialog() {
  $("#task-dialog").close();
}

async function openAddress(event) {
  event.preventDefault();
  const input = $("#omnibox").value.trim();
  if (input) await openNewTab(input);
}

async function navigateCurrentTab(event) {
  event.preventDefault();
  const input = $("#current-address").value.trim();
  if (!input) return;
  if (!currentTab) {
    await openNewTab(input);
    return;
  }
  try {
    const url = normalizedInputUrl(input);
    if (isStartPageUrl(currentTab.url)) {
      currentTab.url = url;
      const stateTab = state.tabs.find((item) => item.targetId === currentTab.targetId);
      if (stateTab) stateTab.url = url;
      const webview = ensureWebview(currentTab);
      showTab(currentTab, false);
      try {
        if (webview.getURL() !== url) await webview.loadURL(url);
      } catch (error) {
        showToast(localizedError(error), true);
        return;
      }
      await registerWebview(webview);
      renderBrowserTabs();
    } else {
      activeWebview()?.loadURL(url);
    }
    $("#current-address").blur();
  } catch (error) {
    showToast(localizedError(error), true);
  }
}

async function openNewTab(url, selectedTask, options = {}) {
  if (state.backend?.kind === "companion") {
    switchView("settings");
    showToast("请在 Edge 或 Chrome 中打开标签，并通过 Companion 扩展授权给当前任务。");
    return;
  }
  const task = selectedTask || state.spaces.find((item) => item.taskId === activeTaskId) || state.spaces[0];
  if (!task) {
    openTaskDialog();
    return;
  }
  if (!options.allowDuplicate && tabBehaviorPreferences.duplicateOpenBehavior === "reuse") {
    let duplicateKey = "";
    try { duplicateKey = normalizedDuplicateUrl(normalizedInputUrl(url)); } catch {}
    const existing = duplicateKey
      ? state.tabs.find((tab) => tab.taskId === task.taskId && normalizedDuplicateUrl(tab.url) === duplicateKey)
      : null;
    if (existing) {
      await focusExistingTab(existing);
      showActionToast("这个页面已经打开，已切换到现有标签", "仍然新建", () => openNewTab(url, task, { allowDuplicate: true }));
      return existing;
    }
  }
  const tab = await invoke("tab.open", { url, taskId: task.taskId, visual: true });
  if (activeTaskId !== task.taskId) fileAttachments.clear();
  activeTaskId = task.taskId;
  await refresh();
  await showTab(state.tabs.find((item) => item.targetId === tab.targetId) || tab);
  return tab;
}

async function focusExistingTab(tab) {
  if (tab.taskId !== activeTaskId) {
    const task = state.spaces.find((item) => item.taskId === tab.taskId);
    if (task) await activateTaskById(task.id, { quiet: true });
  }
  switchView("start");
  const fresh = state.tabs.find((item) => item.targetId === tab.targetId) || tab;
  await showTab(fresh);
}

async function openBlankTab() {
  const button = $("#titlebar-new-tab");
  button.disabled = true;
  try {
    const tab = await openNewTab("about:blank", undefined, { allowDuplicate: true });
    if (tab) focusOmnibox();
  } catch (error) {
    showToast(localizedError(error), true);
  } finally {
    button.disabled = state.backend?.kind === "companion";
  }
}

function focusOmnibox() {
  switchView("start");
  const input = currentTab && !isStartPageUrl(currentTab.url) ? $("#current-address") : $("#omnibox");
  input.focus();
  input.select();
}

async function runBrowserCommand(command) {
  if (!command) return;
  if (command === "element-context-copied") return showToast("元素信息已复制，可以粘贴给 Agent");
  if (["toggle-devtools", "inspect-element", "copy-element-context"].includes(command)) {
    closeBrowserMoreMenu();
    const webview = activeWebview();
    if (state.backend?.kind === "companion") return showToast("请使用当前浏览器的开发者工具");
    if (!webview || webview.hidden) return showToast("请先打开一个网页");
    const method = {
      "toggle-devtools": "browser.devtools.toggle",
      "inspect-element": "browser.devtools.inspect",
      "copy-element-context": "browser.devtools.copy",
    }[command];
    try {
      await invoke(method, { targetId: webview.dataset.targetId, webContentsId: webview.getWebContentsId() });
    } catch (error) { showToast(localizedError(error), true); }
    return;
  }
  if (command === "new-tab") return openBlankTab();
  if (command === "restore-tab") return reopenClosedTab();
  if (command === "close-tab") {
    if (currentTab) await closeBrowserTab(currentTab);
    return;
  }
  if (command === "close-window") return invoke("shell.closeWindow");
  if (command === "toggle-fullscreen") return invoke("shell.toggleFullscreen");
  if (command === "focus-address") return focusOmnibox();
  if (command === "next-recent-tab") return cycleBrowserTab(1);
  if (command === "previous-recent-tab") return cycleBrowserTab(-1);
  if (command === "next-tab") return cycleBrowserTabInOrder(1);
  if (command === "previous-tab") return cycleBrowserTabInOrder(-1);
  if (command === "move-tab-left") return moveCurrentTabInOrder(-1);
  if (command === "move-tab-right") return moveCurrentTabInOrder(1);
  if (command.startsWith("activate-tab-")) return activateTabByNumber(Number(command.slice(-1)));
  if (command === "tab-overview") return toggleTabOverview();
  if (command === "back") {
    const webview = activeWebview();
    if (webview?.canGoBack()) webview.goBack();
    return;
  }
  if (command === "forward") {
    const webview = activeWebview();
    if (webview?.canGoForward()) webview.goForward();
    return;
  }
  if (command === "reload") return reloadCurrentPage();
  if (command === "reload-bypass-cache") return reloadCurrentPage(true);
  if (command === "find") return openFindBar();
  if (command === "find-next" || command === "find-previous") {
    if ($("#find-bar").hidden) openFindBar();
    else findInPage(command === "find-next", true);
    return;
  }
  if (command === "print") return printCurrentPage();
  if (command === "history") return openHistoryPanel();
  if (command === "downloads") return openDownloadsPanel();
  if (command === "bookmark") return saveCurrentAddress();
  if (command === "favorites") return bookmarkLibrary.togglePanel();
  if (command === "toggle-favorites-bar") return bookmarkLibrary.toggleBar();
  if (command === "zoom-in") return changeZoom(0.1);
  if (command === "zoom-out") return changeZoom(-0.1);
  if (command === "zoom-reset") return changeZoom(0, true);
}

function cycleBrowserTab(direction) {
  const tabs = recentTabsForTask(activeTaskId);
  if (tabs.length < 2) return;
  const index = Math.max(0, tabs.findIndex((tab) => tab.targetId === currentTab?.targetId));
  const next = tabs[(index + direction + tabs.length) % tabs.length];
  showTab(next);
  showRecentTabSwitcher(next.targetId);
}

function cycleBrowserTabInOrder(direction) {
  const tabs = tabsForTask(activeTaskId);
  if (tabs.length < 2) return;
  const index = Math.max(0, tabs.findIndex((tab) => tab.targetId === currentTab?.targetId));
  showTab(tabs[(index + direction + tabs.length) % tabs.length]);
}

async function moveCurrentTabInOrder(direction) {
  if (!currentTab) return;
  const tabs = tabsForTask(activeTaskId);
  const peers = tabs.filter((tab) => Boolean(tab.pinned) === Boolean(currentTab.pinned));
  const peerIndex = peers.findIndex((tab) => tab.targetId === currentTab.targetId);
  const swapTarget = peers[peerIndex + direction];
  if (peerIndex < 0 || !swapTarget) return;
  const sourceIndex = tabs.findIndex((tab) => tab.targetId === currentTab.targetId);
  const targetIndex = tabs.findIndex((tab) => tab.targetId === swapTarget.targetId);
  [tabs[sourceIndex], tabs[targetIndex]] = [tabs[targetIndex], tabs[sourceIndex]];
  tabs.forEach((tab, index) => { tab.order = index; });
  await invoke("tab.reorder", { taskId: activeTaskId, targetIds: tabs.map((tab) => tab.targetId) });
  renderBrowserTabs();
}

function activateTabByNumber(number) {
  const tabs = tabsForTask(activeTaskId);
  if (!tabs.length) return;
  const tab = number === 9 ? tabs.at(-1) : tabs[number - 1];
  if (tab) showTab(tab);
}

async function reopenClosedTab(index = closedTabs.length - 1) {
  const [closed] = closedTabs.splice(index, 1);
  if (!closed) return;
  persistClosedTabs();
  renderHistory();
  const task = state.spaces.find((item) => item.taskId === closed.taskId)
    || state.spaces.find((item) => item.taskId === activeTaskId)
    || state.spaces[0];
  if (!task) return;
  const tab = await invoke("tab.open", { url: closed.url || "about:blank", taskId: task.taskId });
  activeTaskId = task.taskId;
  await refresh();
  const restored = state.tabs.find((item) => item.targetId === tab.targetId) || tab;
  if (closed.pinned || closed.muted || Number(closed.zoomFactor) !== 1) {
    await queueTabPreferences(restored.targetId, {
      pinned: closed.pinned === true,
      muted: closed.muted === true,
      zoomFactor: Number(closed.zoomFactor || 1),
    }).catch(() => null);
    await refresh();
  }
  showTab(state.tabs.find((item) => item.targetId === restored.targetId) || restored);
}

function queueVisualTabActivation(targetId, notifyBroker) {
  if (!notifyBroker) return Promise.resolve();
  const selectionRevision = tabSelectionRevision;
  const activation = visualTabActivationTail
    .catch(() => null)
    .then(() => currentTab?.targetId === targetId && selectionRevision === tabSelectionRevision
      ? invoke("tab.activate", { targetId, visual: true, selectionRevision }) : undefined);
  visualTabActivationTail = activation.catch(() => null);
  return activation.catch(() => null);
}

function queueVisualTaskMutation(operation) {
  const queued = visualTaskMutationTail
    .catch(() => null)
    .then(operation);
  visualTaskMutationTail = queued.catch(() => null);
  return queued;
}

function showTab(tab, notifyBroker = true, shouldRender = true) {
  if (!tab?.targetId) return Promise.resolve();
  cosWorkspace.hide();
  tabSelectionRevision += 1;
  hideTabPreview();
  currentTab = state.tabs.find((item) => item.targetId === tab.targetId) || tab;
  translation.pageChanged();
  retainPendingTabPreferences(currentTab);
  currentTab.sleeping = false;
  syncWindowTitle();
  currentTab.lastActiveAt = new Date().toISOString();
  tabActivityTimes.set(currentTab.targetId, Date.now());
  const stateTab = state.tabs.find((item) => item.targetId === currentTab.targetId);
  if (stateTab) {
    stateTab.sleeping = false;
    stateTab.lastActiveAt = currentTab.lastActiveAt;
  }
  if (notifyBroker) void queueTabPreferences(currentTab.targetId, {
    sleeping: false,
    lastActiveAt: currentTab.lastActiveAt,
  }).catch(() => null);
  rememberRecentTab(currentTab.targetId);
  if (state.backend?.kind === "companion") {
    $(".browser-surface").classList.add("empty-state");
    $("#start-view").classList.remove("has-browser-page");
    for (const candidate of webviews.values()) setWebviewVisibility(candidate, false);
    $("#webview-stack").hidden = true;
    $("#welcome").hidden = false;
    $("#welcome h2").textContent = "浏览器伴侣正在使用外部标签";
    $("#welcome p").textContent = "页面保留在 Edge 或 Chrome 中。请在扩展内授权当前标签，再让 Codex 在该任务中继续操作。";
    $("#current-address").value = currentTab.url || "外部浏览器标签";
    $("#omnibox").value = "";
    updateZoomLabel(1);
    closeFindBar();
    $("#crash-panel").hidden = true;
    if (shouldRender) renderBrowserTabs();
    updateBrowserToolbar();
    return queueVisualTabActivation(currentTab.targetId, notifyBroker);
  }
  if (isStartPageUrl(currentTab.url)) {
    $(".browser-surface").classList.add("empty-state");
    $("#start-view").classList.remove("has-browser-page");
    for (const candidate of webviews.values()) setWebviewVisibility(candidate, false);
    $("#webview-stack").hidden = true;
    $("#welcome").hidden = false;
    $("#current-address").value = "ego://start";
    $("#omnibox").value = "";
    updateZoomLabel(1);
    closeFindBar();
    $("#crash-panel").hidden = true;
    if (shouldRender) renderBrowserTabs();
    updateBrowserToolbar();
    return queueVisualTabActivation(currentTab.targetId, notifyBroker);
  }
  $(".browser-surface").classList.remove("empty-state");
  $("#start-view").classList.add("has-browser-page");
  $("#welcome").hidden = true;
  $("#webview-stack").hidden = false;
  const webview = ensureWebview(currentTab, { background: false });
  for (const candidate of webviews.values()) setWebviewVisibility(candidate, candidate === webview);
  setWebviewVisibility(webview, true);
  const zoomFactor = Number(currentTab.zoomFactor || 1);
  try {
    if (Math.abs(webview.getZoomFactor() - zoomFactor) > 0.001) webview.setZoomFactor(zoomFactor);
    if (webview.isAudioMuted() !== (currentTab.muted === true)) webview.setAudioMuted(currentTab.muted === true);
  } catch {}
  $("#current-address").value = currentTab.url;
  $("#omnibox").value = currentTab.url;
  updateZoomLabel(zoomFactor);
  closeFindBar();
  renderCrashPanel();
  void registerWebview(webview);
  try { webview.send("ego:credentials-scan"); } catch {}
  if (shouldRender) renderBrowserTabs();
  updateBrowserToolbar();
  return queueVisualTabActivation(currentTab.targetId, notifyBroker);
}

async function closeBrowserTab(tab) {
  await closeBrowserTabs([tab]);
}

async function closeBrowserTabs(tabsToClose) {
  const taskId = activeTaskId;
  const selectionRevision = tabSelectionRevision;
  const tabs = tabsForTask(taskId);
  const closingIds = new Set(tabsToClose.map((tab) => tab.targetId));
  const index = Math.max(0, tabs.findIndex((item) => closingIds.has(item.targetId)));
  const closedIds = tabsToClose.map((tab) => rememberClosedTab(tab).id);
  if (closedTabs.length > 50) closedTabs.splice(0, closedTabs.length - 50);
  persistClosedTabs();
  renderHistory();
  for (const tab of tabsToClose) {
    await invoke("tab.close", { targetId: tab.targetId });
    markAttachmentsStale(tab.targetId, true);
    removeWebview(tab.targetId);
    selectedTabIds.delete(tab.targetId);
  }
  recentTabIds = recentTabIds.filter((id) => !closingIds.has(id));
  persistRecentTabIds();
  if (currentTab && closingIds.has(currentTab.targetId)) currentTab = null;
  await refresh();
  if (activeTaskId === taskId) {
    const remaining = tabsForTask(taskId);
    const currentTargetId = currentTab?.targetId || "";
    const currentStillVisible = Boolean(currentTargetId && remaining.some((tab) => tab.targetId === currentTargetId));
    if (!currentStillVisible && tabSelectionRevision === selectionRevision) {
      const awake = remaining.filter((tab) => !tab.sleeping);
      const next = awake[Math.min(index, awake.length - 1)] || awake[0];
      if (next) showTab(next);
      else showWelcome();
    }
  }
  showClosedTabsUndo(closedIds);
}

function rememberClosedTab(tab) {
  const closed = {
    id: crypto.randomUUID(),
    taskId: tab.taskId || activeTaskId,
    url: tab.url,
    title: tab.title,
    pinned: tab.pinned === true,
    muted: tab.muted === true,
    zoomFactor: Number(tab.zoomFactor || 1),
    closedAt: new Date().toISOString(),
  };
  closedTabs.push(closed);
  return closed;
}

function ensureWebview(tab, { background = false } = {}) {
  let webview = webviews.get(tab.targetId);
  if (webview) {
    if (!background) setWebviewVisibility(webview, true);
    return webview;
  }
  webview = document.createElement("webview");
  const task = state.spaces.find((task) => task.taskId === tab.taskId);
  if (!task) throw new Error("找不到标签所属的工作空间，无法确定浏览器 Profile");
  const profile = browserProfileForTask(task);
  if (profile.missing || !profile.partition) throw new Error(`找不到工作空间使用的 Profile ${profile.id}，无法打开页面`);
  webview.setAttribute("partition", profile.partition);
  webview.setAttribute("preload", WEBVIEW_PRELOAD_URL);
  webview.setAttribute("allowpopups", "");
  webview.dataset.targetId = tab.targetId;
  webview.dataset.taskId = tab.taskId || "";
  webview.dataset.profileId = profile.id;
  const interactive = !background && browserViewIsActive();
  webview.dataset.background = interactive ? "false" : "true";
  webview.style.pointerEvents = interactive ? "auto" : "none";
  webview.inert = !interactive;
  webview.setAttribute("aria-hidden", interactive ? "false" : "true");
  webview.src = tab.url || "about:blank";
  bindWebviewEvents(webview, tab.targetId);
  $("#webview-stack").hidden = false;
  $("#webview-stack").append(webview);
  webviews.set(tab.targetId, webview);
  // 新建的后台 WebView 先保持挂载且不隐藏，等 dom-ready/注册完成后再隐藏。
  // Electron 在元素尚未完成挂载时直接设置 hidden，会导致 WebContents 永远拿不到。
  webview.hidden = false;
  return webview;
}

function setWebviewVisibility(webview, visible) {
  if (!webview) return;
  const interactive = Boolean(visible && browserViewIsActive());
  webview.dataset.background = interactive ? "false" : "true";
  webview.hidden = !interactive;
  webview.style.pointerEvents = interactive ? "auto" : "none";
  webview.inert = !interactive;
  webview.setAttribute("aria-hidden", interactive ? "false" : "true");
  if (!interactive) {
    try { webview.blur(); } catch {}
  }
}

function browserViewIsActive() {
  return $("#start-view")?.classList.contains("active") === true;
}

function setBrowserInteractionEnabled(enabled) {
  const stack = $("#webview-stack");
  if (!stack) return;
  stack.dataset.interactive = enabled ? "true" : "false";
  stack.style.pointerEvents = enabled ? "" : "none";
  stack.inert = !enabled;
  if (!enabled) {
    for (const webview of webviews.values()) setWebviewVisibility(webview, false);
  }
}

function removeWebview(targetId) {
  const webview = webviews.get(targetId);
  webview?.remove();
  webviews.delete(targetId);
  credentialStates.delete(targetId);
}

function bindWebviewEvents(webview, targetId) {
  const updateUrl = (event) => {
    tabPreviewCache.delete(targetId);
    const tab = state.tabs.find((item) => item.targetId === targetId);
    const previousUrl = tab?.url || (currentTab?.targetId === targetId ? currentTab.url : "");
    if (tab) tab.url = event.url;
    if (currentTab?.targetId === targetId) {
      currentTab = tab || currentTab;
      currentTab.url = event.url;
      $("#current-address").value = event.url;
      $("#omnibox").value = event.url;
      updateBrowserToolbar();
      if (isStartPageUrl(previousUrl) && !isStartPageUrl(event.url)) showTab(currentTab, false);
    }
    markAttachmentsStale(targetId);
    recordWebsiteVisit({ ...tab, targetId, taskId: tab?.taskId || webview.dataset.taskId, url: event.url, title: tab?.title || webview.getTitle() });
    const credentialState = credentialStates.get(targetId);
    if (credentialState) credentialState.lastAutoKey = "";
    try { webview.send("ego:credentials-scan"); } catch {}
    void registerWebview(webview);
  };
  webview.addEventListener("did-navigate", updateUrl);
  webview.addEventListener("did-navigate-in-page", updateUrl);
  webview.addEventListener("ipc-message", (event) => {
    if (event.channel === "ego:user-interaction") void handleUserInteraction(targetId);
    if (event.channel === "ego:credentials-form") void handleCredentialFormState(webview, targetId, event.args?.[0]);
    if (event.channel === "ego:credentials-submit") void handleCredentialSubmission(webview, targetId, event.args?.[0]);
    if (event.channel === "ego:browser-zoom-wheel" && currentTab?.targetId === targetId) handleZoomWheel(event.args?.[0]);
  });
  webview.addEventListener("dom-ready", () => {
    const tab = state.tabs.find((item) => item.targetId === targetId);
    if (tab?.zoomFactor) webview.setZoomFactor(tab.zoomFactor);
    if (tab?.muted) webview.setAudioMuted(true);
    if (currentTab?.targetId === targetId) void registerWebview(webview);
    clearTabCrash(targetId);
    recordWebsiteVisit({ ...tab, targetId, taskId: tab?.taskId || webview.dataset.taskId, url: webview.getURL(), title: webview.getTitle() || tab?.title });
    try { webview.send("ego:credentials-scan"); } catch {}
    if (currentTab?.targetId === targetId) updateBrowserToolbar();
  });
  webview.addEventListener("did-start-loading", () => {
    const previous = credentialStates.get(targetId);
    if (previous) credentialStates.set(targetId, { ...previous, lastAutoKey: "", detail: null, matches: [], scanVersion: (previous.scanVersion || 0) + 1 });
    if (currentTab?.targetId === targetId) {
      updateBrowserToolbar(true);
      updateCredentialToolbar();
    }
  });
  webview.addEventListener("did-stop-loading", () => {
    try { webview.send("ego:credentials-scan"); } catch {}
    if (currentTab?.targetId === targetId) {
      updateBrowserToolbar(false);
      translation.pageChanged();
    }
  });
  webview.addEventListener("media-started-playing", () => {
    mediaPlayingTargets.add(targetId);
    if (!$("#tab-hover-preview").hidden && tabPreviewTargetId === targetId) {
      const tab = state.tabs.find((item) => item.targetId === targetId);
      const anchor = document.querySelector(`.browser-tab[data-target-id="${CSS.escape(targetId)}"]`);
      if (tab && anchor) void showTabPreview(anchor, tab);
    }
  });
  webview.addEventListener("media-paused", () => mediaPlayingTargets.delete(targetId));
  webview.addEventListener("did-fail-load", (event) => {
    if (!event.isMainFrame || event.errorCode === -3) return;
    markTabCrashed({
      targetId,
      title: "页面加载失败",
      reason: "load-failed",
      message: event.errorDescription ? `${event.errorDescription} (${event.errorCode})` : "无法加载当前页面。",
    });
  });
  webview.addEventListener("render-process-gone", (event) => {
    markTabCrashed({
      targetId,
      title: "页面停止运行",
      reason: event.details?.reason || "crashed",
      message: "页面进程已停止，可以重新加载后继续。",
    });
  });
  webview.addEventListener("unresponsive", () => markTabCrashed({
    targetId,
    title: "页面没有响应",
    reason: "unresponsive",
    message: "页面暂时没有响应；恢复后此提示会自动关闭，也可以立即重新加载。",
  }));
  webview.addEventListener("responsive", () => clearTabCrash(targetId));
  webview.addEventListener("page-title-updated", (event) => {
    const tab = state.tabs.find((item) => item.targetId === targetId);
    const title = isStartPageUrl(tab?.url || webview.getURL()) ? "新建标签页" : event.title;
    if (tab) tab.title = title;
    if (currentTab?.targetId === targetId) {
      currentTab = tab || currentTab;
      currentTab.title = title;
      syncWindowTitle();
    }
    void registerWebview(webview);
    updateWebsiteHistoryTitle(targetId, title);
    renderBrowserTabs();
  });
}

function showWelcome() {
  cosWorkspace.hide();
  currentTab = null;
  syncWindowTitle();
  $("#start-view").classList.remove("has-browser-page");
  $(".browser-surface").classList.add("empty-state");
  for (const webview of webviews.values()) setWebviewVisibility(webview, false);
  $("#webview-stack").hidden = true;
  $("#welcome").hidden = false;
  const companionMode = state.backend?.kind === "companion";
  $("#welcome h2").textContent = companionMode ? "等待 Companion 授权" : "搜索网页，或让 Codex 直接开始";
  $("#welcome p").textContent = companionMode
    ? "在 Edge 或 Chrome 中打开需要使用的页面，然后通过扩展将当前标签授权给一个 EgoLite 任务。"
    : "浏览记录和收藏会继续留在当前任务空间。";
  $("#current-address").value = "ego://start";
  $("#omnibox").value = "";
  updateZoomLabel(1);
  closeFindBar();
  $("#crash-panel").hidden = true;
  renderBrowserTabs();
  renderRecentTabs();
  updateBrowserToolbar();
}

async function showCosHome(activate = true) {
  const task = state.cos?.workspace;
  if (!task || !state.cos.enabled) return;
  try {
    if (activate && activeTaskId !== task.taskId) {
      await activateTaskById(task.id, { quiet: true });
    }
    switchView("start");
    currentTab = null;
    for (const webview of webviews.values()) setWebviewVisibility(webview, false);
    $("#webview-stack").hidden = false;
    $("#welcome").hidden = true;
    $("#crash-panel").hidden = true;
    $("#start-view").classList.add("has-browser-page");
    $(".browser-surface").classList.remove("empty-state");
    $("#current-address").value = "ego://cos";
    $("#omnibox").value = "";
    await cosWorkspace.show();
    renderBrowserTabs();
    updateBrowserToolbar();
  } catch (error) { showToast(error.message, true); }
}

function updateBrowserToolbar(loading) {
  const webview = activeWebview();
  if (loading === undefined) {
    try { loading = webview?.isLoading() || false; } catch { loading = false; }
  }
  browserLoading = Boolean(loading);
  const hasTab = state.backend?.kind !== "companion" && Boolean(currentTab && webview);
  let canGoBack = false;
  let canGoForward = false;
  if (hasTab) {
    try {
      canGoBack = webview.canGoBack?.() === true;
      canGoForward = webview.canGoForward?.() === true;
    } catch {
      // A newly attached WebView is not callable until dom-ready.
    }
  }
  $("#browser-back").disabled = !canGoBack;
  $("#browser-forward").disabled = !canGoForward;
  for (const id of ["browser-reload", "browser-find", "browser-zoom-out", "browser-zoom-reset", "browser-zoom-in", "browser-print", "save-page", "browser-passwords"]) {
    $(`#${id}`).disabled = !hasTab;
  }
  $("#browser-reload").title = loading ? "正在加载" : "刷新";
  $("#browser-reload").setAttribute("aria-label", loading ? "停止加载" : "刷新");
  $("#browser-reload").innerHTML = `<i data-lucide="${loading ? "x" : "rotate-cw"}"></i>`;
  const saved = Boolean(hasTab && currentTab?.url && state.collections.some((item) => item.kind === "bookmark" && item.sourceUrl === currentTab.url));
  $("#save-page").classList.toggle("active", saved);
  $("#save-page").title = hasTab ? (saved ? "已收藏当前地址" : "收藏当前地址") : "收藏当前地址";
  window.lucide.createIcons({ root: $("#browser-reload") });
  updateCredentialToolbar();
}

function openFindBar() {
  if (!activeWebview()) return;
  $("#find-bar").hidden = false;
  $("#find-input").focus();
  $("#find-input").select();
}

function closeFindBar() {
  const bar = $("#find-bar");
  if (!bar) return;
  bar.hidden = true;
  $("#find-result").textContent = "0/0";
  const webContentsId = currentWebContentsId();
  if (currentTab && webContentsId) void invoke("browser.stopFind", { targetId: currentTab.targetId, webContentsId }).catch(() => null);
}

function toggleBrowserMoreMenu() {
  const menu = $("#browser-more-menu");
  menu.hidden = !menu.hidden;
  $("#browser-more").classList.toggle("active", !menu.hidden);
  if (!menu.hidden) {
    $("#downloads-panel").hidden = true;
    $("#history-panel").hidden = true;
  }
}

function closeBrowserMoreMenu() {
  $("#browser-more-menu").hidden = true;
  $("#browser-more").classList.remove("active");
}

function findInPage(forward, findNext) {
  const text = $("#find-input").value;
  const webContentsId = currentWebContentsId();
  if (!currentTab || !webContentsId || !text) {
    if (currentTab && webContentsId) void invoke("browser.stopFind", { targetId: currentTab.targetId, webContentsId }).catch(() => null);
    $("#find-result").textContent = "0/0";
    return;
  }
  const targetId = currentTab.targetId;
  void invoke("browser.find", { targetId, webContentsId, text, forward, findNext }).then((result) => {
    if (currentTab?.targetId !== targetId || $("#find-input").value !== text) return;
    $("#find-result").textContent = result?.matches ? `${result.activeMatchOrdinal}/${result.matches}` : "0/0";
  }).catch(() => { $("#find-result").textContent = "0/0"; });
}

async function changeZoom(delta, reset = false) {
  const webview = activeWebview();
  if (!webview || !currentTab) return;
  const targetId = currentTab.targetId;
  const current = Number(webview.getZoomFactor() || currentTab.zoomFactor || 1);
  const zoomFactor = reset ? 1 : Math.min(2, Math.max(0.5, Math.round((current + delta) * 10) / 10));
  webview.setZoomFactor(zoomFactor);
  currentTab.zoomFactor = zoomFactor;
  const tab = state.tabs.find((item) => item.targetId === currentTab.targetId);
  if (tab) tab.zoomFactor = zoomFactor;
  updateZoomLabel(zoomFactor);
  try {
    await queueTabPreferences(targetId, { zoomFactor });
  } catch (error) {
    if (webviews.get(targetId) === webview && webview.getZoomFactor() === zoomFactor) {
      webview.setZoomFactor(current);
      if (tab) tab.zoomFactor = current;
      if (currentTab?.targetId === targetId) { currentTab.zoomFactor = current; updateZoomLabel(current); }
    }
    showToast(`缩放设置失败：${localizedError(error)}`, true);
  }
}

function handleZoomWheel(detail = {}) {
  const rawDelta = Number(detail.deltaY) || 0;
  if (!rawDelta) return;
  const mode = Number(detail.deltaMode) || 0;
  const pixelDelta = rawDelta * (mode === 1 ? 16 : mode === 2 ? 100 : 1);
  zoomWheelRemainder += pixelDelta;
  clearTimeout(zoomWheelResetTimer);
  zoomWheelResetTimer = setTimeout(() => { zoomWheelRemainder = 0; }, 180);

  const threshold = 100;
  const steps = Math.min(3, Math.floor(Math.abs(zoomWheelRemainder) / threshold));
  if (!steps) return;
  const zoomDelta = zoomWheelRemainder < 0 ? 0.1 : -0.1;
  zoomWheelRemainder -= Math.sign(zoomWheelRemainder) * steps * threshold;
  for (let index = 0; index < steps; index += 1) void changeZoom(zoomDelta);
}

function reloadCurrentPage(ignoreCache = false) {
  const webview = activeWebview();
  if (!webview) return;
  if (ignoreCache && typeof webview.reloadIgnoringCache === "function") webview.reloadIgnoringCache();
  else webview.reload();
}

function updateZoomLabel(zoomFactor) {
  $("#browser-zoom-reset").textContent = `${Math.round((Number(zoomFactor) || 1) * 100)}%`;
}

function printCurrentPage() {
  const webview = activeWebview();
  if (!webview) return;
  webview.print({ printBackground: true }, (success) => {
    $("#browser-print").title = success ? "已发送到打印机" : "打印已取消";
  });
}

async function handleCredentialFormState(webview, targetId, detail = {}) {
  const profileId = webview.dataset.profileId || "default";
  const previous = credentialStates.get(targetId) || { lastAutoKey: "", scanVersion: 0 };
  const scanVersion = previous.scanVersion + 1;
  const origin = /^https?:\/\//i.test(String(detail.origin || "")) ? String(detail.origin) : "";
  const normalizedDetail = origin ? {
    origin,
    username: String(detail.username || ""),
    passwordEmpty: detail.passwordEmpty !== false,
    passwordCount: Math.max(0, Number(detail.passwordCount) || 0),
    formSignature: String(detail.formSignature || ""),
  } : null;
  const next = { ...previous, profileId, detail: normalizedDetail, matches: [], scanVersion };
  credentialStates.set(targetId, next);
  if (!normalizedDetail) {
    if (currentTab?.targetId === targetId) updateCredentialToolbar();
    return;
  }

  const matches = await invoke("credentials.find", { profileId, origin }).catch(() => []);
  const current = credentialStates.get(targetId);
  if (!current || current.scanVersion !== scanVersion) return;
  current.matches = Array.isArray(matches) ? matches : [];
  if (currentTab?.targetId === targetId) {
    updateCredentialToolbar();
    if (!$("#credentials-panel").hidden) renderCredentialPanel();
  }

  if (browserSettings.passwordAutofillEnabled === false || !normalizedDetail.passwordCount || !normalizedDetail.passwordEmpty || !current.matches.length) return;
  const preferred = current.matches.find((credential) => normalizedDetail.username && credential.username === normalizedDetail.username) || current.matches[0];
  const autoKey = `${origin}\n${normalizedDetail.formSignature}\n${preferred.id}`;
  if (current.lastAutoKey === autoKey) return;
  current.lastAutoKey = autoKey;
  const webContentsId = safeWebContentsId(webview);
  try {
    const result = await invoke("credentials.fill", {
      profileId,
      id: preferred.id,
      targetId,
      webContentsId,
      formSignature: normalizedDetail.formSignature,
    });
    if (!result?.filled) current.lastAutoKey = "";
  } catch {
    current.lastAutoKey = "";
  }
}

async function handleCredentialSubmission(webview, targetId, detail = {}) {
  const origin = /^https?:\/\//i.test(String(detail.origin || "")) ? String(detail.origin) : "";
  const password = typeof detail.password === "string" ? detail.password : "";
  if (!origin || !password) return;
  const profileId = webview.dataset.profileId || "default";
  const matches = await invoke("credentials.find", { profileId, origin }).catch(() => []);
  const username = String(detail.username || "");
  const existing = (matches || []).find((credential) => credential.username === username);
  if (existing) {
    const check = await invoke("credentials.check", { profileId, id: existing.id, password }).catch(() => ({ matches: false }));
    if (check.matches) return;
  }
  const fingerprint = `${profileId}\n${origin}\n${username}\n${password}`;
  if (pendingCredentialSave?.fingerprint === fingerprint) return;
  openCredentialSaveDialog({
    id: existing?.id || "",
    profileId,
    origin,
    username,
    password,
    formSignature: String(detail.formSignature || ""),
    fingerprint,
  });
}

function updateCredentialToolbar() {
  const button = $("#browser-passwords");
  const badge = $("#password-badge");
  const current = currentTab ? credentialStates.get(currentTab.targetId) : undefined;
  const matches = current?.matches || [];
  const hasForm = Number(current?.detail?.passwordCount) > 0;
  button.classList.toggle("active", Boolean(matches.length || hasForm));
  button.title = matches.length
    ? `${matches.length} 个已保存账号`
    : hasForm ? "保存或填充此页面的登录信息" : "密码与自动填充";
  button.setAttribute("aria-label", button.title);
  badge.hidden = !matches.length;
  badge.textContent = matches.length > 9 ? "9+" : String(matches.length);
  if (!$("#credentials-panel").hidden) renderCredentialPanel();
}

async function toggleCredentialPanel() {
  const panel = $("#credentials-panel");
  if (!panel.hidden) {
    closeCredentialPanel();
    return;
  }
  $("#downloads-panel").hidden = true;
  $("#history-panel").hidden = true;
  $("#extensions-panel").hidden = true;
  panel.hidden = false;
  $("#browser-passwords").setAttribute("aria-expanded", "true");
  renderCredentialPanel();
  const webview = activeWebview();
  try { webview?.send("ego:credentials-scan"); } catch {}
}

function closeCredentialPanel() {
  $("#credentials-panel").hidden = true;
  $("#browser-passwords").setAttribute("aria-expanded", "false");
}

function renderCredentialPanel() {
  const list = $("#credentials-panel-list");
  const summary = $("#credentials-panel-summary");
  const saveButton = $("#save-current-credential");
  list.replaceChildren();
  const current = currentTab ? credentialStates.get(currentTab.targetId) : undefined;
  const matches = current?.matches || [];
  const hasForm = Number(current?.detail?.passwordCount) > 0;
  saveButton.disabled = !hasForm;
  summary.textContent = !currentTab
    ? "先打开一个网页"
    : hasForm
      ? matches.length ? `${matches.length} 个账号可用` : "检测到登录表单"
      : matches.length ? `${matches.length} 个账号已保存` : "当前页面没有登录表单";
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "credentials-empty";
    empty.textContent = hasForm ? "填写账号和密码后可以保存" : "这个网站还没有保存账号";
    list.append(empty);
    return;
  }
  for (const credential of matches) {
    const row = document.createElement("div");
    row.className = "credential-panel-row";
    row.innerHTML = `<span class="credential-key"><i data-lucide="key-round"></i></span><div class="credential-panel-copy"><strong>${escapeHtml(credential.username || "无用户名")}</strong><span>${escapeHtml(credential.origin)}</span></div><button class="secondary-button" type="button" data-credential-fill="${escapeAttribute(credential.id)}">填充</button>`;
    list.append(row);
  }
  window.lucide.createIcons({ root: list });
}

async function runCredentialPanelAction(event) {
  const button = event.target.closest("[data-credential-fill]");
  if (!button || !currentTab) return;
  const webview = activeWebview();
  const profileId = webview?.dataset.profileId || "default";
  button.disabled = true;
  try {
    const result = await invoke("credentials.fill", {
      profileId,
      id: button.dataset.credentialFill,
      targetId: currentTab.targetId,
      webContentsId: safeWebContentsId(webview),
      formSignature: credentialStates.get(currentTab.targetId)?.detail?.formSignature || "",
    });
    if (!result?.filled) throw new Error("当前页面没有可填写的密码框");
    closeCredentialPanel();
    showToast("登录信息已填入");
  } catch (error) {
    showToast(`无法填充登录信息：${localizedError(error)}`, true);
  } finally {
    button.disabled = false;
  }
}

async function saveCurrentPageCredential() {
  if (!currentTab) return;
  const webview = activeWebview();
  const profileId = webview?.dataset.profileId || "default";
  try {
    const captured = await invoke("credentials.capture", {
      targetId: currentTab.targetId,
      webContentsId: safeWebContentsId(webview),
    });
    if (!captured?.password) throw new Error("请先在页面中填写密码");
    const matches = await invoke("credentials.find", { profileId, origin: captured.origin }).catch(() => []);
    const existing = (matches || []).find((credential) => credential.username === captured.username);
    closeCredentialPanel();
    openCredentialSaveDialog({ ...captured, id: existing?.id || "", profileId });
  } catch (error) {
    showToast(localizedError(error), true);
  }
}

function openCredentialSaveDialog(credential) {
  const dialog = $("#credential-save-dialog");
  if (dialog.open) dialog.close();
  pendingCredentialSave = { ...credential };
  const profile = browserProfiles().find((item) => item.id === credential.profileId);
  $("#credential-save-title").textContent = credential.id ? "更新密码" : "保存密码";
  $("#credential-save-origin").textContent = credential.origin || "当前网站";
  $("#credential-save-username").value = credential.username || "";
  $("#credential-save-password").type = "password";
  $("#credential-save-password").value = credential.password || "";
  $("#credential-password-visible").checked = false;
  $("#credential-save-profile").textContent = `保存到 ${profile?.name || credential.profileId || "默认 Profile"}`;
  $("#credential-save-accept").textContent = credential.id ? "更新" : "保存";
  dialog.showModal();
  queueMicrotask(() => $("#credential-save-username").focus());
}

function closeCredentialSaveDialog() {
  const dialog = $("#credential-save-dialog");
  if (dialog.open) dialog.close();
  pendingCredentialSave = null;
}

async function saveCredentialDialog(event) {
  event.preventDefault();
  if (!pendingCredentialSave) return;
  const password = $("#credential-save-password").value;
  if (!password) return;
  const button = $("#credential-save-accept");
  button.disabled = true;
  try {
    const wasUpdate = Boolean(pendingCredentialSave.id);
    const saved = await invoke("credentials.save", {
      id: pendingCredentialSave.id,
      profileId: pendingCredentialSave.profileId,
      origin: pendingCredentialSave.origin,
      username: $("#credential-save-username").value,
      password,
      realm: pendingCredentialSave.realm || "",
      formSignature: pendingCredentialSave.formSignature || "",
    });
    closeCredentialSaveDialog();
    await loadCredentials();
    const webview = activeWebview();
    try { webview?.send("ego:credentials-scan"); } catch {}
    showToast(wasUpdate ? "密码已更新" : "密码已保存");
  } catch (error) {
    showToast(`保存密码失败：${localizedError(error)}`, true);
  } finally {
    button.disabled = false;
  }
}

async function loadCredentials() {
  savedCredentials = await invoke("credentials.list").catch(() => []);
  if (!Array.isArray(savedCredentials)) savedCredentials = [];
  const savedIds = new Set(savedCredentials.map((credential) => credential.id));
  for (const state of credentialStates.values()) state.matches = (state.matches || []).filter((credential) => savedIds.has(credential.id));
  $("#settings-credential-count").textContent = `${savedCredentials.length} 条`;
  syncCredentialProfileFilter();
  renderCredentialSettings();
  updateCredentialToolbar();
}

function syncCredentialProfileFilter() {
  const select = $("#credential-profile-filter");
  if (!select) return;
  const profiles = browserProfiles();
  if (!profiles.some((profile) => profile.id === credentialSettingsProfileId)) credentialSettingsProfileId = profiles[0]?.id || "default";
  select.replaceChildren(...profiles.map((profile) => new Option(profile.name, profile.id)));
  select.value = credentialSettingsProfileId;
}

function renderCredentialSettings() {
  const list = $("#credential-settings-list");
  if (!list) return;
  const rows = savedCredentials.filter((credential) => credential.profileId === credentialSettingsProfileId);
  list.replaceChildren();
  $("#clear-saved-credentials").disabled = !rows.length;
  $("#password-autofill-enabled").checked = browserSettings.passwordAutofillEnabled !== false;
  $("#password-autofill-label").textContent = browserSettings.passwordAutofillEnabled !== false ? "已开启" : "已关闭";
  $("#credential-settings-status").textContent = rows.length ? `当前 Profile 保存了 ${rows.length} 条登录信息` : "当前 Profile 还没有保存登录信息";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "credential-settings-empty";
    empty.textContent = "登录网站并提交表单后，保存提示会出现在浏览器窗口中";
    list.append(empty);
    return;
  }
  for (const credential of rows) {
    const row = document.createElement("div");
    row.className = "credential-settings-row";
    row.dataset.credentialId = credential.id;
    const updated = new Date(credential.updatedAt || credential.createdAt || Date.now()).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    row.innerHTML = `<span class="credential-key"><i data-lucide="key-round"></i></span><div class="credential-settings-copy"><strong>${escapeHtml(credential.username || "无用户名")}</strong><span>${escapeHtml(credential.origin)}${credential.realm ? ` · ${escapeHtml(credential.realm)}` : ""} · ${updated}</span></div><div class="credential-settings-actions"><button class="icon-button" type="button" data-credential-action="edit" title="编辑登录信息"><i data-lucide="pencil"></i></button><button class="icon-button danger-icon" type="button" data-credential-action="delete" title="删除登录信息"><i data-lucide="trash-2"></i></button></div>`;
    list.append(row);
  }
  window.lucide.createIcons({ root: list });
}

async function runCredentialSettingsAction(event) {
  const button = event.target.closest("[data-credential-action]");
  const row = button?.closest("[data-credential-id]");
  if (!row) return;
  const id = row.dataset.credentialId;
  if (button.dataset.credentialAction === "edit") {
    try {
      const credential = await invoke("credentials.get", { profileId: credentialSettingsProfileId, id });
      openCredentialSaveDialog(credential);
    } catch (error) {
      showToast(localizedError(error), true);
    }
    return;
  }
  await invoke("credentials.remove", { profileId: credentialSettingsProfileId, id }).catch(() => false);
  await loadCredentials();
  showToast("登录信息已删除");
}

async function clearSavedCredentials() {
  const profile = browserProfiles().find((item) => item.id === credentialSettingsProfileId);
  if (!await confirmAction("清空保存的密码", `将删除“${profile?.name || credentialSettingsProfileId}”中的全部登录信息。`, "清空")) return;
  await invoke("credentials.clear", { profileId: credentialSettingsProfileId });
  await loadCredentials();
  showToast("当前 Profile 的登录信息已清空");
}

async function savePasswordAutofillSetting() {
  const enabled = $("#password-autofill-enabled").checked;
  try {
    const result = await invoke("settings.setPasswordAutofill", { enabled });
    browserSettings.passwordAutofillEnabled = result.enabled !== false;
    renderCredentialSettings();
    if (browserSettings.passwordAutofillEnabled) {
      try { activeWebview()?.send("ego:credentials-scan"); } catch {}
    }
    showToast(browserSettings.passwordAutofillEnabled ? "自动填充已开启" : "自动填充已关闭");
  } catch (error) {
    showToast(`设置保存失败：${localizedError(error)}`, true);
    $("#password-autofill-enabled").checked = browserSettings.passwordAutofillEnabled !== false;
  }
}

function openCredentialSettings() {
  closeCredentialPanel();
  const webview = activeWebview();
  credentialSettingsProfileId = webview?.dataset.profileId || credentialSettingsProfileId || "default";
  syncCredentialProfileFilter();
  renderCredentialSettings();
  switchView("settings");
  requestAnimationFrame(() => $("#credential-settings").scrollIntoView({ block: "start" }));
}

function safeWebContentsId(webview) {
  try { return webview?.getWebContentsId() || 0; } catch { return 0; }
}

async function loadDownloads() {
  const records = await invoke("downloads.list").catch(() => []);
  downloads.clear();
  for (const record of records || []) if (record?.id) downloads.set(record.id, record);
  renderDownloads();
}

function toggleDownloadsPanel() {
  const panel = $("#downloads-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    $("#history-panel").hidden = true;
    void loadDownloads();
  }
}

function openDownloadsPanel() {
  switchView("start");
  if ($("#downloads-panel").hidden) toggleDownloadsPanel();
}

function toggleHistoryPanel() {
  const panel = $("#history-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    $("#downloads-panel").hidden = true;
    renderHistory();
  }
}

function openHistoryPanel() {
  switchView("start");
  if ($("#history-panel").hidden) toggleHistoryPanel();
}

function renderHistory() {
  const list = $("#history-list");
  list.replaceChildren();
  const needle = $("#history-search").value.trim().toLocaleLowerCase();
  const source = historyMode === "visits" ? websiteHistory : closedTabs;
  const records = [...source].reverse().filter((item) => !needle || [item.title, item.url].some((value) => String(value || "").toLocaleLowerCase().includes(needle)));
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "downloads-empty";
    empty.textContent = needle ? "没有匹配的历史记录" : historyMode === "visits" ? "暂无网站访问历史" : "没有最近关闭的标签页";
    list.append(empty);
    return;
  }
  let day = "";
  records.forEach((item) => {
    const nextDay = operationDayLabel(item.visitedAt || item.closedAt);
    if (nextDay !== day) {
      day = nextDay;
      const heading = document.createElement("div");
      heading.className = "history-day";
      heading.textContent = day;
      list.append(heading);
    }
    const row = document.createElement("div");
    row.className = "history-row";
    row.dataset.historyId = item.id;
    const time = formatClosedTime(item.visitedAt || item.closedAt);
    const primaryAction = historyMode === "visits" ? "open" : "restore";
    const primaryTitle = historyMode === "visits" ? "打开网页" : "重新打开";
    const primaryIcon = historyMode === "visits" ? "external-link" : "rotate-ccw";
    const visitText = historyMode === "visits" && Number(item.visitCount) > 1 ? ` · ${Number(item.visitCount)} 次访问` : "";
    row.innerHTML = `<i data-lucide="${historyMode === "visits" ? "globe-2" : "history"}"></i><div class="history-copy"><strong>${escapeHtml(item.title || item.url || "历史记录")}</strong><span>${escapeHtml(item.url || "about:blank")} · ${time}${visitText}</span></div><div class="history-actions"><button class="icon-button" type="button" data-history-action="${primaryAction}" title="${primaryTitle}"><i data-lucide="${primaryIcon}"></i></button><button class="icon-button" type="button" data-history-action="delete" title="删除记录"><i data-lucide="x"></i></button></div>`;
    list.append(row);
  });
  window.lucide.createIcons({ root: list });
}

async function runHistoryAction(event) {
  const button = event.target.closest("[data-history-action]");
  const row = button?.closest("[data-history-id]");
  if (!row) return;
  const action = button.dataset.historyAction;
  const source = historyMode === "visits" ? websiteHistory : closedTabs;
  const index = source.findIndex((item) => item.id === row.dataset.historyId);
  if (index < 0) return;
  if (action === "restore") {
    await reopenClosedTab(index);
    $("#history-panel").hidden = true;
  } else if (action === "open") {
    await openNewTab(source[index].url);
    $("#history-panel").hidden = true;
  } else if (action === "delete") {
    source.splice(index, 1);
    if (historyMode === "visits") persistWebsiteHistory();
    else persistClosedTabs();
    renderHistory();
  }
}

async function clearClosedTabs() {
  const source = historyMode === "visits" ? websiteHistory : closedTabs;
  if (!source.length) return;
  const title = historyMode === "visits" ? "清空访问历史" : "清空最近关闭";
  if (!await confirmAction(title, `确定清除 ${source.length} 条记录吗？此操作无法撤销。`, "清空")) return;
  source.splice(0);
  if (historyMode === "visits") persistWebsiteHistory();
  else persistClosedTabs();
  renderHistory();
}

function setHistoryMode(mode) {
  historyMode = mode === "closed" ? "closed" : "visits";
  for (const button of document.querySelectorAll("[data-history-mode]")) button.classList.toggle("active", button.dataset.historyMode === historyMode);
  $("#history-search").placeholder = historyMode === "visits" ? "搜索标题或网址" : "搜索最近关闭";
  renderHistory();
}

function renderDownloads() {
  const list = $("#downloads-list");
  list.replaceChildren();
  const allRecords = [...downloads.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const activeCount = allRecords.filter((record) => record.state === "inProgress").length;
  const badge = $("#download-badge");
  badge.hidden = activeCount === 0;
  badge.textContent = activeCount > 9 ? "9+" : String(activeCount);
  const needle = $("#downloads-search").value.trim().toLocaleLowerCase();
  const filter = $("#downloads-filter").value;
  const records = allRecords.filter((record) => {
    const stateMatches = filter === "all"
      || (filter === "active" && record.state === "inProgress")
      || (filter === "completed" && record.state === "completed")
      || (filter === "failed" && ["canceled", "interrupted"].includes(record.state));
    const searchMatches = !needle || [record.filename, record.url, record.savePath].filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(needle));
    return stateMatches && searchMatches;
  });
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "downloads-empty";
    empty.textContent = allRecords.length ? "没有匹配的下载" : "暂无下载";
    list.append(empty);
    return;
  }
  for (const record of records) {
    const row = document.createElement("div");
    row.className = "download-row";
    row.dataset.downloadId = record.id;
    const icon = document.createElement("i");
    icon.dataset.lucide = record.state === "completed" ? "circle-check" : record.state === "inProgress" ? "loader-circle" : "circle-x";
    const body = document.createElement("div");
    body.className = "download-copy";
    const title = document.createElement("strong");
    title.textContent = record.filename || "下载文件";
    title.title = record.savePath || record.url || "";
    const status = document.createElement("span");
    status.textContent = downloadStatus(record);
    body.append(title, status);
    if (record.state === "inProgress") {
      const progress = document.createElement("progress");
      progress.max = Math.max(1, Number(record.totalBytes) || 1);
      progress.value = Math.max(0, Number(record.receivedBytes) || 0);
      if (!record.totalBytes) progress.removeAttribute("value");
      body.append(progress);
    }
    const actions = document.createElement("div");
    actions.className = "download-actions";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "icon-button";
    action.dataset.downloadAction = record.state === "inProgress" ? "cancel" : record.state === "completed" ? "open" : "show";
    action.title = record.state === "inProgress" ? "取消" : record.state === "completed" ? "打开" : "在文件夹中显示";
    action.innerHTML = `<i data-lucide="${record.state === "inProgress" ? "x" : record.state === "completed" ? "external-link" : "folder-open"}"></i>`;
    actions.append(action);
    if (record.savePath && record.state === "completed") {
      const show = document.createElement("button");
      show.type = "button";
      show.className = "icon-button";
      show.dataset.downloadAction = "show";
      show.title = "在文件夹中显示";
      show.innerHTML = '<i data-lucide="folder-open"></i>';
      actions.append(show);
    }
    row.append(icon, body, actions);
    list.append(row);
  }
  window.lucide.createIcons({ root: list });
}

function downloadStatus(record) {
  if (record.state === "completed") return `${formatBytes(record.receivedBytes)} · 已完成`;
  if (record.state === "inProgress") return record.totalBytes
    ? `${formatBytes(record.receivedBytes)} / ${formatBytes(record.totalBytes)}`
    : `${formatBytes(record.receivedBytes)} · 下载中`;
  return record.state === "canceled" ? "已取消" : "下载中断";
}

async function runDownloadAction(event) {
  const button = event.target.closest("[data-download-action]");
  const row = button?.closest("[data-download-id]");
  if (!button || !row) return;
  try {
    const succeeded = await invoke(`downloads.${button.dataset.downloadAction}`, { id: row.dataset.downloadId });
    if (succeeded === false) showToast("无法完成下载操作，请检查文件是否仍然存在。", true);
  } catch (error) {
    showToast(localizedError(error), true);
  }
}

async function clearFinishedDownloads() {
  const finished = [...downloads.values()].filter((record) => record.state !== "inProgress").length;
  if (finished && !await confirmAction("清理下载记录", `将从列表中清除 ${finished} 条已结束的下载记录，不会删除本地文件。`, "清理")) return;
  try {
    const records = await invoke("downloads.clear");
    downloads.clear();
    for (const record of records || []) downloads.set(record.id, record);
    renderDownloads();
    if (finished) showToast(`已清理 ${finished} 条下载记录`);
  } catch (error) {
    showToast(`清理下载记录失败：${localizedError(error)}`, true);
  }
}

async function clearSitePermissions() {
  const count = (await invoke("permissions.list").catch(() => [])).length;
  if (!count) return;
  if (!await confirmAction("重置网站权限", `将清除 ${count} 条已保存的网站权限决定。网站下次请求时会重新询问。`, "全部重置")) return;
  try {
    await invoke("permissions.clear");
    await loadSitePermissions();
    showToast(`已重置 ${count} 条网站权限`);
  } catch (error) {
    showToast(`重置网站权限失败：${localizedError(error)}`, true);
  }
}

async function loadSitePermissions() {
  const rows = await invoke("permissions.list").catch(() => []);
  const list = $("#site-permissions-list");
  list.replaceChildren();
  $("#settings-permission-count").textContent = `${rows.length} 条决定`;
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "site-permissions-empty";
    empty.textContent = "没有已保存的网站权限决定";
    list.append(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "site-permission-row";
    item.dataset.permissionId = row.id;
    item.innerHTML = `<div class="site-permission-copy"><strong>${escapeHtml(row.origin || "未知来源")}</strong><span>${escapeHtml(row.label || row.permission)} · ${row.scope === "session" ? "本次会话" : "已记住"}</span></div><span class="permission-decision ${row.allowed ? "allowed" : "blocked"}">${row.allowed ? "允许" : "阻止"}</span><button class="icon-button" type="button" data-permission-action="remove" title="撤销决定"><i data-lucide="rotate-ccw"></i></button>`;
    list.append(item);
  }
  window.lucide.createIcons({ root: list });
}

async function loadBrowserSettings() {
  void automationSettingsPanel.refresh();
  try {
    browserSettings = await invoke("settings.get");
    browserSettings.controlMode = normalizeControlMode(browserSettings.controlMode);
    $("#browser-backend-select").value = browserSettings.browserBackend || "desktop";
    $("#password-autofill-enabled").checked = browserSettings.passwordAutofillEnabled !== false;
    $("#agent-web-access-enabled").checked = browserSettings.agentWebAccessEnabled !== false;
    $("#agent-silent-downloads-enabled").checked = browserSettings.agentSilentDownloadsEnabled !== false;
    $("#control-handoff-enabled").checked = browserSettings.controlMode !== "agent";
    $("#control-consent-enabled").checked = browserSettings.controlConsentEnabled === true;
    $("#control-consent-level").value = browserSettings.controlConsentLevel === "strict" ? "strict" : "balanced";
    renderBrowserSettings();
    renderAgentPolicySettings();
    renderControlConsentSettings();
    renderControlModeSwitcher();
    renderLocalAgentSettings();
    renderVisualSettings();
    renderCredentialSettings();
  } catch (error) {
    $("#companion-status-text").textContent = `无法检查状态：${localizedError(error)}`;
  }
}

function renderLocalAgentSettings() {
  const integration = browserSettings.localAgents || {};
  const rows = Array.isArray(integration.integrations) ? integration.integrations : [];
  const detected = rows.filter((item) => item.detected);
  const installed = detected.filter((item) => item.installed);
  $("#settings-agent-summary").textContent = integration.error
    ? "需要修复"
    : detected.length && installed.length === detected.length ? `${installed.length} 个已接入` : `${installed.length}/${detected.length || rows.length} 已接入`;
  const list = $("#agent-integration-list");
  list.replaceChildren();
  for (const item of rows) {
    const row = document.createElement("div");
    row.className = `agent-integration-row ${item.installed ? "ready" : item.error ? "failed" : "pending"}`;
    const status = item.installed ? "已接入" : item.error ? "修复失败" : item.detected ? "待接入" : "未检测到";
    const skills = Array.isArray(item.skills) ? item.skills : [];
    const skillDetail = skills.length
      ? skills.map((skill) => skill.enabled === false ? `${agentSkillName(skill.name)} 已关闭` : `${agentSkillName(skill.name)} ${skill.installed ? "已安装" : "待安装"}`).join(" · ")
      : `Skill ${item.version || "已安装"}`;
    const detail = item.error || (item.installed ? `${skillDetail} · MCP ${item.mcpConfigured ? "已配置" : "不适用"}` : "启动或点击修复后自动安装");
    row.innerHTML = `<span class="agent-integration-dot" aria-hidden="true"></span><div class="agent-integration-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(detail)}</span></div><span class="agent-integration-state">${escapeHtml(status)}</span><button class="icon-button" type="button" data-agent-integration-open="${escapeAttribute(item.kind)}" data-agent-integration-root="${escapeAttribute(item.root)}" title="打开 Agent 目录"><i data-lucide="folder-open"></i></button>`;
    list.append(row);
  }
  $("#agent-integration-status").textContent = integration.error
    ? `自动接入未完成：${integration.error}`
    : integration.browserReady === false ? "本地 Agent 已配置，EgoLite 浏览器控制服务正在启动。" : "本地 Agent 已连接到 EgoLite。对话留在 Agent 中，浏览器只显示状态与操作记录。";
  window.lucide.createIcons({ root: list });
}

function agentSkillName(name) {
  return name === "web-access-ego" ? "Web Access" : name === "ego-browser" ? "Ego Browser" : name;
}

function renderAgentPolicySettings() {
  const webAccessEnabled = $("#agent-web-access-enabled").checked;
  const silentDownloadsEnabled = $("#agent-silent-downloads-enabled").checked;
  $("#agent-web-access-label").textContent = webAccessEnabled ? "已开启" : "已关闭";
  $("#agent-silent-downloads-label").textContent = silentDownloadsEnabled ? "已开启" : "已关闭";
  $("#agent-download-directory").textContent = browserSettings.agentDownloadDirectory || "系统下载目录";
  $("#agent-policy-status").textContent = !webAccessEnabled
    ? "Web Access 已关闭，Ego 管理的 web-access-ego Skill 会从本机 Agent 移除。"
    : !silentDownloadsEnabled
      ? "Web Access 已开启。Agent 下载未指定路径时会显示系统保存窗口。"
      : "Web Access 已开启。Agent 下载未指定路径时会自动保存，已有同名文件会生成新文件名。";
}

async function saveAgentPolicySettings() {
  renderAgentPolicySettings();
  const webAccessEnabled = $("#agent-web-access-enabled").checked;
  const silentDownloadsEnabled = $("#agent-silent-downloads-enabled").checked;
  $("#agent-web-access-enabled").disabled = true;
  $("#agent-silent-downloads-enabled").disabled = true;
  try {
    const result = await invoke("settings.setAgentPolicy", { webAccessEnabled, silentDownloadsEnabled });
    browserSettings.agentWebAccessEnabled = result.webAccessEnabled === true;
    browserSettings.agentSilentDownloadsEnabled = result.silentDownloadsEnabled === true;
    browserSettings.agentDownloadDirectory = result.downloadDirectory || browserSettings.agentDownloadDirectory;
    browserSettings.localAgents = result.localAgents || browserSettings.localAgents;
    $("#agent-web-access-enabled").checked = browserSettings.agentWebAccessEnabled;
    $("#agent-silent-downloads-enabled").checked = browserSettings.agentSilentDownloadsEnabled;
    renderAgentPolicySettings();
    renderLocalAgentSettings();
    showToast("Agent 设置已保存");
  } catch (error) {
    showToast(`Agent 设置保存失败：${localizedError(error)}`, true);
    await loadBrowserSettings();
  } finally {
    $("#agent-web-access-enabled").disabled = false;
    $("#agent-silent-downloads-enabled").disabled = false;
  }
}

async function repairAgentIntegrations() {
  const button = $("#repair-agent-integrations");
  button.disabled = true;
  $("#agent-integration-status").textContent = "正在重新检测并同步本地 Agent…";
  try {
    browserSettings.localAgents = await invoke("agents.integrations.repair");
    renderLocalAgentSettings();
    if (browserSettings.localAgents.error || !browserSettings.localAgents.browserReady) throw new Error(browserSettings.localAgents.error || "浏览器控制服务尚未就绪");
    showToast("本地 Agent 连接已更新");
  } catch (error) {
    $("#agent-integration-status").textContent = `修复失败：${localizedError(error)}`;
  } finally {
    button.disabled = false;
  }
}

async function openAgentIntegrationFolder(event) {
  const button = event.target.closest("[data-agent-integration-open]");
  if (!button) return;
  try {
    await invoke("agents.integrations.open", { kind: button.dataset.agentIntegrationOpen, root: button.dataset.agentIntegrationRoot });
  } catch (error) {
    showToast(`无法打开目录：${localizedError(error)}`, true);
  }
}

function renderBrowserSettings() {
  const companionMode = browserSettings.browserBackend === "companion";
  $("#browser-backend-help").textContent = companionMode
    ? "复用已登录的 Edge 或 Chrome 标签页。切换完成后，需要在扩展中明确授权需要操作的标签。"
    : "在 EgoLite 窗口中打开和操作网页。网站登录状态保存在 EgoLite 自己的浏览器会话中。";
  const status = browserSettings.companion || {};
  const running = state.backend?.kind === "companion" && state.backend?.ready;
  const registered = status.edgeRegistered || status.chromeRegistered;
  $("#companion-status-text").textContent = running
    ? "已连接到 Companion，可以使用已授权的 Edge 或 Chrome 标签。"
    : registered && status.configured
      ? "本机桥接已安装，等待浏览器扩展连接和标签授权。"
      : "尚未完成安装。安装后需要在浏览器扩展页面加载 Companion。";
  $("#install-companion").disabled = status.installSupported === false;
  $("#install-companion").textContent = status.installSupported === false ? "安装包未包含组件" : registered ? "重新打开安装向导" : "安装 Companion";
}

function renderControlConsentSettings() {
  const mode = normalizeControlMode(browserSettings.controlMode);
  const handoffEnabled = mode !== "agent";
  $("#control-handoff-enabled").checked = handoffEnabled;
  const consentEnabled = $("#control-consent-enabled").checked;
  const level = $("#control-consent-level").value;
  $("#control-handoff-label").textContent = handoffEnabled ? "已开启" : "已关闭";
  $("#control-consent-enabled").disabled = !handoffEnabled || mode !== "collaborative";
  $("#control-consent-level").disabled = !handoffEnabled || mode !== "collaborative" || !consentEnabled;
  $("#control-consent-label").textContent = consentEnabled ? "需要授权" : "自动归还";
  $("#control-consent-status").textContent = mode === "manual"
    ? "人为干预模式已开启。Agent 暂停操作，页面由你控制。"
    : !handoffEnabled
      ? "Agent 自主模式已开启。页面操作不会自动暂停 Agent，未接管的工作区仍需 Agent 接管。"
    : !consentEnabled
      ? "原 Agent 可自动恢复普通交接的控制权；点击“停止”仍会强制阻止 Agent。"
    : level === "strict"
      ? "每次点击归还控制权都会再次确认；Agent 的其他接管请求也必须授权。"
      : "归还给原 Agent 只需点击一次；其他 Agent 或其他接管请求仍需授权。";
}

async function saveControlHandoffSettings() {
  const enabled = $("#control-handoff-enabled").checked;
  renderControlConsentSettings();
  try {
    const result = await invoke("settings.setControlHandoff", { enabled });
    browserSettings.controlHandoffEnabled = result.enabled === true;
    browserSettings.controlMode = normalizeControlMode(result.mode || (enabled ? "collaborative" : "agent"));
    browserSettings.autoCollaboration = result.autoCollaboration === true;
    $("#control-handoff-enabled").checked = browserSettings.controlHandoffEnabled;
    renderControlConsentSettings();
    renderControlModeSwitcher();
    await refresh();
    renderAgentHud();
    if ($("#control-panel").open) await refreshControlPanel();
    showToast(enabled
      ? "所有工作区已切换为人机协同，已开启页面操作检测；已暂停的 Agent 仍需批准接管"
      : "所有工作区已切换为 Agent 自主，未接管的工作区仍需 Agent 接管");
  } catch (error) {
    showToast(`控制权交接设置失败：${localizedError(error)}`, true);
    await loadBrowserSettings();
    renderAgentHud();
  }
}

function normalizeControlMode(value) {
  return value === "collaborative" || value === "manual" ? value : "agent";
}

function controlModeLabel(mode) {
  return ({ agent: "Agent 自主", collaborative: "人机协同", manual: "人为干预" })[normalizeControlMode(mode)];
}

function renderControlModeSwitcher() {
  const mode = normalizeControlMode(browserSettings.controlMode);
  for (const button of document.querySelectorAll("[data-control-mode]")) {
    const active = button.dataset.controlMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.title = `所有工作区 · ${controlModeLabel(button.dataset.controlMode)}${active ? "（当前）" : ""}`;
  }
  const status = $("#control-mode-status");
  if (status) {
    status.textContent = controlModeLabel(mode);
    status.dataset.mode = mode;
  }
}

async function saveControlMode(mode) {
  const nextMode = normalizeControlMode(mode);
  if (nextMode === normalizeControlMode(browserSettings.controlMode)) return;
  const buttons = [...document.querySelectorAll("[data-control-mode]")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await invoke("settings.setControlMode", { mode: nextMode });
    browserSettings.controlMode = normalizeControlMode(result.mode);
    browserSettings.autoCollaboration = result.autoCollaboration === true;
    browserSettings.controlHandoffEnabled = browserSettings.controlMode !== "agent";
    $("#control-handoff-enabled").checked = browserSettings.controlHandoffEnabled;
    renderControlModeSwitcher();
    renderControlConsentSettings();
    await refresh();
    renderAgentHud();
    if ($("#control-panel").open) await refreshControlPanel();
    showToast(nextMode === "agent"
      ? "所有工作区已切换为 Agent 自主，未接管的工作区仍需 Agent 接管"
      : nextMode === "collaborative"
        ? "所有工作区已切换为人机协同，已开启页面操作检测；已暂停的 Agent 仍需批准接管"
        : "所有工作区已切换为人为干预，Agent 操作已禁用");
  } catch (error) {
    showToast(`控制模式切换失败：${localizedError(error)}`, true);
    await loadBrowserSettings();
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function saveControlConsentSettings() {
  renderControlConsentSettings();
  const enabled = $("#control-consent-enabled").checked;
  const level = $("#control-consent-level").value === "strict" ? "strict" : "balanced";
  try {
    const result = await invoke("settings.setControlPolicy", { enabled, level });
    browserSettings.controlConsentEnabled = result.enabled === true;
    browserSettings.controlConsentLevel = result.level;
    renderControlConsentSettings();
    renderAgentHud();
    showToast("控制权安全策略已保存");
  } catch (error) {
    showToast(`安全策略保存失败：${localizedError(error)}`, true);
    await loadBrowserSettings();
  }
}

function applyVisualPreferences() {
  const theme = ["night", "slate", "ember", "light", "paper"].includes(visualPreferences.theme) ? visualPreferences.theme : "paper";
  document.documentElement.dataset.theme = theme;
  const selectedBackground = visualPreferences.background ? cssBackgroundUrl(visualPreferences.background) : THEME_BACKGROUNDS[theme];
  const welcomeBackground = visualPreferences.background
    ? selectedBackground
    : theme === "paper"
      ? DEFAULT_WELCOME_BACKGROUND
      : selectedBackground;
  document.documentElement.style.setProperty("--app-background-image", selectedBackground);
  document.documentElement.style.setProperty("--welcome-background-image", welcomeBackground);
  document.documentElement.style.setProperty("--glass-strength", String(Math.max(0.6, Math.min(1.4, visualPreferences.glassOpacity / 100))));
  document.documentElement.style.setProperty("--glass-blur-px", `${Math.max(8, Math.min(36, visualPreferences.glassBlur))}px`);
  document.documentElement.style.setProperty("--background-dim", String(Math.max(0.45, Math.min(0.85, visualPreferences.backgroundDim / 100))));
  if (appliedNativeTheme !== theme) {
    appliedNativeTheme = theme;
    void invoke("appearance.setNativeTheme", { theme }).catch(() => {});
  }
}

function cssBackgroundUrl(value) {
  return `url("${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll(")", "\\)")}")`;
}

function renderVisualSettings() {
  const theme = $("#theme-select");
  const background = $("#background-url");
  if (!theme || !background) return;
  theme.value = visualPreferences.theme;
  background.value = visualPreferences.background.startsWith("data:") ? "本地图片已设置" : visualPreferences.background;
  $("#glass-opacity").value = String(visualPreferences.glassOpacity);
  $("#glass-blur").value = String(visualPreferences.glassBlur);
  $("#background-dim").value = String(visualPreferences.backgroundDim);
  $("#glass-opacity-value").textContent = `${visualPreferences.glassOpacity}%`;
  $("#glass-blur-value").textContent = `${visualPreferences.glassBlur}px`;
  $("#background-dim-value").textContent = `${visualPreferences.backgroundDim}%`;
}

function updateVisualNumber(key, value) {
  const ranges = { glassOpacity: [60, 140], glassBlur: [8, 36], backgroundDim: [45, 85] };
  const [min, max] = ranges[key] || [0, 100];
  visualPreferences[key] = Math.max(min, Math.min(max, Number(value) || min));
  localStorage.setItem(`ego-desktop-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, String(visualPreferences[key]));
  applyVisualPreferences();
  renderVisualSettings();
  $("#appearance-status").textContent = "外观参数已更新";
}

function setCustomBackground(value) {
  if (!value) return;
  if (!/^https?:\/\//i.test(value)) {
    $("#appearance-status").textContent = "背景 URL 需要以 http:// 或 https:// 开头";
    return;
  }
  visualPreferences.background = value;
  localStorage.setItem("ego-desktop-background", value);
  applyVisualPreferences();
  $("#appearance-status").textContent = "背景已更新";
}

function resetCustomBackground() {
  visualPreferences.background = "";
  localStorage.removeItem("ego-desktop-background");
  applyVisualPreferences();
  renderVisualSettings();
  $("#appearance-status").textContent = "已恢复默认背景";
}

async function readBackgroundFile(file) {
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    $("#appearance-status").textContent = "图片太大，请选择 4 MB 以内的图片";
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  }).catch(() => "");
  if (!dataUrl) return;
  try {
    localStorage.setItem("ego-desktop-background", dataUrl);
    visualPreferences.background = dataUrl;
    applyVisualPreferences();
    renderVisualSettings();
    $("#appearance-status").textContent = "本地背景已应用";
  } catch {
    $("#appearance-status").textContent = "图片保存失败，请换一张较小的图片";
  }
}

async function applyBrowserBackend() {
  const browserBackend = $("#browser-backend-select").value;
  if (browserBackend === browserSettings.browserBackend) {
    showToast("当前浏览器模式已经生效");
    return;
  }
  const label = browserBackend === "companion" ? "复用 Edge / Chrome 登录状态" : "Ego 内置浏览器";
  if (!await confirmAction("切换浏览器模式", `将切换到“${label}”并重新启动 EgoLite。当前未完成的页面操作会停止。`, "切换并重启")) return;
  try {
    const result = await invoke("settings.setBackend", { browserBackend });
    if (result.restartRequired) await invoke("settings.restart");
    else showToast("当前浏览器模式已经生效");
  } catch (error) {
    showToast(`切换浏览器模式失败：${localizedError(error)}`, true);
  }
}

async function installCompanion() {
  try {
    const result = await invoke("companion.install");
    if (result?.started) showToast("已打开 Companion 安装向导，请按浏览器扩展页中的步骤加载扩展。");
  } catch (error) {
    showToast(`无法启动 Companion 安装：${localizedError(error)}`, true);
  }
}

async function removeSitePermission(event) {
  const button = event.target.closest("[data-permission-action=remove]");
  const row = button?.closest("[data-permission-id]");
  if (!row) return;
  await invoke("permissions.remove", { id: row.dataset.permissionId }).catch(() => false);
  await loadSitePermissions();
}

function showNextBrowserPrompt() {
  if (activeBrowserPrompt || !browserPromptQueue.length) return;
  activeBrowserPrompt = browserPromptQueue.shift();
  const prompt = activeBrowserPrompt;
  $("#browser-prompt-kind").textContent = prompt.type === "auth" ? "登录请求" : prompt.type === "certificate" ? "证书警告" : "网站请求";
  $("#browser-prompt-title").textContent = prompt.title || "网站请求";
  $("#browser-prompt-message").textContent = prompt.message || "";
  $("#browser-auth-fields").hidden = prompt.type !== "auth";
  $("#browser-prompt-remember-row").hidden = prompt.rememberAllowed === false;
  $("#browser-prompt-remember").checked = prompt.rememberAllowed !== false;
  $("#browser-prompt-remember-row span").textContent = prompt.type === "auth" ? "保存此登录信息" : "记住此网站的选择";
  const options = Array.isArray(prompt.credentialOptions) ? prompt.credentialOptions : [];
  const credentialSelect = $("#browser-auth-credential");
  credentialSelect.replaceChildren(new Option("手动输入", ""), ...options.map((credential) => new Option(credential.username || "无用户名", credential.id)));
  credentialSelect.value = prompt.prefillCredentialId || "";
  $("#browser-auth-credential-row").hidden = prompt.type !== "auth" || !options.length;
  $("#browser-auth-username").value = prompt.prefillUsername || "";
  $("#browser-auth-password").value = prompt.prefillPassword || "";
  $("#browser-prompt-allow").textContent = prompt.type === "certificate" ? "仍然继续" : prompt.type === "auth" ? "登录" : "允许";
  const dialog = $("#browser-prompt-dialog");
  try { dialog.showModal(); } catch { dialog.show(); }
  if (prompt.type === "auth") $("#browser-auth-username").focus();
}

async function loadBrowserAuthCredential() {
  if (activeBrowserPrompt?.type !== "auth") return;
  const id = $("#browser-auth-credential").value;
  if (!id) {
    $("#browser-auth-username").value = "";
    $("#browser-auth-password").value = "";
    return;
  }
  try {
    const credential = await invoke("credentials.get", {
      profileId: activeBrowserPrompt.credentialProfileId || "default",
      id,
    });
    $("#browser-auth-username").value = credential.username || "";
    $("#browser-auth-password").value = credential.password || "";
  } catch (error) {
    showToast(`无法读取登录信息 ${localizedError(error)}`, true);
  }
}

function resolveBrowserPrompt(accepted) {
  if (!activeBrowserPrompt) return;
  window.egoDesktop.respondBrowserPrompt({
    id: activeBrowserPrompt.id,
    accepted,
    remember: $("#browser-prompt-remember").checked,
    username: $("#browser-auth-username").value,
    password: $("#browser-auth-password").value,
    credentialId: activeBrowserPrompt.type === "auth" ? $("#browser-auth-credential").value : "",
  });
  activeBrowserPrompt = null;
  $("#browser-prompt-dialog").close();
  showNextBrowserPrompt();
}

function expireBrowserPrompt(id) {
  if (activeBrowserPrompt?.id === id) {
    activeBrowserPrompt = null;
    $("#browser-prompt-dialog").close();
    showNextBrowserPrompt();
    return;
  }
  const index = browserPromptQueue.findIndex((prompt) => prompt.id === id);
  if (index >= 0) browserPromptQueue.splice(index, 1);
}

function markTabCrashed(detail) {
  if (!detail?.targetId) return;
  crashedTargets.set(detail.targetId, detail);
  renderCrashPanel();
}

function clearTabCrash(targetId) {
  if (!crashedTargets.delete(targetId)) return;
  renderCrashPanel();
}

function renderCrashPanel() {
  const panel = $("#crash-panel");
  const detail = currentTab ? crashedTargets.get(currentTab.targetId) : null;
  panel.hidden = !detail;
  if (!detail) return;
  $("#crash-title").textContent = detail.title || "页面停止运行";
  $("#crash-message").textContent = detail.message || "可以重新加载页面，或关闭此标签。";
}

function reloadCrashedTab() {
  if (!currentTab) return;
  const targetId = currentTab.targetId;
  crashedTargets.delete(targetId);
  renderCrashPanel();
  webviews.get(targetId)?.reload();
}

function openTabContextMenu(event, tab, groupOnly = false) {
  event.preventDefault();
  tabMenuTarget = tab;
  tabMenuGroupId = tab.groupId || "";
  const menu = $("#tab-context-menu");
  for (const button of menu.querySelectorAll('[data-tab-scope="tab"]')) button.hidden = groupOnly;
  for (const button of menu.querySelectorAll('[data-tab-scope="group"]')) button.hidden = !tab.groupId;
  menu.querySelector(".menu-separator").hidden = groupOnly;
  menu.querySelector('[data-tab-action="pin"] span').textContent = tab.pinned ? "取消固定" : "固定标签";
  menu.querySelector('[data-tab-action="mute"] span').textContent = tab.muted ? "取消静音" : "静音标签";
  menu.querySelector('[data-tab-action="sleep"] span').textContent = tab.sleeping ? "唤醒标签" : "休眠标签";
  menu.querySelector('[data-tab-action="sleep"]').disabled = tab.pinned && !tab.sleeping;
  menu.querySelector('[data-tab-action="group"] span').textContent = tab.groupId ? "编辑标签组" : "添加到标签组";
  menu.querySelector('[data-tab-action="ungroup"]').hidden = groupOnly || !tab.groupId;
  if (tab.groupId) {
    const collapsed = isTabGroupCollapsed(tab.taskId || activeTaskId, tab.groupId);
    menu.querySelector('[data-tab-action="group-collapse"] span').textContent = collapsed ? "展开标签组" : "折叠标签组";
    const groupTabs = tabsForTask(tab.taskId || activeTaskId).filter((item) => item.groupId === tab.groupId);
    menu.querySelector('[data-tab-action="group-sleep"]').disabled = !groupTabs.some((item) => !item.pinned && !item.sleeping);
    menu.querySelector('[data-tab-action="group-close"]').disabled = !groupTabs.some((item) => !item.pinned);
  }
  const tabs = tabsForTask(tab.taskId || activeTaskId);
  const tabIndex = tabs.findIndex((item) => item.targetId === tab.targetId);
  menu.querySelector('[data-tab-action="close-right"]').disabled = !tabs.slice(tabIndex + 1).some((item) => !item.pinned);
  menu.hidden = false;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 8)}px`;
}

function hideTabContextMenu() {
  $("#tab-context-menu").hidden = true;
  tabMenuTarget = null;
  tabMenuGroupId = "";
}

async function runTabAction(action) {
  const tab = tabMenuTarget;
  const groupId = tabMenuGroupId;
  hideTabContextMenu();
  if (!tab) return;
  if (action === "duplicate") {
    await openNewTab(tab.url, state.spaces.find((item) => item.taskId === tab.taskId), { allowDuplicate: true });
    return;
  }
  if (action === "group-collapse") {
    toggleTabGroupCollapsed(tab.taskId || activeTaskId, groupId);
    return;
  }
  if (action === "group-sleep") {
    await sleepTabGroup(tab.taskId || activeTaskId, groupId);
    return;
  }
  if (action === "group-close") {
    await closeTabGroup(tab.taskId || activeTaskId, groupId);
    return;
  }
  if (action === "sleep") {
    await setTabSleeping(tab, !tab.sleeping);
    return;
  }
  if (action === "group") {
    openTabGroupDialog(tab);
    return;
  }
  if (action === "ungroup") {
    await applyTabGroup(tab, null);
    return;
  }
  if (action === "close") {
    await closeBrowserTab(tab);
    return;
  }
  if (action === "close-others" || action === "close-right") {
    const tabs = tabsForTask(activeTaskId);
    const index = tabs.findIndex((item) => item.targetId === tab.targetId);
    const targets = action === "close-right"
      ? tabs.slice(index + 1).filter((item) => !item.pinned)
      : tabs.filter((item) => item.targetId !== tab.targetId);
    if (targets.length) await closeBrowserTabs(targets);
    else showToast(action === "close-right" ? "右侧只有固定标签，没有关闭任何页面" : "没有可关闭的标签页");
    return;
  }
  const property = action === "pin" ? "pinned" : "muted";
  const previous = tab[property] === true;
  tab[property] = !previous;
  const stateTab = state.tabs.find((item) => item.targetId === tab.targetId);
  if (stateTab) stateTab[property] = tab[property];
  let webContentsId = 0;
  try { webContentsId = webviews.get(tab.targetId)?.getWebContentsId() || 0; } catch {}
  try {
    await queueTabPreferences(tab.targetId, { webContentsId, [property]: tab[property] });
  } catch (error) {
    tab[property] = previous;
    if (stateTab) stateTab[property] = previous;
    showToast(`${property === "pinned" ? "固定" : "静音"}标签失败：${localizedError(error)}`, true);
  }
  renderBrowserTabs();
}

async function setTabSleeping(tab, sleeping, options = {}) {
  if (sleeping && tab.pinned) {
    showToast("固定标签不会进入休眠");
    return;
  }
  if (sleeping && currentTab?.targetId === tab.targetId) {
    const next = tabsForTask(tab.taskId || activeTaskId).find((item) => item.targetId !== tab.targetId && !item.sleeping);
    if (next) showTab(next);
    else {
      currentTab = null;
      showWelcome();
    }
  }
  tab.sleeping = sleeping;
  const stateTab = state.tabs.find((item) => item.targetId === tab.targetId);
  if (stateTab) stateTab.sleeping = sleeping;
  await queueTabPreferences(tab.targetId, { sleeping });
  if (sleeping) {
    removeWebview(tab.targetId);
    mediaPlayingTargets.delete(tab.targetId);
    tabPreviewCache.delete(tab.targetId);
    if (!options.silent) showToast(`已休眠“${tab.title || "标签页"}”`);
  } else {
    showTab(stateTab || tab);
  }
  renderBrowserTabs();
}

async function sleepTabGroup(taskId, groupId) {
  const targets = tabsForTask(taskId).filter((tab) => tab.groupId === groupId && !tab.pinned && !tab.sleeping);
  if (!targets.length) {
    showToast("标签组中没有可休眠的页面");
    return;
  }
  for (const tab of targets) await setTabSleeping(tab, true, { silent: true });
  showToast(`已休眠标签组中的 ${targets.length} 个页面`);
}

async function closeTabGroup(taskId, groupId) {
  const groupTabs = tabsForTask(taskId).filter((tab) => tab.groupId === groupId);
  const targets = groupTabs.filter((tab) => !tab.pinned);
  if (!targets.length) {
    showToast("标签组中只有固定标签，没有关闭任何页面");
    return;
  }
  await closeBrowserTabs(targets);
  if (targets.length === groupTabs.length) setTabGroupCollapsed(taskId, groupId, false);
}

async function runAutoSleep(options = {}) {
  if (autoSleepRunning || state.backend?.kind === "companion" || !tabBehaviorPreferences.autoSleepMinutes) return;
  autoSleepRunning = true;
  try {
    const cutoff = Date.now() - tabBehaviorPreferences.autoSleepMinutes * 60_000;
    const candidates = state.tabs.filter((tab) => {
      const lastActive = tabActivityTimes.get(tab.targetId) ?? Date.parse(tab.lastActiveAt || "");
      return !tab.sleeping
        && tab.autoDiscardable !== false
        && !tab.pinned
        && tab.targetId !== currentTab?.targetId
        && !isStartPageUrl(tab.url)
        && Number.isFinite(lastActive)
        && lastActive <= cutoff
        && !mediaPlayingTargets.has(tab.targetId)
        && !isNeverSleepUrl(tab.url);
    });
    let slept = 0;
    let protectedForms = 0;
    for (const tab of candidates) {
      if (await tabHasEditedForm(tab.targetId)) {
        protectedForms += 1;
        continue;
      }
      await setTabSleeping(tab, true, { silent: true });
      slept += 1;
    }
    if (slept) updateTabBehaviorStatus(`已自动休眠 ${slept} 个闲置标签`);
    else if (options.report && protectedForms) updateTabBehaviorStatus(`${protectedForms} 个闲置标签含有未提交表单，已保持唤醒`);
    else if (options.report) updateTabBehaviorStatus("当前没有符合休眠条件的闲置标签");
  } finally {
    autoSleepRunning = false;
  }
}

const RESOURCE_POLICIES = {
  balanced: { thresholdBytes: 1_200 * 1024 * 1024, targetBytes: 900 * 1024 * 1024, minimumIdleMinutes: 10 },
  saving: { thresholdBytes: 850 * 1024 * 1024, targetBytes: 620 * 1024 * 1024, minimumIdleMinutes: 5 },
  performance: { thresholdBytes: 1_700 * 1024 * 1024, targetBytes: 1_300 * 1024 * 1024, minimumIdleMinutes: 20 },
};

function normalizeResourcePolicy(value) {
  return ["balanced", "saving", "performance", "off"].includes(value) ? value : "balanced";
}

async function refreshResourceSnapshot() {
  if (state.backend?.kind === "companion") {
    resourceSnapshot = null;
    renderResourceSnapshot("Companion 模式的页面资源由 Edge 或 Chrome 管理。");
    return null;
  }
  try {
    resourceSnapshot = await invoke("resources.snapshot");
    renderResourceSnapshot();
    return resourceSnapshot;
  } catch (error) {
    renderResourceSnapshot(`读取资源占用失败：${localizedError(error)}`);
    return null;
  }
}

function renderResourceSnapshot(message = "") {
  const snapshot = resourceSnapshot;
  $("#resource-policy").value = tabBehaviorPreferences.resourcePolicy;
  $("#resource-memory-total").textContent = snapshot ? formatBytes(snapshot.totalWorkingSetBytes) : "不可用";
  $("#resource-awake-tabs").textContent = String(snapshot?.awakeTabs ?? state.tabs.filter((tab) => !tab.sleeping).length);
  $("#resource-sleeping-tabs").textContent = String(snapshot?.sleepingTabs ?? state.tabs.filter((tab) => tab.sleeping).length);
  const list = $("#resource-heavy-tabs");
  list.replaceChildren();
  const heavyTabs = [...(snapshot?.tabs || [])].filter((tab) => !tab.sleeping && tab.estimatedBytes > 0).sort((left, right) => right.estimatedBytes - left.estimatedBytes).slice(0, 4);
  for (const tab of heavyTabs) {
    const row = document.createElement("div");
    row.className = "resource-tab-row";
    row.innerHTML = `<span class="resource-tab-icon"><i data-lucide="globe-2"></i></span><span class="resource-tab-copy"><strong>${escapeHtml(tab.title || tab.url || "标签页")}</strong><span>${escapeHtml(domainOf(tab.url) || "本地页面")}</span></span><span class="resource-tab-value">${formatBytes(tab.estimatedBytes)}</span>`;
    list.append(row);
  }
  if (!heavyTabs.length) list.innerHTML = '<div class="resource-empty">当前没有正在占用 Chromium 渲染进程的网页。</div>';
  window.lucide.createIcons({ root: list });
  const policyText = ({ balanced: "平衡模式", saving: "节省内存模式", performance: "优先性能模式", off: "自动调节已关闭" })[tabBehaviorPreferences.resourcePolicy];
  $("#resource-status").textContent = message || `${policyText}。资源紧张时只休眠闲置且可安全释放的标签。`;
}

async function runAdaptiveResourceManagement(options = {}) {
  if (resourceManagementRunning || state.backend?.kind === "companion") return;
  const policy = RESOURCE_POLICIES[tabBehaviorPreferences.resourcePolicy];
  if (!policy && !options.force) return;
  resourceManagementRunning = true;
  const button = $("#release-idle-memory");
  if (options.force) button.disabled = true;
  try {
    const snapshot = await refreshResourceSnapshot();
    if (!snapshot) return;
    const thresholdBytes = options.force ? 0 : policy.thresholdBytes;
    if (!options.force && snapshot.totalWorkingSetBytes <= thresholdBytes) {
      if (options.report) renderResourceSnapshot(`当前占用 ${formatBytes(snapshot.totalWorkingSetBytes)}，无需释放。`);
      return;
    }
    const minimumIdleMinutes = options.force ? 2 : policy.minimumIdleMinutes;
    const cutoff = Date.now() - minimumIdleMinutes * 60_000;
    const metrics = new Map(snapshot.tabs.map((tab) => [tab.targetId, tab]));
    const candidates = state.tabs.filter((tab) => {
      const lastActive = tabActivityTimes.get(tab.targetId) ?? Date.parse(tab.lastActiveAt || "");
      return !tab.sleeping
        && tab.autoDiscardable !== false
        && !tab.pinned
        && tab.targetId !== currentTab?.targetId
        && !isStartPageUrl(tab.url)
        && Number.isFinite(lastActive)
        && lastActive <= cutoff
        && !mediaPlayingTargets.has(tab.targetId)
        && !isNeverSleepUrl(tab.url);
    }).sort((left, right) => {
      const leftActive = tabActivityTimes.get(left.targetId) ?? (Date.parse(left.lastActiveAt || "") || 0);
      const rightActive = tabActivityTimes.get(right.targetId) ?? (Date.parse(right.lastActiveAt || "") || 0);
      if (leftActive !== rightActive) return leftActive - rightActive;
      return (metrics.get(right.targetId)?.estimatedBytes || 0) - (metrics.get(left.targetId)?.estimatedBytes || 0);
    });
    let estimatedRemaining = snapshot.totalWorkingSetBytes;
    let releasedBytes = 0;
    let slept = 0;
    let protectedForms = 0;
    const targetBytes = options.force ? 0 : policy.targetBytes;
    for (const tab of candidates) {
      if (!options.force && estimatedRemaining <= targetBytes) break;
      if (await tabHasEditedForm(tab.targetId)) {
        protectedForms += 1;
        continue;
      }
      const estimatedBytes = metrics.get(tab.targetId)?.estimatedBytes || 0;
      await setTabSleeping(tab, true, { silent: true });
      estimatedRemaining = Math.max(0, estimatedRemaining - estimatedBytes);
      releasedBytes += estimatedBytes;
      slept += 1;
    }
    await refreshResourceSnapshot();
    if (slept) renderResourceSnapshot(`已休眠 ${slept} 个闲置标签，预计释放 ${formatBytes(releasedBytes)}。`);
    else if (protectedForms) renderResourceSnapshot(`${protectedForms} 个闲置标签含有未提交表单，已保持唤醒。`);
    else renderResourceSnapshot("当前没有可以安全释放的闲置标签。");
  } finally {
    resourceManagementRunning = false;
    button.disabled = false;
  }
}

async function tabHasEditedForm(targetId) {
  const webview = webviews.get(targetId);
  if (!webview) return false;
  try {
    return await webview.executeJavaScript(`(() => [...document.querySelectorAll("input, textarea, select")].some((field) => {
      if (field.disabled || field.readOnly) return false;
      if (field.tagName === "SELECT") return [...field.options].some((option) => option.selected !== option.defaultSelected);
      if (field.type === "checkbox" || field.type === "radio") return field.checked !== field.defaultChecked;
      if (field.type === "file" || field.type === "password") return Boolean(field.value);
      return String(field.value ?? "") !== String(field.defaultValue ?? "");
    }))()`);
  } catch {
    return true;
  }
}

function normalizeAutoSleepMinutes(value) {
  const minutes = Number(value);
  return [0, 15, 30, 60, 120].includes(minutes) ? minutes : 30;
}

function loadNeverSleepSites() {
  try {
    const value = JSON.parse(localStorage.getItem("ego-desktop-never-sleep-sites") || "[]");
    return Array.isArray(value) ? parseNeverSleepSites(value.join(",")) : [];
  } catch {
    return [];
  }
}

function parseNeverSleepSites(value) {
  const sites = String(value || "").split(/[,，;；\s]+/).map((item) => {
    const input = item.trim().toLocaleLowerCase().replace(/^\*\./, "").replace(/^\./, "");
    if (!input) return "";
    try { return new URL(input.includes("://") ? input : `https://${input}`).hostname.toLocaleLowerCase(); } catch { return ""; }
  }).filter(Boolean);
  return [...new Set(sites)].slice(0, 100);
}

function isNeverSleepUrl(value) {
  try {
    const host = new URL(value).hostname.toLocaleLowerCase();
    return tabBehaviorPreferences.neverSleepSites.some((site) => host === site || host.endsWith(`.${site}`));
  } catch {
    return false;
  }
}

function syncTabBehaviorControls() {
  $("#auto-sleep-minutes").value = String(tabBehaviorPreferences.autoSleepMinutes);
  $("#duplicate-open-behavior").value = tabBehaviorPreferences.duplicateOpenBehavior;
  $("#never-sleep-sites").value = tabBehaviorPreferences.neverSleepSites.join(", ");
  $("#resource-policy").value = tabBehaviorPreferences.resourcePolicy;
  updateTabBehaviorStatus();
}

function updateTabBehaviorStatus(message = "") {
  const status = $("#tab-behavior-status");
  if (message) {
    status.textContent = message;
    return;
  }
  const sleep = tabBehaviorPreferences.autoSleepMinutes ? `${tabBehaviorPreferences.autoSleepMinutes} 分钟后休眠闲置标签` : "自动休眠已关闭";
  const exceptions = tabBehaviorPreferences.neverSleepSites.length ? `，${tabBehaviorPreferences.neverSleepSites.length} 个网站保持唤醒` : "";
  status.textContent = `${sleep}${exceptions}。固定标签、播放媒体和改动过表单的页面会跳过。`;
}

function scheduleTabPreview(anchor, tab) {
  clearTimeout(tabPreviewHideTimer);
  clearTimeout(tabPreviewShowTimer);
  tabPreviewShowTimer = setTimeout(() => void showTabPreview(anchor, tab), 420);
}

function scheduleTabPreviewHide() {
  clearTimeout(tabPreviewShowTimer);
  clearTimeout(tabPreviewHideTimer);
  tabPreviewHideTimer = setTimeout(hideTabPreview, 120);
}

function cancelTabPreviewHide() {
  clearTimeout(tabPreviewHideTimer);
}

function hideTabPreview() {
  tabPreviewTargetId = "";
  $("#tab-hover-preview").hidden = true;
}

async function showTabPreview(anchor, tab) {
  if (!anchor.isConnected || tabManagementMode) return;
  const preview = $("#tab-hover-preview");
  const image = preview.querySelector("img");
  const placeholder = preview.querySelector(".tab-hover-preview-placeholder");
  tabPreviewTargetId = tab.targetId;
  preview.querySelector("strong").textContent = tab.title || tab.url || "新标签页";
  preview.querySelector(".tab-hover-preview-url").textContent = displayTabUrl(tab.url);
  const details = [];
  if (tab.groupTitle) details.push(tab.groupTitle);
  if (tab.sleeping) details.push("已休眠");
  if (tab.pinned) details.push("已固定");
  if (mediaPlayingTargets.has(tab.targetId)) details.push("正在播放媒体");
  preview.querySelector(".tab-hover-preview-meta").textContent = details.join(" · ") || "活动标签";
  image.hidden = true;
  placeholder.hidden = false;
  const rect = anchor.getBoundingClientRect();
  preview.hidden = false;
  const previewWidth = preview.offsetWidth || 320;
  preview.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - previewWidth - 8))}px`;
  preview.style.top = `${Math.max(8, Math.min(window.innerHeight - preview.offsetHeight - 8, rect.bottom + 8))}px`;
  if (tab.sleeping || isStartPageUrl(tab.url)) return;
  const cached = tabPreviewCache.get(tab.targetId);
  if (cached?.url === tab.url && Date.now() - cached.createdAt < 20_000) {
    image.src = cached.image;
    image.hidden = false;
    placeholder.hidden = true;
    return;
  }
  try {
    const result = await invoke("tab.preview", { targetId: tab.targetId });
    if (!result?.image || tabPreviewTargetId !== tab.targetId) return;
    tabPreviewCache.set(tab.targetId, { url: tab.url, image: result.image, createdAt: Date.now() });
    if (tabPreviewCache.size > 24) tabPreviewCache.delete(tabPreviewCache.keys().next().value);
    image.src = result.image;
    image.hidden = false;
    placeholder.hidden = true;
  } catch {}
}

function displayTabUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "data:" ? "本地页面" : `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value || "新标签页";
  }
}

function openTabGroupDialog(tab) {
  tabGroupTarget = tab;
  const select = $("#tab-group-existing");
  const groups = tabGroupsForTask(tab.taskId || activeTaskId);
  select.replaceChildren(new Option("新建标签组", ""), ...groups.map((group) => new Option(group.title, group.id)));
  select.value = tab.groupId || "";
  $("#tab-group-name").value = tab.groupTitle || "";
  selectedTabGroupColor = safeTabGroupColor(tab.groupColor);
  renderTabGroupColors();
  $("#tab-group-dialog").showModal();
  queueMicrotask(() => (tab.groupId ? select : $("#tab-group-name")).focus());
}

function closeTabGroupDialog() {
  $("#tab-group-dialog").close();
  tabGroupTarget = null;
}

function tabGroupsForTask(taskId) {
  const groups = new Map();
  for (const tab of tabsForTask(taskId)) {
    if (!tab.groupId || groups.has(tab.groupId)) continue;
    groups.set(tab.groupId, {
      id: tab.groupId,
      title: tab.groupTitle || "标签组",
      color: safeTabGroupColor(tab.groupColor),
    });
  }
  return [...groups.values()];
}

function tabGroupPreferenceKey(taskId, groupId) {
  return `${taskId || "unassigned"}:${groupId}`;
}

function isTabGroupCollapsed(taskId, groupId) {
  return collapsedTabGroups.has(tabGroupPreferenceKey(taskId, groupId));
}

function toggleTabGroupCollapsed(taskId, groupId) {
  setTabGroupCollapsed(taskId, groupId, !isTabGroupCollapsed(taskId, groupId));
}

function setTabGroupCollapsed(taskId, groupId, collapsed) {
  if (!groupId) return;
  const key = tabGroupPreferenceKey(taskId, groupId);
  if (collapsed) collapsedTabGroups.add(key);
  else collapsedTabGroups.delete(key);
  localStorage.setItem("ego-desktop-collapsed-tab-groups", JSON.stringify([...collapsedTabGroups]));
  renderBrowserTabs();
}

function loadCollapsedTabGroups() {
  try {
    const value = JSON.parse(localStorage.getItem("ego-desktop-collapsed-tab-groups") || "[]");
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function selectExistingTabGroup() {
  const group = tabGroupsForTask(tabGroupTarget?.taskId || activeTaskId).find((item) => item.id === $("#tab-group-existing").value);
  if (!group) return;
  $("#tab-group-name").value = group.title;
  selectedTabGroupColor = group.color;
  renderTabGroupColors();
}

function renderTabGroupColors() {
  const container = $("#tab-group-color-options");
  container.innerHTML = TAB_GROUP_COLORS.map((color) => `<button class="tab-group-color ${color === selectedTabGroupColor ? "active" : ""}" type="button" data-tab-group-color="${color}" style="--tab-group-color:${color}" title="选择颜色" aria-label="选择颜色" aria-pressed="${color === selectedTabGroupColor}"></button>`).join("");
}

function selectTabGroupColor(event) {
  const button = event.target.closest("[data-tab-group-color]");
  if (!button) return;
  selectedTabGroupColor = safeTabGroupColor(button.dataset.tabGroupColor);
  renderTabGroupColors();
}

async function saveTabGroup(event) {
  event.preventDefault();
  if (!tabGroupTarget) return;
  const existingId = $("#tab-group-existing").value;
  const existing = tabGroupsForTask(tabGroupTarget.taskId || activeTaskId).find((group) => group.id === existingId);
  const title = $("#tab-group-name").value.trim() || existing?.title || "";
  if (!title) {
    $("#tab-group-name").focus();
    return;
  }
  const group = {
    id: existing?.id || `tab-group-${crypto.randomUUID()}`,
    title,
    color: existing?.color || selectedTabGroupColor,
  };
  const tab = tabGroupTarget;
  closeTabGroupDialog();
  await applyTabGroup(tab, group);
}

async function applyTabGroup(tab, group) {
  const changes = {
    groupId: group?.id || "",
    groupTitle: group?.title || "",
    groupColor: group?.color || "",
  };
  Object.assign(tab, changes);
  const stateTab = state.tabs.find((item) => item.targetId === tab.targetId);
  if (stateTab) Object.assign(stateTab, changes);
  await queueTabPreferences(tab.targetId, changes);
  if (group) await moveTabBesideGroup(tab, group.id);
  renderBrowserTabs();
  renderTabOverview();
  showToast(group ? `已加入“${group.title}”标签组` : "已移出标签组");
}

async function moveTabBesideGroup(tab, groupId) {
  const ordered = tabsForTask(tab.taskId || activeTaskId);
  const sourceIndex = ordered.findIndex((item) => item.targetId === tab.targetId);
  const otherGroupTabs = ordered.filter((item) => item.targetId !== tab.targetId && item.groupId === groupId);
  if (sourceIndex < 0 || !otherGroupTabs.length) return;
  const withoutSource = ordered.filter((item) => item.targetId !== tab.targetId);
  const lastGroupIndex = withoutSource.findLastIndex((item) => item.groupId === groupId);
  withoutSource.splice(lastGroupIndex + 1, 0, tab);
  withoutSource.forEach((item, index) => { item.order = index; });
  await invoke("tab.reorder", { taskId: tab.taskId || activeTaskId, targetIds: withoutSource.map((item) => item.targetId) });
}

function safeTabGroupColor(value) {
  return TAB_GROUP_COLORS.includes(value) ? value : TAB_GROUP_COLORS[0];
}

async function reorderTab(sourceTargetId, beforeTargetId) {
  if (!sourceTargetId || sourceTargetId === beforeTargetId) return;
  const tabs = tabsForTask(activeTaskId);
  const source = tabs.find((tab) => tab.targetId === sourceTargetId);
  const before = tabs.find((tab) => tab.targetId === beforeTargetId);
  if (!source || !before || Boolean(source.pinned) !== Boolean(before.pinned)) return;
  const ordered = tabs.filter((tab) => tab.targetId !== sourceTargetId);
  ordered.splice(ordered.findIndex((tab) => tab.targetId === beforeTargetId), 0, source);
  ordered.forEach((tab, index) => { tab.order = index; });
  await invoke("tab.reorder", { taskId: activeTaskId, targetIds: ordered.map((tab) => tab.targetId) });
  renderBrowserTabs();
}

async function registerWebview(webview = activeWebview()) {
  let id;
  try { id = webview?.getWebContentsId(); } catch { return false; }
  if (!id) return false;
  const tab = currentTab?.targetId === webview.dataset.targetId
    ? currentTab
    : state.tabs.find((item) => item.targetId === webview.dataset.targetId);
  await invoke("browser.register", {
    webContentsId: id,
    targetId: webview.dataset.targetId,
    active: currentTab?.targetId === webview.dataset.targetId && !webview.hidden,
    taskId: tab?.taskId,
    url: webview.getURL(),
    title: webview.getTitle(),
    sleeping: tab?.sleeping === true,
  }).catch(() => false);
  return true;
}

async function refreshVisualTask(taskId) {
  const deadline = Date.now() + 2000;
  do {
    const expectedRevision = refreshRevision + 1;
    if (await refresh()) {
      const task = state.spaces.find((item) => item.taskId === taskId);
      if (task) return task;
      break;
    }
    if (refreshRevision === expectedRevision) break;
    // A superseded refresh cannot establish that a newly created task is absent.
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`Task is unavailable in the desktop UI: ${taskId}`);
}

async function handleHostRequest(method, payload) {
  if (method === 'cos.showHome') { await showCosHome(); return true; }
  if (method === 'cos.groupCollapsed') {
    setTabGroupCollapsed(payload.taskId, payload.groupId, payload.collapsed === true);
    renderBrowserTabs();
    return true;
  }
  if (method === "task.visual-state") {
    const task = state.spaces.find((item) => item.taskId === activeTaskId);
    return {
      taskId: activeTaskId || null,
      taskSpaceId: task?.id || null,
      taskName: task?.name || null,
      targetId: currentTab?.targetId || null,
      webContentsId: activeWebview()?.getWebContentsId() || null,
    };
  }
  if (method === "task.visual-select") {
    return queueVisualTaskMutation(async () => {
      const task = await refreshVisualTask(payload.taskId);
      fileAttachments.clear();
      renderAttachments();
      activeTaskId = task.taskId;
      await ensureConversation(activeTaskId);
      if (chatMode === "operations") await ensureOperations(activeTaskId);
      renderActiveTaskSelect();
      renderConversation();
      const selectedTab = automaticTabForTask(tabsForTask(activeTaskId));
      switchView("start");
      if (selectedTab) await showTab(selectedTab, false);
      else showWelcome();
      return {
        taskId: activeTaskId,
        taskSpaceId: task.id,
        targetId: currentTab?.targetId || null,
        webContentsId: activeWebview()?.getWebContentsId() || null,
      };
    });
  }
  if (method === "task.visual-close") {
    return queueVisualTaskMutation(async () => {
      const wasActive = activeTaskId === payload.taskId;
      if (wasActive) {
        currentTab = null;
        activeTaskId = "";
      }
      await refresh();
      if (wasActive) {
        const selectedTab = automaticTabForTask(tabsForTask(activeTaskId));
        if (selectedTab) await showTab(selectedTab, false);
        else showWelcome();
      }
      return true;
    });
  }
  if (method === "tab.visual-bounds") {
    const tab = state.tabs.find((item) => item.targetId === payload.targetId);
    if (!tab) throw new Error(`Tab is unavailable in the desktop UI: ${payload.targetId}`);
    switchView("start");
    if (currentTab?.targetId !== tab.targetId) showTab(tab, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const webview = webviews.get(tab.targetId);
    if (!webview || webview.hidden) throw new Error(`Tab is not visible in the desktop UI: ${payload.targetId}`);
    const rect = webview.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) throw new Error(`Tab has no visible bounds: ${payload.targetId}`);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  if (method === "tab.create") {
    // Restore requests can arrive before the initial state response.
    if (!state.spaces.some((space) => space.taskId === payload.taskId)
      && payload.workspace?.taskId === payload.taskId) state.spaces.push(payload.workspace);
    if (Array.isArray(payload.profiles)) state.profiles = payload.profiles;
    const selectionRevision = tabSelectionRevision;
    let visual = payload.visual === true;
    const existingIndex = state.tabs.findIndex((item) => item.targetId === payload.targetId);
    if (existingIndex >= 0) state.tabs[existingIndex] = { ...state.tabs[existingIndex], ...payload };
    else state.tabs.push(payload);
    const tab = state.tabs[existingIndex >= 0 ? existingIndex : state.tabs.length - 1];
    if (visual) {
      await observeTaskByTaskId(payload.taskId, { quiet: true });
      visual = selectionRevision === tabSelectionRevision;
    }
    if (visual) {
      switchView("start");
    }
    const webview = ensureWebview(tab, { background: !visual });
    if (visual) showTab(tab, false);
    else if (payload.taskId === activeTaskId) renderBrowserTabs();
    else {
      renderTasks();
      renderTaskBoard();
    }
    const webContentsId = await waitForWebContentsId(webview);
    await registerWebview(webview);
    if (visual && currentTab?.targetId === tab.targetId && !webview.hidden && !isStartPageUrl(tab.url)) webview.focus();
    if (!visual && currentTab?.targetId !== tab.targetId) setWebviewVisibility(webview, false);
    setTimeout(() => void refresh(), 80);
    return { webContentsId };
  }
  if (method === "tab.activate") {
    if (Number.isInteger(payload.selectionRevision) && payload.selectionRevision !== tabSelectionRevision) return { skipped: true };
    const existingIndex = state.tabs.findIndex((item) => item.targetId === payload.targetId);
    if (existingIndex >= 0) state.tabs[existingIndex] = { ...state.tabs[existingIndex], ...payload };
    else state.tabs.push(payload);
    const tab = state.tabs[existingIndex >= 0 ? existingIndex : state.tabs.length - 1];
    const visual = payload.visual === true;
    if (visual) {
      await observeTaskByTaskId(payload.taskId, { quiet: true });
      if (Number.isInteger(payload.selectionRevision) && payload.selectionRevision !== tabSelectionRevision) return { skipped: true };
      switchView("start");
      if (currentTab?.targetId !== tab.targetId) showTab(tab, false);
    }
    const webview = ensureWebview(tab, { background: !visual && currentTab?.targetId !== tab.targetId });
    const webContentsId = webview ? await waitForWebContentsId(webview) : 0;
    if (webview) await registerWebview(webview);
    if (visual && currentTab?.targetId === tab.targetId && !webview.hidden && !isStartPageUrl(tab.url)) webview.focus();
    if (webview && !visual && currentTab?.targetId !== tab.targetId) setWebviewVisibility(webview, false);
    if (!visual) {
      if (payload.taskId === activeTaskId) renderBrowserTabs();
      else {
        renderTasks();
        renderTaskBoard();
      }
    }
    return { webContentsId };
  }
  if (method === "tab.sleep") {
    const tab = state.tabs.find((item) => item.targetId === payload.targetId);
    if (tab) tab.sleeping = true;
    removeWebview(payload.targetId);
    if (currentTab?.targetId === payload.targetId) currentTab = null;
    renderBrowserTabs();
    return true;
  }
  if (method === "tab.resolve") {
    let webview = webviews.get(payload.targetId);
    let webContentsId = 0;
    try { webContentsId = webview?.getWebContentsId() || 0; } catch {}
    if (!webContentsId) {
      removeWebview(payload.targetId);
      webview = ensureWebview(payload, { background: currentTab?.targetId !== payload.targetId });
      webContentsId = await waitForWebContentsId(webview);
    }
    await registerWebview(webview);
    return { webContentsId };
  }
  if (method === "tab.close") {
    const wasVisible = currentTab?.targetId === payload.targetId;
    const siblings = tabsForTask(payload.taskId).filter(tab => !tab.sleeping);
    const closedIndex = siblings.findIndex(tab => tab.targetId === payload.targetId);
    markAttachmentsStale(payload.targetId, true);
    removeWebview(payload.targetId);
    state.tabs = state.tabs.filter((item) => item.targetId !== payload.targetId);
    if (wasVisible) {
      currentTab = null;
      const replacement = siblings[closedIndex + 1] || siblings[closedIndex - 1];
      if (replacement) showTab(replacement, false);
      else showWelcome();
    }
    renderBrowserTabs();
    return true;
  }
  throw new Error(`Unsupported desktop host method: ${method}`);
}

async function waitForWebContentsId(webview) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    let id;
    try { id = webview.getWebContentsId(); } catch {}
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Electron WebView was not attached");
}

async function attachCurrentTab() {
  if (!currentTab) {
    $("#compose-status").textContent = "先打开一个标签";
    return;
  }
  closeContextPicker();
  await addTabAttachment(currentTab);
}

async function sendMessage() {
  if (!["chat", "codex"].includes(chatMode)) return;
  if (activeGeneration) {
    await stopGeneration();
    return;
  }
  if (!activeTaskId) await ensureQuickTask();
  const prompt = $("#prompt").value.trim();
  const context = buildContext();
  const selectedAttachments = [...fileAttachments.values()];
  if (!prompt && !context && !selectedAttachments.length) return;
  const taskId = activeTaskId;
  const mode = chatMode;
  const meta = [context ? `${readyAttachmentCount()} 个上下文` : "", selectedAttachments.length ? `${selectedAttachments.length} 个附件` : ""].filter(Boolean).join(" · ");
  addMessage(prompt || (selectedAttachments.length ? "分析所附内容" : "使用所选上下文"), "user", meta, { taskId, mode, attachments: selectedAttachments });
  $("#prompt").value = "";
  clearPromptDraft(taskId);
  const request = prompt || (selectedAttachments.length ? "请分析所附文件或图片。" : "请基于所选上下文进行总结。");
  if (mode === "codex") await sendCodexMessage(request, context, taskId, selectedAttachments);
  else await startChatGeneration(request, context, taskId, selectedAttachments);
}

async function startChatGeneration(prompt, context, taskId, selectedAttachments = []) {
  if (activeGeneration) return;
  const requestId = crypto.randomUUID();
  const record = appendAssistantDraft(taskId, "chat", prompt, context, selectedAttachments);
  activeGeneration = { requestId, taskId, mode: "chat", record, startedAt: Date.now(), statusBase: "正在生成回答" };
  setGenerating(true, "正在生成回答");
  try {
    await invoke("chat.stream.start", {
      requestId,
      taskId,
      prompt,
      context,
      attachments: selectedAttachments,
    });
    for (const attachment of selectedAttachments) fileAttachments.delete(attachment.id);
    renderAttachments();
  } catch (error) {
    finishGeneration("error", { message: error.message });
  }
}

async function sendCodexMessage(prompt, context, taskId, selectedAttachments = []) {
  if (activeGeneration) return;
  const conversation = conversationForTask(taskId);
  const requestId = crypto.randomUUID();
  const record = appendAssistantDraft(taskId, "codex", prompt, context, selectedAttachments);
  record.meta = "Codex";
  record.activities = [];
  activeGeneration = { requestId, taskId, mode: "codex", record, activities: new Map(), startedAt: Date.now(), statusBase: "Codex 正在工作" };
  setGenerating(true, "Codex 正在工作");
  try {
    await invoke("codex.stream.start", {
      requestId,
      taskId,
      prompt,
      context,
      threadId: conversation.codexThreadId,
      attachments: selectedAttachments,
    });
    for (const attachment of selectedAttachments) fileAttachments.delete(attachment.id);
    renderAttachments();
  } catch (error) {
    finishCodexGeneration("error", { message: error.message });
  }
}

function handleRuntimeEvent(method, payload) {
  if (method === "collection.changed") {
    void refresh();
    return;
  }
  if (method === "space.controlChanged") {
    if ($("#control-panel").open && payload.space?.id === controlPanelId) renderControlPanel(payload);
    return;
  }
  if (method.startsWith("chat.stream.")) handleChatStreamEvent(method, payload);
  else if (method.startsWith("codex.stream.")) handleCodexStreamEvent(method, payload);
  else if (method === "tab.changed") handleTabChanged(payload);
  else if (method === "operation.changed") handleOperationChanged(payload);
  else if (method === "operation.cleared") handleOperationCleared(payload);
  else if (method === "agent.changed") handleAgentChanged(payload?.agent);
  else if (method === "agent.disconnected") handleAgentChanged(payload?.agent);
  else if (method === "agent.integrations.changed") {
    browserSettings.localAgents = payload;
    renderLocalAgentSettings();
  }
  else if (method === "space.changed") handleSpaceChanged(payload);
}

async function refreshControlPanel() {
  const id = controlPanelId;
  try {
    const value = await invoke("control.inspect", { id });
    if (id === controlPanelId) renderControlPanel(value);
  } catch (error) { showToast(error.message, true); }
}

function renderControlPanel(value) {
  if (value.revision < controlPanelRevision) return;
  controlPanelRevision = value.revision;
  const agents = (state.agents || []).filter((agent) => agent.clientKind !== "desktop-ui");
  const displayName = (id) => !id ? "无人接管" : id.startsWith("desktop-") ? "用户" : agents.find((agent) => agent.clientId === id)?.displayName || id;
  $("#control-panel-mode").textContent = `全局模式 · ${controlModeLabel(browserSettings.controlMode)}`;
  $("#control-auto-collaboration").checked = browserSettings.autoCollaboration === true;
  $("#control-auto-collaboration").disabled = browserSettings.controlMode !== "collaborative";
  $("#control-panel-status").textContent = browserSettings.controlMode === "manual"
    ? "用户控制 · Agent 操作已禁用"
    : value.space.agentBlocked
      ? `Agent 已暂停${value.interactionPending ? " · 等待确认接管" : " · 等待批准恢复"}`
      : browserSettings.controlMode === "agent" && value.space.ownership !== "agentDelegatedToUser"
        ? "Agent 自主 · 共享操作"
      : value.controllerClientId
        ? `${displayName(value.controllerClientId)} · 持有写权限`
        : value.space.ownership === "agentDelegatedToUser"
          ? "用户控制 · Agent 无写权限"
          : "无人接管 · Agent 无写权限";
  $("#control-panel-agents").replaceChildren(...agents.map((agent) => {
    const row = document.createElement("div");
    row.textContent = `${agent.displayName || agent.clientId} · ${agent.status === "offline" ? "离线" : "在线"}${value.controllerClientId === agent.clientId ? " · 正在控制此工作区" : ""}`;
    return row;
  }));
  const select = $("#control-panel-target");
  const previous = select.value;
  select.replaceChildren(...agents.filter((agent) => agent.status !== "offline").map((agent) => new Option(agent.displayName || agent.clientId, agent.clientId)));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  const disabled = browserSettings.controlMode === "manual" || value.space.lifecycle === "closed";
  if (!select.options.length) {
    const empty = new Option("暂无在线 Agent", "");
    empty.disabled = true;
    select.replaceChildren(empty);
  }
  select.disabled = disabled || !select.value;
  $("#control-panel-assign").disabled = disabled || !select.value;
  $("#control-panel-reason").textContent = value.space.lifecycle === "closed"
    ? "当前工作区已关闭"
    : browserSettings.controlMode === "manual"
      ? "人为干预模式禁止 Agent 接管，请先切换全局模式"
      : !select.value ? "暂无在线 Agent，请先连接 Agent"
        : "批准仅对当前工作区生效";
  const requests = value.requests || [];
  $("#control-panel-requests").replaceChildren(...requests.map((request) => {
    const row = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = `${displayName(request.clientId)} · ${{ pending: "等待批准", approved: "已批准（历史记录）", cancelled: "已取消" }[request.status]} · ${new Date(request.createdAt).toLocaleTimeString()}`;
    row.append(label);
    if (request.status === "pending") {
      const button = document.createElement("button");
      button.textContent = "批准";
      button.disabled = disabled || !agents.some((agent) => agent.clientId === request.clientId && agent.status !== "offline");
      const id = value.space.id;
      button.onclick = async () => {
        button.disabled = true;
        try { await invoke("control.approve", { id, requestId: request.id }); }
        catch (error) { showToast(error.message, true); }
        await refreshControlPanel();
      };
      row.append(button);
    }
    return row;
  }));
  if (!requests.length) $("#control-panel-requests").textContent = "暂无申请";
}

async function handleUserInteraction(targetId) {
  if (!browserSettings.autoCollaboration || browserSettings.controlMode !== "collaborative" || currentTab?.targetId !== targetId || interactionPrompts.has(targetId)) return;
  interactionPrompts.add(targetId);
  try {
    const value = await invoke("desktop.userInteraction", { targetId });
    if (!value.interactionPending) return;
    if (await confirmAction("接管页面", "Agent 已暂停。确认后由你控制此工作区，取消会保留暂停状态。", "确认接管")) {
      await invoke("task.takeover", { id: value.space.id });
    }
  } catch (error) { showToast(error.message, true); }
  finally { interactionPrompts.delete(targetId); }
}

function handleAgentChanged(agent) {
  if (!agent?.clientId) return;
  const agents = Array.isArray(state.agents) ? state.agents : [];
  const index = agents.findIndex((item) => item.clientId === agent.clientId);
  if (index >= 0) agents[index] = agent; else agents.push(agent);
  if ($("#control-panel").open) void refreshControlPanel();
  state.agents = agents;
  renderAgentHud();
  scheduleAgentUiRender();
}

function scheduleAgentUiRender() {
  if (agentUiRenderTimer) return;
  agentUiRenderTimer = setTimeout(() => {
    agentUiRenderTimer = 0;
    renderTasks();
    renderTaskBoard();
  }, 16);
}

function scheduleOperationUiRender(taskId) {
  if (!taskId || taskId !== activeTaskId) return;
  pendingOperationUiTaskIds.add(taskId);
  if (operationUiRenderTimer) return;
  operationUiRenderTimer = setTimeout(() => {
    operationUiRenderTimer = 0;
    const shouldRender = pendingOperationUiTaskIds.has(activeTaskId);
    pendingOperationUiTaskIds.clear();
    if (!shouldRender) return;
    updateAssistantContext();
    if (chatMode === "operations") renderConversation();
  }, 16);
}

function handleTabChanged(payload) {
  if (!payload?.targetId || !payload.taskId) return;
  retainPendingTabPreferences(payload);
  const index = state.tabs.findIndex((tab) => tab.targetId === payload.targetId);
  if (index >= 0) state.tabs[index] = { ...state.tabs[index], ...payload };
  else state.tabs.push(payload);
  if (currentTab?.targetId === payload.targetId) {
    currentTab = state.tabs[index >= 0 ? index : state.tabs.length - 1];
    const startPage = isStartPageUrl(currentTab.url);
    $("#current-address").value = startPage ? "ego://start" : currentTab.url || "";
    $("#omnibox").value = startPage ? "" : currentTab.url || "";
  }
  if (payload.taskId === activeTaskId) {
    renderBrowserTabs();
  } else {
    // 后台任务的标签变化也要立即反映到工作区列表和任务看板。
    // 这里只更新状态展示，不切换当前工作区，也不创建前台 WebView。
    renderTasks();
    renderTaskBoard();
  }
}

function handleSpaceChanged(payload) {
  if (payload?.packageId === "cos") {
    void refresh();
    return;
  }
  const space = payload?.space;
  if (!space?.taskId) return;
  const spaces = Array.isArray(state.spaces) ? state.spaces : [];
  const index = spaces.findIndex((item) => item.taskId === space.taskId);
  if (payload.removed) {
    if (index >= 0) spaces.splice(index, 1);
  } else if (index >= 0) {
    spaces[index] = { ...spaces[index], ...space };
  } else {
    spaces.push(space);
  }
  state.spaces = spaces;
  renderActiveTaskSelect();
  renderTasks();
  renderTaskBoard();
  renderAgentHud();
}

function handleOperationChanged(payload) {
  if (!payload?.taskId || !payload.record?.id) return;
  markOperationStateChanged(payload.taskId);
  const records = operationRecords.get(payload.taskId) || [];
  const index = records.findIndex((record) => record.id === payload.record.id);
  if (index >= 0) records[index] = payload.record;
  else records.push(payload.record);
  if (records.length > 500) records.splice(0, records.length - 500);
  operationRecords.set(payload.taskId, records);
  if (payload.taskId === activeTaskId) renderAgentHud();
  scheduleOperationUiRender(payload.taskId);
}

function handleOperationCleared(payload) {
  if (!payload?.taskId) return;
  markOperationStateChanged(payload.taskId, true);
  operationRecords.set(payload.taskId, []);
  if (payload.taskId === activeTaskId) renderAgentHud();
  scheduleOperationUiRender(payload.taskId);
}

function markOperationStateChanged(taskId, cleared = false) {
  operationStateRevisions.set(taskId, (operationStateRevisions.get(taskId) || 0) + 1);
  if (cleared) operationClearRevisions.set(taskId, (operationClearRevisions.get(taskId) || 0) + 1);
}

function applyOperationSnapshot(taskId, records, revision, clearRevision) {
  const currentRevision = operationStateRevisions.get(taskId) || 0;
  const currentClearRevision = operationClearRevisions.get(taskId) || 0;
  if (currentClearRevision !== clearRevision) return operationRecords.get(taskId) || [];

  const merged = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.id) merged.set(record.id, record);
  }
  if (currentRevision !== revision) {
    for (const record of operationRecords.get(taskId) || []) {
      if (record?.id) merged.set(record.id, record);
    }
  }
  const next = [...merged.values()].sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
  if (next.length > 500) next.splice(0, next.length - 500);
  operationRecords.set(taskId, next);
  return next;
}

function handleChatStreamEvent(method, payload) {
  if (!activeGeneration || activeGeneration.requestId !== payload.requestId || activeGeneration.mode !== "chat") return;
  if (method === "chat.stream.delta") {
    activeGeneration.record.text += payload.delta || "";
    updateMessageRecord(activeGeneration.record, activeGeneration.taskId, "chat");
    return;
  }
  if (method === "chat.stream.complete") finishGeneration("complete", payload);
  else if (method === "chat.stream.cancelled") finishGeneration("cancelled", payload);
  else if (method === "chat.stream.error") finishGeneration("error", payload);
}

function handleCodexStreamEvent(method, payload) {
  const generation = activeGeneration;
  if (!generation || generation.requestId !== payload.requestId || generation.mode !== "codex") return;
  if (method === "codex.stream.event") {
    const event = payload.event || {};
    if (event.type === "thread" && event.threadId) {
      const conversation = conversationForTask(generation.taskId);
      conversation.codexThreadId = event.threadId;
      persistConversation(generation.taskId);
    } else if (event.type === "message") {
      generation.record.text = event.text || generation.record.text;
    } else if (event.type === "activity" && event.activity?.id) {
      generation.activities.set(event.activity.id, event.activity);
      generation.record.activities = [...generation.activities.values()].slice(-100);
      generation.statusBase = codexActivityStatus(event.activity);
      updateGenerationStatus();
    }
    updateMessageRecord(generation.record, generation.taskId, "codex");
    persistConversation(generation.taskId);
    return;
  }
  if (method === "codex.stream.complete") finishCodexGeneration("complete", payload);
  else if (method === "codex.stream.cancelled") finishCodexGeneration("cancelled", payload);
  else if (method === "codex.stream.error") finishCodexGeneration("error", payload);
}

function finishCodexGeneration(status, payload = {}) {
  const generation = activeGeneration;
  if (!generation || generation.mode !== "codex") return;
  const { record, taskId } = generation;
  record.durationLabel = elapsedLabel(Date.now() - generation.startedAt);
  const conversation = conversationForTask(taskId);
  if (payload.threadId) conversation.codexThreadId = payload.threadId;
  if (status === "complete") {
    record.text = payload.text || record.text || "Codex 已完成任务。";
    record.meta = payload.model || "Codex";
    record.status = "complete";
    for (const activity of record.activities || []) if (activity.status === "in_progress") activity.status = "completed";
    if (taskId === activeTaskId && chatMode === "codex") $("#compose-status").textContent = "";
  } else if (status === "cancelled") {
    record.text ||= "已停止 Codex 的后续执行。已完成的命令和文件修改不会撤销。";
    record.meta = "已停止";
    record.status = "cancelled";
    for (const activity of record.activities || []) if (activity.status === "in_progress") activity.status = "cancelled";
    if (taskId === activeTaskId && chatMode === "codex") $("#compose-status").textContent = "已停止后续执行";
  } else {
    record.text ||= payload.message || "Codex 执行失败";
    record.meta = `执行中断 · ${payload.message || "未知错误"}`;
    record.status = "error";
    for (const activity of record.activities || []) if (activity.status === "in_progress") activity.status = "failed";
    if (taskId === activeTaskId && chatMode === "codex") $("#compose-status").textContent = "执行失败";
  }
  updateMessageRecord(record, taskId, "codex");
  persistConversation(taskId);
  activeGeneration = null;
  setGenerating(false);
}

function appendAssistantDraft(taskId, mode, prompt, context, selectedAttachments = []) {
  const record = {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    meta: "Ego",
    status: "streaming",
    requestPrompt: prompt,
    requestContext: context,
    requestAttachments: selectedAttachments,
    createdAt: new Date().toISOString(),
  };
  const conversation = conversationForTask(taskId);
  conversation[mode].push(record);
  if (taskId === activeTaskId && mode === chatMode) {
    $("#messages").querySelector(".assistant-empty")?.remove();
    $("#messages").append(createMessageElement(record, mode));
    $("#messages").scrollTop = $("#messages").scrollHeight;
  }
  return record;
}

function updateMessageRecord(record, taskId, mode) {
  if (taskId !== activeTaskId || mode !== chatMode) return;
  const message = document.querySelector(`.message[data-message-id="${CSS.escape(record.id)}"]`);
  if (!message) return renderConversation();
  message.replaceWith(createMessageElement(record, mode));
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

function finishGeneration(status, payload = {}) {
  const generation = activeGeneration;
  if (!generation || generation.mode !== "chat") return;
  const { record, taskId } = generation;
  record.durationLabel = elapsedLabel(Date.now() - generation.startedAt);
  if (status === "complete") {
    record.text = payload.text || record.text;
    record.meta = payload.model || "Ego";
    record.status = "complete";
    $("#compose-status").textContent = "";
  } else if (status === "cancelled") {
    record.text ||= "已停止生成。";
    record.meta = "已停止";
    record.status = "cancelled";
    $("#compose-status").textContent = "已停止生成";
  } else {
    if (!record.text) record.role = "error";
    record.text ||= payload.message || "生成失败";
    record.meta = record.role === "assistant" ? `生成中断 · ${payload.message || "未知错误"}` : "";
    record.status = "error";
    $("#compose-status").textContent = "发送失败";
  }
  updateMessageRecord(record, taskId, "chat");
  persistConversation(taskId);
  activeGeneration = null;
  setGenerating(false);
}

async function stopGeneration() {
  const generation = activeGeneration;
  if (!generation) return;
  $("#compose-status").textContent = "正在停止";
  $("#send-message").disabled = true;
  try {
    const result = await invoke("chat.stream.cancel", { requestId: generation.requestId });
    if (!result.cancelled) {
      finishGeneration("cancelled");
    }
  } catch (error) {
    finishGeneration("error", { message: error.message });
  }
}

function setGenerating(generating, status = "") {
  const button = $("#send-message");
  button.disabled = false;
  button.classList.toggle("stop-button", generating);
  button.title = generating ? "停止生成" : "发送";
  button.innerHTML = generating ? '<i data-lucide="square"></i>' : '<i data-lucide="arrow-up"></i>';
  window.lucide.createIcons({ root: button });
  if (generationTimer) clearInterval(generationTimer);
  generationTimer = null;
  if (generating && activeGeneration) {
    if (status) activeGeneration.statusBase = status;
    updateGenerationStatus();
    generationTimer = setInterval(updateGenerationStatus, 1_000);
  } else if (status) {
    $("#compose-status").textContent = status;
  }
}

function updateGenerationStatus() {
  const generation = activeGeneration;
  if (!generation || generation.taskId !== activeTaskId || generation.mode !== chatMode) return;
  $("#compose-status").textContent = `${generation.statusBase} · ${elapsedLabel(Date.now() - generation.startedAt)}`;
}

function elapsedLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}

function codexActivityStatus(activity) {
  return ({
    command_execution: "Codex 正在执行命令",
    file_change: "Codex 正在修改文件",
    mcp_tool_call: "Codex 正在调用工具",
    web_search: "Codex 正在搜索",
    todo_list: "Codex 正在更新任务进度",
    reasoning: "Codex 正在思考",
  })[activity.type] || "Codex 正在工作";
}

function toggleContextPicker() {
  closeAttachmentMenu();
  if ($("#context-picker").hidden) openContextPicker();
  else closeContextPicker();
}

function openContextPicker() {
  $("#context-picker").hidden = false;
  $("#attach-tab").setAttribute("aria-expanded", "true");
  renderContextSources();
  queueMicrotask(() => $("#context-search").focus());
}

function closeContextPicker() {
  $("#context-picker").hidden = true;
  $("#attach-tab").setAttribute("aria-expanded", "false");
}

function toggleAttachmentMenu() {
  closeContextPicker();
  const menu = $("#attachment-menu");
  menu.hidden = !menu.hidden;
  $("#add-attachment").setAttribute("aria-expanded", String(!menu.hidden));
}

function closeAttachmentMenu() {
  $("#attachment-menu").hidden = true;
  $("#add-attachment").setAttribute("aria-expanded", "false");
}

async function addExternalAttachment(action) {
  closeAttachmentMenu();
  if (!activeTaskId) {
    $("#compose-status").textContent = "先创建一个 Task Space";
    return;
  }
  $("#compose-status").textContent = action === "page" ? "正在截取当前页面" : "正在读取附件";
  try {
    let result;
    if (action === "files") result = await invoke("attachment.pickFiles", { taskId: activeTaskId });
    else if (action === "page") {
      if (!currentTab) throw new Error("先打开一个网页标签");
      result = await invoke("attachment.capturePage", { taskId: activeTaskId, targetId: currentTab.targetId });
    } else if (action === "clipboard") result = await invoke("attachment.clipboardImage", { taskId: activeTaskId });
    const items = Array.isArray(result) ? result : result ? [result] : [];
    if (fileAttachments.size + items.length > 8) throw new Error("一次最多添加 8 个文件或图片附件");
    for (const item of items) fileAttachments.set(item.id, item);
    renderAttachments();
    $("#compose-status").textContent = items.length ? `已添加 ${items.length} 个附件` : "未选择附件";
  } catch (error) {
    $("#compose-status").textContent = error.message;
  }
}

function removeFileAttachment(id) {
  fileAttachments.delete(id);
  renderAttachments();
}

function setContextSource(source) {
  contextSource = source;
  for (const button of document.querySelectorAll(".context-source-tab")) button.classList.toggle("active", button.dataset.source === source);
  $("#context-search").value = "";
  renderContextSources();
}

function renderContextSources() {
  const list = $("#context-source-list");
  list.replaceChildren();
  const needle = $("#context-search").value.trim().toLowerCase();
  if (contextSource === "collections") {
    for (const item of state.collections) {
      if (!matchesContext(item.text, item.pageTitle, item.sourceUrl, needle)) continue;
      list.append(contextSourceRow({
        id: `collection-${item.id}`,
        title: item.text,
        subtitle: item.pageTitle || item.sourceUrl || "收藏",
        onSelect: () => addCollectionAttachment(item),
      }));
    }
  } else {
    for (const group of state.groups) {
      if (!matchesContext(group.title, group.tabs?.map((tab) => tab.title).join(" "), "", needle)) continue;
      list.append(contextSourceRow({
        id: `group-${group.id}`,
        title: group.title || "Tab Group",
        subtitle: `${group.tabs?.length || 0} 个标签`,
        onSelect: () => addGroupAttachment(group),
      }));
    }
    for (const tab of state.tabs) {
      if (!matchesContext(tab.title, tab.url, "", needle)) continue;
      list.append(contextSourceRow({
        id: `tab-${tab.id || tab.targetId}`,
        title: tab.title || tab.url,
        subtitle: tab.url,
        onSelect: () => addTabAttachment(tab),
      }));
    }
  }
  if (!list.children.length) {
    const empty = document.createElement("div");
    empty.className = "context-source-empty";
    empty.textContent = needle ? "没有匹配的来源" : "暂无可用来源";
    list.append(empty);
  }
  window.lucide.createIcons({ root: list });
}

function contextSourceRow({ id, title, subtitle, onSelect }) {
  const label = document.createElement("label");
  label.className = "context-source-row";
  label.dataset.attachmentId = id;
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = attachments.has(id);
  checkbox.addEventListener("change", () => checkbox.checked ? void onSelect() : removeAttachment(id));
  const copy = document.createElement("span");
  copy.className = "context-source-copy";
  const heading = document.createElement("span");
  heading.className = "context-source-title";
  heading.textContent = title;
  const detail = document.createElement("span");
  detail.className = "context-source-url";
  detail.textContent = subtitle;
  copy.append(heading, detail);
  label.append(checkbox, copy);
  return label;
}

async function addTabAttachment(tab, attachmentId = `tab-${tab.id || tab.targetId}`) {
  const targetId = tab.targetId || tab.id;
  const requestVersion = nextAttachmentRequest(attachmentId);
  setAttachment({ id: attachmentId, type: "tab", targetId, title: tab.title || tab.url, state: "loading", sourceUrl: tab.url, requestVersion });
  $("#compose-status").textContent = `正在读取 ${tab.title || tab.url}`;
  try {
    const page = await invoke("chat.pageContent", { targetId });
    if (!isCurrentAttachmentRequest(attachmentId, requestVersion)) return;
    const content = page?.rootNode ? treeToMarkdown(page.rootNode) : "";
    setAttachment({
      id: attachmentId,
      type: "tab",
      targetId,
      title: page?.title || tab.title || tab.url,
      sourceUrl: page?.url || tab.url,
      sourceVersion: page?.url || tab.url,
      domain: domainOf(page?.url || tab.url),
      favicon: tab.faviconUrl || "",
      content,
      state: content ? "success" : "error",
      requestVersion,
    });
    $("#compose-status").textContent = content ? "已附加页面上下文" : "页面没有可读取内容";
  } catch (error) {
    if (!isCurrentAttachmentRequest(attachmentId, requestVersion)) return;
    const existing = attachments.get(attachmentId);
    setAttachment({ ...existing, state: existing?.content ? "stale" : "error", error: error.message, requestVersion });
    $("#compose-status").textContent = "页面上下文读取失败";
  }
}

async function addGroupAttachment(group, attachmentId = `group-${group.id}`) {
  const tabs = group.tabs || [];
  const requestVersion = nextAttachmentRequest(attachmentId);
  setAttachment({ id: attachmentId, type: "group", groupId: group.id, targetIds: tabs.map((tab) => tab.targetId || tab.id), title: group.title || "Tab Group", state: "loading", requestVersion });
  $("#compose-status").textContent = `正在读取 ${tabs.length} 个标签`;
  const pages = await Promise.all(tabs.map(async (tab) => {
    try {
      const page = await invoke("chat.pageContent", { targetId: tab.targetId || tab.id });
      const content = page?.rootNode ? treeToMarkdown(page.rootNode) : "";
      return content ? wrapContext({ ...tab, title: page.title || tab.title, url: page.url || tab.url }, content) : null;
    } catch { return null; }
  }));
  if (!isCurrentAttachmentRequest(attachmentId, requestVersion)) return;
  const contexts = pages.filter(Boolean);
  const previous = attachments.get(attachmentId);
  setAttachment({
    id: attachmentId,
    type: "group",
    groupId: group.id,
    targetIds: tabs.map((tab) => tab.targetId || tab.id),
    title: group.title || "Tab Group",
    state: contexts.length ? "success" : previous?.content ? "stale" : "error",
    content: contexts.length ? `<context-group title="${escapeAttribute(group.title || "Tab Group")}" color="${escapeAttribute(group.color || "")}" count="${tabs.length}">\n${contexts.join("\n")}\n</context-group>` : previous?.content || "",
    requestVersion,
  });
  $("#compose-status").textContent = contexts.length ? `已附加 ${contexts.length} 个页面` : "标签组没有可读取内容";
}

function addCollectionAttachment(item) {
  setAttachment({
    id: `collection-${item.id}`,
    type: "collection",
    collectionId: item.id,
    title: item.pageTitle || item.text.slice(0, 48),
    state: "success",
    content: `<context type="selected-text" source="${escapeAttribute(item.sourceUrl || "")}" title="${escapeAttribute(item.pageTitle || "")}">\n${item.text}\n</context>`,
  });
  $("#compose-status").textContent = "已附加收藏内容";
}

function setAttachment(value) {
  if (!value?.id) return;
  attachments.set(value.id, { ...attachments.get(value.id), ...value });
  renderAttachments();
  if (!$("#context-picker").hidden) renderContextSources();
}

function removeAttachment(id) {
  nextAttachmentRequest(id);
  attachments.delete(id);
  renderAttachments();
  if (!$("#context-picker").hidden) renderContextSources();
}

function renderAttachments() {
  const strip = $("#context-strip");
  strip.replaceChildren();
  strip.hidden = attachments.size === 0 && fileAttachments.size === 0;
  strip.dataset.readyCount = String(readyAttachmentCount());
  for (const item of attachments.values()) {
    const chip = document.createElement("div");
    chip.className = `context-chip ${item.state}`;
    chip.dataset.attachmentId = item.id;
    chip.dataset.state = item.state;
    const icon = document.createElement("i");
    icon.dataset.lucide = item.type === "collection" ? "bookmark" : item.type === "group" ? "layers-3" : "globe-2";
    const label = document.createElement("span");
    const stateLabel = { loading: "正在读取", stale: "已变化", closed: "已关闭", error: "读取失败" }[item.state];
    label.textContent = stateLabel ? `${stateLabel} · ${item.title}` : item.title;
    label.title = item.error || item.title;
    chip.append(icon, label);
    if (["stale", "error"].includes(item.state)) {
      const refreshButton = document.createElement("button");
      refreshButton.type = "button";
      refreshButton.className = "context-chip-action context-refresh";
      refreshButton.dataset.action = "refresh";
      refreshButton.title = item.state === "stale" ? "刷新上下文" : "重试";
      refreshButton.innerHTML = '<i data-lucide="refresh-cw"></i>';
      refreshButton.addEventListener("click", () => void refreshAttachment(item.id));
      chip.append(refreshButton);
    }
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "context-chip-action context-remove";
    removeButton.dataset.action = "remove";
    removeButton.title = "移除";
    removeButton.innerHTML = '<i data-lucide="x"></i>';
    removeButton.addEventListener("click", () => removeAttachment(item.id));
    chip.append(removeButton);
    strip.append(chip);
  }
  for (const item of fileAttachments.values()) {
    const chip = document.createElement("div");
    chip.className = `context-chip file-attachment ${item.kind}`;
    chip.dataset.fileAttachmentId = item.id;
    if (item.kind === "image" && item.previewDataUrl) {
      const preview = document.createElement("img");
      preview.src = item.previewDataUrl;
      preview.alt = "";
      chip.append(preview);
    } else {
      const icon = document.createElement("i");
      icon.dataset.lucide = "file-text";
      chip.append(icon);
    }
    const label = document.createElement("span");
    label.textContent = item.name;
    label.title = `${item.name} · ${formatBytes(item.size)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "context-chip-action";
    remove.dataset.action = "remove-file";
    remove.title = "移除附件";
    remove.innerHTML = '<i data-lucide="x"></i>';
    remove.addEventListener("click", () => removeFileAttachment(item.id));
    chip.append(label, remove);
    strip.append(chip);
  }
  window.lucide.createIcons({ root: strip });
}

async function refreshAttachment(id) {
  const item = attachments.get(id);
  if (!item) return;
  if (item.type === "tab") {
    const tab = state.tabs.find((candidate) => (candidate.targetId || candidate.id) === item.targetId);
    if (!tab) return setAttachment({ ...item, state: "closed", error: "来源标签已关闭" });
    return addTabAttachment(tab, id);
  }
  if (item.type === "group") {
    const group = state.groups.find((candidate) => candidate.id === item.groupId);
    if (!group) return setAttachment({ ...item, state: "closed", error: "来源标签组已不存在" });
    return addGroupAttachment(group, id);
  }
}

function markAttachmentsStale(targetId, closed = false) {
  let changed = false;
  for (const [id, item] of attachments) {
    const affected = item.targetId === targetId || item.targetIds?.includes(targetId);
    if (!affected) continue;
    if (closed && item.state === "loading") nextAttachmentRequest(id);
    attachments.set(id, { ...item, state: closed ? "closed" : "stale", error: closed ? "来源标签已关闭" : "页面已变化，请刷新上下文" });
    changed = true;
  }
  if (changed) renderAttachments();
}

function reconcileAttachments() {
  const liveTargets = new Set(state.tabs.map((tab) => tab.targetId || tab.id));
  let changed = false;
  for (const [id, item] of attachments) {
    if (item.type === "tab" && !liveTargets.has(item.targetId) && item.state !== "closed") {
      attachments.set(id, { ...item, state: "closed", error: "来源标签已关闭" });
      changed = true;
    }
    if (item.type === "group" && item.targetIds?.some((targetId) => !liveTargets.has(targetId)) && item.state === "success") {
      attachments.set(id, { ...item, state: "stale", error: "标签组内容已变化，请刷新上下文" });
      changed = true;
    }
  }
  if (changed) renderAttachments();
}

function buildContext() {
  return [...attachments.values()].filter((item) => ["success", "stale", "closed"].includes(item.state) && item.content).map((item) => {
    if (item.type !== "tab") return item.content;
    return `<context source="${escapeAttribute(item.sourceUrl || "")}" title="${escapeAttribute(item.title)}" domain="${escapeAttribute(item.domain || "")}" favicon="${escapeAttribute(item.favicon || "")}">\n${item.content}\n</context>`;
  }).join("\n");
}

function readyAttachmentCount() {
  return [...attachments.values()].filter((item) => ["success", "stale", "closed"].includes(item.state) && item.content).length;
}

function nextAttachmentRequest(id) {
  const version = (attachmentRequests.get(id) || 0) + 1;
  attachmentRequests.set(id, version);
  return version;
}

function isCurrentAttachmentRequest(id, version) {
  return attachments.has(id) && attachmentRequests.get(id) === version;
}

function treeToMarkdown(root) {
  const output = [];
  const skipped = new Set([1, 8, 9, 10, 11, 12]);
  const text = (node) => node.textInfo?.textContent || (node.children || []).map(text).filter(Boolean).join(" ");
  const visit = (node) => {
    if (skipped.has(node.attributeType)) return;
    const value = text(node);
    if (node.attributeType === 6) { if (value) output.push(`\n## ${value}\n`); return; }
    if (node.attributeType === 4) { if (value) output.push(node.label ? `[${value}](${node.label})` : value); return; }
    if (node.attributeType === 7) { if (node.label) output.push(`[Image: ${node.label}]`); return; }
    if (node.attributeType === 18) { if (value) output.push(`- ${value}`); return; }
    if (node.attributeType === 5) { if (value) output.push(`\n${value}\n`); return; }
    if (node.attributeType === 14) { const cells = (node.children || []).map(text).filter(Boolean); if (cells.length) output.push(cells.join(" | ")); return; }
    if (node.textInfo?.textContent) output.push(node.textInfo.textContent);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function wrapContext(tab, content) {
  return `<context source="${escapeAttribute(tab.url || "")}" title="${escapeAttribute(tab.title || tab.url || "")}" domain="${escapeAttribute(domainOf(tab.url || ""))}" favicon="${escapeAttribute(tab.faviconUrl || "")}">\n${content}\n</context>`;
}

function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function matchesContext(a, b, c, needle) { return !needle || `${a || ""} ${b || ""} ${c || ""}`.toLowerCase().includes(needle); }

async function saveCurrentAddress() {
  await bookmarkLibrary.savePage(currentTab || { url: $("#current-address").value });
}

function switchView(name) {
  bookmarkLibrary.onViewChange(name);
  const settingsArea = name === "settings" || name === "agent-settings" || name === "scansci-settings";
  document.querySelectorAll(".rail-button").forEach((button) => {
    const active = button.dataset.view === (settingsArea ? "settings" : name);
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${name}-view`));
  setBrowserInteractionEnabled(name === "start");
  if (name === "start") {
    if (currentTab) void showTab(currentTab, false, false);
    else showWelcome();
  }
  $("#downloads-panel").hidden = true;
  $("#history-panel").hidden = true;
  $("#extensions-panel").hidden = true;
  if (settingsArea) {
    void loadBrowserSettings();
  }
  if (name === "settings") {
    void loadSitePermissions();
    void refreshResourceSnapshot();
  }
  if (name === "scansci-settings") void openScanSciSettings({ forceCheck: true });
}

async function openScanSciSettings({ restart = false, forceCheck = false } = {}) {
  if (scanSciLoadPromise) return scanSciLoadPromise;
  scanSciLoadPromise = (async () => {
    setScanSciBusy(true, restart ? "正在重启 ScanSci PDF" : "正在启动 ScanSci PDF");
    showScanSciError("");
    try {
      const status = await invoke(restart ? "scansci.restart" : "scansci.ensure");
      renderScanSciService(status);
      if (!status.online) throw new Error(status.error || "ScanSci 服务未就绪");
      loadScanSciWebview(status.settingsUrl);
      if (forceCheck) {
        $("#scansci-channel-state").textContent = "正在检查 8 个通道";
        const report = await invoke("scansci.checkAll");
        const failed = report.failed?.length || 0;
        $("#scansci-channel-state").textContent = failed
          ? `${report.checked} 个通道已检查，${failed} 项需处理`
          : `${report.checked} 个通道已检查`;
        renderScanSciService(report.service || status);
        const webview = $("#scansci-settings-webview");
        if (!webview.hidden && typeof webview.reload === "function") webview.reload();
      }
      return status;
    } catch (error) {
      showScanSciError(error?.message || String(error));
      $("#scansci-service-state").textContent = "启动失败";
      $("#scansci-channel-state").textContent = "检查未完成";
      return null;
    } finally {
      setScanSciBusy(false);
    }
  })();
  try {
    return await scanSciLoadPromise;
  } finally {
    scanSciLoadPromise = null;
  }
}

function loadScanSciWebview(url) {
  const webview = $("#scansci-settings-webview");
  if (!url) return;
  $("#scansci-loading").hidden = false;
  webview.hidden = false;
  if (scanSciSettingsUrl === url && typeof webview.reload === "function") webview.reload();
  else {
    scanSciSettingsUrl = url;
    webview.setAttribute("src", url);
  }
}

function renderScanSciService(status = {}) {
  $("#scansci-service-state").textContent = status.online
    ? `运行中${status.pid ? ` · PID ${status.pid}` : ""}`
    : status.state === "starting" ? "正在启动" : "已停止";
  $("#scansci-owner-state").textContent = status.managed ? "EgoLite 托管" : status.online ? "复用本机实例" : "EgoLite 待命";
  $("#scansci-project-path").textContent = status.projectDirectory || "A:\\Project\\ScanSci PDF";
  $("#scansci-project-path").title = status.projectDirectory || "";
  if (status.error) showScanSciError(status.error);
}

function setScanSciBusy(busy, message = "") {
  for (const selector of ["#scansci-refresh", "#scansci-restart", "#scansci-stop"]) $(selector).disabled = busy;
  if (busy) {
    $("#scansci-loading").hidden = false;
    $("#scansci-loading strong").textContent = message;
  }
}

function showScanSciError(message) {
  const error = $("#scansci-service-error");
  error.textContent = message || "";
  error.hidden = !message;
}

async function stopScanSciService() {
  setScanSciBusy(true, "正在停止 ScanSci PDF");
  try {
    const status = await invoke("scansci.stop");
    renderScanSciService(status);
    $("#scansci-channel-state").textContent = status.external ? "外部实例仍在运行" : "服务已停止";
    if (!status.online) {
      const webview = $("#scansci-settings-webview");
      webview.hidden = true;
      webview.setAttribute("src", "about:blank");
      scanSciSettingsUrl = "";
      $("#scansci-loading strong").textContent = "ScanSci PDF 已停止";
      $("#scansci-loading span").textContent = "再次进入页面时会自动启动";
    }
  } catch (error) {
    showScanSciError(error?.message || String(error));
  } finally {
    setScanSciBusy(false);
  }
}

function toggleWorkspaceSidebar() {
  if (sidebarCollapsed) openWorkspaceSidebar();
  else closeWorkspaceSidebar();
}

function openWorkspaceSidebar() {
  sidebarCollapsed = false;
  workspaceSidebarQuickMode = true;
  applySidebarState();
}

function closeWorkspaceSidebar() {
  sidebarCollapsed = true;
  workspaceSidebarQuickMode = false;
  applySidebarState();
}

function applySidebarState() {
  $(".app-shell").classList.toggle("sidebar-collapsed", sidebarCollapsed);
  const backdrop = $("#workspace-sidebar-backdrop");
  if (backdrop) backdrop.hidden = sidebarCollapsed;
  const quickSwitch = $("#workspace-quick-switch");
  quickSwitch.classList.toggle("active", !sidebarCollapsed);
  quickSwitch.setAttribute("aria-expanded", String(!sidebarCollapsed));
  quickSwitch.title = sidebarCollapsed ? "打开工作空间" : "收起工作空间";
  quickSwitch.setAttribute("aria-label", quickSwitch.title);
  const quickIcon = quickSwitch.querySelector(".workspace-quick-chevron");
  if (quickIcon) quickIcon.setAttribute("data-lucide", sidebarCollapsed ? "panel-left-open" : "panel-left-close");
  window.lucide.createIcons({ root: quickSwitch });
  for (const selector of ["#titlebar-toggle-sidebar", "#sidebar-collapse"]) {
    const button = $(selector);
    if (!button) continue;
    button.title = sidebarCollapsed ? "打开工作空间" : "收起工作空间";
    button.setAttribute("aria-label", button.title);
    button.innerHTML = `<i data-lucide="${sidebarCollapsed ? "panel-left-open" : "panel-left-close"}"></i>`;
    window.lucide.createIcons({ root: button });
  }
}

function toggleAssistantPanel() {
  assistantCollapsed = !assistantCollapsed;
  localStorage.setItem("ego-desktop-assistant-collapsed", assistantCollapsed ? "1" : "0");
  applyAssistantState();
}

function applyAssistantState() {
  $(".app-shell").classList.toggle("assistant-collapsed", assistantCollapsed);
  $(".app-shell").style.setProperty("--assistant-width", `${assistantWidth}px`);
  const button = $("#titlebar-toggle-assistant");
  button.title = assistantCollapsed ? "展开 Codex" : "收起 Codex";
  button.setAttribute("aria-label", button.title);
  button.innerHTML = `<i data-lucide="${assistantCollapsed ? "panel-right-open" : "panel-right-close"}"></i>`;
  window.lucide.createIcons({ root: button });
}

function bindAssistantResizer() {
  const handle = $("#assistant-resizer");
  let startX = 0;
  let startWidth = assistantWidth;
  let activePointerId = null;
  handle.addEventListener("pointerdown", (event) => {
    startX = event.clientX;
    startWidth = assistantWidth;
    activePointerId = event.pointerId;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-assistant");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    assistantWidth = Math.max(340, Math.min(Math.min(600, innerWidth * 0.48), startWidth + startX - event.clientX));
    $(".app-shell").style.setProperty("--assistant-width", `${Math.round(assistantWidth)}px`);
  });
  const finish = (event) => {
    const pointerId = event?.pointerId ?? activePointerId;
    if (pointerId != null && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    activePointerId = null;
    document.body.classList.remove("resizing-assistant");
    localStorage.setItem("ego-desktop-assistant-width", String(Math.round(assistantWidth)));
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("lostpointercapture", finish);
  window.addEventListener("blur", finish);
}

function isStartPageUrl(url) {
  return !url || url === "about:blank" || url === "ego://start";
}

function syncWindowTitle() {
  const title = !currentTab || currentTab.sleeping || isStartPageUrl(currentTab.url)
    ? "EgoLite"
    : `${browserTabTitle(currentTab)} - EgoLite`;
  if (document.title !== title) document.title = title;
}

function browserTabTitle(tab) {
  if (isStartPageUrl(tab?.url)) return "新建标签页";
  return tab?.title || tab?.url || "新建标签页";
}

function recentTabLabel(tab) {
  const title = String(tab?.title || "").trim();
  const rawUrl = String(tab?.url || "").trim();
  if (title && title !== rawUrl && !/^https?:\/\//i.test(title)) return title;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./i, "");
    const path = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    const detail = path.slice(-2).join("/");
    return detail ? `${host} · ${detail}` : host;
  } catch {
    return browserTabTitle(tab);
  }
}

function setMode(mode) {
  chatMode = "operations";
  document.querySelectorAll(".assistant-head .mode").forEach((button) => button.classList.toggle("active", button.dataset.mode === "operations"));
  $(".composer-wrap").hidden = true;
  $("#context-strip").hidden = true;
  $("#operation-toolbar").hidden = false;
  $("#clear-chat").title = "清空操作记录";
  if (activeTaskId) void ensureOperations(activeTaskId);
  renderConversation();
  updateAssistantContext();
  $("#compose-status").textContent = "";
}

function openCodexComposer() {
  if (assistantCollapsed) {
    assistantCollapsed = false;
    localStorage.setItem("ego-desktop-assistant-collapsed", "0");
    applyAssistantState();
  }
  setMode("operations");
}

async function openCodexForCurrentPage() {
  openCodexComposer();
}

function toggleExtensionsPanel() {
  const panel = $("#extensions-panel");
  panel.hidden = !panel.hidden;
  $("#history-panel").hidden = true;
  $("#downloads-panel").hidden = true;
  closeBrowserMoreMenu();
  if (!panel.hidden) renderExtensionsPanel();
}

function addMessage(text, role, meta = "", options = {}) {
  const taskId = options.taskId || activeTaskId;
  const mode = options.mode || chatMode;
  const conversation = conversationForTask(taskId);
  const record = {
    id: crypto.randomUUID(),
    role,
    text,
    meta,
    status: role === "error" ? "error" : "complete",
    requestPrompt: options.requestPrompt || "",
    requestContext: options.requestContext || "",
    attachments: options.attachments || [],
    requestAttachments: options.requestAttachments || [],
    createdAt: new Date().toISOString(),
  };
  conversation[mode].push(record);
  if (conversation[mode].length > 500) conversation[mode].splice(0, conversation[mode].length - 500);
  persistConversation(taskId);
  if (taskId !== activeTaskId || mode !== chatMode) return null;
  const message = createMessageElement(record, mode);
  $("#messages").querySelector(".assistant-empty")?.remove();
  $("#messages").append(message);
  message.scrollIntoView({ block: "end" });
  return message;
}

function createMessageElement(record, mode = chatMode) {
  const { text, role, meta = "" } = record;
  if (!record.id) record.id = crypto.randomUUID();
  $("#messages").querySelector(".assistant-empty")?.remove();
  const message = document.createElement("div");
  message.className = `message ${role}`;
  message.dataset.messageId = record.id;
  message.dataset.status = record.status || "complete";
  const body = document.createElement("div");
  body.className = "message-body";
  renderMessageBody(body, record);
  message.append(body);
  if (mode === "codex" && record.activities?.length) message.append(renderCodexActivities(record.activities));
  if (record.attachments?.length) message.append(renderMessageAttachments(record.attachments));
  const metaText = [meta, record.durationLabel].filter(Boolean).join(" · ");
  if (metaText) {
    const detail = document.createElement("div");
    detail.className = "message-meta";
    detail.textContent = metaText;
    message.append(detail);
  }
  if (["assistant", "error"].includes(role) && record.requestPrompt && record.status !== "streaming") {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "message-action";
    retry.title = "重试";
    retry.innerHTML = '<i data-lucide="rotate-ccw"></i>';
    retry.addEventListener("click", () => void retryMessage(record, mode));
    actions.append(retry);
    message.append(actions);
    window.lucide.createIcons({ root: actions });
  }
  return message;
}

function renderCodexActivities(activities) {
  const list = document.createElement("div");
  list.className = "codex-activity-list";
  const icons = {
    command_execution: "terminal",
    file_change: "file-pen-line",
    mcp_tool_call: "wrench",
    web_search: "search",
    todo_list: "list-checks",
    reasoning: "brain",
    error: "circle-alert",
  };
  for (const activity of activities) {
    const row = document.createElement("div");
    row.className = "codex-activity-row";
    row.dataset.activityId = activity.id;
    row.dataset.activityType = activity.type;
    row.dataset.status = activity.status || "in_progress";
    const icon = document.createElement("i");
    icon.dataset.lucide = icons[activity.type] || "circle-dot";
    const content = document.createElement("div");
    content.className = "codex-activity-content";
    const title = document.createElement("div");
    title.className = "codex-activity-title";
    title.textContent = activity.title || activity.type;
    content.append(title);
    if (activity.detail) {
      const details = document.createElement("details");
      details.className = "codex-activity-details";
      const summary = document.createElement("summary");
      summary.textContent = "查看详情";
      const detail = document.createElement("pre");
      detail.textContent = activity.detail;
      details.append(summary, detail);
      content.append(details);
    }
    const status = document.createElement("i");
    status.className = "codex-activity-status";
    status.dataset.lucide = activity.status === "completed" ? "check" : activity.status === "failed" ? "x" : activity.status === "cancelled" ? "square" : "loader-circle";
    row.append(icon, content, status);
    list.append(row);
  }
  window.lucide.createIcons({ root: list });
  return list;
}

function renderMessageAttachments(items) {
  const list = document.createElement("div");
  list.className = "message-attachments";
  for (const item of items) {
    const attachment = document.createElement("div");
    attachment.className = `message-attachment ${item.kind}`;
    if (item.kind === "image" && item.previewDataUrl) {
      const image = document.createElement("img");
      image.src = item.previewDataUrl;
      image.alt = item.name;
      attachment.append(image);
    } else {
      const icon = document.createElement("i");
      icon.dataset.lucide = "file-text";
      attachment.append(icon);
    }
    const copy = document.createElement("span");
    copy.textContent = item.name;
    copy.title = `${item.name} · ${formatBytes(item.size)}`;
    attachment.append(copy);
    list.append(attachment);
  }
  window.lucide.createIcons({ root: list });
  return list;
}

function renderMessageBody(body, record) {
  if (record.role !== "assistant") {
    body.textContent = record.text;
    return;
  }
  const source = record.text || (record.status === "streaming" ? "正在思考..." : "");
  const html = window.marked.parse(source, { gfm: true, breaks: true });
  body.innerHTML = window.DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
  });
  for (const link of body.querySelectorAll("a")) {
    link.target = "_blank";
    link.rel = "noreferrer noopener";
  }
  for (const pre of body.querySelectorAll("pre")) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-copy";
    copy.title = "复制代码";
    copy.innerHTML = '<i data-lucide="copy"></i>';
    copy.addEventListener("click", async () => {
      await writeClipboardText(pre.querySelector("code")?.textContent || pre.textContent || "");
      copy.title = "已复制";
    });
    pre.append(copy);
  }
  window.lucide.createIcons({ root: body });
}

async function retryMessage(record, mode) {
  if (activeGeneration || !record.requestPrompt) return;
  if (mode === "chat") await startChatGeneration(record.requestPrompt, record.requestContext || "", activeTaskId, record.requestAttachments || []);
  else await sendCodexMessage(record.requestPrompt, record.requestContext || "", activeTaskId, record.requestAttachments || []);
}

async function ensureConversation(taskId) {
  if (!taskId || conversations.has(taskId)) return conversationForTask(taskId);
  const saved = await invoke("conversation.load", { taskId }).catch(() => null);
  const conversation = normalizedConversation(saved);
  const legacyThread = localStorage.getItem("ego-desktop-codex-thread") || "";
  let migratedLegacyThread = false;
  if (!conversation.codexThreadId && legacyThread) {
    conversation.codexThreadId = legacyThread;
    localStorage.removeItem("ego-desktop-codex-thread");
    migratedLegacyThread = true;
  }
  conversations.set(taskId, conversation);
  if (migratedLegacyThread) persistConversation(taskId);
  renderConversation();
  return conversation;
}

function conversationForTask(taskId) {
  if (!conversations.has(taskId)) conversations.set(taskId, normalizedConversation());
  return conversations.get(taskId);
}

function currentConversation() {
  return conversationForTask(activeTaskId || "__unassigned__");
}

function normalizedConversation(value = {}) {
  const normalizeMessages = (messages) => Array.isArray(messages) ? messages.map((record) => {
    const interrupted = record.status === "streaming";
    return {
      ...record,
      id: record.id || crypto.randomUUID(),
      status: interrupted ? "cancelled" : (record.status || (record.role === "error" ? "error" : "complete")),
      meta: interrupted ? "上次运行已中断" : (record.meta || ""),
      requestPrompt: record.requestPrompt || "",
      requestContext: record.requestContext || "",
      attachments: Array.isArray(record.attachments) ? record.attachments : [],
      requestAttachments: Array.isArray(record.requestAttachments) ? record.requestAttachments : [],
      activities: Array.isArray(record.activities)
        ? record.activities.map((activity) => activity.status === "in_progress" ? { ...activity, status: "cancelled" } : activity)
        : [],
    };
  }) : [];
  return {
    chat: normalizeMessages(value.chat),
    codex: normalizeMessages(value.codex),
    codexThreadId: typeof value.codexThreadId === "string" ? value.codexThreadId : "",
  };
}

function renderConversation() {
  const messages = $("#messages");
  const scrollState = captureMessagesScrollState(messages);
  messages.replaceChildren();
  if (chatMode === "operations") {
    if (activeTaskId && !operationRecords.has(activeTaskId)) void ensureOperations(activeTaskId);
    const allRecords = operationRecords.get(activeTaskId) || [];
    const records = filteredOperationRecords(allRecords);
    $("#operation-filter-count").textContent = records.length === allRecords.length ? `${records.length} 项` : `${records.length}/${allRecords.length} 项`;
    if (!records.length) {
      messages.append(emptyOperations(allRecords.length > 0));
      restoreMessagesScrollState(messages, scrollState);
      return;
    }
    const fragment = document.createDocumentFragment();
    let day = "";
    for (const record of records) {
      const nextDay = operationDayLabel(record.startedAt);
      if (nextDay !== day) {
        day = nextDay;
        const heading = document.createElement("div");
        heading.className = "operation-day";
        heading.textContent = day;
        fragment.append(heading);
      }
      fragment.append(createOperationElement(record));
    }
    messages.append(fragment);
    window.lucide.createIcons({ root: messages });
    restoreMessagesScrollState(messages, scrollState);
    return;
  }
  const records = currentConversation()[chatMode];
  if (!records.length) {
    messages.append(emptyChat());
    return;
  }
  for (const record of records) messages.append(createMessageElement(record, chatMode));
  messages.scrollTop = messages.scrollHeight;
}

function captureMessagesScrollState(messages) {
  if (!messages) return null;
  const distanceFromBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  return {
    distanceFromBottom: Math.max(0, distanceFromBottom),
    followBottom: messages.scrollHeight === 0 || distanceFromBottom <= 24,
  };
}

function restoreMessagesScrollState(messages, scrollState) {
  if (!messages || !scrollState) return;
  if (scrollState.followBottom) {
    messages.scrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight);
    return;
  }
  messages.scrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight - scrollState.distanceFromBottom);
}

function persistConversation(taskId = activeTaskId) {
  if (!taskId || taskId === "__unassigned__") return;
  void invoke("conversation.save", { taskId, conversation: conversationForTask(taskId) }).catch(() => null);
}

async function clearConversation() {
  if (!activeTaskId) return;
  if (chatMode === "operations") {
    if (!await confirmAction("清空操作记录", "确定清空当前任务的全部 Agent 浏览器操作记录吗？", "清空")) return;
    try {
      await invoke("operation.clear", { taskId: activeTaskId });
      markOperationStateChanged(activeTaskId, true);
      operationRecords.set(activeTaskId, []);
      renderConversation();
      updateAssistantContext();
      showToast("已清空当前任务的操作记录");
    } catch (error) {
      showToast(`清空操作记录失败：${localizedError(error)}`, true);
    }
    return;
  }
  if (!currentConversation()[chatMode].length) return;
  if (!await confirmAction("清空聊天", "确定清空当前任务的聊天内容吗？", "清空")) return;
  if (activeGeneration?.taskId === activeTaskId && activeGeneration.mode === chatMode) await stopGeneration();
  const conversation = currentConversation();
  conversation[chatMode] = [];
  if (chatMode === "codex") conversation.codexThreadId = "";
  renderConversation();
  await invoke("conversation.clear", { taskId: activeTaskId, mode: chatMode }).catch(() => persistConversation(activeTaskId));
}

async function ensureOperations(taskId) {
  if (!taskId || operationRecords.has(taskId)) return operationRecords.get(taskId) || [];
  const revision = operationStateRevisions.get(taskId) || 0;
  const clearRevision = operationClearRevisions.get(taskId) || 0;
  operationRecords.set(taskId, []);
  const records = await invoke("operation.list", { taskId, limit: 200 }).catch(() => []);
  const next = applyOperationSnapshot(taskId, records, revision, clearRevision);
  scheduleOperationUiRender(taskId);
  return next;
}

async function refreshOperations(taskId) {
  if (!taskId) return [];
  const pending = operationRefreshes.get(taskId);
  if (pending) return pending;
  const request = (async () => {
    const revision = operationStateRevisions.get(taskId) || 0;
    const clearRevision = operationClearRevisions.get(taskId) || 0;
    const previous = operationRecords.get(taskId) || [];
    const records = await invoke("operation.list", { taskId, limit: 200 }).catch(() => null);
    if (!Array.isArray(records)) return operationRecords.get(taskId) || [];
    const next = applyOperationSnapshot(taskId, records, revision, clearRevision);
    if (!operationSnapshotsEqual(previous, next)) scheduleOperationUiRender(taskId);
    return next;
  })();
  operationRefreshes.set(taskId, request);
  try {
    return await request;
  } finally {
    if (operationRefreshes.get(taskId) === request) operationRefreshes.delete(taskId);
  }
}

function operationSnapshotsEqual(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const before = left[index] || {};
    const after = right[index] || {};
    if (before.id !== after.id
      || before.clientId !== after.clientId
      || before.tool !== after.tool
      || before.title !== after.title
      || before.detail !== after.detail
      || before.status !== after.status
      || before.startedAt !== after.startedAt
      || before.finishedAt !== after.finishedAt) return false;
  }
  return true;
}

function createOperationElement(record) {
  const row = document.createElement("article");
  row.className = "operation-record";
  row.dataset.operationId = record.id;
  row.dataset.status = record.status || "completed";
  const icon = document.createElement("i");
  icon.dataset.lucide = operationIcon(record.tool);
  const content = document.createElement("div");
  content.className = "operation-record-content";
  const title = document.createElement("strong");
  title.textContent = record.title || record.tool || "浏览器操作";
  content.append(title);
  if (record.detail) {
    const detail = document.createElement("span");
    detail.textContent = localizedOperationDetail(record.detail);
    content.append(detail);
    const raw = document.createElement("details");
    raw.className = "operation-record-detail";
    const summary = document.createElement("summary");
    summary.textContent = record.status === "failed" ? "查看失败详情" : "查看原始详情";
    const pre = document.createElement("pre");
    pre.textContent = record.detail;
    raw.append(summary, pre);
    raw.addEventListener("click", (event) => event.stopPropagation());
    content.append(raw);
  }
  if (record.status === "failed") content.append(createOperationDiagnosis(record));
  const targetUrl = operationTargetUrl(record);
  if (targetUrl) {
    row.classList.add("actionable");
    row.title = "打开相关网页";
    const url = document.createElement("span");
    url.className = "operation-record-url";
    url.textContent = "打开相关网页";
    content.append(url);
    row.addEventListener("click", () => void openOperationTarget(targetUrl));
  }
  const actions = document.createElement("div");
  actions.className = "operation-record-actions";
  if (record.status === "failed" && canRetryOperation(record)) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "icon-button operation-retry";
    retry.title = "重试此操作";
    retry.innerHTML = '<i data-lucide="rotate-ccw"></i>';
    retry.addEventListener("click", (event) => {
      event.stopPropagation();
      void retryOperation(record, retry);
    });
    actions.append(retry);
  }
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "icon-button operation-copy";
  copy.title = "复制操作详情";
  copy.innerHTML = '<i data-lucide="copy"></i>';
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    void copyOperationRecord(record, copy);
  });
  actions.append(copy);
  content.append(actions);
  const meta = document.createElement("span");
  meta.className = "operation-record-meta";
  meta.textContent = `${operationStatusText(record.status)} · ${formatOperationTime(record.finishedAt || record.startedAt)}${operationDurationText(record) ? ` · ${operationDurationText(record)}` : ""}`;
  content.append(meta);
  const status = document.createElement("i");
  status.className = "operation-record-status";
  status.dataset.lucide = record.status === "failed" ? "circle-x" : record.status === "running" ? "loader-circle" : "circle-check";
  row.append(icon, content, status);
  return row;
}

function emptyOperations(filtered = false) {
  const empty = document.createElement("div");
  empty.className = "assistant-empty";
  empty.innerHTML = filtered
    ? '<div class="mini-mark"><i data-lucide="search-x"></i></div><strong>没有匹配记录</strong><span>调整搜索文字或状态筛选。</span>'
    : '<div class="mini-mark"><i data-lucide="inbox"></i></div><strong>暂无操作记录</strong><span>从本机 Agent 发起任务后，操作会显示在这里。</span>';
  window.lucide.createIcons({ root: empty });
  return empty;
}

function filteredOperationRecords(records) {
  const needle = $("#operation-search").value.trim().toLocaleLowerCase();
  const status = $("#operation-status-filter").value;
  return records.filter((record) => {
    const statusMatches = status === "all" || record.status === status;
    const diagnosis = record.status === "failed" ? operationDiagnosis(record) : null;
    const textMatches = !needle || [record.title, record.tool, record.detail, diagnosis?.category, diagnosis?.cause, ...(diagnosis?.steps || []), operationStatusText(record.status)]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(needle));
    return statusMatches && textMatches;
  });
}

function createOperationDiagnosis(record) {
  const diagnosis = operationDiagnosis(record);
  const element = document.createElement("section");
  element.className = "operation-diagnosis";
  const heading = document.createElement("strong");
  heading.textContent = `诊断：${diagnosis.category}`;
  const cause = document.createElement("p");
  cause.textContent = diagnosis.cause;
  const steps = document.createElement("ul");
  for (const step of diagnosis.steps) {
    const item = document.createElement("li");
    item.textContent = step;
    steps.append(item);
  }
  const context = document.createElement("div");
  context.className = "operation-diagnosis-context";
  for (const value of [`工具 ${record.tool || "未知"}`, record.clientId ? `客户端 ${shortIdentifier(record.clientId)}` : "", operationDurationText(record)]) {
    if (!value) continue;
    const chip = document.createElement("span");
    chip.textContent = value;
    context.append(chip);
  }
  element.append(heading, cause, steps, context);
  element.addEventListener("click", (event) => event.stopPropagation());
  return element;
}

function operationDiagnosis(record) {
  const detail = operationDetailObject(record);
  const message = String(detail.error || record.detail || "").toLocaleLowerCase();
  if (/timeout|timed out|超时|等待.*超/.test(message)) return {
    category: "等待超时",
    cause: "页面、网络或目标元素没有在限定时间内进入预期状态。",
    steps: ["确认页面仍在加载，必要时刷新后重试。", "重新读取页面快照，避免继续使用过期元素引用。", "如果网站响应较慢，改用明确的等待条件。"],
  };
  if (/not found|no node|locator|strict|detached|stale|@ref|元素|target.*missing/.test(message)) return {
    category: "目标元素失效",
    cause: "页面结构可能已经变化，原来的元素引用或定位条件不再有效。",
    steps: ["重新读取当前页面快照。", "使用新快照中的元素引用再次执行。", "确认弹窗、遮罩或标签页切换没有改变操作上下文。"],
  };
  if (/lease|task space|under user control|inactive|unavailable|控制权|任务/.test(message)) return {
    category: "任务控制权异常",
    cause: "Codex 当前没有这个任务空间的有效控制租约，或任务已由用户接管。",
    steps: ["在任务空间列表中重新激活目标任务。", "确认没有另一个 Codex 会话正在控制同一任务。", "重新连接后再执行原操作。"],
  };
  if (/cdp|pipe|channel|disconnect|connection|browser.*unavailable|socket|econn/.test(message)) return {
    category: "浏览器连接中断",
    cause: "桌面端、Broker 或页面控制通道在执行期间断开。",
    steps: ["确认右侧状态显示浏览器已连接。", "重新选择标签页以重建页面控制通道。", "若持续失败，重启 EgoLite 后重试。"],
  };
  if (/net::|network|dns|load failed|navigation|certificate|网络|证书/.test(message)) return {
    category: "页面或网络错误",
    cause: "目标网址未能正常加载，可能是网络、证书、重定向或站点限制。",
    steps: ["直接打开相关网址检查页面状态。", "确认代理、登录状态和证书提示。", "页面恢复后重新执行操作。"],
  };
  if (/permission|denied|not allowed|权限|拒绝/.test(message)) return {
    category: "权限被拒绝",
    cause: "网站权限、系统权限或浏览器安全策略阻止了该操作。",
    steps: ["检查 EgoLite 设置中的网站权限记录。", "在页面提示中重新允许所需权限。", "确认目标操作未被网站安全策略限制。"],
  };
  return {
    category: "执行失败",
    cause: detail.error ? String(detail.error) : "操作未成功完成，但没有匹配到更具体的故障类型。",
    steps: ["打开原始详情确认失败参数。", "检查当前标签页与操作目标是否一致。", canRetryOperation(record) ? "使用重试按钮重新执行。" : "重新读取页面状态后再执行。"],
  };
}

function operationTargetUrl(record) {
  const detail = operationDetailObject(record);
  return typeof detail.url === "string" && /^(https?:|data:|file:)/i.test(detail.url) ? detail.url : "";
}

function operationDetailObject(record) {
  try { return JSON.parse(record.detail || "{}"); } catch { return {}; }
}

function canRetryOperation(record) {
  const detail = operationDetailObject(record);
  return (record.tool === "ego_open" && typeof detail.url === "string")
    || (record.tool === "ego_navigate" && ["back", "forward", "reload"].includes(detail.action))
    || (record.tool === "ego_tab_select" && typeof detail.target === "string");
}

async function retryOperation(record, button) {
  const detail = operationDetailObject(record);
  button.disabled = true;
  try {
    if (record.tool === "ego_open") {
      await openOperationTarget(detail.url);
    } else if (record.tool === "ego_navigate") {
      const webview = activeWebview();
      if (!webview) throw new Error("当前任务没有可操作的标签页");
      if (detail.action === "back") webview.goBack();
      else if (detail.action === "forward") webview.goForward();
      else webview.reload();
    } else if (record.tool === "ego_tab_select") {
      const target = String(detail.target);
      const tab = state.tabs.find((item) => item.taskId === activeTaskId && [item.targetId, item.title, item.url].some((value) => value === target || String(value || "").includes(target)));
      if (!tab) throw new Error("相关标签页已经关闭");
      switchView("start");
      showTab(tab);
    }
    button.title = "重试完成";
    showToast("已重新执行操作");
  } catch (error) {
    const message = localizedError(error);
    button.title = `重试失败：${message}`;
    showToast(message, true);
  } finally {
    button.disabled = false;
  }
}

async function openOperationTarget(url) {
  const existing = state.tabs.find((tab) => tab.taskId === activeTaskId && tab.url === url);
  if (existing) {
    switchView("start");
    showTab(existing);
    return;
  }
  await openNewTab(url);
}

function agentForTask(task) {
  if (!task || !Array.isArray(state.agents)) return null;
  const agents = state.agents.filter((agent) => agent?.clientId);
  const exact = task.lastAgentClientId ? agents.find((agent) => (
    agent.clientId === task.lastAgentClientId
    && (agent.currentTaskId === task.taskId || task.ownership === "agentDelegatedToUser")
  )) : null;
  if (exact) return exact;
  const active = agents.find((agent) => agent.currentTaskId === task.taskId && agent.clientKind !== "desktop-ui");
  if (active) return active;
  const uiAgent = agents.find((agent) => agent.currentTaskId === task.taskId && agent.currentAction);
  if (uiAgent) return uiAgent;
  if (task.ownership === "agentDelegatedToUser" && task.lastAgentClientId) {
    return { clientId: task.lastAgentClientId, clientKind: "other", displayName: "Agent", status: "offline" };
  }
  return null;
}

function operationActionText(tool = "") {
  const value = String(tool).toLocaleLowerCase();
  if (value.includes("click")) return "正在点击";
  if (value.includes("fill") || value.includes("type") || value.includes("press") || value.includes("select") || value.includes("check")) return "正在填写内容";
  if (value.includes("wait") || value.includes("response")) return "正在等待页面响应";
  if (value.includes("open") || value.includes("navigate") || value.includes("goto") || value.includes("tab")) return "正在打开网页";
  if (value.includes("snapshot") || value.includes("inspect") || value.includes("info") || value.includes("page")) return "正在读取页面";
  if (value.includes("screenshot")) return "正在截取页面";
  if (value.includes("download")) return "正在下载文件";
  if (value.includes("upload")) return "正在上传文件";
  return "正在执行操作";
}

function agentStatusText(status, blocked = false) {
  if (blocked) return "已停止";
  return ({ online: "在线", executing: "执行中", "user-control": "用户接管", offline: "离线" })[status] || "离线";
}

function elapsedText(startedAt) {
  const start = Date.parse(startedAt || "");
  if (!Number.isFinite(start)) return "--";
  const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function agentActionForTask(task, agent) {
  const userControl = browserSettings.controlHandoffEnabled === true && task?.ownership === "agentDelegatedToUser";
  if (userControl && task?.agentBlocked) return "已停止";
  if (userControl && task?.pendingAgentReturn === true) {
    return agent?.status === "offline" ? "等待 Agent 重新连接" : "等待 Agent 接管";
  }
  if (userControl) return "用户操作中";
  if (agent?.currentAction?.tool) return operationActionText(agent.currentAction.tool);
  const records = operationRecords.get(task?.taskId) || [];
  const running = [...records].reverse().find((record) => record.status === "running");
  return running ? operationActionText(running.tool) : "空闲";
}

function latestOperationRecord(records) {
  let latest = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const record of Array.isArray(records) ? records : []) {
    const timestamp = Date.parse(record?.finishedAt || record?.startedAt || "");
    const time = Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
    if (!latest || time >= latestTime) {
      latest = record;
      latestTime = time;
    }
  }
  return latest;
}

function renderAgentHud() {
  const indicator = $("#browser-codex");
  if (!indicator) return;
  const task = state.spaces.find((item) => item.taskId === activeTaskId);
  const agent = agentForTask(task);
  const handoffEnabled = browserSettings.controlHandoffEnabled === true;
  const records = operationRecords.get(task?.taskId) || [];
  const latestRecord = latestOperationRecord(records);
  const hasActiveWork = !task?.agentBlocked && agent?.status !== "offline" && (
    agent?.status === "executing"
    || Boolean(agent?.currentAction)
    || records.some((record) => record.status === "running")
  );
  const hasFailure = latestRecord?.status === "failed";
  const indicatorState = hasActiveWork ? "executing" : hasFailure ? "failed" : "idle";
  const action = task && agent ? agentActionForTask(task, agent) : "空闲";
  const duration = agent ? elapsedText(agent.activityStartedAt || agent.taskStartedAt || agent.connectedAt) : "";
  const title = indicatorState === "executing"
    ? `${agent?.displayName || "Agent"} ${action}${duration && duration !== "--" ? ` · ${duration}` : ""}`
    : indicatorState === "failed"
      ? "Agent 操作异常，点击查看记录"
      : "Agent 空闲，点击查看活动";
  indicator.dataset.agentState = indicatorState;
  indicator.title = title;
  indicator.setAttribute("aria-label", title);

  const takeover = $("#agent-hud-takeover");
  const stop = $("#agent-hud-stop");
  const returnButton = $("#agent-hud-return");
  if (!task || !agent) {
    takeover.hidden = true;
    stop.hidden = true;
    returnButton.hidden = true;
    return;
  }
  const userControl = handoffEnabled && task.ownership === "agentDelegatedToUser";
  takeover.hidden = !handoffEnabled || userControl;
  stop.hidden = !handoffEnabled || userControl;
  returnButton.hidden = !handoffEnabled || !userControl;
  if (handoffEnabled && userControl) {
    const online = agent.status !== "offline";
    const pendingReturn = task.pendingAgentReturn === true;
    returnButton.disabled = false;
    returnButton.title = pendingReturn
      ? online ? "再次尝试将控制权交还给 Agent" : "取消等待并继续由你控制"
      : online ? "将当前任务的控制权交还给原 Agent" : "允许原 Agent 连接后接管当前任务";
    returnButton.querySelector("span").textContent = pendingReturn
      ? online ? "重试归还" : "取消等待"
      : online ? "归还控制权" : "允许 Agent 接管";
  } else if (handoffEnabled) {
    takeover.disabled = false;
    stop.disabled = false;
  }
}

function updateAgentHud() {
  renderAgentHud();
}

async function takeOverCurrentTask() {
  const task = state.spaces.find((item) => item.taskId === activeTaskId);
  if (!task) return;
  if (browserSettings.controlHandoffEnabled !== true) {
    showToast("控制权交接功能已关闭", true);
    return;
  }
  try {
    await invoke("task.takeover", { id: task.id });
    await refresh();
    showToast("已接管当前任务");
  } catch (error) { showToast(`接管失败：${localizedError(error)}`, true); }
}

async function stopCurrentTask() {
  const task = state.spaces.find((item) => item.taskId === activeTaskId);
  if (!task) return;
  if (browserSettings.controlHandoffEnabled !== true) {
    showToast("控制权交接功能已关闭", true);
    return;
  }
  const accepted = await confirmAction("停止 Agent", `将停止 ${agentForTask(task)?.displayName || "Agent"} 在“${task.name}”中的后续操作。标签页和页面状态会保留。`, "停止任务");
  if (!accepted) return;
  try { await invoke("task.stop", { id: task.id }); await refresh(); showToast("Agent 已停止，页面状态已保留"); }
  catch (error) { showToast(`停止失败：${localizedError(error)}`, true); }
}

async function returnCurrentTaskToAgent() {
  const task = state.spaces.find((item) => item.taskId === activeTaskId);
  const agent = agentForTask(task);
  if (!task || !agent) return;
  if (browserSettings.controlHandoffEnabled !== true) {
    showToast("控制权交接功能已关闭", true);
    return;
  }
  const pendingReturn = task.pendingAgentReturn === true;
  const button = $("#agent-hud-return");
  if (pendingReturn && agent.status === "offline") {
    button.disabled = true;
    button.querySelector("span").textContent = "正在取消…";
    try {
      await invoke("task.takeover", { id: task.id });
      await refresh();
      showToast("已取消归还，当前仍由你控制");
    } catch (error) {
      showToast(`取消失败：${localizedError(error)}`, true);
      renderAgentHud();
    }
    return;
  }
  if (!pendingReturn && browserSettings.controlConsentEnabled === true && browserSettings.controlConsentLevel === "strict") {
    const accepted = await confirmAction("归还控制权", `将允许 ${agent.displayName || "Agent"} 继续操作“${task.name}”。`, "确认归还");
    if (!accepted) return;
  }
  button.disabled = true;
  button.querySelector("span").textContent = pendingReturn ? "正在重试…" : agent.status === "offline" ? "正在允许…" : "正在归还…";
  try {
    const returned = await invoke("task.return", { id: task.id });
    const remainsPending = returned?.ownership === "agentDelegatedToUser" && returned?.pendingAgentReturn === true;
    if (!remainsPending && returned?.ownership !== "agent") throw new Error("Broker did not restore Agent ownership");
    await refresh();
    showToast(remainsPending
      ? pendingReturn ? "Agent 尚未完成连接，已继续等待" : `已允许 ${agent.displayName || "Agent"} 连接后接管`
      : `控制权已归还给 ${agent.displayName}`);
  } catch (error) {
    showToast(`归还失败：${localizedError(error)}`, true);
    renderAgentHud();
  }
}

function updateAssistantContext() {
  const task = state.spaces.find((item) => item.taskId === activeTaskId);
  $("#assistant-task-label").textContent = task ? `当前任务：${task.name}` : "尚未选择任务";
  const status = $("#operation-live-status");
  if (chatMode !== "operations") {
    status.textContent = state.backend?.ready ? "浏览器已连接" : "浏览器离线";
    status.className = `operation-live-status ${state.backend?.ready ? "running" : "failed"}`;
    renderAgentHud();
    return;
  }
  const records = operationRecords.get(activeTaskId) || [];
  const running = records.filter((record) => record.status === "running").length;
  const failed = records.filter((record) => record.status === "failed").length;
  status.textContent = running ? `Agent 正在执行 ${running} 项` : failed ? `最近有 ${failed} 项失败` : records.length ? `已记录 ${records.length} 项` : "Agent 空闲";
  status.className = `operation-live-status ${running ? "running" : failed ? "failed" : ""}`;
  renderAgentHud();
}

function promptDraftKey(taskId = activeTaskId) {
  return taskId ? `ego-desktop-prompt-draft:${taskId}` : "";
}

function savePromptDraftSoon() {
  if (!activeTaskId) return;
  clearTimeout(promptDraftSaveTimer);
  promptDraftSaveTimer = setTimeout(() => {
    const key = promptDraftKey();
    const value = $("#prompt").value;
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  }, 120);
}

function restorePromptDraft() {
  if (!activeTaskId || promptDraftTaskId === activeTaskId) return;
  promptDraftTaskId = activeTaskId;
  const draft = localStorage.getItem(promptDraftKey()) || "";
  if (!$("#prompt").value.trim() && draft) {
    $("#prompt").value = draft;
    $("#compose-status").textContent = "已恢复未发送草稿";
  }
}

function clearPromptDraft(taskId = activeTaskId) {
  if (!taskId) return;
  localStorage.removeItem(promptDraftKey(taskId));
  if (promptDraftTaskId === taskId) $("#compose-status").textContent = "";
}

function operationIcon(tool = "") {
  if (tool.includes("click")) return "mouse-pointer-click";
  if (tool.includes("fill") || tool.includes("type") || tool.includes("press")) return "keyboard";
  if (tool.includes("snapshot") || tool.includes("inspect") || tool.includes("info")) return "scan-text";
  if (tool.includes("open") || tool.includes("navigate") || tool.includes("tab")) return "globe-2";
  if (tool.includes("screenshot")) return "camera";
  if (tool.includes("download")) return "download";
  if (tool.includes("upload")) return "upload";
  return "wrench";
}

function operationStatusText(status) {
  return status === "failed" ? "失败" : status === "running" ? "执行中" : "已完成";
}

function operationDayLabel(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "时间未知";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const key = date.toLocaleDateString("zh-CN");
  if (key === today.toLocaleDateString("zh-CN")) return "今天";
  if (key === yesterday.toLocaleDateString("zh-CN")) return "昨天";
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

async function copyOperationRecord(record, button) {
  const diagnosis = record.status === "failed" ? operationDiagnosis(record) : null;
  const text = [
    record.title || record.tool,
    `状态：${operationStatusText(record.status)}`,
    `工具：${record.tool || "未知"}`,
    `操作 ID：${record.id || "未知"}`,
    `开始时间：${new Date(record.startedAt || Date.now()).toLocaleString("zh-CN")}`,
    operationDurationText(record) ? `耗时：${operationDurationText(record)}` : "",
    localizedOperationDetail(record.detail || ""),
    diagnosis ? `诊断：${diagnosis.category}\n原因：${diagnosis.cause}\n建议：${diagnosis.steps.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  await writeClipboardText(text);
  button.title = "已复制";
  showToast("操作详情已复制");
}

async function writeClipboardText(text) {
  await invoke("clipboard.writeText", { text: String(text || "") });
}

function operationDurationText(record) {
  if (!record?.startedAt || !record?.finishedAt) return "";
  const duration = new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime();
  if (!Number.isFinite(duration) || duration < 0) return "";
  return duration < 1000 ? `${duration} 毫秒` : `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)} 秒`;
}

function shortIdentifier(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
}

function formatOperationTime(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? "刚刚" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function localizedOperationDetail(value) {
  try {
    const detail = JSON.parse(value);
    return Object.entries(detail).map(([key, item]) => `${({ target: "目标", source: "来源", action: "动作", scope: "范围", url: "网址", method: "方法", state: "状态", key: "按键", accept: "接受", checked: "选中", content: "内容", error: "错误" })[key] || key}：${String(item)}`).join(" · ");
  } catch {
    return value;
  }
}

function emptyChat() {
  const element = document.createElement("div");
  element.className = "assistant-empty";
  element.innerHTML = chatMode === "codex"
    ? '<div class="mini-mark">e</div><strong>和当前页面一起工作</strong><span>添加网页、收藏、文件或截图，Codex 可以继续分析并执行任务。</span>'
    : '<div class="mini-mark">e</div><strong>可以开始了</strong><span>我可以读取当前任务空间中的网页、选中文本和收藏内容。</span>';
  return element;
}

function normalizedDuplicateUrl(value) {
  const input = String(value || "").trim();
  if (!input || isStartPageUrl(input) || input === "about:blank") return "";
  try {
    const url = new URL(input);
    if (url.protocol === "data:") {
      try { return `data:${decodeURIComponent(input.slice(5))}`; } catch { return input; }
    }
    if (!["http:", "https:"].includes(url.protocol)) return url.toString();
    url.hash = "";
    url.hostname = url.hostname.toLocaleLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

function duplicateTabGroups(tabs = state.tabs) {
  const groups = new Map();
  for (const tab of tabs) {
    const key = normalizedDuplicateUrl(tab.url);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(tab);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, tabs: group }));
}

function duplicateTabsToClose() {
  const result = [];
  for (const group of duplicateTabGroups()) {
    const protectedIds = new Set(group.tabs
      .filter((tab) => tab.pinned || tab.targetId === currentTab?.targetId)
      .map((tab) => tab.targetId));
    if (!protectedIds.size) {
      const keeper = [...group.tabs].sort((left, right) => String(right.lastActiveAt || "").localeCompare(String(left.lastActiveAt || "")))[0];
      if (keeper) protectedIds.add(keeper.targetId);
    }
    result.push(...group.tabs.filter((tab) => !protectedIds.has(tab.targetId)));
  }
  return result;
}

function duplicateGroupTitle(key, tab) {
  try {
    const url = new URL(key);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.hostname}${path}`.slice(0, 80);
  } catch {
    return tab?.title || "重复页面";
  }
}

async function closeDuplicateTabs() {
  const targets = duplicateTabsToClose();
  if (!targets.length) {
    showToast("没有可安全清理的重复标签");
    return;
  }
  if (targets.length > 5 && !await confirmAction("清理重复标签", `将关闭 ${targets.length} 个重复标签，当前标签和固定标签会保留。`, "清理")) return;
  const closedIds = [];
  for (const tab of targets) {
    await invoke("tab.close", { targetId: tab.targetId });
    const closed = rememberClosedTab(tab);
    closedIds.push(closed.id);
    markAttachmentsStale(tab.targetId, true);
    removeWebview(tab.targetId);
    selectedTabIds.delete(tab.targetId);
  }
  if (closedTabs.length > 50) closedTabs.splice(0, closedTabs.length - 50);
  persistClosedTabs();
  renderHistory();
  const closingTargets = new Set(targets.map((tab) => tab.targetId));
  recentTabIds = recentTabIds.filter((id) => !closingTargets.has(id));
  persistRecentTabIds();
  await refresh();
  showClosedTabsUndo(closedIds);
  if (!$("#tab-overview").hidden) renderTabOverview();
}

function tabsForTask(taskId) {
  return state.tabs
    .filter((tab) => tab.taskId === taskId)
    .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || Number(left.order ?? 1e9) - Number(right.order ?? 1e9));
}
function activeWebview() { return currentTab ? webviews.get(currentTab.targetId) : undefined; }
function currentWebContentsId() { try { return activeWebview()?.getWebContentsId() || 0; } catch { return 0; } }
function backendName(value) { return ({ managed: "托管 Edge", companion: "浏览器伴侣", desktop: "Ego 桌面", fake: "测试后端" })[value] || "浏览器后端"; }
function ownershipName(value) { return ({ agent: "可由 Codex 操作", agentDelegatedToUser: "用户操作中", user: "待激活" })[value] || "待激活"; }
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function escapeAttribute(value) { return escapeHtml(value); }
function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 * 1024 ? 0 : 1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function loadRecentTabIds() {
  try {
    const value = JSON.parse(localStorage.getItem("ego-desktop-recent-tabs") || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string").slice(0, 100) : [];
  } catch {
    return [];
  }
}
function persistRecentTabIds() {
  localStorage.setItem("ego-desktop-recent-tabs", JSON.stringify(recentTabIds.slice(0, 100)));
}
function rememberRecentTab(targetId) {
  if (!targetId) return;
  recentTabIds = [targetId, ...recentTabIds.filter((id) => id !== targetId)].slice(0, 100);
  persistRecentTabIds();
}
function recentTabsForTask(taskId) {
  const tabs = tabsForTask(taskId);
  const byId = new Map(tabs.map((tab) => [tab.targetId, tab]));
  const recent = recentTabIds.map((id) => byId.get(id)).filter(Boolean);
  for (const tab of tabs) if (!recent.some((item) => item.targetId === tab.targetId)) recent.push(tab);
  return recent;
}
function showRecentTabSwitcher(selectedId) {
  const switcher = $("#recent-tab-switcher");
  const tabs = recentTabsForTask(activeTaskId).slice(0, 6);
  if (tabs.length < 2) return;
  switcher.innerHTML = `<strong>最近使用</strong><div>${tabs.map((tab) => `<span class="recent-tab-switcher-item ${tab.targetId === selectedId ? "active" : ""}">${tab.faviconUrl ? `<img src="${escapeAttribute(tab.faviconUrl)}" alt="">` : '<i data-lucide="globe-2"></i>'}<span>${escapeHtml(tab.title || tab.url || "新标签页")}</span></span>`).join("")}</div>`;
  switcher.hidden = false;
  window.lucide.createIcons({ root: switcher });
  clearTimeout(recentSwitcherTimer);
  recentSwitcherTimer = setTimeout(() => { switcher.hidden = true; }, 900);
}
function loadClosedTabs() {
  try {
    const value = JSON.parse(localStorage.getItem("ego-desktop-closed-tabs") || "[]");
    return Array.isArray(value) ? value.filter((tab) => tab && typeof tab.url === "string").slice(-50) : [];
  } catch {
    return [];
  }
}
function loadWebsiteHistory() {
  try {
    const value = JSON.parse(localStorage.getItem("ego-desktop-website-history") || "[]");
    return Array.isArray(value) ? value.filter((item) => item && typeof item.url === "string" && /^https?:/i.test(item.url)).slice(-1000) : [];
  } catch {
    return [];
  }
}
function mergeImportedWebsiteHistory(entries) {
  const incoming = Array.isArray(entries) ? entries : [];
  const knownUrls = new Set(websiteHistory.map((item) => String(item.url || "").trim().toLocaleLowerCase()));
  let added = 0;
  let skipped = 0;
  for (const entry of [...incoming].sort((left, right) => String(left.visitedAt || "").localeCompare(String(right.visitedAt || "")))) {
    const url = String(entry?.url || "").trim();
    const key = url.toLocaleLowerCase();
    if (!/^https?:/i.test(url) || knownUrls.has(key)) {
      skipped += 1;
      continue;
    }
    knownUrls.add(key);
    websiteHistory.push({
      id: crypto.randomUUID(),
      taskId: "",
      targetId: "",
      url,
      title: String(entry.title || domainOf(url) || url),
      visitedAt: Number.isNaN(Date.parse(entry.visitedAt)) ? new Date().toISOString() : new Date(entry.visitedAt).toISOString(),
      ...(Number(entry.visitCount) > 0 ? { visitCount: Number(entry.visitCount) } : {}),
    });
    added += 1;
  }
  websiteHistory.sort((left, right) => String(left.visitedAt).localeCompare(String(right.visitedAt)));
  if (websiteHistory.length > 1000) websiteHistory.splice(0, websiteHistory.length - 1000);
  if (added) persistWebsiteHistory();
  if (!$("#history-panel").hidden && historyMode === "visits") renderHistory();
  return { added, skipped };
}
async function migrateLegacyImportedHistory() {
  if (localStorage.getItem("ego-desktop-history-import-migration") === "1" || !state.backend?.ready || legacyHistoryMigrationRunning) return;
  legacyHistoryMigrationRunning = true;
  try {
    const legacy = state.collections.filter((item) => legacyImportedHistory(item) && /^https?:/i.test(String(item.sourceUrl || "")));
    if (!legacy.length) {
      localStorage.setItem("ego-desktop-history-import-migration", "1");
      return;
    }
    mergeImportedWebsiteHistory(legacy.map((item) => ({
      url: item.sourceUrl,
      title: item.text,
      visitedAt: item.createdAt,
      visitCount: legacyImportedHistory(item)?.visits,
    })));
    await invoke("collection.delete", { ids: legacy.map((item) => item.id) });
    localStorage.setItem("ego-desktop-history-import-migration", "1");
    await refresh();
  } finally {
    legacyHistoryMigrationRunning = false;
  }
}
function recordWebsiteVisit(tab) {
  const url = String(tab?.url || "");
  if (!/^https?:/i.test(url)) return;
  const now = new Date().toISOString();
  const latest = websiteHistory[websiteHistory.length - 1];
  if (latest && latest.url === url && latest.taskId === tab.taskId && Date.now() - new Date(latest.visitedAt).getTime() < 30_000) {
    latest.title = tab.title || latest.title;
    latest.targetId = tab.targetId || latest.targetId;
    latest.visitedAt = now;
  } else {
    websiteHistory.push({ id: crypto.randomUUID(), taskId: tab.taskId || activeTaskId, targetId: tab.targetId || "", url, title: tab.title || domainOf(url) || url, visitedAt: now });
  }
  if (websiteHistory.length > 1000) websiteHistory.splice(0, websiteHistory.length - 1000);
  persistWebsiteHistory();
  if (!$("#history-panel").hidden && historyMode === "visits") renderHistory();
}
function updateWebsiteHistoryTitle(targetId, title) {
  if (!targetId || !title) return;
  const item = [...websiteHistory].reverse().find((record) => record.targetId === targetId);
  if (!item || item.title === title) return;
  item.title = title;
  persistWebsiteHistory();
  if (!$("#history-panel").hidden && historyMode === "visits") renderHistory();
}
function persistWebsiteHistory() {
  localStorage.setItem("ego-desktop-website-history", JSON.stringify(websiteHistory.slice(-1000)));
}
function persistClosedTabs() {
  localStorage.setItem("ego-desktop-closed-tabs", JSON.stringify(closedTabs.slice(-50)));
}
function formatClosedTime(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? "刚刚" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function normalizedInputUrl(value) {
  const text = String(value || "").trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  if (text.includes(".") && !text.includes(" ")) return `https://${text}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}
function confirmAction(title, message, acceptLabel = "确认") {
  const dialog = $("#confirm-dialog");
  if (confirmResolver) {
    const resolvePrevious = confirmResolver;
    confirmResolver = null;
    resolvePrevious(false);
  }
  if (dialog.open) dialog.close("cancel");
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  $("#confirm-accept").textContent = acceptLabel;
  dialog.returnValue = "";
  return new Promise((resolve) => {
    confirmResolver = resolve;
    dialog.showModal();
  });
}
function showToast(message, error = false) {
  const toast = document.createElement("div");
  toast.className = `toast ${error ? "error" : ""}`;
  toast.textContent = message;
  $("#toast-stack").append(toast);
  setTimeout(() => toast.remove(), 3600);
}
function showActionToast(message, actionLabel, action, className = "") {
  const toast = document.createElement("div");
  toast.className = `toast action-toast ${className}`.trim();
  const copy = document.createElement("span");
  copy.textContent = message;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = actionLabel;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await action();
      toast.remove();
    } catch (error) {
      toast.remove();
      showToast(localizedError(error), true);
    }
  });
  toast.append(copy, button);
  $("#toast-stack").append(toast);
  setTimeout(() => toast.remove(), 6000);
}
function showClosedTabsUndo(ids) {
  const validIds = ids.filter(Boolean);
  if (!validIds.length) return;
  for (const toast of document.querySelectorAll(".closed-tabs-toast")) toast.remove();
  showActionToast(`已关闭 ${validIds.length === 1 ? "标签页" : `${validIds.length} 个标签页`}`, "撤销", async () => {
    for (const id of validIds) {
      const index = closedTabs.findIndex((tab) => tab.id === id);
      if (index >= 0) await reopenClosedTab(index);
    }
  }, "closed-tabs-toast");
}
function localizedError(error) {
  const code = error?.code || error?.error_code;
  return ({
    EGO_TASK_SPACE_UNAVAILABLE: "这个任务正在被另一个控制端使用，请稍后重试。",
    EGO_TASK_SPACE_USER_IN_CONTROL: "任务当前由用户控制，无法切换控制权。",
    EGO_TASK_SPACE_INACTIVE: "任务尚未激活。",
    EGO_BROWSER_UNAVAILABLE: "浏览器后端暂时不可用。",
    EGO_CDP_CHANNEL_UNAVAILABLE: "页面控制通道暂时不可用。",
  })[code] || error?.message || "操作失败，请重试。";
}
function debounce(fn, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }
