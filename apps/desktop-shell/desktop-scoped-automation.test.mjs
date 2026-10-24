import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { MutationGate } from "./mutation-gate.mjs";
import { DesktopReferenceRegistry } from "./desktop-reference-registry.mjs";
import { DesktopFrameRouter } from "./desktop-frame-router.mjs";
import { DesktopBrowserController } from "./desktop-browser-controller.mjs";
import {
  DesktopScopedAutomation,
  invokeAfterFinalAuthorization,
  scopedCommandRequiresBoundFocus,
  scopedCommandRequiresExactObject,
} from "./desktop-scoped-automation.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function stateHarness(request) {
  const cancellations = [];
  const context = vm.createContext({
    automationDecisions: { invalidate() {} },
    pageTranslations: { jobs: new Map() },
    rpc: { request }, clientId: "desktop-ui", backendConnectionGeneration: 1, setTimeout, clearTimeout,
    brokerSpaceStateRevision: 0, brokerAgentStateRevision: 0,
    brokerSpaceStates: new Map(), brokerAgentStates: new Map(), recentDesktopAgentTasks: new Set(),
    desktopScopedAutomation: { cancelTask: (...args) => cancellations.push(args) },
    process: { env: {} }, mainWindow: undefined,
    homeBarShortcut: "", homeBarShortcutRegistered: false, tray: undefined,
    desktopPreferences: {}, agentIntegrationStatus: () => ({}),
    desktopScopedNativeConfigurations: new Map(), writeDiagnostic() {},
    listBrowserExtensions: () => [], listBrowserProfiles: () => [],
    cosWorkspace: { enabled: false, taskId: undefined, describe: () => ({ enabled: false }), async restore() {} },
  });
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  for (const name of ["updateBrokerSpaceState", "updateBrokerAgentState", "replaceBrokerSpaceStates", "replaceBrokerAgentStates", "loadState", "connectBackend", "desktopTarget", "sendDesktopCdp", "sendDesktopScopedRawCdp", "notifyDesktopCdp", "assertDesktopScopedNativeSession", "bootstrapDesktopScopedFrameTree", "configureDesktopScopedNativeSession", "sameDesktopScopedNativeAuthority", "pruneDesktopScopedNativeConfigurations", "awaitDesktopScopedInitialization", "resumeDesktopScopedNativeConfigurations", "drainDesktopScopedRouterEffects", "ensureDesktopScopedPage"]) {
    const source = main.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
    assert.ok(source, name);
    vm.runInContext(source, context);
  }
  return { context, cancellations };
}

test("loaded root and nested iframe trees are registered before their default execution contexts", async () => {
  const { context } = stateHarness();
  let id = 0;
  const router = new DesktopFrameRouter({ createId: (kind) => `${kind}-${++id}`, nativeSend: async () => ({}) });
  const page = pageScope();
  router.registerPage({ ...page, profileId: "profile-1", webContentsId: 101, rootTargetId: "root-target", rootFrameId: "root-frame" });
  const tree = (frameId, parentId, childFrames = []) => ({ frame: { id: frameId, ...(parentId ? { parentId } : {}), loaderId: `loader-${frameId}`, url: `https://fixture.test/${frameId}` }, childFrames });
  const nested = tree("nested-frame", "cross-frame");
  const cross = tree("cross-frame", "root-frame", [nested]);
  const trees = new Map([[undefined, tree("root-frame", undefined, [tree("same-frame", "root-frame"), cross])], ["cross-session", cross], ["nested-session", nested]]);
  const contextIds = new Map([[undefined, [["root-frame", 1], ["same-frame", 2]]], ["cross-session", [["cross-frame", 3]]], ["nested-session", [["nested-frame", 4]]]]);
  const calls = [];
  Object.assign(context, { desktopFrameRouter: router, desktopBrowser: { async sendNativeCommand(_target, method, _params, sessionId) {
    calls.push({ method, sessionId });
    if (method === "Page.getFrameTree") return { frameTree: trees.get(sessionId) };
    if (method === "Runtime.enable") for (const [frameId, contextId] of contextIds.get(sessionId)) router.applyDebuggerEvent({ pageScope: page, sourceElectronSessionId: sessionId,
      method: "Runtime.executionContextCreated", params: { context: { id: contextId, uniqueId: `context-${contextId}`, auxData: { isDefault: true, frameId } } } });
    return {};
  } } });
  await context.configureDesktopScopedNativeSession(page, {});
  router.applyDebuggerEvent({ pageScope: page, method: "Target.attachedToTarget", params: { sessionId: "cross-session", targetInfo: { targetId: "cross-target", type: "iframe" } } });
  await context.configureDesktopScopedNativeSession(page, {}, "cross-session");
  router.applyDebuggerEvent({ pageScope: page, sourceElectronSessionId: "cross-session", method: "Target.attachedToTarget", params: { sessionId: "nested-session", targetInfo: { targetId: "nested-target", type: "iframe" } } });
  await context.configureDesktopScopedNativeSession(page, {}, "nested-session");
  assert.deepEqual(router.listFrameRoutes(page).map((route) => [route.identity.frameId, route.transportState]), [
    ["root-frame", "root"], ["same-frame", "same_process"], ["cross-frame", "oopif"], ["nested-frame", "oopif"],
  ]);
  for (const sessionId of trees.keys()) {
    const methods = calls.filter((call) => call.sessionId === sessionId).map((call) => call.method);
    assert.ok(methods.indexOf("Page.getFrameTree") < methods.indexOf("Runtime.enable"));
  }
  const stamp = router.captureNativeSession(page, "cross-session");
  router.applyDebuggerEvent({ pageScope: page, method: "Target.detachedFromTarget", params: { sessionId: "cross-session" } });
  assert.throws(() => context.bootstrapDesktopScopedFrameTree(page, "cross-session", cross, stamp));
});

function configurationHarness(onTree) {
  const { context } = stateHarness();
  const page = pageScope();
  const calls = [];
  const slots = new Map(["child", "sibling"].map((sessionId) => [sessionId, { key: `native-${sessionId}`, generation: 0, live: true, ready: false }]));
  const source = (sessionId) => {
    const slot = slots.get(sessionId);
    if (!slot?.live) throw Object.assign(new Error("detached"), { code: "DETACHED_SESSION" });
    return { ...page, electronSessionId: sessionId, nativeSessionKey: slot.key, nativeSessionGeneration: slot.generation,
      frameId: `${sessionId}-frame`, parentNativeSessionKey: slot.parentKey || "native-root",
      pageIncarnationId: slot.incarnation || "incarnation-1", webContentsId: slot.webContentsId || 101 };
  };
  let effects = [];
  const tab = { taskId: page.taskId, targetId: page.pageId };
  Object.assign(context, { desktopTabs: new Map([[tab.targetId, tab]]),
    desktopScopedPagePromises: new Map([[`${tab.taskId}\u0000${tab.targetId}`, Promise.resolve(page)]]),
    scopedReferencesEnabled: true, initializeDesktopScopedAutomation() {}, desktopRuntimeId: page.runtimeId,
    scopedPageScope: () => page, desktopTarget: async () => ({ id: 101 }),
    desktopScopedAutomation: { consumeRouterEffects: (items) => items },
    desktopFrameRouter: {
      captureNativeSession: (_scope, sessionId) => source(sessionId),
      takeEffects: () => { const result = effects; effects = []; return result; },
      applyDebuggerEvent() {},
    },
    desktopBrowser: { async sendNativeCommand(_target, method, _params, sessionId) {
      calls.push({ method, sessionId });
      if (method === "Page.getFrameTree") {
        await onTree?.(slots.get(sessionId), sessionId);
        return { frameTree: { frame: { id: `${sessionId}-frame`, parentId: "root-frame", loaderId: "loaded-document" } } };
      }
      if (method === "Runtime.enable") slots.get(sessionId).ready = true;
      return {};
    } },
  });
  return { context, calls, slots, source, tab,
    effects(...sessionIds) { effects = sessionIds.map((sessionId) => ({ type: "configure_native_session", pageScope: page,
      nativeSessionKey: source(sessionId).nativeSessionKey, nativeSessionGeneration: source(sessionId).nativeSessionGeneration,
      electronSessionId: sessionId })); },
    ensure: () => context.ensureDesktopScopedPage(tab, { id: 101 }),
    count: (method, sessionId = "child") => calls.filter((call) => call.method === method && call.sessionId === sessionId).length,
  };
}

