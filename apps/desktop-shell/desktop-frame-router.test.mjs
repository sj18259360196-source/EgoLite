import assert from "node:assert/strict";
import test from "node:test";

import { DesktopFrameRouter } from "./desktop-frame-router.mjs";
import { DesktopReferenceRegistry } from "./desktop-reference-registry.mjs";

function pageScope(overrides = {}) {
  return {
    runtimeId: "runtime-1",
    taskId: "task-1",
    pageId: "page-1",
    ...overrides,
  };
}

function pageRegistration(overrides = {}) {
  return {
    ...pageScope(overrides),
    profileId: overrides.profileId || "profile-1",
    webContentsId: overrides.webContentsId || 101,
    rootTargetId: overrides.rootTargetId || "target-root",
    rootFrameId: overrides.rootFrameId || "frame-root",
  };
}

function deterministicIds() {
  const counts = new Map();
  return (kind) => {
    const next = (counts.get(kind) || 0) + 1;
    counts.set(kind, next);
    return `${kind}-${next}`;
  };
}

function nativeFixture() {
  const calls = [];
  const routes = new Map();
  const key = (sessionId) => sessionId || "root";
  const api = {
    calls,
    set(sessionId, { tree, contexts }) {
      routes.set(key(sessionId), {
        tree,
        contexts: new Map(Object.entries(contexts || {}).map(([contextId, value]) => [Number(contextId), value])),
      });
    },
    async send(call) {
      calls.push(call);
      const route = routes.get(key(call.electronSessionId));
      if (!route) throw new Error(`No native fixture for ${key(call.electronSessionId)}`);
      if (call.method === "Page.getFrameTree") return { frameTree: route.tree };
      if (call.method === "Runtime.evaluate") {
        const doc = route.contexts.get(call.params.contextId);
        if (!doc) throw new Error(`Unknown context ${call.params.contextId}`);
        return { result: { objectId: doc.objectId } };
      }
      if (call.method === "DOM.describeNode") {
        const doc = [...route.contexts.values()].find((candidate) => candidate.objectId === call.params.objectId);
        if (!doc) throw new Error(`Unknown document object ${call.params.objectId}`);
        return { node: { backendNodeId: doc.backendNodeId } };
      }
      if (call.method === "Runtime.releaseObject") return {};
      throw new Error(`Unexpected native method ${call.method}`);
    },
  };
  return api;
}

function frameTree(frame, children = []) {
  return {
    frame,
    ...(children.length ? { childFrames: children } : {}),
  };
}

function routerHarness() {
  let now = 1_000;
  const native = nativeFixture();
  const router = new DesktopFrameRouter({
    nativeSend: (call) => native.send(call),
    createId: deterministicIds(),
    now: () => now,
  });
  return { router, native, advance: (amount = 1) => { now += amount; } };
}

function apply(router, method, params, sourceElectronSessionId, scope = pageScope()) {
  return router.applyDebuggerEvent({
    pageScope: scope,
    sourceElectronSessionId,
    method,
    params,
  });
}

function navigate(router, { frameId, parentId, loaderId, source, url = "http://root.test/" }, scope = pageScope()) {
  return apply(router, "Page.frameNavigated", {
    frame: { id: frameId, ...(parentId ? { parentId } : {}), loaderId, url },
  }, source, scope);
}

function context(router, { frameId, contextId, uniqueId, source }, scope = pageScope()) {
  return apply(router, "Runtime.executionContextCreated", {
    context: {
      id: contextId,
      uniqueId,
      auxData: { frameId, isDefault: true, type: "default" },
    },
  }, source, scope);
}

function attachIframe(router, { sessionId, targetId, source, url = "" }, scope = pageScope()) {
  return apply(router, "Target.attachedToTarget", {
    sessionId,
    targetInfo: { targetId, type: "iframe", title: "", url },
    waitingForDebugger: false,
  }, source, scope);
}

test("trusted page registration isolates runtime, task, page, and webContents ownership", () => {
  const { router } = routerHarness();
  const registered = router.registerPage(pageRegistration());
  assert.deepEqual(registered, {
    ...pageScope(),
    profileId: "profile-1",
    webContentsId: 101,
    rootTargetId: "target-root",
    rootFrameId: "frame-root",
    incarnationId: "pageIncarnation-1",
    pageGeneration: 0,
    state: "live",
  });
  assert.throws(() => router.registerPage(pageRegistration({ pageId: "page-2" })), { code: "WEBCONTENTS_ALREADY_OWNED" });
  assert.throws(
    () => router.observedFrameIdentity(pageScope({ taskId: "task-2" }), "frame-root"),
    { code: "UNKNOWN_PAGE" },
  );

  router.registerPage(pageRegistration({
    runtimeId: "runtime-2",
    taskId: "task-2",
    pageId: "page-2",
    webContentsId: 101,
    rootTargetId: "target-2",
    rootFrameId: "frame-2",
  }));
  assert.equal(router.stats(pageScope()).frames, 1);
  assert.equal(router.stats(pageScope({ runtimeId: "runtime-2", taskId: "task-2", pageId: "page-2" })).frames, 1);
});

