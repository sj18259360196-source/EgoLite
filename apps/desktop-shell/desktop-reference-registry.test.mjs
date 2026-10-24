import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopReferenceRegistry,
  formatPublicReference,
  parsePublicReference,
} from "./desktop-reference-registry.mjs";

function allocator(start = 10_000) {
  let next = start;
  return { allocate: () => next++ };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function liveDocumentAuthority(...initialDocuments) {
  const currentByFrame = new Map();
  const frameKey = (identity) => JSON.stringify([
    identity.runtimeId,
    identity.taskId,
    identity.pageId,
    identity.frameId,
  ]);
  const documentKey = (identity) => JSON.stringify([
    identity.runtimeId,
    identity.taskId,
    identity.pageId,
    identity.frameId,
    identity.documentId,
    identity.documentEpoch,
  ]);
  const authority = {
    set(identity) { currentByFrame.set(frameKey(identity), documentKey(identity)); },
    remove(identity) { currentByFrame.delete(frameKey(identity)); },
    isCurrentDocument(identity) {
      return currentByFrame.get(frameKey(identity)) === documentKey(identity);
    },
  };
  for (const identity of initialDocuments) authority.set(identity);
  return authority;
}

function document(overrides = {}) {
  return {
    runtimeId: "runtime-1",
    taskId: "task-1",
    pageId: "page-1",
    frameId: "frame-main",
    documentId: "document-a",
    documentEpoch: 1,
    ...overrides,
  };
}

function scope(identity = document(), overrides = {}) {
  return {
    runtimeId: identity.runtimeId,
    taskId: identity.taskId,
    pageId: identity.pageId,
    ...overrides,
  };
}

function lease(overrides = {}) {
  return {
    taskId: "task-1",
    taskSpaceId: 1,
    clientId: "client-1",
    leaseEpoch: 4,
    ...overrides,
  };
}

function registry(options = {}) {
  return new DesktopReferenceRegistry({
    allocator: options.allocator || allocator(),
    revalidateAction: options.revalidateAction || (async () => {}),
    isCurrentDocument: options.isCurrentDocument || (() => true),
    ...options,
  });
}

function capture(target, identity, mode, backendNodeIds) {
  const ticket = target.beginSnapshot(identity);
  return target.commitSnapshot(ticket, {
    mode,
    nodes: backendNodeIds.map((backendNodeId) => ({ backendNodeId })),
  });
}

test("discard consumes only its own ticket without advancing commit sequence or changing refs", () => {
  const target = registry();
  const other = registry();
  const [original] = capture(target, document(), "partial", [1]);
  const older = target.beginSnapshot(document());
  const abandoned = target.beginSnapshot(document());
  assert.equal(other.discardSnapshot(abandoned), false);
  assert.equal(target.discardSnapshot(abandoned), true);
  assert.equal(target.discardSnapshot(abandoned), false);
  assert.equal(target.resolve(original.refId, scope()).backendNodeId, 1);
  target.commitSnapshot(older, { mode: "full_document", nodes: [{ backendNodeId: 2 }] });
  assert.equal(target.stats().pendingSnapshots, 0);
  assert.throws(() => target.commitSnapshot(abandoned, { mode: "partial", nodes: [] }));
});

test("public references are independent IDs and require runtime, task, and page scope", () => {
  const refs = registry();
  const identity = document();
  const [record] = capture(refs, identity, "partial", [7]);
  assert.equal(record.ref, "@10000");
  assert.equal(record.backendNodeId, 7);
  assert.equal(refs.resolve("@10000", scope(identity)), record);
  assert.throws(() => refs.resolve("@10000", scope(identity, { pageId: "page-2" })), { code: "REFERENCE_SCOPE_MISMATCH" });
  assert.throws(() => refs.resolve("@7", scope(identity)), { code: "REFERENCE_UNKNOWN" });
  assert.throws(() => refs.resolve("10000", scope(identity)), { code: "REFERENCE_FORMAT_INVALID" });
});

test("same native node IDs in different pages, tasks, and runtimes never alias", () => {
  const refs = registry();
  const identities = [
    document(),
    document({ pageId: "page-2" }),
    document({ taskId: "task-2", pageId: "page-3" }),
    document({ runtimeId: "runtime-2", pageId: "page-4" }),
  ];
  const records = identities.map((identity) => capture(refs, identity, "partial", [42])[0]);
  assert.deepEqual(records.map((record) => record.refId), [10000, 10001, 10002, 10003]);
  for (let index = 0; index < records.length; index += 1) {
    assert.equal(refs.resolve(records[index].ref, scope(identities[index])).pageId, identities[index].pageId);
  }
});

test("partial snapshots merge and full snapshots replace only their exact document", () => {
  const refs = registry();
  const main = document();
  const child = document({ frameId: "frame-child", documentId: "document-child" });
  const [one, two] = capture(refs, main, "partial", [1, 2]);
  const [three] = capture(refs, main, "partial", [3]);
  const [childRef] = capture(refs, child, "full_document", [1]);
  assert.equal(refs.resolve(one.ref, scope(main)), one);
  assert.equal(refs.resolve(two.ref, scope(main)), two);
  assert.equal(refs.resolve(three.ref, scope(main)), three);

  const [sameThree] = capture(refs, main, "full_document", [3]);
  assert.equal(sameThree.refId, three.refId);
  assert.throws(() => refs.resolve(one.ref, scope(main)), { code: "REFERENCE_STALE" });
  assert.equal(refs.resolve(childRef.ref, scope(child)), childRef);
});

test("viewport-like partial absence never retires unrelated references", () => {
  const refs = registry();
  const identity = document();
  const [top, bottom] = capture(refs, identity, "full_document", [1, 2]);
  capture(refs, identity, "partial", [1]);
  assert.equal(refs.resolve(bottom.ref, scope(identity)), bottom);
  assert.equal(refs.resolve(top.ref, scope(identity)), top);
});

test("independent partial captures may commit out of order", () => {
  const refs = registry();
  const identity = document();
  const first = refs.beginSnapshot(identity);
  const second = refs.beginSnapshot(identity);
  const [two] = refs.commitSnapshot(second, { mode: "partial", nodes: [{ backendNodeId: 2 }] });
  const [one] = refs.commitSnapshot(first, { mode: "partial", nodes: [{ backendNodeId: 1 }] });
  assert.equal(refs.resolve(one.ref, scope(identity)).backendNodeId, 1);
  assert.equal(refs.resolve(two.ref, scope(identity)).backendNodeId, 2);
});

test("obsolete full snapshots cannot erase newer commits", () => {
  const refs = registry();
  const identity = document();
  const olderFull = refs.beginSnapshot(identity);
  const newerPartial = refs.beginSnapshot(identity);
  refs.commitSnapshot(newerPartial, { mode: "partial", nodes: [{ backendNodeId: 2 }] });
  assert.throws(
    () => refs.commitSnapshot(olderFull, { mode: "full_document", nodes: [{ backendNodeId: 1 }] }),
    { code: "SNAPSHOT_STALE" },
  );

  const oldPartial = refs.beginSnapshot(identity);
  const newFull = refs.beginSnapshot(identity);
  refs.commitSnapshot(newFull, { mode: "full_document", nodes: [{ backendNodeId: 3 }] });
  assert.throws(
    () => refs.commitSnapshot(oldPartial, { mode: "partial", nodes: [{ backendNodeId: 4 }] }),
    { code: "SNAPSHOT_STALE" },
  );
});

test("document invalidation rejects in-flight snapshots and only retires the exact document", () => {
  const refs = registry();
  const main = document();
  const child = document({ frameId: "child", documentId: "child-document" });
  const [mainRef] = capture(refs, main, "partial", [1]);
  const [childRef] = capture(refs, child, "partial", [2]);
  const pending = refs.beginSnapshot(main);
  refs.invalidateDocuments([main], "navigation");
  assert.throws(() => refs.commitSnapshot(pending, { mode: "partial", nodes: [{ backendNodeId: 3 }] }), { code: "SNAPSHOT_STALE" });
  assert.throws(() => refs.resolve(mainRef.ref, scope(main)), { code: "REFERENCE_STALE" });
  assert.equal(refs.resolve(childRef.ref, scope(child)), childRef);
});

test("frame-subtree and page invalidation use integration-supplied scope", () => {
  const refs = registry();
  const main = document();
  const child = document({ frameId: "child", documentId: "child-doc" });
  const grandchild = document({ frameId: "grandchild", documentId: "grandchild-doc" });
  const siblingPage = document({ pageId: "page-2", frameId: "other", documentId: "other-doc" });
  const [mainRef] = capture(refs, main, "partial", [1]);
  const [childRef] = capture(refs, child, "partial", [2]);
  const [grandchildRef] = capture(refs, grandchild, "partial", [3]);
  const [otherRef] = capture(refs, siblingPage, "partial", [4]);

  refs.invalidateFrameSubtree(scope(main), ["child", "grandchild"], "frame_navigation");
  assert.equal(refs.resolve(mainRef.ref, scope(main)), mainRef);
  assert.throws(() => refs.resolve(childRef.ref, scope(child)), { code: "REFERENCE_STALE" });
  assert.throws(() => refs.resolve(grandchildRef.ref, scope(grandchild)), { code: "REFERENCE_STALE" });
  assert.equal(refs.resolve(otherRef.ref, scope(siblingPage)), otherRef);

  refs.invalidatePage(scope(main));
  assert.throws(() => refs.resolve(mainRef.ref, scope(main)), { code: "REFERENCE_STALE" });
  assert.equal(refs.resolve(otherRef.ref, scope(siblingPage)), otherRef);
});

test("action tokens bind exact caller lease and scope and revalidate at each phase", async () => {
  const calls = [];
  const refs = registry({ revalidateAction: async (call) => { calls.push(call); } });
  const identity = document();
  const [record] = capture(refs, identity, "partial", [8]);
  const expected = scope(identity, { frameId: identity.frameId, documentId: identity.documentId, documentEpoch: 1 });
  const callerLease = lease();
  const token = await refs.bindAction(record.ref, { expectedScope: expected, lease: callerLease });
  assert.match(token, /^action_[A-Za-z0-9_-]+$/);
  assert.equal(typeof JSON.parse(JSON.stringify(token)), "string");
  assert.equal((await refs.revalidateBoundAction(token, { expectedScope: expected, lease: callerLease })).refId, record.refId);
  assert.deepEqual(calls.map((call) => call.phase), ["bind", "use"]);
  await assert.rejects(
    refs.revalidateBoundAction("action_forged", { expectedScope: expected, lease: callerLease }),
    /unknown or expired/,
  );
  await assert.rejects(
    refs.revalidateBoundAction(token, { expectedScope: expected, lease: lease({ leaseEpoch: 5 }) }),
    { code: "ACTION_CONTEXT_MISMATCH" },
  );
  assert.equal(refs.releaseBoundAction(token), true);
});

test("action deadlines are capped, never renewed, and expired contexts are reclaimed", async () => {
  let now = 1_000;
  const observedExpiries = [];
  const refs = registry({
    now: () => now,
    maxActionContextTtlMs: 30_000,
    revalidateAction: async ({ expiresAt }) => { observedExpiries.push(expiresAt); },
  });
  const identity = document();
  const [record] = capture(refs, identity, "partial", [1]);
  const token = await refs.bindAction(record.ref, {
    expectedScope: scope(identity),
    lease: lease(),
    deadlineAt: now + 120_000,
  });
  assert.deepEqual(observedExpiries, [31_000]);
  now = 30_999;
  await refs.revalidateBoundAction(token, { expectedScope: scope(identity), lease: lease() });
  assert.deepEqual(observedExpiries, [31_000, 31_000]);
  now = 31_000;
  await assert.rejects(
    refs.revalidateBoundAction(token, { expectedScope: scope(identity), lease: lease() }),
    { code: "ACTION_CONTEXT_INVALID" },
  );
  assert.equal(refs.stats().actionContexts, 0);
});

test("reference invalidation makes an already bound action stale", async () => {
  const refs = registry();
  const identity = document();
  const [record] = capture(refs, identity, "partial", [1]);
  const token = await refs.bindAction(record.ref, { expectedScope: scope(identity), lease: lease() });
  refs.invalidateDocuments([identity]);
  await assert.rejects(
    refs.revalidateBoundAction(token, { expectedScope: scope(identity), lease: lease() }),
    { code: "REFERENCE_STALE" },
  );
});

test("live metadata and tombstones stay bounded without reusing IDs", () => {
  const refs = registry({ maxLiveRefs: 2, maxTombstones: 1 });
  const identity = document();
  const [one, two] = capture(refs, identity, "partial", [1, 2]);
  const [three] = capture(refs, identity, "partial", [3]);
  assert.throws(() => refs.resolve(one.ref, scope(identity)));
  assert.equal(refs.resolve(two.ref, scope(identity)), two);
  assert.equal(refs.resolve(three.ref, scope(identity)), three);
  capture(refs, identity, "partial", [4]);
  assert.deepEqual(refs.stats(), {
    liveRefs: 2,
    tombstones: 1,
    invalidatedScopes: 0,
    documents: 1,
    pendingSnapshots: 0,
    actionContexts: 0,
  });
  assert.deepEqual([one.refId, two.refId, three.refId], [10000, 10001, 10002]);
});

test("snapshot tickets and action contexts enforce configured capacity", async () => {
  const refs = registry({ maxPendingSnapshots: 1, maxActionContexts: 1 });
  const identity = document();
  const pending = refs.beginSnapshot(identity);
  assert.throws(() => refs.beginSnapshot(identity), { code: "SNAPSHOT_CAPACITY_EXCEEDED" });
  const [record] = refs.commitSnapshot(pending, { mode: "partial", nodes: [{ backendNodeId: 1 }] });
  await refs.bindAction(record.ref, { expectedScope: scope(identity), lease: lease() });
  await assert.rejects(
    refs.bindAction(record.ref, { expectedScope: scope(identity), lease: lease() }),
    { code: "ACTION_CONTEXT_CAPACITY_EXCEEDED" },
  );
});

test("allocator duplicate IDs fail before registry state is mutated", () => {
  const refs = registry({ allocator: { allocate: () => 77 } });
  const identity = document();
  const ticket = refs.beginSnapshot(identity);
  assert.throws(
    () => refs.commitSnapshot(ticket, {
      mode: "partial",
      nodes: [{ backendNodeId: 1 }, { backendNodeId: 2 }],
    }),
    { code: "REFERENCE_ALLOCATOR_INVALID" },
  );
  assert.equal(refs.stats().liveRefs, 0);
});

test("document state metadata is bounded and does not evict live document state", () => {
  const refs = registry({ maxDocumentStates: 1, maxLiveRefs: 1 });
  const first = document();
  const second = document({ pageId: "page-2", documentId: "document-b" });
  const [record] = capture(refs, first, "partial", [1]);
  assert.throws(() => refs.beginSnapshot(second), { code: "DOCUMENT_STATE_CAPACITY_EXCEEDED" });
  capture(refs, first, "full_document", []);
  assert.doesNotThrow(() => refs.beginSnapshot(second));
  assert.throws(() => refs.resolve(record.ref, scope(first)), { code: "REFERENCE_STALE" });
  assert.equal(refs.stats().documents, 1);
});

test("failed action callback never creates a reusable token", async () => {
  const refs = registry({ revalidateAction: async () => { throw new Error("lease revoked"); } });
  const identity = document();
  const [record] = capture(refs, identity, "partial", [1]);
  await assert.rejects(
    refs.bindAction(record.ref, { expectedScope: scope(identity), lease: lease() }),
    /lease revoked/,
  );
  assert.equal(refs.stats().actionContexts, 0);
});

test("concurrent action binds reserve capacity before awaiting authorization", async () => {
  const entered = deferred();
  const release = deferred();
  const refs = registry({
    maxActionContexts: 1,
    revalidateAction: async ({ phase }) => {
      if (phase === "bind") {
        entered.resolve();
        await release.promise;
      }
    },
  });
  const identity = document();
  const [record] = capture(refs, identity, "partial", [1]);
  const first = refs.bindAction(record.ref, { expectedScope: scope(identity), lease: lease() });
  await entered.promise;
  assert.equal(refs.stats().actionContexts, 1);
  await assert.rejects(
    refs.bindAction(record.ref, { expectedScope: scope(identity), lease: lease() }),
    { code: "ACTION_CONTEXT_CAPACITY_EXCEEDED" },
  );
  release.resolve();
  const token = await first;
  assert.equal(refs.releaseBoundAction(token), true);
});

test("revalidation rejects a context released while its async callback is pending", async () => {
  const entered = deferred();
  const release = deferred();
  const refs = registry({
    revalidateAction: async ({ phase }) => {
      if (phase === "use") {
        entered.resolve();
        await release.promise;
      }
    },
  });
  const identity = document();
  const [record] = capture(refs, identity, "partial", [1]);
  const token = await refs.bindAction(record.ref, { expectedScope: scope(identity), lease: lease() });
  const pending = refs.revalidateBoundAction(token, { expectedScope: scope(identity), lease: lease() });
  await entered.promise;
  assert.equal(refs.releaseBoundAction(token), true);
  release.resolve();
  await assert.rejects(pending, { code: "ACTION_CONTEXT_INVALID" });
});

test("live document authority rejects delayed captures for a removed unknown frame", () => {
  const oldFrameDocument = document({ frameId: "removed-frame", documentId: "old-frame-document" });
  const authority = liveDocumentAuthority(oldFrameDocument);
  const refs = registry({ isCurrentDocument: authority.isCurrentDocument });
  const ticket = refs.beginSnapshot(oldFrameDocument);
  authority.remove(oldFrameDocument);
  refs.invalidateFrameSubtree(scope(oldFrameDocument), [oldFrameDocument.frameId]);
  assert.throws(
    () => refs.commitSnapshot(ticket, { mode: "partial", nodes: [{ backendNodeId: 1 }] }),
    { code: "REFERENCE_DOCUMENT_NOT_CURRENT" },
  );

  const neverObserved = document({ frameId: "never-observed", documentId: "never-observed-document" });
  refs.invalidateFrameSubtree(scope(neverObserved), [neverObserved.frameId]);
  assert.throws(() => refs.beginSnapshot(neverObserved), { code: "REFERENCE_DOCUMENT_NOT_CURRENT" });
});

for (const invalidationKind of ["document", "page", "runtime"]) {
  test(`${invalidationKind} identity stays rejected after its diagnostic tombstone is evicted`, () => {
    const stale = document();
    const authority = liveDocumentAuthority(stale);
    const refs = registry({ maxTombstones: 1, isCurrentDocument: authority.isCurrentDocument });
    capture(refs, stale, "partial", [1]);
    authority.remove(stale);
    if (invalidationKind === "document") refs.invalidateDocuments([stale]);
    if (invalidationKind === "page") refs.invalidatePage(scope(stale));
    if (invalidationKind === "runtime") refs.invalidateRuntime(stale.runtimeId);

    refs.invalidateDocuments([
      document({ pageId: "evict-page-1", frameId: "evict-frame-1", documentId: "evict-doc-1" }),
      document({ pageId: "evict-page-2", frameId: "evict-frame-2", documentId: "evict-doc-2" }),
    ]);
    assert.equal(refs.stats().invalidatedScopes, 1);
    assert.throws(() => refs.beginSnapshot(stale), { code: "REFERENCE_DOCUMENT_NOT_CURRENT" });
  });
}

test("diagnostic page tombstone does not block a freshly authoritative page incarnation", () => {
  const oldDocument = document();
  const newDocument = document({ documentId: "document-new", documentEpoch: 0 });
  const authority = liveDocumentAuthority(oldDocument);
  const refs = registry({ isCurrentDocument: authority.isCurrentDocument });
  const [oldRef] = capture(refs, oldDocument, "partial", [1]);
  authority.remove(oldDocument);
  refs.invalidatePage(scope(oldDocument), "page_replaced");
  authority.set(newDocument);
  const [newRef] = capture(refs, newDocument, "partial", [1]);
  assert.notEqual(newRef.refId, oldRef.refId);
  assert.throws(() => refs.resolve(oldRef.ref, scope(oldDocument)), { code: "REFERENCE_STALE" });
  assert.equal(refs.resolve(newRef.ref, scope(newDocument)), newRef);
});

test("document authority is rechecked after asynchronous action validation", async () => {
  const identity = document();
  const authority = liveDocumentAuthority(identity);
  const refs = registry({
    isCurrentDocument: authority.isCurrentDocument,
    revalidateAction: async () => { authority.remove(identity); },
  });
  const [record] = capture(refs, identity, "partial", [1]);
  await assert.rejects(
    refs.bindAction(record.ref, { expectedScope: scope(identity), lease: lease() }),
    { code: "REFERENCE_DOCUMENT_NOT_CURRENT" },
  );
  assert.equal(refs.stats().actionContexts, 0);
});

test("document authority is rechecked after asynchronous bound-action revalidation", async () => {
  const identity = document();
  const authority = liveDocumentAuthority(identity);
  const refs = registry({
    isCurrentDocument: authority.isCurrentDocument,
    revalidateAction: async ({ phase }) => {
      if (phase === "use") authority.remove(identity);
    },
  });
  const [record] = capture(refs, identity, "partial", [1]);
  const token = await refs.bindAction(record.ref, { expectedScope: scope(identity), lease: lease() });
  await assert.rejects(
    refs.revalidateBoundAction(token, { expectedScope: scope(identity), lease: lease() }),
    { code: "REFERENCE_DOCUMENT_NOT_CURRENT" },
  );
});

test("document authority callback must return synchronously", () => {
  const refs = registry({ isCurrentDocument: async () => true });
  assert.throws(() => refs.beginSnapshot(document()), /must return synchronously/);
});

test("synchronous bound-action assertion checks exact token, lease, expiry, and current document", async () => {
  let now = 1_000;
  const refs = registry({ now: () => now });
  const identity = document();
  const [record] = capture(refs, identity, "partial", [1]);
  const token = await refs.bindAction(record.ref, {
    expectedScope: scope(identity), lease: lease(), deadlineAt: 2_000,
  });
  assert.equal(refs.assertBoundActionCurrent(token, {
    expectedScope: scope(identity), lease: lease(),
  }).refId, record.refId);
  assert.throws(() => refs.assertBoundActionCurrent(token, {
    expectedScope: scope(identity), lease: lease({ leaseEpoch: 5 }),
  }), { code: "ACTION_CONTEXT_MISMATCH" });
  now = 2_000;
  assert.throws(() => refs.assertBoundActionCurrent(token, {
    expectedScope: scope(identity), lease: lease(),
  }), { code: "ACTION_CONTEXT_EXPIRED" });
});

test("public reference parsing rejects zero, signs, decimals, and unsafe integers", () => {
  assert.equal(formatPublicReference(12), "@12");
  assert.equal(parsePublicReference("@12"), 12);
  for (const value of ["@0", "@+1", "@01", "@1.5", "@9007199254740992", "1", -1]) {
    assert.throws(() => parsePublicReference(value));
  }
});