test("natural source generation change during initialization rereads only the tree and sends no input", async () => {
  let reads = 0;
  const subject = configurationHarness((slot) => { if (++reads === 1) slot.generation += 1; });
  subject.effects("child");
  await subject.context.drainDesktopScopedRouterEffects();
  assert.equal(subject.count("Page.enable"), 1);
  assert.equal(subject.count("Page.getFrameTree"), 2);
  assert.equal(subject.count("Runtime.enable"), 1);
  assert.equal(subject.slots.get("child").ready, true);
  assert.equal(subject.context.desktopScopedNativeConfigurations.size, 0);
  assert.equal(subject.calls.some((call) => call.method.startsWith("Input.")), false);
});

test("exhausted configuration remains explicitly resumable without another Page.enable", async () => {
  let unstable = true;
  const subject = configurationHarness((slot) => { if (unstable) slot.generation += 1; });
  subject.effects("child");
  await subject.context.drainDesktopScopedRouterEffects();
  assert.equal(subject.count("Page.getFrameTree"), 3);
  assert.equal(subject.count("Runtime.enable"), 0);
  assert.equal(subject.context.desktopScopedNativeConfigurations.size, 1);
  assert.equal(subject.context.desktopScopedNativeConfigurations.get("native-child").pageEnabled, true);
  unstable = false;
  await subject.ensure();
  assert.equal(subject.count("Page.enable"), 1);
  assert.equal(subject.count("Page.getFrameTree"), 4);
  assert.equal(subject.count("Runtime.enable"), 1);
  assert.equal(subject.count("Target.setAutoAttach"), 1);
  assert.equal(subject.context.desktopScopedNativeConfigurations.size, 0);
});

test("concurrent snapshot ensure attempts share the existing configuration promise", async () => {
  const pause = deferred();
  const entered = deferred();
  let firstAttempt = true;
  const subject = configurationHarness(async () => {
    if (firstAttempt) throw new Error("initial native read failed");
    entered.resolve(); await pause.promise;
  });
  subject.effects("child");
  await subject.context.drainDesktopScopedRouterEffects();
  firstAttempt = false;
  const one = subject.ensure();
  const two = subject.ensure();
  await entered.promise;
  pause.resolve();
  await Promise.all([one, two]);
  assert.equal(subject.count("Page.enable"), 1);
  assert.equal(subject.count("Page.getFrameTree"), 2);
  assert.equal(subject.count("Runtime.enable"), 1);
  assert.equal(subject.context.desktopScopedNativeConfigurations.size, 0);
});

test("detached or replaced configuration source is removed and never retried by snapshot", async () => {
  for (const change of [
    (slot) => { slot.live = false; }, (slot) => { slot.key = "replacement-key"; },
    (slot) => { slot.incarnation = "replacement-instance"; }, (slot) => { slot.webContentsId = 202; },
    (slot) => { slot.parentKey = "other-parent"; },
  ]) {
    const subject = configurationHarness((slot) => change(slot));
    subject.effects("child");
    await subject.context.drainDesktopScopedRouterEffects();
    await subject.ensure();
    assert.equal(subject.count("Page.getFrameTree"), 1);
    assert.equal(subject.count("Runtime.enable"), 0);
    assert.equal(subject.context.desktopScopedNativeConfigurations.size, 0);
  }
});

test("failed source initialization does not consume its sibling's configuration opportunity", async () => {
  const subject = configurationHarness((_slot, sessionId) => {
    if (sessionId === "child") throw Object.assign(new Error("native read failed"), { code: "STALE_SESSION_ROUTE" });
  });
  subject.effects("child", "sibling");
  await subject.context.drainDesktopScopedRouterEffects();
  assert.equal(subject.count("Page.getFrameTree"), 1);
  assert.equal(subject.count("Runtime.enable"), 0);
  assert.equal(subject.count("Runtime.enable", "sibling"), 1);
  assert.equal(subject.context.desktopScopedNativeConfigurations.size, 1);
  assert.equal(subject.slots.get("sibling").ready, true);
});

test("late initialization cleanup cannot delete a newer state and late tree cannot exceed the deadline", async () => {
  const pause = deferred();
  const entered = deferred();
  const subject = configurationHarness(async () => { entered.resolve(); await pause.promise; });
  subject.effects("child");
  const initializing = subject.context.drainDesktopScopedRouterEffects();
  await entered.promise;
  const replacementState = { source: subject.source("child"), pageEnabled: true };
  subject.context.desktopScopedNativeConfigurations.set("native-child", replacementState);
  pause.resolve();
  await initializing;
  assert.equal(subject.context.desktopScopedNativeConfigurations.get("native-child"), replacementState);

  const timedOut = configurationHarness();
  let elapsed = 0;
  timedOut.context.Date = { now: () => elapsed };
  timedOut.context.desktopBrowser.sendNativeCommand = async (_target, method, _params, sessionId) => {
    timedOut.calls.push({ method, sessionId });
    if (method === "Page.getFrameTree") elapsed = 3_001;
    return { frameTree: { frame: { id: "child-frame", parentId: "root-frame" } } };
  };
  timedOut.effects("child");
  await timedOut.context.drainDesktopScopedRouterEffects();
  assert.equal(timedOut.count("Page.enable"), 1);
  assert.equal(timedOut.count("Page.getFrameTree"), 1);
  assert.equal(timedOut.count("Runtime.enable"), 0);
});

function taskState(overrides = {}) {
  return { id: 1, taskId: "task-live", leaseEpoch: 1, ownership: "agent", lifecycle: "active", agentBlocked: false, ...overrides };
}

test("in-flight UI list cannot erase a newer trusted bridge state or revoke an unchanged lease", async () => {
  const list = deferred();
  const { context, cancellations } = stateHarness(async (method) => method === "space.list" ? list.promise : []);
  const loading = context.loadState();
  context.updateBrokerSpaceState({ space: taskState() });
  cancellations.length = 0;
  list.resolve({ taskSpaces: [] });
  await loading;
  assert.equal(context.brokerSpaceStates.get("task-live").leaseEpoch, 1);
  context.updateBrokerSpaceState({ space: taskState() });
  assert.equal(cancellations.length, 0);
  context.updateBrokerSpaceState({ space: taskState({ leaseEpoch: 2, ownership: "user" }) });
  assert.equal(cancellations.length, 1);
});

test("UI list from an old connection cannot replace the reconnected task map", async () => {
  const list = deferred();
  const { context } = stateHarness(async (method) => method === "space.list" ? list.promise : []);
  const loading = context.loadState();
  context.backendConnectionGeneration += 1;
  context.rpc = { request: async () => ({}) };
  context.brokerSpaceStates.set("task-live", taskState({ leaseEpoch: 3 }));
  list.resolve({ taskSpaces: [taskState()] });
  await loading;
  assert.equal(context.brokerSpaceStates.get("task-live").leaseEpoch, 3);
});

test("public UI task lists preserve internal lease and lifecycle needed for unchanged full updates", async () => {
  const publicSpace = { id: 1, taskId: "task-live", name: "Displayed", ownership: "agent", controlMode: "collaborative" };
  const { context, cancellations } = stateHarness(async (method) => method === "space.list" ? { taskSpaces: [publicSpace] } : []);
  context.updateBrokerSpaceState({ space: taskState() });
  cancellations.length = 0;
  await context.loadState();
  assert.equal(context.brokerSpaceStates.get("task-live").leaseEpoch, 1);
  assert.equal(context.brokerSpaceStates.get("task-live").lifecycle, "active");
  context.updateBrokerSpaceState({ space: taskState() });
  assert.equal(cancellations.length, 0);
  context.updateBrokerSpaceState({ space: taskState({ leaseEpoch: 2 }) });
  assert.equal(cancellations.length, 1);
  context.updateBrokerSpaceState({ space: taskState({ agentBlocked: true }) });
  context.replaceBrokerSpaceStates([publicSpace]);
  assert.equal(context.brokerSpaceStates.get("task-live").agentBlocked, false);
});

test("disabled CoS is hidden from presentation without removing its authoritative space", async () => {
  const spaces = [taskState({ taskId: "cos" }), taskState({ id: 2, taskId: "ordinary" })];
  const tabs = spaces.map(space => ({ taskId: space.taskId, targetId: space.taskId }));
  const { context } = stateHarness(async method => {
    if (method === "space.list") return { taskSpaces: spaces };
    if (method === "tab.listAll") return tabs;
    return [];
  });
  context.cosWorkspace.taskId = "cos";
  const hidden = await context.loadState();
  assert.deepEqual(Array.from(hidden.spaces, space => space.taskId), ["ordinary"]);
  assert.deepEqual(Array.from(hidden.tabs, tab => tab.taskId), ["ordinary"]);
  assert.equal(context.brokerSpaceStates.has("cos"), true);
  context.cosWorkspace.enabled = true;
  assert.equal((await context.loadState()).spaces.length, 2);
});