test("closed page replacement preserves public scope with a fresh incarnation and document identity", () => {
  const { router } = routerHarness();
  const firstPage = router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-old" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-old" });
  const oldIdentity = router.observedFrameIdentity(pageScope(), "frame-root");
  const oldAlias = router.attachClient({ pageScope: pageScope(), clientId: "client-a", targetId: "target-root" });
  router.closePage(pageScope(), "renderer_crashed");
  assert.equal(router.isCurrentDocument(oldIdentity), false);

  const replacementInput = pageRegistration({ webContentsId: 202 });
  const replacement = router.replacePage(replacementInput, "renderer_recreated");
  assert.equal(replacement.pageId, firstPage.pageId);
  assert.notEqual(replacement.incarnationId, firstPage.incarnationId);
  const newIdentity = router.observedFrameIdentity(pageScope(), "frame-root");
  assert.notEqual(newIdentity.documentId, oldIdentity.documentId);
  assert.equal(router.isCurrentDocument(newIdentity), true);
  assert.equal(router.isCurrentDocument(oldIdentity), false);
  assert.throws(
    () => router.resolveCommand({ pageScope: pageScope(), clientId: "client-a", alias: oldAlias.alias }),
    { code: "UNKNOWN_ALIAS" },
  );
  assert.throws(() => router.replacePage(replacementInput), { code: "PAGE_ALREADY_REGISTERED" });

  router.registerPage(pageRegistration({
    pageId: "page-old-webcontents-reused",
    webContentsId: 101,
    rootTargetId: "target-other",
    rootFrameId: "frame-other",
  }));
  assert.equal(router.stats(pageScope({ pageId: "page-old-webcontents-reused" })).state, "live");
});

test("blank attach metadata updates later and nested session ownership comes from the event source", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  const firstEffects = attachIframe(router, { sessionId: "session-child", targetId: "target-child" });
  assert.equal(firstEffects[0].type, "configure_native_session");
  assert.equal(firstEffects[0].electronSessionId, "session-child");
  assert.equal(firstEffects[0].parentNativeSessionKey, "nativeSession-1");

  apply(router, "Target.targetInfoChanged", {
    targetInfo: { targetId: "target-child", type: "iframe", title: "Cross", url: "http://cross.test/cross" },
  });
  const child = router.attachClient({ pageScope: pageScope(), clientId: "client-1", targetId: "target-child" });
  assert.equal(child.targetId, "target-child");

  const nestedEffects = attachIframe(router, {
    sessionId: "session-nested",
    targetId: "target-nested",
    source: "session-child",
  });
  assert.equal(nestedEffects[0].parentNativeSessionKey, firstEffects[0].nativeSessionKey);
  assert.throws(
    () => attachIframe(router, { sessionId: "bad", targetId: "bad", source: "foreign-session" }),
    { code: "FOREIGN_SESSION" },
  );
});

test("same-process frames route through root context while OOPIF routes through its child session", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-root" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "root-context" });

  apply(router, "Page.frameAttached", { frameId: "frame-sif", parentFrameId: "frame-root" });
  navigate(router, { frameId: "frame-sif", parentId: "frame-root", loaderId: "loader-sif", url: "http://root.test/same" });
  context(router, { frameId: "frame-sif", contextId: 2, uniqueId: "sif-context" });

  attachIframe(router, { sessionId: "session-oopif", targetId: "target-oopif" });
  navigate(router, {
    frameId: "frame-oopif",
    parentId: "frame-root",
    loaderId: "loader-oopif",
    source: "session-oopif",
    url: "http://cross.test/cross",
  });
  context(router, { frameId: "frame-oopif", contextId: 1, uniqueId: "oopif-context", source: "session-oopif" });

  const sif = router.resolveFrameCommand({ pageScope: pageScope(), frameId: "frame-sif" });
  assert.equal(sif.electronSessionId, undefined);
  assert.equal(sif.executionContextId, 2);
  const oopif = router.resolveFrameCommand({ pageScope: pageScope(), frameId: "frame-oopif" });
  assert.equal(oopif.electronSessionId, "session-oopif");
  assert.equal(oopif.executionContextId, 1);
  assert.throws(
    () => router.resolveFrameCommand({ pageScope: pageScope(), frameId: "missing" }),
    { code: "DETACHED_FRAME" },
  );
});

