import {
  browserEgo,
  clearPreferredTarget,
  ensureSession,
  invalidateSession,
  isBrowserRuntime,
  pendingDialog,
  setPreferredTarget
} from "../browser-runtime.js";
import { cdp, evaluate } from "../cdp-eval.js";
import { assertNoEgoError } from "../ego-errors.js";
import { state } from "../state.js";
import { clearScopedReferenceState } from "../ref-state.js";
import { waitForDocumentLoad } from "./load.js";
const INTERNAL_URL_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "devtools://",
  "chrome-extension://",
  "about:"
];
async function goto(url, options = {}) {
  const navigation = await cdp("Page.navigate", { url });
  const loaded = options.waitUntil === "commit" ? false : await waitForDocumentLoad({
    timeout: options.timeout ?? 2e4,
    until: options.waitUntil === "domcontentloaded" ? "domcontentloaded" : "load"
  });
  const settle = Number(options.settle ?? 0);
  if (settle > 0) {
    await state.sleep(settle);
  }
  return { navigation, loaded };
}
async function navigateHistory(delta, options = {}) {
  const history = await cdp("Page.getNavigationHistory");
  const targetIndex = Number(history.currentIndex) + delta;
  const entry = history.entries?.[targetIndex];
  if (!entry) return null;
  await cdp("Page.navigateToHistoryEntry", { entryId: entry.id });
  if (options.waitUntil !== "commit") {
    await waitForDocumentLoad({
      timeout: options.timeout ?? 2e4,
      until: options.waitUntil === "domcontentloaded" ? "domcontentloaded" : "load"
    });
  }
  return pageInfo();
}
async function goBack(options = {}) {
  return navigateHistory(-1, options);
}
async function goForward(options = {}) {
  return navigateHistory(1, options);
}
async function pageInfo() {
  if (isBrowserRuntime()) {
    await ensureSession();
    const dialog = pendingDialog();
    if (dialog) {
      return { dialog };
    }
  }
  const expression = `(() => {
    const root = document.documentElement;
    return JSON.stringify({
      url: location.href,
      title: document.title,
      w: innerWidth,
      h: innerHeight,
      sx: scrollX,
      sy: scrollY,
      pw: root?.scrollWidth ?? innerWidth,
      ph: root?.scrollHeight ?? innerHeight,
    });
  })()`;
  return JSON.parse(await evaluate(expression));
}
async function listTabs(options = {}) {
  const includeChrome = options.includeChrome ?? true;
  const result = assertNoEgoError(await browserEgo().listTabs(), "listTabs");
  const tabs = result.tabs || [];
  return tabs.filter(
    (tab) => includeChrome || !INTERNAL_URL_PREFIXES.some(
      (prefix) => (tab.url || "").startsWith(prefix)
    )
  ).map((tab) => ({
    targetId: tab.targetId,
    title: tab.title || "",
    url: tab.url || "",
    active: Boolean(tab.active),
    index: tab.index
  }));
}
async function currentTab() {
  const tabs = await listTabs();
  const active = tabs.find((tab) => tab.active) || tabs[0];
  if (!active) {
    throw new Error("no active browser tab");
  }
  return { targetId: active.targetId, url: active.url, title: active.title };
}
async function switchTab(target) {
  const tabs = await listTabs();
  const targetId = resolveTabTarget(tabs, target, "switchTab").targetId;
  await cdp("Target.activateTarget", { targetId });
  clearScopedReferenceState();
  invalidateSession();
  setPreferredTarget(targetId);
  return targetId;
}
async function newTab(url = "about:blank") {
  const result = assertNoEgoError(await browserEgo().createTab(url), "newTab");
  if (!result.targetId) {
    throw new Error("newTab returned no targetId");
  }
  return result.targetId;
}
async function openOrReuseTab(url, options = {}) {
  const ego = browserEgo();
  if (typeof ego.openOrReuseTab !== "function") throw new Error("Atomic tab.openOrReuse requires an updated Ego runtime");
  const result = assertNoEgoError(await ego.openOrReuseTab(url, options.match || "exact"), "openOrReuseTab");
  clearScopedReferenceState();
  invalidateSession();
  setPreferredTarget(result.targetId);
  if (result.reused ? options.wait : options.wait !== false) await waitForDocumentLoad({ timeout: options.timeout ?? 2e4 });
  if (Number(options.settle ?? 0) > 0) await state.sleep(Number(options.settle));
  return result;
}
async function closeTab(target = void 0) {
  const tabs = await listTabs();
  const targetId = target === void 0
    ? (tabs.find((tab) => tab.active) || tabs[0])?.targetId
    : resolveTabTarget(tabs, target, "closeTab").targetId;
  if (!targetId) throw new Error("closeTab requires a targetId");
  await cdp("Target.closeTarget", { targetId });
  clearScopedReferenceState();
  invalidateSession();
  if (state.preferredTargetId === targetId) {
    clearPreferredTarget();
  }
  if (tabs.length > 1) {
    await waitForClosedTarget(targetId);
  }
  return targetId;
}
async function ensureRealTab() {
  const tabs = await listTabs({ includeChrome: false });
  if (tabs.length === 0) {
    return null;
  }
  const current = await currentTab().catch(() => null);
  if (current?.url && !INTERNAL_URL_PREFIXES.some((prefix) => current.url.startsWith(prefix))) {
    return current;
  }
  await switchTab(tabs[0].targetId);
  return tabs[0];
}
async function iframeTarget(urlSubstring) {
  const targets = (await cdp("Target.getTargets")).targetInfos || [];
  return targets.find(
    (target) => target.type === "iframe" && (target.url || "").includes(urlSubstring)
  )?.targetId || null;
}
function targetIdFrom(target, operation) {
  const targetId = typeof target === "string" ? target : target && typeof target === "object" ? target.targetId : void 0;
  if (typeof targetId !== "string" || !targetId) {
    throw new Error(
      `${operation} requires a targetId; received ${JSON.stringify(target)}`
    );
  }
  return targetId;
}
function resolveTabTarget(tabs, target, operation) {
  if (target && typeof target === "object" && typeof target.targetId === "string") {
    return currentTargetFrom(tabs, target.targetId, operation);
  }
  if (typeof target !== "string" || !target) {
    throw new Error(`${operation} requires a targetId, exact title, or URL`);
  }
  const exact = tabs.filter((tab) => tab.targetId === target || tab.title === target || tab.url === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`${operation} target is ambiguous: ${JSON.stringify(target)}`);
  const partial = tabs.filter((tab) => tab.title.includes(target) || tab.url.includes(target));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`${operation} target matches multiple tabs: ${JSON.stringify(partial)}`);
  }
  currentTargetFrom(tabs, target, operation);
}
function currentTargetFrom(tabs, targetId, operation) {
  const tab = tabs.find((candidate) => candidate.targetId === targetId);
  if (tab) return tab;
  const available = tabs.map(({ targetId: targetId2, title, url }) => ({
    targetId: targetId2,
    title,
    url
  }));
  throw new Error(
    `${operation} target not found: ${JSON.stringify(targetId)}. Refresh browser.listTabs() and select a current targetId. Available tabs: ${JSON.stringify(available)}`
  );
}
async function waitForClosedTarget(targetId) {
  const deadline = state.now() + 2e3;
  while (true) {
    const tabs = await listTabs();
    if (!tabs.some((tab) => tab.targetId === targetId)) return tabs;
    if (state.now() >= deadline) {
      throw new Error(
        `closeTab timed out waiting for target to close: ${JSON.stringify(targetId)}`
      );
    }
    await state.sleep(50);
  }
}
export {
  INTERNAL_URL_PREFIXES,
  closeTab,
  currentTab,
  ensureRealTab,
  goBack,
  goForward,
  goto,
  iframeTarget,
  listTabs,
  newTab,
  openOrReuseTab,
  pageInfo,
  switchTab
};