test("target resolution preserves a concurrently registered replacement and never falls back to another page", async () => {
  const resolving = deferred();
  const entered = deferred();
  const { context } = stateHarness();
  let elapsed = 0;
  Object.assign(context, { desktopTabs: new Map([ ["page-exact", { targetId: "page-exact", taskId: "task-live", webContentsId: 41 }] ]),
    Date: { now: () => elapsed }, delay: async (ms) => { elapsed += ms; }, activeWebviewId: 99,
    publicDesktopRecord: (tab) => tab,
    hostRequest: async () => { entered.resolve(); return resolving.promise; },
    webviewContents: (id) => { if (id !== 99) throw new Error("old guest closed"); return { id }; },
    requiredNumber: (value) => value,
  });
  const pending = context.desktopTarget({ targetId: "page-exact", taskId: "task-live" });
  await entered.promise;
  context.desktopTabs.set("page-exact", { targetId: "page-exact", taskId: "task-live", webContentsId: 99 });
  resolving.resolve({ webContentsId: 42 });
  assert.equal((await pending).id, 99);
  assert.equal(context.desktopTabs.get("page-exact").webContentsId, 99);
  await assert.rejects(() => context.desktopTarget({ targetId: "missing", taskId: "task-live" }), /Requested desktop target is unavailable/);
});

test("scoped download policy and final path reuse existing bookkeeping for the exact alias page", async () => {
  const { context } = stateHarness();
  const scopedPage = { ...pageScope(), pageId: "page-download" };
  const tab = { taskId: "task-1", targetId: "page-download" };
  const paths = new Map();
  const record = { id: "download-1", taskId: "task-1", targetId: "page-download", savePath: "A:/old.txt" };
  let allowed = true;
  let notifications = 0;
  Object.assign(context, { desktopScopedAliasPages: new Map([["alias-download", scopedPage]]),
    desktopFrameRouter: { resolveCommand: ({ clientId }) => { if (clientId !== "owner") throw Object.assign(new Error("wrong caller"), { code: "EGO_ACTION_SCOPE_MISMATCH" }); return {}; } },
    mutationGate: { assertMutationAllowed() {} }, desktopTabs: new Map([[tab.targetId, tab]]),
    desktopSessions: new Map(), desktopDownloadPaths: paths, desktopDownloads: new Map([[record.id, record]]),
    required: (value) => { if (!value) throw new Error("required"); return value; },
    isAbsolute: (path) => path.startsWith("A:/"), basename: (path) => path.split("/").at(-1), mkdirSync() {},
    persistDesktopDownloads() {}, notifyDesktopDownload: () => { notifications += 1; },
    drainDesktopScopedRouterEffects: async () => {},
    invokeCurrentScopedMutation: async (_taskId, invoke) => { if (!allowed) throw new Error("revoked"); return invoke(); },
  });
  const call = async (method, params, caller = "owner") => JSON.parse(await context.sendDesktopScopedRawCdp("task-1", { id: 1, method, params, sessionId: "alias-download" }, { clientId: caller }));
  assert.equal((await call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "A:/downloads" })).error, undefined);
  assert.equal(paths.get(tab.targetId), "A:/downloads");
  await call("Ego.setDownloadPath", { guid: record.id, path: "A:/final.txt" });
  assert.equal(record.savePath, "A:/final.txt"); assert.equal(notifications, 1);
  assert.ok((await call("Page.setDownloadBehavior", { behavior: "deny" }, "other")).error);
  assert.equal(paths.get(tab.targetId), "A:/downloads");
  allowed = false;
  assert.ok((await call("Page.setDownloadBehavior", { behavior: "deny" })).error);
  assert.equal(paths.get(tab.targetId), "A:/downloads");
});

test("download events route once per scoped page caller without requiring a legacy session", () => {
  const { context } = stateHarness();
  const messages = [];
  let scope;
  Object.assign(context, { desktopTargetSessions: new Map(), desktopSessions: new Map(), scopedReferencesEnabled: true,
    scopedPageScope: (tab) => ({ pageId: tab.targetId }),
    desktopFrameRouter: { routeNativeEvent(input) { scope = input.scope; return [
      { taskId: "task-1", clientId: "owner", alias: "root-alias", method: input.method, params: input.params },
    ]; } }, desktopRpcServer: { notify: (_method, value) => messages.push(value) } });
  context.notifyDesktopCdp({ taskId: "task-1", targetId: "page-download" }, "Page.downloadProgress", { guid: "download-1", state: "completed" });
  assert.equal(scope, "page"); assert.equal(messages.length, 1);
  assert.equal(JSON.parse(messages[0].payload).sessionId, "root-alias");
});

test("page session discovery returns only current distinct aliases within the root alias page and caller", async () => {
  const { context } = stateHarness();
  const page = { ...pageScope(), pageId: "page-network" };
  const attachedTargets = [];
  Object.assign(context, { mutationGate: { assertMutationAllowed() {} },
    required: (value) => { if (!value) throw new Error("required"); return value; },
    drainDesktopScopedRouterEffects: async () => {},
    desktopScopedAliasPages: new Map([["root-alias", page], ["child-alias", page]]),
    desktopFrameRouter: {
      resolveCommand({ clientId, alias }) {
        if (clientId !== "owner") throw Object.assign(new Error("wrong caller"), { code: "EGO_ACTION_SCOPE_MISMATCH" });
        return { transportState: alias === "root-alias" ? "root" : "oopif" };
      },
      listFrameRoutes(candidatePage) {
        assert.equal(candidatePage.pageId, "page-network");
        return [
          { targetId: "root-target", nativeSessionKey: "native-root", identity: { frameId: "root-frame" } },
          { targetId: "root-target", nativeSessionKey: "native-root", identity: { frameId: "same-frame" } },
          { targetId: "child-target", nativeSessionKey: "native-child", identity: { frameId: "child-frame" } },
        ];
      },
      attachClient({ clientId, targetId }) { assert.equal(clientId, "owner"); attachedTargets.push(targetId); return { alias: `public-${targetId}` }; },
    },
  });
  const call = async (clientId, sessionId) => JSON.parse(await context.sendDesktopScopedRawCdp("task-1", { id: 1, method: "Ego.getPageSessions", sessionId }, { clientId }));
  const response = await call("owner", "root-alias");
  assert.equal(response.result.pageId, "page-network");
  assert.deepEqual(attachedTargets, ["root-target", "child-target"]);
  assert.equal(response.result.sessions.length, 2);
  assert.ok(response.result.sessions.every((entry) => Object.keys(entry).every((key) => ["sessionId", "frameId"].includes(key))));
  assert.ok((await call("other", "root-alias")).error);
  assert.ok((await call("owner", "child-alias")).error);
  assert.ok((await call("owner", "missing")).error);
  assert.equal(attachedTargets.length, 2);
});

test("connection bootstrap subscribes before list and preserves newer bridge updates", async () => {
  const list = deferred();
  const requested = deferred();
  let eventHandler;
  const connection = {
    closed: false,
    onDisconnect() {},
    onEvent(handler) { eventHandler = handler; },
    async request(method) {
      if (method === "space.list") { assert.equal(typeof eventHandler, "function"); requested.resolve(); return list.promise; }
      return { ready: true, agents: [] };
    },
  };
  const { context } = stateHarness();
  Object.assign(context, { rpc: undefined, backendConnectionGeneration: 0, ensureBroker: async () => {},
    PipeRpcClient: { connect: async () => connection }, pipeName: "test", app: { getVersion: () => "test" },
    desktopControlToken: "test", controlMode: () => "collaborative", controlConsentPolicy: () => ({}),
    scheduleBackendRecovery() {}, writeDiagnostic() {}, backendReady: false, backendError: "" });
  const loading = context.connectBackend();
  await requested.promise;
  context.updateBrokerSpaceState({ space: taskState() });
  list.resolve({ taskSpaces: [] });
  await loading;
  assert.equal(context.brokerSpaceStates.get("task-live").leaseEpoch, 1);
  context.rpc = { request: async () => ({}) };
  context.backendConnectionGeneration += 1;
  eventHandler("space.changed", { space: taskState({ leaseEpoch: 99 }) });
  assert.equal(context.brokerSpaceStates.get("task-live").leaseEpoch, 1);
});