test("listFrameRoutes is parent-first and sendFrameCommand re-resolves exact identity and session generation", async () => {
  const { router, native } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-root" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "root-context" });
  apply(router, "Page.frameAttached", { frameId: "frame-sif", parentFrameId: "frame-root" });
  navigate(router, { frameId: "frame-sif", parentId: "frame-root", loaderId: "loader-sif" });
  context(router, { frameId: "frame-sif", contextId: 2, uniqueId: "sif-context" });
  attachIframe(router, { sessionId: "session-oopif", targetId: "target-oopif" });
  navigate(router, { frameId: "frame-oopif", parentId: "frame-sif", loaderId: "loader-oopif", source: "session-oopif" });
  context(router, { frameId: "frame-oopif", contextId: 1, uniqueId: "oopif-context", source: "session-oopif" });

  const routes = router.listFrameRoutes(pageScope());
  assert.deepEqual(routes.map((route) => route.identity.frameId), ["frame-root", "frame-sif", "frame-oopif"]);
  assert.deepEqual(routes.map((route) => route.parentFrameId), [undefined, "frame-root", "frame-sif"]);
  const oopif = routes[2];
  native.set("session-oopif", {
    tree: frameTree({ id: "frame-oopif", loaderId: "loader-oopif" }),
    contexts: { 1: { objectId: "oopif-document", backendNodeId: 20 } },
  });
  const result = await router.sendFrameCommand({
    pageScope: pageScope(),
    expectedIdentity: oopif.identity,
    expectedNativeSessionGeneration: oopif.nativeSessionGeneration,
  }, "Runtime.evaluate", { expression: "document.title", contextId: oopif.executionContextId });
  assert.equal(result.result.objectId, "oopif-document");
  assert.equal(native.calls.at(-1).electronSessionId, "session-oopif");
  await assert.rejects(router.sendFrameCommand({
    pageScope: pageScope(),
    expectedIdentity: oopif.identity,
    expectedNativeSessionGeneration: oopif.nativeSessionGeneration + 1,
  }, "Runtime.evaluate", {}), { code: "STALE_SESSION_ROUTE" });
  navigate(router, { frameId: "frame-oopif", parentId: "frame-sif", loaderId: "loader-new", source: "session-oopif" });
  await assert.rejects(router.sendFrameCommand({
    pageScope: pageScope(),
    expectedIdentity: oopif.identity,
    expectedNativeSessionGeneration: oopif.nativeSessionGeneration,
  }, "Runtime.evaluate", {}), { code: "STALE_DOCUMENT" });
});

test("native pre and post verification preserves hash identity and detects missed cross-document navigation", async () => {
  const { router, native } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-1" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-1" });
  native.set(undefined, {
    tree: frameTree({ id: "frame-root", loaderId: "loader-1" }),
    contexts: { 1: { objectId: "document-1", backendNodeId: 10 } },
  });

  const stamp = await router.captureFrameIdentity({ pageScope: pageScope(), frameId: "frame-root" });
  apply(router, "Page.navigatedWithinDocument", {
    frameId: "frame-root",
    navigationType: "fragment",
    url: "http://root.test/#same",
  });
  assert.deepEqual(await router.validateFrameIdentity(stamp), stamp.identity);
  assert.equal(router.isCurrentDocument(stamp.identity), true);
  assert.deepEqual(native.calls.map((call) => call.method), [
    "Page.getFrameTree", "Runtime.evaluate", "DOM.describeNode", "Runtime.releaseObject",
    "Page.getFrameTree", "Runtime.evaluate", "DOM.describeNode", "Runtime.releaseObject",
  ]);

  router.takeEffects();
  native.set(undefined, {
    tree: frameTree({ id: "frame-root", loaderId: "loader-missed" }),
    contexts: { 1: { objectId: "document-2", backendNodeId: 20 } },
  });
  await assert.rejects(router.validateFrameIdentity(stamp), { code: "STALE_DOCUMENT" });
  assert.equal(router.isCurrentDocument(stamp.identity), false);
  const effects = router.takeEffects();
  assert.equal(effects.some((effect) => effect.type === "invalidate_documents" && effect.reason === "native_loader_changed"), true);
});

test("cross-document events rotate exact identity even when frame and native session stay the same", async () => {
  const { router, native } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-1" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-1" });
  const oldIdentity = router.observedFrameIdentity(pageScope(), "frame-root");
  navigate(router, { frameId: "frame-root", loaderId: "loader-2", url: "http://root.test/two" });
  assert.equal(router.isCurrentDocument(oldIdentity), false);
  assert.throws(
    () => router.resolveFrameCommand({ pageScope: pageScope(), frameId: "frame-root" }),
    { code: "FRAME_CONTEXT_UNAVAILABLE" },
  );
  context(router, { frameId: "frame-root", contextId: 2, uniqueId: "context-2" });
  const current = router.observedFrameIdentity(pageScope(), "frame-root");
  assert.equal(current.documentEpoch, oldIdentity.documentEpoch + 1);
  assert.notEqual(current.documentId, oldIdentity.documentId);

  native.set(undefined, {
    tree: frameTree({ id: "frame-root", loaderId: "loader-2" }),
    contexts: { 2: { objectId: "document-2", backendNodeId: 20 } },
  });
  const stamp = await router.captureFrameIdentity({ pageScope: pageScope(), frameId: "frame-root" });
  assert.deepEqual(stamp.identity, current);
});

