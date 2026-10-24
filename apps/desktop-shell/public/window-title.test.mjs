import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  const end = source.slice(start).search(/^}/m);
  assert.ok(end >= 0, `${name} closing brace`);
  return source.slice(start, start + end + 1);
}

function harness() {
  const noop = () => {};
  const context = vm.createContext({
    document: { title: "登录 | 腾讯招聘 - Ego" },
    translation: { pageChanged: noop },
    currentTab: null, activeTaskId: "task", tabSelectionRevision: 0,
    pendingTabPreferences: new Map(),
    state: { tabs: [], backend: { kind: "desktop" } },
    $: () => ({ classList: { add: noop, remove: noop } }),
    tabActivityTimes: new Map(), webviews: new Map(),
    mediaPlayingTargets: new Set(), tabPreviewCache: new Map(),
    selectedTabIds: new Set(), recentTabIds: [], closedTabs: [],
    hideTabPreview: noop, rememberRecentTab: noop, setWebviewVisibility: noop,
    updateZoomLabel: noop, closeFindBar: noop, renderCrashPanel: noop,
    registerWebview: noop, updateBrowserToolbar: noop, renderRecentTabs: noop,
    updateWebsiteHistoryTitle: noop, removeWebview: noop, showToast: noop,
    ensureWebview: () => ({}),
    queueTabPreferences: async () => {}, queueVisualTabActivation: async () => {},
    persistClosedTabs: noop, renderHistory: noop, markAttachmentsStale: noop,
    persistRecentTabIds: noop, refresh: async () => {}, showClosedTabsUndo: noop,
    rememberClosedTab: (tab) => ({ id: tab.targetId }),
  });
  vm.runInContext([
    "retainPendingTabPreferences", "isStartPageUrl", "browserTabTitle", "syncWindowTitle", "showTab",
    "showWelcome", "bindWebviewEvents", "setTabSleeping", "closeBrowserTabs",
  ].map(extract).join("\n"), context);
  vm.runInContext(`
    function renderBrowserTabs() { syncWindowTitle(); }
    function tabsForTask(taskId) { return state.tabs.filter(tab => tab.taskId === taskId); }
    async function invoke(method, payload) {
      if (method === "tab.close") state.tabs = state.tabs.filter(tab => tab.targetId !== payload.targetId);
    }
  `, context);
  return context;
}

const tab = (id, title = id) => ({ targetId: id, taskId: "task", url: `https://${id}.example`, title });

test("switching existing tabs updates the title without a page title event or tab render", async () => {
  const ctx = harness();
  const a = tab("a", "Tencent login");
  const b = tab("b", "WebVPN");
  ctx.state.tabs = [a, b];
  await ctx.showTab(a, false, false);
  assert.equal(ctx.document.title, "Tencent login - EgoLite");
  await ctx.showTab(b, false, false);
  assert.equal(ctx.document.title, "WebVPN - EgoLite");
});

test("welcome and start tabs clear the previous title", async () => {
  const ctx = harness();
  ctx.showWelcome();
  assert.equal(ctx.document.title, "EgoLite");
  for (const url of ["ego://start", "about:blank", ""]) {
    await ctx.showTab({ ...tab("start", "Stale title"), url }, false, false);
    assert.equal(ctx.document.title, "EgoLite");
  }
});

test("sleeping the only active tab returns to the home title and waking restores it", async () => {
  const ctx = harness();
  const current = tab("vpn", "WebVPN");
  ctx.state.tabs = [current];
  await ctx.showTab(current, false);
  await ctx.setTabSleeping(current, true);
  assert.equal(ctx.document.title, "EgoLite");
  await ctx.setTabSleeping(current, false);
  assert.equal(ctx.document.title, "WebVPN - EgoLite");
});

test("closing the current tab uses the next tab title, then the home title", async () => {
  const ctx = harness();
  const a = tab("login", "Tencent login");
  const b = tab("vpn", "WebVPN");
  ctx.state.tabs = [a, b];
  await ctx.showTab(a, false);
  await ctx.closeBrowserTabs([a]);
  assert.equal(ctx.document.title, "WebVPN - EgoLite");
  await ctx.closeBrowserTabs([b]);
  assert.equal(ctx.document.title, "EgoLite");
});

test("only foreground page title events update the window title, including after returning home", async () => {
  const ctx = harness();
  const a = tab("a");
  const b = tab("b");
  ctx.state.tabs = [a, b];
  const listeners = new Map();
  for (const item of [a, b]) {
    ctx.bindWebviewEvents({ addEventListener: (name, fn) => listeners.set(`${item.targetId}:${name}`, fn) }, item.targetId);
  }
  await ctx.showTab(a, false);
  listeners.get("a:page-title-updated")({ title: "Updated" });
  assert.equal(ctx.document.title, "Updated - EgoLite");
  listeners.get("b:page-title-updated")({ title: "Background login" });
  assert.equal(ctx.document.title, "Updated - EgoLite");
  ctx.showWelcome();
  listeners.get("a:page-title-updated")({ title: "Late event" });
  assert.equal(ctx.document.title, "EgoLite");
});

test("untitled pages use their URL and sleeping tabs cannot leave a stale title", () => {
  const ctx = harness();
  ctx.currentTab = tab("untitled", "");
  ctx.syncWindowTitle();
  assert.equal(ctx.document.title, "https://untitled.example - EgoLite");
  ctx.currentTab.sleeping = true;
  ctx.syncWindowTitle();
  assert.equal(ctx.document.title, "EgoLite");
});