test("exact frame pointer probe rejects overlays and maps shared-session coordinates into the node realm", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const context = vm.createContext({ Element: class {}, innerWidth: 300, innerHeight: 150,
    getComputedStyle: (node) => ({ transform: node.transform || "none", perspective: "none", zoom: "1" }) });
  const probe = vm.runInContext(`(${main.match(/function desktopScopedPointerProbe\([^]*?\n\}/)[0]})`, context);
  const node = new context.Element();
  Object.assign(node, { isConnected: true, contains: () => false,
    getBoundingClientRect: () => ({ left: 8, top: 10, width: 40, height: 20 }),
    ownerDocument: { elementFromPoint(x, y) { assert.equal(x, 28); assert.equal(y, 20); return node; } } });
  const quad = [108, 210, 148, 210, 148, 230, 108, 230];
  assert.equal(probe.call(node, 128, 220, quad).hit, true);
  node.ownerDocument.elementFromPoint = () => new context.Element();
  assert.equal(probe.call(node, 128, 220, quad).hit, false);
  node.transform = "matrix(2,0,0,2,0,0)";
  assert.equal(probe.call(node, 128, 220, quad).unsupported, true);
});

test("frame owner pointer probe rejects clipping and overlays before projecting into the parent", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const context = vm.createContext({ Element: class {}, innerWidth: 800, innerHeight: 600,
    getComputedStyle: () => ({ transform: "none", perspective: "none", zoom: "1" }) });
  const probe = vm.runInContext(`(${main.match(/function desktopScopedFrameOwnerPointerProbe\([^]*?\n\}/)[0]})`, context);
  const owner = new context.Element();
  Object.assign(owner, { isConnected: true, offsetWidth: 304, offsetHeight: 154, clientWidth: 300, clientHeight: 150,
    clientLeft: 2, clientTop: 2, getBoundingClientRect: () => ({ left: 100, top: 200, width: 304, height: 154 }),
    ownerDocument: { elementFromPoint: () => owner } });
  const result = probe.call(owner, { localX: 20, localY: 30 });
  assert.equal(result.hit, true); assert.equal(result.localX, 122); assert.equal(result.localY, 232);
  assert.equal(probe.call(owner, { localX: 301, localY: 30 }).hit, false);
  owner.ownerDocument.elementFromPoint = () => new context.Element();
  assert.equal(probe.call(owner, { localX: 20, localY: 30 }).hit, false);
  owner.offsetWidth = 150;
  assert.equal(probe.call(owner, { localX: 20, localY: 30 }).unsupported, true);
});