test("native document backend changes invalidate an operation even when loader events were missed", async () => {
  const { router, native } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-1" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-1" });
  native.set(undefined, {
    tree: frameTree({ id: "frame-root", loaderId: "loader-1" }),
    contexts: { 1: { objectId: "document-1", backendNodeId: 10 } },
  });
  const stamp = await router.captureFrameIdentity({ pageScope: pageScope(), frameId: "frame-root" });
  native.set(undefined, {
    tree: frameTree({ id: "frame-root", loaderId: "loader-1" }),
    contexts: { 1: { objectId: "document-replaced", backendNodeId: 99 } },
  });
  await assert.rejects(router.validateFrameIdentity(stamp), { code: "STALE_DOCUMENT" });
  assert.equal(router.isCurrentDocument(stamp.identity), false);
});

test("late swap does not overwrite a newer OOPIF binding and remove invalidates the subtree", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  apply(router, "Page.frameAttached", { frameId: "frame-child", parentFrameId: "frame-root" });
  navigate(router, { frameId: "frame-child", parentId: "frame-root", loaderId: "loader-child" });
  context(router, { frameId: "frame-child", contextId: 2, uniqueId: "sif-child" });
  attachIframe(router, { sessionId: "session-child", targetId: "target-child" });
  navigate(router, {
    frameId: "frame-child",
    parentId: "frame-root",
    loaderId: "loader-child",
    source: "session-child",
    url: "http://cross.test/cross",
  });
  context(router, { frameId: "frame-child", contextId: 1, uniqueId: "oopif-child", source: "session-child" });

  apply(router, "Page.frameDetached", { frameId: "frame-child", reason: "swap" });
  assert.equal(router.resolveFrameCommand({ pageScope: pageScope(), frameId: "frame-child" }).electronSessionId, "session-child");
  const identity = router.observedFrameIdentity(pageScope(), "frame-child");
  const pending = router.beginPending({ pageScope: pageScope(), clientId: "client-1", frameId: "frame-child" });
  router.takeEffects();
  const effects = apply(router, "Page.frameDetached", { frameId: "frame-child", reason: "remove" }, "session-child");
  assert.equal(router.isCurrentDocument(identity), false);
  assert.equal(effects.some((effect) => effect.type === "cancel_pending" && effect.pendingIds.includes(pending)), true);
  assert.throws(() => router.resolveFrameCommand({ pageScope: pageScope(), frameId: "frame-child" }), { code: "DETACHED_FRAME" });
});

test("client aliases reuse live attachments, rotate after explicit detach, and remain client scoped", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-root" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-root" });
  const first = router.attachClient({ pageScope: pageScope(), clientId: "client-a", targetId: "target-root" });
  const repeated = router.attachClient({ pageScope: pageScope(), clientId: "client-a", targetId: "target-root" });
  const other = router.attachClient({ pageScope: pageScope(), clientId: "client-b", targetId: "target-root" });
  assert.equal(repeated.alias, first.alias);
  assert.notEqual(other.alias, first.alias);
  assert.throws(
    () => router.resolveCommand({ pageScope: pageScope(), clientId: "client-b", alias: first.alias }),
    { code: "FOREIGN_ALIAS" },
  );

  router.detachClient({ pageScope: pageScope(), clientId: "client-a", alias: first.alias });
  assert.equal(router.resolveCommand({ pageScope: pageScope(), clientId: "client-b", alias: other.alias }).alias, other.alias);
  const rotated = router.attachClient({ pageScope: pageScope(), clientId: "client-a", targetId: "target-root" });
  assert.notEqual(rotated.alias, first.alias);
  assert.throws(
    () => router.resolveCommand({ pageScope: pageScope(), clientId: "client-a", alias: first.alias }),
    { code: "UNKNOWN_ALIAS" },
  );
});

test("native detach retires only that session aliases and cancels its pending work", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-root" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-root" });
  attachIframe(router, { sessionId: "session-child", targetId: "target-child" });
  navigate(router, { frameId: "frame-child", parentId: "frame-root", loaderId: "loader-child", source: "session-child" });
  context(router, { frameId: "frame-child", contextId: 1, uniqueId: "context-child", source: "session-child" });
  const rootAlias = router.attachClient({ pageScope: pageScope(), clientId: "client-a", targetId: "target-root" });
  const childAlias = router.attachClient({ pageScope: pageScope(), clientId: "client-a", targetId: "target-child" });
  const pending = router.beginPending({ pageScope: pageScope(), clientId: "client-a", alias: childAlias.alias });
  router.takeEffects();

  const effects = apply(router, "Target.detachedFromTarget", {
    sessionId: "session-child",
    targetId: "target-child",
  });
  assert.equal(effects.some((effect) => effect.type === "cancel_pending" && effect.pendingIds.includes(pending)), true);
  assert.throws(
    () => router.resolveCommand({ pageScope: pageScope(), clientId: "client-a", alias: childAlias.alias }),
    { code: "UNKNOWN_ALIAS" },
  );
  assert.equal(router.resolveCommand({ pageScope: pageScope(), clientId: "client-a", alias: rootAlias.alias }).alias, rootAlias.alias);
});

test("nested native detach recursively retires descendants and their waiters", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  attachIframe(router, { sessionId: "session-child", targetId: "target-child" });
  navigate(router, { frameId: "frame-child", parentId: "frame-root", loaderId: "loader-child", source: "session-child" });
  context(router, { frameId: "frame-child", contextId: 1, uniqueId: "context-child", source: "session-child" });
  attachIframe(router, { sessionId: "session-nested", targetId: "target-nested", source: "session-child" });
  navigate(router, { frameId: "frame-nested", parentId: "frame-child", loaderId: "loader-nested", source: "session-nested" });
  context(router, { frameId: "frame-nested", contextId: 1, uniqueId: "context-nested", source: "session-nested" });
  const nestedAlias = router.attachClient({ pageScope: pageScope(), clientId: "client-a", targetId: "target-nested" });
  const pending = router.beginPending({ pageScope: pageScope(), clientId: "client-a", alias: nestedAlias.alias });
  const nestedIdentity = router.observedFrameIdentity(pageScope(), "frame-nested");
  router.takeEffects();
  const effects = apply(router, "Target.detachedFromTarget", { sessionId: "session-child" });
  assert.equal(effects.some((effect) => effect.type === "cancel_pending" && effect.pendingIds.includes(pending)), true);
  assert.equal(router.isCurrentDocument(nestedIdentity), false);
  assert.throws(
    () => router.resolveCommand({ pageScope: pageScope(), clientId: "client-a", alias: nestedAlias.alias }),
    { code: "UNKNOWN_ALIAS" },
  );
});

test("event fanout uses exact session aliases and source child alias for one dialog event per client", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-root" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-root" });
  attachIframe(router, { sessionId: "session-child", targetId: "target-child" });
  navigate(router, { frameId: "frame-child", parentId: "frame-root", loaderId: "loader-child", source: "session-child" });
  context(router, { frameId: "frame-child", contextId: 1, uniqueId: "context-child", source: "session-child" });
  const rootA = router.attachClient({ pageScope: pageScope(), clientId: "client-a", targetId: "target-root" });
  const childA = router.attachClient({ pageScope: pageScope(), clientId: "client-a", targetId: "target-child" });
  const childB = router.attachClient({ pageScope: pageScope(), clientId: "client-b", targetId: "target-child" });
  const rootC = router.attachClient({ pageScope: pageScope(), clientId: "client-c", targetId: "target-root" });

  const sessionEvents = router.routeNativeEvent({
    pageScope: pageScope(),
    sourceElectronSessionId: "session-child",
    method: "Runtime.consoleAPICalled",
    params: { type: "log" },
  });
  assert.deepEqual(sessionEvents.map((event) => event.alias).sort(), [childA.alias, childB.alias].sort());

  const pageEvents = router.routeNativeEvent({
    pageScope: pageScope(),
    sourceElectronSessionId: "session-child",
    method: "Page.javascriptDialogOpening",
    params: { message: "hello" },
  });
  assert.deepEqual(pageEvents.map((event) => [event.clientId, event.alias]).sort(), [
    ["client-a", childA.alias],
    ["client-b", childB.alias],
    ["client-c", rootC.alias],
  ]);
  assert.equal(pageEvents.length, 3);
  assert.equal(pageEvents[0].origin.pageId, "page-1");
  assert.equal(pageEvents[0].origin.frameId, "frame-child");
  assert.equal(pageEvents[0].origin.identity.frameId, "frame-child");

  const downloadEvents = router.routeNativeEvent({
    pageScope: pageScope(),
    sourceElectronSessionId: "session-child",
    method: "Browser.downloadWillBegin",
    params: { guid: "download-1" },
  });
  assert.deepEqual(downloadEvents.map((event) => [event.clientId, event.alias]).sort(), [
    ["client-a", rootA.alias],
    ["client-b", childB.alias],
    ["client-c", rootC.alias],
  ]);
});

test("root native session keeps root source while a trusted event frameId identifies child origin", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-root" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-root" });
  apply(router, "Page.frameAttached", { frameId: "frame-sif", parentFrameId: "frame-root" });
  navigate(router, { frameId: "frame-sif", parentId: "frame-root", loaderId: "loader-sif" });
  context(router, { frameId: "frame-sif", contextId: 2, uniqueId: "context-sif" });
  const rootAlias = router.attachClient({ pageScope: pageScope(), clientId: "client-a", targetId: "target-root" });
  const [dialog] = router.routeNativeEvent({
    pageScope: pageScope(),
    method: "Page.javascriptDialogOpening",
    params: { message: "child surfaced at page root", frameId: "frame-sif" },
  });
  assert.equal(dialog.alias, rootAlias.alias);
  assert.equal(dialog.origin.frameId, "frame-sif");
  assert.equal(dialog.origin.identity.frameId, "frame-sif");
  assert.equal(dialog.origin.sourceFrameId, "frame-root");
  assert.equal(dialog.origin.sourceTargetId, "target-root");
});