function fakeClock(start = 1_000) {
  let now = start;
  const tasks = new Set();
  return {
    now: () => now,
    schedule(callback, delay) {
      const task = { at: now + delay, callback, cancelled: false, unref() {} };
      tasks.add(task);
      return task;
    },
    cancel(task) { task.cancelled = true; tasks.delete(task); },
    advance(milliseconds) {
      now += milliseconds;
      for (;;) {
        const due = [...tasks].filter((task) => !task.cancelled && task.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        tasks.delete(due);
        due.callback();
      }
    },
  };
}

function pageScope(overrides = {}) {
  return { runtimeId: "runtime-1", taskId: "task-1", pageId: "page-1", ...overrides };
}

function mutation(overrides = {}) {
  return { clientId: "client-1", taskSpaceId: 1, leaseEpoch: 4, ...overrides };
}

function harness(options = {}) {
  let nextRef = 10_000;
  let current = true;
  let selected = true;
  let allowed = true;
  let brokerHook = async () => {};
  let routeError = options.routeError;
  let nativeError = options.nativeError;
  let candidates = [candidate(1, "One"), candidate(2, "Two")];
  const nativeCalls = [];
  const validationCalls = [];
  const identity = Object.freeze({
    ...pageScope(),
    frameId: "frame-root",
    documentId: "document-1",
    documentEpoch: 1,
  });
  const route = Object.freeze({
    identity,
    targetId: "target-root",
    executionContextId: 77,
    nativeSessionGeneration: 3,
    nativeSessionKey: "native-root",
    webContentsId: 101,
    transportState: "root",
  });
  const childIdentity = options.childIdentity && Object.freeze({ ...options.childIdentity });
  const childRoute = childIdentity && Object.freeze({
    identity: childIdentity,
    targetId: "target-child",
    executionContextId: 88,
    nativeSessionGeneration: 4,
    transportState: options.childTransportState || "oopif",
  });
  const routes = childRoute ? [route, childRoute] : [route];
  const validationCounts = new Map();
  const router = {
    async captureFrameIdentity({ frameId }) {
      if (!current) throw Object.assign(new Error("stale"), { code: "STALE_DOCUMENT" });
      const selectedRoute = routes.find((candidateRoute) => candidateRoute.identity.frameId === frameId);
      if (!selectedRoute) throw Object.assign(new Error("missing frame"), { code: "DETACHED_FRAME" });
      return Object.freeze({
        identity: selectedRoute.identity,
        pageGeneration: 1,
        nativeSessionGeneration: selectedRoute.nativeSessionGeneration,
      });
    },
    async validateFrameIdentity(stamp) {
      const count = (validationCounts.get(stamp.identity.frameId) || 0) + 1;
      validationCounts.set(stamp.identity.frameId, count);
      await options.identityValidationHook?.(stamp, count);
      if (!current || (options.invalidateChildAfterCapture && stamp.identity.frameId === childIdentity?.frameId && count > 1)) {
        throw Object.assign(new Error("stale"), { code: "STALE_DOCUMENT" });
      }
      return stamp.identity;
    },
    resolveFrameCommand({ expectedIdentity }) {
      if (routeError) throw routeError;
      if (!current || expectedIdentity.documentId !== identity.documentId) {
        throw Object.assign(new Error("detached"), { code: "DETACHED_FRAME" });
      }
      return route;
    },
    listFrameRoutes() { return routes; },
    stats() { return { frames: routes.length }; },
    isCurrentDocument(candidateIdentity) {
      return current && routes.some((candidateRoute) => candidateRoute.identity.documentId === candidateIdentity.documentId
        && candidateRoute.identity.frameId === candidateIdentity.frameId);
    },
    attachClient() { return Object.freeze({ alias: "session-public", targetId: "target-root" }); },
  };
  const gate = new MutationGate(
    (context, taskId) => {
      if (!allowed || context.taskId !== taskId || context.leaseEpoch !== 4) throw new Error("revoked");
      options.events?.push("lease-sync");
    },
    async (context, taskId) => {
      options.events?.push("broker-async");
      await brokerHook(context, taskId);
    },
  );
  const registry = new DesktopReferenceRegistry({
    allocator: { allocate: () => nextRef++ },
    isCurrentDocument: (candidateIdentity) => current
      && routes.some((candidateRoute) => candidateRoute.identity.documentId === candidateIdentity.documentId
        && candidateRoute.identity.documentEpoch === candidateIdentity.documentEpoch),
    revalidateAction: options.revalidateActionHook || (async () => {}),
    now: options.now,
  });
  const automation = new DesktopScopedAutomation({
    router,
    gate,
    registry,
    mutationGate: gate,
    resolveRootFrameId: options.resolveRootFrameId || (() => identity.frameId),
    captureRootCandidates: options.captureRootCandidates || (async () => ({
      title: "Fixture",
      url: "https://fixture.test",
      candidates,
      complete: options.complete?.() ?? true,
    })),
    captureFrameCandidates: options.captureFrameCandidates || (async () => ({ candidates: [], totalCandidates: 0, complete: false })),
    validateBoundCommand: async (input) => {
      options.events?.push("native-check");
      validationCalls.push(input);
      await options.validationHook?.(input);
    },
    resolveBoundObjectIdentity: options.resolveBoundObjectIdentity || (async ({ objectId }) => ({ "source-object": 1, "target-object": 2 }[objectId])),
    sendFrameCommand(routeInput, method, params) {
      options.events?.push("native-send");
      nativeCalls.push({ routeInput, method, params });
      if (nativeError) return Promise.reject(nativeError);
      return Promise.resolve({ ok: true, method, params });
    },
    isPageSelected: () => selected,
    now: options.now,
    schedule: options.schedule,
    cancel: options.cancel,
    maxQueuedPerPage: options.maxQueuedPerPage,
    maxActionTtlMs: options.maxActionTtlMs,
    maxAdmissionPages: options.maxAdmissionPages,
  });
  return {
    automation,
    registry,
    router,
    gate,
    identity,
    nativeCalls,
    validationCalls,
    setCandidates(next) { candidates = next; },
    setCurrent(value) { current = value; },
    setSelected(value) { selected = value; },
    setAllowed(value) { allowed = value; },
    setBrokerHook(value) { brokerHook = value; },
    setRouteError(value) { routeError = value; },
    setNativeError(value) { nativeError = value; },
  };
}

function candidate(backendNodeId, name) {
  return Object.freeze({ backendNodeId, role: "button", name });
}

async function snapshotAndBind(subject, options = {}) {
  const snapshot = await subject.automation.snapshot({
    pageScope: pageScope(),
    clientId: "client-1",
    options: { scope: "full_page" },
  });
  const ref = snapshot.refs[0];
  const binding = await subject.automation.bindReferenceAction({
    pageScope: pageScope(),
    clientId: "client-1",
    mutation: mutation(),
    request: {
      ref: { refId: ref.refId, runtimeId: ref.runtimeId },
      expectedScope: { pageId: ref.pageId },
      ...options,
    },
  });
  return { snapshot, ref, binding };
}

function wire(binding) {
  return { version: "scoped-v1", runtimeId: binding.runtimeId, token: binding.token };
}

function requestContext(binding) {
  return { clientId: "client-1", refFormat: "scoped-v1", refAction: wire(binding) };
}

async function snapshotAndBindGroup(subject, { sameRef = false, deadlineAt } = {}) {
  const snapshot = await subject.automation.snapshot({ pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page" } });
  const binding = await subject.automation.bindReferenceActionGroup({ pageScope: pageScope(), clientId: "client-1", mutation: mutation(),
    request: { kind: "drag", source: { refId: snapshot.refs[0].refId, runtimeId: "runtime-1" },
      target: { refId: snapshot.refs[sameRef ? 0 : 1].refId, runtimeId: "runtime-1" },
      expectedScope: { pageId: "page-1" }, ...(deadlineAt === undefined ? {} : { deadlineAt }) } });
  return { snapshot, binding };
}

function groupDispatch(subject, binding, method, params = {}, overrides = {}) {
  return subject.automation.dispatchCdp({ pageScope: pageScope(), mutation: mutation(), requestContext: requestContext(binding),
    payload: { method, params, sessionId: binding.sessionId }, ...overrides });
}

function groupMouse(subject, binding, type, overrides = {}) {
  return groupDispatch(subject, binding, "Input.dispatchMouseEvent", { type, x: 25, y: 25, button: "left",
    buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...overrides });
}

function releaseGroup(subject, binding) {
  return subject.automation.releaseReferenceAction({ pageScope: pageScope(), clientId: "client-1", mutation: mutation(), wire: wire(binding) });
}

test("group binds two private registry contexts with one admission and preserves source, path, release phases", async () => {
  const subject = harness();
  const { binding } = await snapshotAndBindGroup(subject);
  assert.equal(binding.kind, "drag"); assert.equal(subject.registry.stats().actionContexts, 2);
  assert.equal(subject.automation.stats().activeAdmissions, 1);
  await groupDispatch(subject, binding, "DOM.resolveNode", { backendNodeId: binding.target.backendNodeId });
  await groupDispatch(subject, binding, "Runtime.callFunctionOn", { objectId: "target-object", functionDeclaration: "function(){return true}" });
  await groupDispatch(subject, binding, "Runtime.evaluate", { expression: "true" });
  assert.equal(subject.nativeCalls.some((call) => call.method.startsWith("Input.")), false);
  await groupMouse(subject, binding, "mousePressed");
  await groupMouse(subject, binding, "mouseMoved", { x: 75 });
  await groupMouse(subject, binding, "mouseReleased");
  const inputs = subject.nativeCalls.filter((call) => call.method.startsWith("Input."));
  assert.deepEqual(inputs.map((call) => call.routeInput.expectedIdentity.backendNodeId), [1, 2, 2]);
  assert.ok(subject.validationCalls.some((call) => call.params.type === "mouseMoved" && call.pointerPolicy === "path"));
  assert.ok(subject.validationCalls.some((call) => call.params.objectId === "target-object" && call.binding.identity.backendNodeId === 2));
  releaseGroup(subject, binding);
  assert.equal(subject.registry.stats().actionContexts, 0);
  assert.equal(subject.automation.stats().activeAdmissions, 0);
  assert.equal(subject.automation.stats().retiredGroups, 0);
});

test("same-ref group deduplicates private tokens and second bind failure releases its first token and admission", async () => {
  const same = harness();
  const { binding } = await snapshotAndBindGroup(same, { sameRef: true });
  assert.equal(same.registry.stats().actionContexts, 1);
  assert.equal(binding.source.refId, binding.target.refId);
  releaseGroup(same, binding);
  const failed = harness({ revalidateActionHook: async ({ identity }) => { if (identity.backendNodeId === 2) throw new Error("target rejected"); } });
  await assert.rejects(() => snapshotAndBindGroup(failed));
  assert.equal(failed.registry.stats().actionContexts, 0);
  assert.equal(failed.automation.stats().activeAdmissions, 0);
});

test("group rejects cross-frame endpoints and reverse input before native dispatch", async () => {
  const cross = harness({ childIdentity: { ...pageScope(), frameId: "child", documentId: "child-document", documentEpoch: 1 },
    captureFrameCandidates: async () => ({ candidates: [candidate(3, "Child")], complete: true }) });
  const snapshot = await cross.automation.snapshot({ pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page" } });
  await assert.rejects(() => cross.automation.bindReferenceActionGroup({ pageScope: pageScope(), clientId: "client-1", mutation: mutation(),
    request: { kind: "drag", source: { refId: snapshot.refs[0].refId, runtimeId: "runtime-1" }, target: { refId: snapshot.refs.at(-1).refId, runtimeId: "runtime-1" }, expectedScope: { pageId: "page-1" } } }),
  (error) => error.code === "EGO_ACTION_SCOPE_MISMATCH");
  assert.equal(cross.registry.stats().actionContexts, 0);
  const subject = harness(); const { binding } = await snapshotAndBindGroup(subject);
  await assert.rejects(() => groupMouse(subject, binding, "mouseReleased"), (error) => error.code === "EGO_ACTION_CONTEXT_INVALID");
  assert.equal(subject.nativeCalls.length, 0);
  assert.equal(subject.registry.stats().actionContexts, 0);
});

test("concurrent command on a group rejects immediately while the original command can finish", async () => {
  const pause = deferred(); const entered = deferred();
  const subject = harness({ validationHook: async () => { entered.resolve(); await pause.promise; } });
  const { binding } = await snapshotAndBindGroup(subject);
  const first = groupDispatch(subject, binding, "Runtime.evaluate", { expression: "true" });
  await entered.promise;
  await assert.rejects(() => groupMouse(subject, binding, "mousePressed"), (error) => error.code === "EGO_ACTION_CONTEXT_INVALID");
  assert.equal(subject.nativeCalls.length, 0);
  pause.resolve(); await first;
  assert.equal(subject.nativeCalls.length, 1);
  releaseGroup(subject, binding);
});

test("group final authorization rejects takeover or release with zero input and frees both contexts", async () => {
  for (const mutate of [(subject) => subject.setAllowed(false), (subject, binding) => releaseGroup(subject, binding)]) {
    const subject = harness(); const { binding } = await snapshotAndBindGroup(subject);
    subject.setBrokerHook(async () => mutate(subject, binding));
    await assert.rejects(() => groupMouse(subject, binding, "mousePressed"));
    assert.equal(subject.nativeCalls.length, 0);
    assert.equal(subject.registry.stats().actionContexts, 0);
    assert.equal(subject.automation.stats().activeAdmissions, 0);
  }
});

test("production native primitive has one final Broker await and navigation at that await sends zero input", async () => {
  for (const navigateDuringAuthorization of [false, true]) {
    const subject = harness();
    const nativeInputs = [];
    const target = { id: 101, hostWebContents: { id: 999 }, debugger: { isAttached: () => true,
      sendCommand(method, params) { nativeInputs.push({ method, params }); return Promise.resolve({}); } } };
    const controller = new DesktopBrowserController();
    controller.captureSnapshotCandidates = async () => ({ candidates: [candidate(1, "Source"), candidate(2, "Target")], complete: true });
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const context = vm.createContext({
      desktopScopedAutomation: undefined, scopedReferencesEnabled: true, desktopRuntimeId: "runtime-1",
      desktopBrowser: controller, desktopFrameRouter: undefined, desktopReferenceRegistry: undefined,
      mutationGate: subject.gate, process: { env: {} }, scopedReferenceCounterPath: "unused",
      scopedReferenceActionTtlMs: 300_000, randomUUID: () => "test-id", activeWebviewId: 777,
      mainWindow: { webContents: { id: 999 } }, webContents: { fromId: (id) => id === 101 ? target : undefined },
      desktopTabs: new Map([["page-1", { taskId: "task-1", webContentsId: 101, active: true }]]),
      requiredNumber: (value) => value, desktopTarget: async () => target,
      validateDesktopScopedCommand: async () => {},
      DurableReferenceIdAllocator: class {}, DesktopReferenceRegistry: class { constructor() { return subject.registry; } },
      DesktopScopedAutomation,
      DesktopFrameRouter: class {
        constructor(options) {
          subject.router.sendFrameCommand = (input, method, params) => options.nativeSend({ ...input.pageScope, webContentsId: 101, method, params });
          return subject.router;
        }
      },
    });
    for (const name of ["resolveDesktopWebviewContents", "scopedNativeWebviewContents", "webviewContents", "initializeDesktopScopedAutomation"]) {
      vm.runInContext(main.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0], context);
    }
    context.initializeDesktopScopedAutomation();
    subject.automation = context.desktopScopedAutomation;
    const { binding } = await snapshotAndBindGroup(subject);
    let brokerCalls = 0;
    subject.setBrokerHook(async () => {
      brokerCalls += 1;
      // The old nested target proxy introduced a second awaited Broker check.
      // A navigation there escaped the pair assertions at the outer gate.
      if (navigateDuringAuthorization || brokerCalls === 2) subject.setCurrent(false);
    });
    if (navigateDuringAuthorization) await assert.rejects(() => groupMouse(subject, binding, "mousePressed"));
    else await groupMouse(subject, binding, "mousePressed");
    assert.equal(brokerCalls, 1);
    assert.equal(nativeInputs.length, navigateDuringAuthorization ? 0 : 1);
    if (!navigateDuringAuthorization) releaseGroup(subject, binding);
    assert.equal(subject.registry.stats().actionContexts, 0);
  }
});

test("failure after mouse down returns unknown, releases the admission, and never sends cleanup mouseup", async () => {
  const subject = harness(); const { binding } = await snapshotAndBindGroup(subject);
  await groupMouse(subject, binding, "mousePressed");
  subject.setNativeError(new Error("native move failed"));
  await assert.rejects(() => groupMouse(subject, binding, "mouseMoved"), (error) => error.code === "EGO_ACTION_RESULT_UNKNOWN" && error.data.retry === "never");
  assert.deepEqual(subject.nativeCalls.map((call) => call.params.type), ["mousePressed", "mouseMoved"]);
  assert.equal(subject.registry.stats().actionContexts, 0); assert.equal(subject.automation.stats().activeAdmissions, 0);
  await assert.rejects(() => groupMouse(subject, binding, "mouseReleased"), (error) => error.code === "EGO_ACTION_RESULT_UNKNOWN");
  assert.equal(subject.nativeCalls.length, 2);
  assert.equal(releaseGroup(subject, binding), true); assert.equal(releaseGroup(subject, binding), false);
});

test("down group invalidation retains only owner-scoped unknown diagnostics with bounded original expiry", async () => {
  const clock = fakeClock();
  const subject = harness({ ...clock, maxAdmissionPages: 1 });
  let last;
  for (let index = 0; index < 2; index += 1) {
    const { binding } = await snapshotAndBindGroup(subject, { deadlineAt: 2_000 });
    await groupMouse(subject, binding, "mousePressed");
    subject.automation.cancelTask("task-1");
    assert.equal(subject.registry.stats().actionContexts, 0); assert.equal(subject.automation.stats().activeAdmissions, 0);
    assert.equal(subject.automation.stats().retiredGroups, 1);
    last = binding;
  }
  await assert.rejects(() => groupMouse(subject, last, "mouseReleased"), (error) => error.code === "EGO_ACTION_RESULT_UNKNOWN");
  await assert.rejects(() => groupDispatch(subject, last, "Runtime.evaluate", {}, { requestContext: { ...requestContext(last), clientId: "foreign" } }),
    (error) => error.code === "EGO_ACTION_CONTEXT_INVALID");
  clock.advance(1_001);
  assert.equal(subject.automation.stats().retiredGroups, 0);
});

test("group admission expiry releases pair contexts and invalid receiver cannot select an unrelated node", async () => {
  const clock = fakeClock(); const subject = harness(clock);
  const { binding } = await snapshotAndBindGroup(subject, { deadlineAt: 1_010 });
  clock.advance(11);
  assert.equal(subject.registry.stats().actionContexts, 0); assert.equal(subject.automation.stats().bindings, 0);
  const other = harness(); const data = await snapshotAndBindGroup(other);
  await assert.rejects(() => groupDispatch(other, data.binding, "Runtime.callFunctionOn", { objectId: "foreign-object" }), (error) => error.code === "EGO_ACTION_SCOPE_MISMATCH");
  assert.equal(other.nativeCalls.length, 0); assert.equal(other.registry.stats().actionContexts, 0);
});

test("full snapshots replace refs while viewport and truncated results preserve absent refs", async () => {
  const subject = harness();
  const first = await subject.automation.snapshot({
    pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page" },
  });
  assert.equal(first.refFormat, "scoped-v1");
  assert.equal(first.completeness, "complete-page");
  assert.match(first.content, /\[@10000\]/);
  assert.equal(first.refs[0].frameId, "frame-root");
  const oldSecond = first.refs[1];

  subject.setCandidates([candidate(1, "One")]);
  const replacement = await subject.automation.snapshot({
    pageScope: pageScope(), clientId: "client-1", options: { scope: "only_within_viewport" },
  });
  assert.equal(subject.registry.resolve(oldSecond.refId, pageScope()).backendNodeId, 2);

  subject.setCandidates(Array.from({ length: 20 }, (_, index) => candidate(index + 20, `Long action ${index}`)));
  const truncated = await subject.automation.snapshot({
    pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page", maxResultLength: 96 },
  });
  assert.ok(truncated.truncation);
  assert.equal(subject.registry.resolve(oldSecond.refId, pageScope()).backendNodeId, 2);

  subject.setCandidates([candidate(99, "Replacement")]);
  await subject.automation.snapshot({
    pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page" },
  });
  assert.equal(replacement.completeness, "partial");
  assert.throws(() => subject.registry.resolve(oldSecond.refId, pageScope()));
});

test("parent-first frame merge namespaces duplicate backend IDs and omits child stable locators", async () => {
  const childIdentity = {
    ...pageScope(), frameId: "frame-child", documentId: "document-child", documentEpoch: 1,
  };
  const subject = harness({
    childIdentity,
    captureFrameCandidates: async () => ({
      candidates: [{ backendNodeId: 1, role: "button", name: "Shared", stableLocator: "#unsafe-child" }],
      totalCandidates: 1,
      complete: true,
    }),
  });
  subject.setCandidates([candidate(1, "Shared")]);
  const snapshot = await subject.automation.snapshot({
    pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page", includeStableLocator: true },
  });
  assert.equal(snapshot.refs.length, 2);
  assert.notEqual(snapshot.refs[0].refId, snapshot.refs[1].refId);
  assert.deepEqual(snapshot.refs.map((ref) => ref.frameId), ["frame-root", "frame-child"]);
  assert.equal(snapshot.refs[1].backendNodeId, 1);
  assert.equal(snapshot.refs[1].stableLocator, undefined);
  assert.equal(snapshot.completeness, "complete-page");
});

test("child invalidation after capture removes its rows and marks the frame incomplete", async () => {
  const childIdentity = {
    ...pageScope(), frameId: "frame-child", documentId: "document-child", documentEpoch: 1,
  };
  const subject = harness({
    childIdentity,
    invalidateChildAfterCapture: true,
    captureFrameCandidates: async () => ({
      candidates: [candidate(5, "Child action")], totalCandidates: 1, complete: true,
    }),
  });
  const snapshot = await subject.automation.snapshot({
    pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page" },
  });
  assert.equal(snapshot.refs.some((ref) => ref.frameId === "frame-child"), false);
  assert.deepEqual(snapshot.incompleteFrames, ["frame-child"]);
  assert.equal(snapshot.completeness, "partial");
});

test("global node budget is applied before public ID allocation", async () => {
  const subject = harness();
  subject.setCandidates(Array.from({ length: 70_000 }, (_, index) => candidate(index + 1, `Action ${index}`)));
  const snapshot = await subject.automation.snapshot({
    pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page" },
  });
  assert.equal(snapshot.refs.length, 600);
  assert.equal(snapshot.truncation.totalLines, 70_000);
  assert.ok(snapshot.truncation.reasons.includes("node_limit"));
  assert.equal(subject.registry.stats().liveRefs, 600);
});

test("all frame identities are rechecked synchronously after the final native await", async () => {
  const childIdentity = { ...pageScope(), frameId: "frame-child", documentId: "document-child", documentEpoch: 1 };
  let childCurrent = true;
  const subject = harness({
    childIdentity,
    captureFrameCandidates: async () => ({ candidates: [candidate(5, "Child")], complete: true }),
    identityValidationHook: async (stamp, count) => {
      if (stamp.identity.frameId === "frame-root" && count === 2) childCurrent = false;
    },
  });
  const isCurrent = subject.router.isCurrentDocument;
  subject.router.isCurrentDocument = (identity) => isCurrent(identity) && (identity.frameId !== "frame-child" || childCurrent);
  const snapshot = await subject.automation.snapshot({ pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page" } });
  assert.equal(snapshot.refs.some((ref) => ref.frameId === "frame-child"), false);
  assert.deepEqual(snapshot.incompleteFrames, ["frame-child"]);
  assert.equal(subject.registry.stats().pendingSnapshots, 0);
  assert.equal(subject.registry.stats().liveRefs, 2);
});

test("older capture retains its ticket and cannot erase a concurrent newer full snapshot", async () => {
  const paused = deferred();
  const entered = deferred();
  let captures = 0;
  const subject = harness({
    captureRootCandidates: async () => {
      captures += 1;
      if (captures === 1) { entered.resolve(); await paused.promise; return { candidates: [candidate(1, "Old")] }; }
      return { candidates: [candidate(7, "New")] };
    },
  });
  const args = { pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page" } };
  const older = subject.automation.snapshot(args);
  const rejected = assert.rejects(older);
  await entered.promise;
  const newer = await subject.automation.snapshot(args);
  paused.resolve();
  await rejected;
  assert.equal(subject.registry.resolve(newer.refs[0].refId, pageScope()).backendNodeId, 7);
  assert.equal(subject.registry.stats().pendingSnapshots, 0);
  assert.equal(subject.registry.stats().liveRefs, 1);
});

test("new frame during capture marks the result incomplete and preserves older refs", async () => {
  const subject = harness();
  const first = await subject.automation.snapshot({ pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page" } });
  subject.setCandidates([candidate(1, "One")]);
  const routes = subject.router.listFrameRoutes();
  let changed = false;
  const validate = subject.router.validateFrameIdentity;
  subject.router.validateFrameIdentity = async (stamp) => { const result = await validate(stamp); changed = true; return result; };
  subject.router.listFrameRoutes = () => changed ? [...routes, { identity: { frameId: "new-frame" } }] : routes;
  subject.router.stats = () => ({ frames: changed ? 2 : 1 });
  const next = await subject.automation.snapshot({ pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page" } });
  assert.equal(next.completeness, "partial");
  assert.deepEqual(next.incompleteFrames, ["new-frame"]);
  assert.equal(subject.registry.resolve(first.refs[1].refId, pageScope()).backendNodeId, 2);
});

test("scoped dispatch binds node, public alias, and explicit execution context without parsing JavaScript", async () => {
  const subject = harness();
  const { ref, binding } = await snapshotAndBind(subject);
  const resolved = await subject.automation.dispatchCdp({
    pageScope: pageScope(),
    mutation: mutation(),
    requestContext: requestContext(binding),
    payload: { method: "DOM.resolveNode", sessionId: binding.sessionId, params: {} },
  });
  assert.equal(resolved.params.backendNodeId, ref.backendNodeId);
  assert.equal(resolved.params.executionContextId, 77);

  const evaluated = await subject.automation.dispatchCdp({
    pageScope: pageScope(),
    mutation: mutation(),
    requestContext: requestContext(binding),
    payload: {
      method: "Runtime.evaluate",
      sessionId: binding.sessionId,
      params: { expression: "window.__existingHelperProbe?.()" },
    },
  });
  assert.equal(evaluated.params.expression, "window.__existingHelperProbe?.()");
  assert.equal(evaluated.params.contextId, 77);
  assert.equal(subject.validationCalls.length, 2);
  await assert.rejects(
    subject.automation.dispatchCdp({
      pageScope: pageScope(), mutation: mutation(), requestContext: requestContext(binding),
      payload: { method: "DOM.getBoxModel", params: { backendNodeId: ref.backendNodeId + 1 } },
    }),
    { code: "EGO_ACTION_SCOPE_MISMATCH" },
  );
  subject.automation.releaseReferenceAction({
    pageScope: pageScope(), clientId: "client-1", mutation: mutation(), wire: wire(binding),
  });
});

test("native verification precedes Broker validation and final synchronous checks immediately precede send", async () => {
  const events = [];
  const subject = harness({ events });
  const { binding } = await snapshotAndBind(subject);
  events.length = 0;
  await subject.automation.dispatchCdp({
    pageScope: pageScope(), mutation: mutation(), requestContext: requestContext(binding),
    payload: { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 10, y: 20 } },
  });
  assert.ok(events.indexOf("native-check") < events.indexOf("broker-async"));
  assert.deepEqual(events.slice(-2), ["lease-sync", "native-send"]);
  subject.automation.releaseReferenceAction({
    pageScope: pageScope(), clientId: "client-1", mutation: mutation(), wire: wire(binding),
  });
});

test("native scroll preparation binds the exact node and rechecks authorization before sending once", async () => {
  const subject = harness();
  const { binding } = await snapshotAndBind(subject);
  const dispatch = (backendNodeId) => subject.automation.dispatchCdp({ pageScope: pageScope(), mutation: mutation(),
    requestContext: requestContext(binding), payload: { method: "DOM.scrollIntoViewIfNeeded", params: { backendNodeId }, sessionId: binding.sessionId } });
  await assert.rejects(() => dispatch(binding.backendNodeId + 10), (error) => error.code === "EGO_ACTION_SCOPE_MISMATCH");
  assert.equal(subject.nativeCalls.length, 0);
  await dispatch(binding.backendNodeId);
  assert.equal(subject.nativeCalls.length, 1);
  assert.equal(subject.nativeCalls[0].method, "DOM.scrollIntoViewIfNeeded");
  subject.setBrokerHook(async () => subject.setAllowed(false));
  await assert.rejects(() => dispatch(binding.backendNodeId));
  assert.equal(subject.nativeCalls.length, 1);
});

for (const interruption of ["release", "navigation", "manual-takeover"]) {
  test(`${interruption} during the final Broker await sends zero Input events`, async () => {
    const entered = deferred();
    const resume = deferred();
    const subject = harness();
    const { binding } = await snapshotAndBind(subject);
    subject.setBrokerHook(async () => { entered.resolve(); await resume.promise; });
    const pending = subject.automation.dispatchCdp({
      pageScope: pageScope(), mutation: mutation(), requestContext: requestContext(binding),
      payload: { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 10, y: 20 } },
    });
    await entered.promise;
    if (interruption === "release") {
      subject.automation.releaseReferenceAction({
        pageScope: pageScope(), clientId: "client-1", mutation: mutation(), wire: wire(binding),
      });
    } else if (interruption === "navigation") {
      subject.setCurrent(false);
    } else {
      subject.setAllowed(false);
    }
    resume.resolve();
    await assert.rejects(pending);
    assert.equal(subject.nativeCalls.length, 0);
  });
}

test("switching pages during the final Broker await sends zero Input events", async () => {
  const entered = deferred();
  const resume = deferred();
  const subject = harness();
  const { binding } = await snapshotAndBind(subject);
  subject.setBrokerHook(async () => { entered.resolve(); await resume.promise; });
  const pending = subject.automation.dispatchCdp({
    pageScope: pageScope(), mutation: mutation(), requestContext: requestContext(binding),
    payload: { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 10, y: 20 } },
  });
  await entered.promise;
  subject.setSelected(false);
  resume.resolve();
  await assert.rejects(pending, { code: "EGO_ACTION_SCOPE_MISMATCH" });
  assert.equal(subject.nativeCalls.length, 0);
});

test("per-page admission serializes binds while snapshots remain independent", async () => {
  const subject = harness({ maxQueuedPerPage: 1 });
  const { snapshot, binding: first } = await snapshotAndBind(subject);
  const ref = snapshot.refs[0];
  const secondPromise = subject.automation.bindReferenceAction({
    pageScope: pageScope(), clientId: "client-1", mutation: mutation(),
    request: { ref: { refId: ref.refId, runtimeId: ref.runtimeId }, expectedScope: { pageId: ref.pageId } },
  });
  assert.equal(subject.automation.stats().queuedAdmissions, 1);
  const read = await subject.automation.snapshot({
    pageScope: pageScope(), clientId: "client-1", options: { scope: "only_within_viewport" },
  });
  assert.equal(read.refFormat, "scoped-v1");
  await assert.rejects(
    subject.automation.bindReferenceAction({
      pageScope: pageScope(), clientId: "client-1", mutation: mutation(),
      request: { ref: { refId: ref.refId, runtimeId: ref.runtimeId }, expectedScope: { pageId: ref.pageId } },
    }),
    { code: "EGO_ACTION_CONTEXT_INVALID" },
  );
  subject.automation.releaseReferenceAction({
    pageScope: pageScope(), clientId: "client-1", mutation: mutation(), wire: wire(first),
  });
  const second = await secondPromise;
  assert.equal(subject.automation.stats().activeAdmissions, 1);
  subject.automation.releaseReferenceAction({
    pageScope: pageScope(), clientId: "client-1", mutation: mutation(), wire: wire(second),
  });
  assert.deepEqual(subject.automation.stats(), {
    bindings: 0, activeAdmissions: 0, admissionPages: 0, queuedAdmissions: 0, retiredGroups: 0,
  });
});

test("page invalidation releases active admission and cancels the next bind", async () => {
  const subject = harness();
  const { snapshot } = await snapshotAndBind(subject);
  const ref = snapshot.refs[0];
  const queued = subject.automation.bindReferenceAction({
    pageScope: pageScope(), clientId: "client-1", mutation: mutation(),
    request: { ref: { refId: ref.refId, runtimeId: ref.runtimeId }, expectedScope: { pageId: ref.pageId } },
  });
  subject.setCurrent(false);
  subject.automation.consumeRouterEffects([{ type: "invalidate_page", pageScope: pageScope(), reason: "closed" }]);
  await assert.rejects(queued);
  assert.deepEqual(subject.automation.stats(), {
    bindings: 0, activeAdmissions: 0, admissionPages: 0, queuedAdmissions: 0, retiredGroups: 0,
  });
});

test("active admission expiry automatically promotes the next page action", async () => {
  const clock = fakeClock();
  const subject = harness({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
  const firstData = await snapshotAndBind(subject, { deadlineAt: 1_010 });
  const ref = firstData.snapshot.refs[0];
  const secondPromise = subject.automation.bindReferenceAction({
    pageScope: pageScope(), clientId: "client-1", mutation: mutation(),
    request: {
      ref: { refId: ref.refId, runtimeId: ref.runtimeId },
      expectedScope: { pageId: ref.pageId },
      deadlineAt: 1_100,
    },
  });
  clock.advance(10);
  const second = await secondPromise;
  assert.equal(subject.automation.stats().bindings, 1);
  assert.equal(subject.automation.releaseReferenceAction({
    pageScope: pageScope(), clientId: "client-1", mutation: mutation(), wire: wire(firstData.binding),
  }), false);
  subject.automation.releaseReferenceAction({
    pageScope: pageScope(), clientId: "client-1", mutation: mutation(), wire: wire(second),
  });
});

test("root context missing during navigation returns an explicit resnapshot error without input", async () => {
  const subject = harness({ resolveRootFrameId: () => undefined });
  await assert.rejects(
    subject.automation.snapshot({ pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page" } }),
    (error) => error.code === "EGO_FRAME_UNAVAILABLE" && error.data.delivery === "not_sent",
  );
  assert.equal(subject.nativeCalls.length, 0);
});

test("deadline above configured maximum rejects before admission or action binding", async () => {
  const clock = fakeClock();
  const subject = harness({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel, maxActionTtlMs: 1_000 });
  const snapshot = await subject.automation.snapshot({
    pageScope: pageScope(), clientId: "client-1", options: { scope: "full_page" },
  });
  const ref = snapshot.refs[0];
  await assert.rejects(
    subject.automation.bindReferenceAction({
      pageScope: pageScope(), clientId: "client-1", mutation: mutation(),
      request: {
        ref: { refId: ref.refId, runtimeId: ref.runtimeId },
        expectedScope: { pageId: ref.pageId },
        deadlineAt: clock.now() + 1_001,
      },
    }),
    { code: "EGO_ACTION_CONTEXT_INVALID" },
  );
  assert.deepEqual(subject.automation.stats(), {
    bindings: 0, activeAdmissions: 0, admissionPages: 0, queuedAdmissions: 0, retiredGroups: 0,
  });
});

test("mutating native failure is reported as result unknown and never retryable", async () => {
  const subject = harness({ nativeError: new Error("transport closed") });
  const { binding } = await snapshotAndBind(subject);
  await assert.rejects(
    subject.automation.dispatchCdp({
      pageScope: pageScope(), mutation: mutation(), requestContext: requestContext(binding),
      payload: { method: "Input.insertText", params: { text: "hello" } },
    }),
    (error) => error.code === "EGO_ACTION_RESULT_UNKNOWN"
      && error.data.delivery === "unknown" && error.data.retry === "never",
  );
});

for (const method of ["DOM.focus", "DOM.setFileInputFiles"]) {
  test(`${method} failure after native invocation is result-unknown`, async () => {
    const subject = harness({ nativeError: new Error("native mutation failed") });
    const { binding, ref } = await snapshotAndBind(subject);
    await assert.rejects(
      subject.automation.dispatchCdp({
        pageScope: pageScope(), mutation: mutation(), requestContext: requestContext(binding),
        payload: { method, params: { backendNodeId: ref.backendNodeId } },
      }),
      { code: "EGO_ACTION_RESULT_UNKNOWN" },
    );
  });
}

test("verified current-document node detachment stays distinct from stale document errors", async () => {
  const subject = harness({
    validationHook: async () => {
      throw Object.assign(new Error("node detached"), { code: "REFERENCE_NODE_DETACHED" });
    },
  });
  const { binding } = await snapshotAndBind(subject);
  await assert.rejects(
    subject.automation.dispatchCdp({
      pageScope: pageScope(), mutation: mutation(), requestContext: requestContext(binding),
      payload: { method: "Runtime.callFunctionOn", params: { objectId: "bound-node" } },
    }),
    (error) => error.code === "EGO_REFERENCE_DETACHED"
      && error.data.delivery === "not_sent" && error.data.retry === "never",
  );
  assert.equal(subject.nativeCalls.length, 0);
});

test("raw native and platform method categories do not run after handoff during final authorization", async () => {
  for (const method of [
    "Input.dispatchKeyEvent",
    "Runtime.evaluate",
    "DOM.setFileInputFiles",
    "Page.reload",
    "Target.createTarget",
    "Target.activateTarget",
    "Target.closeTarget",
  ]) {
    const entered = deferred();
    const resume = deferred();
    let allowed = true;
    let invoked = 0;
    const pending = invokeAfterFinalAuthorization({
      authorize: async () => { entered.resolve(); await resume.promise; },
      assertAllowed: () => { if (!allowed) throw new Error(`revoked ${method}`); },
      invoke: () => { invoked += 1; return true; },
    });
    await entered.promise;
    allowed = false;
    resume.resolve();
    await assert.rejects(pending, /revoked/);
    assert.equal(invoked, 0, method);
  }
});

test("initial route failures map to stale or frame errors before native validation", async () => {
  for (const [internalCode, expectedCode] of [
    ["PAGE_CLOSED", "EGO_REFERENCE_STALE"],
    ["STALE_SESSION_ROUTE", "EGO_FRAME_UNAVAILABLE"],
    ["NATIVE_DOCUMENT_UNAVAILABLE", "EGO_FRAME_UNAVAILABLE"],
  ]) {
    const subject = harness();
    const bound = await snapshotAndBind(subject);
    subject.setRouteError(Object.assign(new Error(internalCode), { code: internalCode }));
    await assert.rejects(
      subject.automation.dispatchCdp({
        pageScope: pageScope(), mutation: mutation(), requestContext: requestContext(bound.binding),
        payload: { method: "DOM.getBoxModel", params: { backendNodeId: bound.ref.backendNodeId } },
      }),
      { code: expectedCode },
    );
    assert.equal(subject.validationCalls.length, 0);
  }
});

test("keyboard focus and file-input object policies are method-specific", () => {
  assert.equal(scopedCommandRequiresBoundFocus("Input.dispatchKeyEvent", { type: "keyDown" }), true);
  assert.equal(scopedCommandRequiresBoundFocus("Input.dispatchKeyEvent", { type: "char" }), true);
  assert.equal(scopedCommandRequiresBoundFocus("Input.dispatchKeyEvent", { type: "keyUp" }), false);
  assert.equal(scopedCommandRequiresExactObject("DOM.setFileInputFiles", { objectId: "node-object" }), true);
  assert.equal(scopedCommandRequiresExactObject("DOM.setFileInputFiles", { backendNodeId: 7 }), false);
  assert.equal(scopedCommandRequiresExactObject("Runtime.evaluate", { objectId: "ignored" }), false);
});