test("execution context replacement without a navigation event rotates the document", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-root" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-one" });
  const oldIdentity = router.observedFrameIdentity(pageScope(), "frame-root");
  router.takeEffects();
  const effects = context(router, { frameId: "frame-root", contextId: 2, uniqueId: "context-two" });
  assert.equal(router.isCurrentDocument(oldIdentity), false);
  assert.equal(effects.some((effect) => effect.type === "invalidate_documents" && effect.reason === "execution_context_changed"), true);
});

test("context destruction followed by replacement still rotates the document", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-root" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-one" });
  const oldIdentity = router.observedFrameIdentity(pageScope(), "frame-root");
  apply(router, "Runtime.executionContextDestroyed", {
    executionContextId: 1,
    executionContextUniqueId: "context-one",
  });
  context(router, { frameId: "frame-root", contextId: 2, uniqueId: "context-two" });
  assert.equal(router.isCurrentDocument(oldIdentity), false);
});

test("reference registry consumes router current-document truth without a second frame graph", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-one" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-one" });
  let nextRef = 1_000;
  const refs = new DesktopReferenceRegistry({
    allocator: { allocate: () => nextRef++ },
    isCurrentDocument: (identity) => router.isCurrentDocument(identity),
    revalidateAction: async () => {},
  });
  const identity = router.observedFrameIdentity(pageScope(), "frame-root");
  const ticket = refs.beginSnapshot(identity);
  const [record] = refs.commitSnapshot(ticket, {
    mode: "partial",
    nodes: [{ backendNodeId: 7 }],
  });
  assert.equal(refs.resolve(record.ref, pageScope()).backendNodeId, 7);

  navigate(router, { frameId: "frame-root", loaderId: "loader-two" });
  assert.throws(() => refs.resolve(record.ref, pageScope()), { code: "REFERENCE_DOCUMENT_NOT_CURRENT" });
  assert.throws(() => refs.beginSnapshot(identity), { code: "REFERENCE_DOCUMENT_NOT_CURRENT" });
});

test("reference registry accepts a fresh closed-page replacement while old references stay stale", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-old" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-old" });
  let nextRef = 2_000;
  const refs = new DesktopReferenceRegistry({
    allocator: { allocate: () => nextRef++ },
    isCurrentDocument: (identity) => router.isCurrentDocument(identity),
    revalidateAction: async () => {},
  });
  const oldIdentity = router.observedFrameIdentity(pageScope(), "frame-root");
  const oldTicket = refs.beginSnapshot(oldIdentity);
  const [oldRef] = refs.commitSnapshot(oldTicket, { mode: "partial", nodes: [{ backendNodeId: 7 }] });

  router.closePage(pageScope(), "renderer_crashed");
  refs.invalidatePage(pageScope(), "renderer_crashed");
  router.replacePage(pageRegistration({ webContentsId: 202 }), "renderer_recreated");
  navigate(router, { frameId: "frame-root", loaderId: "loader-new" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-new" });
  const newIdentity = router.observedFrameIdentity(pageScope(), "frame-root");
  assert.notEqual(newIdentity.documentId, oldIdentity.documentId);
  const newTicket = refs.beginSnapshot(newIdentity);
  const [newRef] = refs.commitSnapshot(newTicket, { mode: "partial", nodes: [{ backendNodeId: 7 }] });
  assert.notEqual(newRef.ref, oldRef.ref);
  assert.equal(refs.resolve(newRef.ref, pageScope()).documentId, newIdentity.documentId);
  assert.throws(() => refs.resolve(oldRef.ref, pageScope()), { code: "REFERENCE_STALE" });
});

test("closePage makes exact live identity checks false and cancels page pending work", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-root" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-root" });
  const identity = router.observedFrameIdentity(pageScope(), "frame-root");
  const pending = router.beginPending({ pageScope: pageScope(), clientId: "client-a", frameId: "frame-root" });
  router.takeEffects();
  const effects = router.closePage(pageScope(), "webcontents_destroyed");
  assert.equal(router.isCurrentDocument(identity), false);
  assert.equal(effects.some((effect) => effect.type === "cancel_pending" && effect.pendingIds.includes(pending)), true);
  assert.throws(() => router.attachClient({ pageScope: pageScope(), clientId: "client-a", targetId: "target-root" }), { code: "PAGE_CLOSED" });
});

test("foreign native events and expected identities never fall back to the root session", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-root", loaderId: "loader-root" });
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "context-root" });
  assert.throws(
    () => apply(router, "Page.navigatedWithinDocument", { frameId: "frame-root", url: "http://bad/" }, "unknown-session"),
    { code: "FOREIGN_SESSION" },
  );
  const alias = router.attachClient({ pageScope: pageScope(), clientId: "client-a", targetId: "target-root" });
  const identity = router.observedFrameIdentity(pageScope(), "frame-root");
  assert.throws(
    () => router.resolveCommand({
      pageScope: pageScope(),
      clientId: "client-a",
      alias: alias.alias,
      expectedIdentity: { ...identity, documentEpoch: identity.documentEpoch + 1 },
    }),
    { code: "STALE_DOCUMENT" },
  );
});

test("native session discovery captures authority before any child frame or default context exists", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  const root = router.captureNativeSession(pageScope());
  const [effect] = attachIframe(router, { sessionId: "session-child", targetId: "unrelated-target-id" });
  const source = router.captureNativeSession(pageScope(), "session-child");
  assert.equal(effect.nativeSessionGeneration, 0);
  assert.equal(source.nativeSessionKey, effect.nativeSessionKey);
  assert.equal(source.nativeSessionGeneration, effect.nativeSessionGeneration);
  assert.equal(source.parentNativeSessionKey, root.nativeSessionKey);
  assert.equal(source.frameId, undefined);
  assert.equal(source.pageIncarnationId, root.pageIncarnationId);
  assert.equal(Object.isFrozen(source), true);
  assert.equal(router.stats(pageScope()).frames, 1);
  assert.deepEqual(router.listFrameRoutes(pageScope()), []);
  assert.throws(() => router.captureNativeSession(pageScope({ taskId: "foreign-task" }), "session-child"), { code: "UNKNOWN_PAGE" });
  assert.throws(() => router.captureNativeSession(pageScope(), "foreign-session"), { code: "FOREIGN_SESSION" });
});

test("loaded root and child frame trees bootstrap parent-first before Runtime enable contexts", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  apply(router, "Page.frameAttached", { frameId: "frame-child", parentFrameId: "frame-root" });
  apply(router, "Page.frameAttached", { frameId: "frame-sif", parentFrameId: "frame-root" });
  navigate(router, { frameId: "frame-root", loaderId: "loader-root" });
  const rootIdentity = router.observedFrameIdentity(pageScope(), "frame-root");
  navigate(router, { frameId: "frame-root", loaderId: "loader-root" });
  assert.deepEqual(router.observedFrameIdentity(pageScope(), "frame-root"), rootIdentity);
  context(router, { frameId: "frame-root", contextId: 1, uniqueId: "root-context" });
  context(router, { frameId: "frame-sif", contextId: 2, uniqueId: "sif-context" });
  attachIframe(router, { sessionId: "session-child", targetId: "target-does-not-equal-frame" });
  const source = router.captureNativeSession(pageScope(), "session-child");
  router.applyDebuggerEvent({
    pageScope: pageScope(), sourceElectronSessionId: "session-child",
    expectedNativeSessionKey: source.nativeSessionKey,
    expectedNativeSessionGeneration: source.nativeSessionGeneration,
    method: "Page.frameNavigated", params: { frame: { id: "frame-child", loaderId: "loader-child" } },
  });
  context(router, { frameId: "frame-child", contextId: 1, uniqueId: "child-context", source: "session-child" });
  attachIframe(router, { sessionId: "session-nested", targetId: "another-target-id", source: "session-child" });
  navigate(router, { frameId: "frame-nested", parentId: "frame-child", loaderId: "loader-nested", source: "session-nested" });
  context(router, { frameId: "frame-nested", contextId: 1, uniqueId: "nested-context", source: "session-nested" });
  const routes = router.listFrameRoutes(pageScope());
  assert.equal(routes.find((route) => route.identity.frameId === "frame-child").parentFrameId, "frame-root");
  assert.equal(routes.find((route) => route.identity.frameId === "frame-nested").parentFrameId, "frame-child");
  assert.equal(routes.find((route) => route.identity.frameId === "frame-child").electronSessionId, "session-child");
  assert.equal(routes.find((route) => route.identity.frameId === "frame-nested").electronSessionId, "session-nested");
  assert.equal(routes.length, 4);
});

test("unknown child contexts remain rejected and unknown child roots without parent authority cannot bootstrap", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  attachIframe(router, { sessionId: "session-child", targetId: "target-child" });
  assert.throws(() => context(router, { frameId: "frame-child", contextId: 1, uniqueId: "child-context", source: "session-child" }), { code: "FOREIGN_FRAME" });
  assert.throws(() => navigate(router, { frameId: "frame-child", loaderId: "loader-child", source: "session-child" }), { code: "FOREIGN_FRAME" });
  assert.throws(() => navigate(router, { frameId: "unknown-root-frame", loaderId: "loader-root" }), { code: "FOREIGN_FRAME" });
  assert.equal(router.stats(pageScope()).frames, 1);
  assert.equal(router.stats(pageScope()).pending, 0);
  navigate(router, { frameId: "frame-child", parentId: "frame-root", loaderId: "loader-child", source: "session-child" });
  context(router, { frameId: "frame-child", contextId: 1, uniqueId: "child-context", source: "session-child" });
  assert.equal(router.resolveFrameCommand({ pageScope: pageScope(), frameId: "frame-child" }).executionContextId, 1);
});

test("same-process descendants inside an OOPIF do not replace its native target root", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  attachIframe(router, { sessionId: "session-child", targetId: "target-child" });
  navigate(router, { frameId: "frame-child", parentId: "frame-root", loaderId: "loader-child", source: "session-child" });
  context(router, { frameId: "frame-child", contextId: 1, uniqueId: "child-context", source: "session-child" });
  navigate(router, { frameId: "frame-inner", parentId: "frame-child", loaderId: "loader-inner", source: "session-child" });
  context(router, { frameId: "frame-inner", contextId: 2, uniqueId: "inner-context", source: "session-child" });
  assert.equal(router.captureNativeSession(pageScope(), "session-child").frameId, "frame-child");
  const alias = router.attachClient({ pageScope: pageScope(), clientId: "client-1", targetId: "target-child" });
  assert.equal(router.resolveCommand({ pageScope: pageScope(), clientId: "client-1", alias: alias.alias }).identity.frameId, "frame-child");
  assert.equal(router.resolveFrameCommand({ pageScope: pageScope(), frameId: "frame-inner" }).executionContextId, 2);
});

test("foreign child sessions cannot rebind root or sibling frames or remove another child subtree", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  attachIframe(router, { sessionId: "session-child", targetId: "target-child" });
  navigate(router, { frameId: "frame-child", parentId: "frame-root", loaderId: "loader-child", source: "session-child" });
  attachIframe(router, { sessionId: "session-sibling", targetId: "target-sibling" });
  navigate(router, { frameId: "frame-sibling", parentId: "frame-root", loaderId: "loader-sibling", source: "session-sibling" });
  const root = router.observedFrameIdentity(pageScope(), "frame-root");
  const sibling = router.observedFrameIdentity(pageScope(), "frame-sibling");
  assert.throws(() => navigate(router, { frameId: "frame-root", loaderId: "bad", source: "session-child" }), { code: "FOREIGN_SESSION" });
  assert.throws(() => navigate(router, { frameId: "frame-sibling", parentId: "frame-root", loaderId: "bad", source: "session-child" }), { code: "FOREIGN_SESSION" });
  assert.throws(() => apply(router, "Page.frameDetached", { frameId: "frame-sibling", reason: "remove" }, "session-child"), { code: "FOREIGN_SESSION" });
  assert.throws(() => apply(router, "Page.frameAttached", { frameId: "frame-foreign", parentFrameId: "frame-sibling" }, "session-child"), { code: "FOREIGN_SESSION" });
  assert.deepEqual(router.observedFrameIdentity(pageScope(), "frame-root"), root);
  assert.deepEqual(router.observedFrameIdentity(pageScope(), "frame-sibling"), sibling);
});

test("frame discovery stamps reject detach, replacement, and generation changes after an awaited query", async () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  attachIframe(router, { sessionId: "session-child", targetId: "target-child" });
  const before = router.captureNativeSession(pageScope(), "session-child");
  const staleEvent = {
    pageScope: pageScope(), sourceElectronSessionId: "session-child",
    expectedNativeSessionKey: before.nativeSessionKey,
    expectedNativeSessionGeneration: before.nativeSessionGeneration,
    method: "Page.frameNavigated", params: { frame: { id: "frame-child", parentId: "frame-root", loaderId: "loader-child" } },
  };
  await Promise.resolve();
  apply(router, "Target.detachedFromTarget", { sessionId: "session-child" });
  assert.throws(() => router.applyDebuggerEvent(staleEvent), { code: "FOREIGN_SESSION" });
  attachIframe(router, { sessionId: "session-child", targetId: "target-child" });
  assert.throws(() => router.applyDebuggerEvent(staleEvent), { code: "STALE_SESSION_ROUTE" });
  const fresh = router.captureNativeSession(pageScope(), "session-child");
  apply(router, "Page.frameAttached", { frameId: "frame-child", parentFrameId: "frame-root" });
  navigate(router, { frameId: "frame-child", parentId: "frame-root", loaderId: "loader-child", source: "session-child" });
  assert.ok(router.captureNativeSession(pageScope(), "session-child").nativeSessionGeneration > fresh.nativeSessionGeneration);
  assert.throws(() => router.applyDebuggerEvent({ ...staleEvent, expectedNativeSessionKey: fresh.nativeSessionKey, expectedNativeSessionGeneration: fresh.nativeSessionGeneration }), { code: "STALE_SESSION_ROUTE" });
  assert.throws(() => router.applyDebuggerEvent({ ...staleEvent, expectedNativeSessionKey: fresh.nativeSessionKey, expectedNativeSessionGeneration: undefined }), TypeError);
});

test("frame discovery rejects a parent cycle without changing the current document", () => {
  const { router } = routerHarness();
  router.registerPage(pageRegistration());
  navigate(router, { frameId: "frame-child", parentId: "frame-root", loaderId: "loader-child" });
  navigate(router, { frameId: "frame-inner", parentId: "frame-child", loaderId: "loader-inner" });
  const before = router.observedFrameIdentity(pageScope(), "frame-child");
  assert.throws(() => navigate(router, { frameId: "frame-child", parentId: "frame-inner", loaderId: "bad" }), { code: "FOREIGN_FRAME" });
  assert.deepEqual(router.observedFrameIdentity(pageScope(), "frame-child"), before);
});
