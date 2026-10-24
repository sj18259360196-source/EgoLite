import assert from "node:assert/strict";
import test from "node:test";

import { DesktopReferenceRegistry } from "./desktop-reference-registry.mjs";
import {
  assertReferencePairCurrent,
  bindReferencePair,
  projectReferencePair,
  releaseReferencePair,
  revalidateReferencePair,
} from "./desktop-reference-pair.mjs";

function allocator(start = 10_000) {
  let next = start;
  return { allocate: () => next++ };
}

function document(overrides = {}) {
  return {
    runtimeId: "runtime-1",
    taskId: "task-1",
    pageId: "page-1",
    frameId: "frame-1",
    documentId: "document-1",
    documentEpoch: 1,
    ...overrides,
  };
}

function pageScope(overrides = {}) {
  return { runtimeId: "runtime-1", taskId: "task-1", pageId: "page-1", ...overrides };
}

function lease(overrides = {}) {
  return { taskId: "task-1", taskSpaceId: 7, clientId: "client-1", leaseEpoch: 3, ...overrides };
}

function documentKey(identity) {
  return JSON.stringify([
    identity.runtimeId, identity.taskId, identity.pageId,
    identity.frameId, identity.documentId, identity.documentEpoch,
  ]);
}

function harness({ documents = [document()], maxActionContexts, revalidateAction } = {}) {
  const current = new Set(documents.map(documentKey));
  const registry = new DesktopReferenceRegistry({
    allocator: allocator(),
    isCurrentDocument: (identity) => current.has(documentKey(identity)),
    revalidateAction: revalidateAction || (async () => {}),
    ...(maxActionContexts === undefined ? {} : { maxActionContexts }),
  });
  const capture = (identity, backendNodeIds) => {
    const ticket = registry.beginSnapshot(identity);
    return registry.commitSnapshot(ticket, {
      mode: "partial",
      nodes: backendNodeIds.map((backendNodeId) => ({ backendNodeId })),
    });
  };
  const routeState = { generation: 4, key: "native-root" };
  const resolveRoute = (identity) => ({
    identity,
    nativeSessionKey: routeState.key,
    nativeSessionGeneration: routeState.generation,
  });
  return { registry, current, capture, routeState, resolveRoute };
}

function descriptor(record) {
  return { refId: record.refId, runtimeId: record.runtimeId };
}

test("binds two drag refs on one document and exposes no registry tokens", async () => {
  const { registry, capture, resolveRoute } = harness();
  const [source, target] = capture(document(), [11, 12]);
  const pair = await bindReferencePair({
    kind: "drag",
    source: descriptor(source),
    target: descriptor(target),
    expectedScope: pageScope(),
    lease: lease(),
    deadlineAt: Date.now() + 30_000,
    registry,
    resolveRoute,
  });
  assert.deepEqual(projectReferencePair(pair), {
    kind: "drag",
    runtimeId: "runtime-1",
    pageId: "page-1",
    frameId: "frame-1",
    documentId: "document-1",
    documentEpoch: 1,
    source: { refId: source.refId, backendNodeId: 11 },
    target: { refId: target.refId, backendNodeId: 12 },
  });
  assert.doesNotMatch(JSON.stringify(pair), /action_/);
  assert.equal(registry.stats().actionContexts, 2);
  await revalidateReferencePair(pair);
  assertReferencePairCurrent(pair);
  assert.equal(releaseReferencePair(pair), true);
  assert.equal(releaseReferencePair(pair), false);
  assert.equal(registry.stats().actionContexts, 0);
});

test("deduplicates identical endpoints into one registry context", async () => {
  const { registry, capture, resolveRoute } = harness();
  const [record] = capture(document(), [11]);
  const pair = await bindReferencePair({
    kind: "drag",
    source: descriptor(record),
    target: descriptor(record),
    expectedScope: pageScope(),
    lease: lease(),
    registry,
    resolveRoute,
  });
  assert.equal(registry.stats().actionContexts, 1);
  const projected = projectReferencePair(pair);
  assert.deepEqual(projected.source, projected.target);
  releaseReferencePair(pair);
  assert.equal(registry.stats().actionContexts, 0);
});

test("rejects cross-runtime, cross-page, cross-frame, and route-generation pairs without residual contexts", async () => {
  {
    const { registry, capture, resolveRoute } = harness();
    const [source, target] = capture(document(), [1, 2]);
    await assert.rejects(bindReferencePair({
      kind: "drag",
      source: descriptor(source),
      target: { ...descriptor(target), runtimeId: "runtime-2" },
      expectedScope: pageScope(), lease: lease(), registry, resolveRoute,
    }), { code: "REFERENCE_PAIR_SCOPE_MISMATCH" });
    assert.equal(registry.stats().actionContexts, 0);
  }
  {
    const other = document({ pageId: "page-2", documentId: "document-2" });
    const { registry, capture, resolveRoute } = harness({ documents: [document(), other] });
    const [source] = capture(document(), [1]);
    const [target] = capture(other, [2]);
    await assert.rejects(bindReferencePair({
      kind: "drag", source: descriptor(source), target: descriptor(target),
      expectedScope: pageScope(), lease: lease(), registry, resolveRoute,
    }));
    assert.equal(registry.stats().actionContexts, 0);
  }
  {
    const child = document({ frameId: "frame-2", documentId: "document-2" });
    const { registry, capture, resolveRoute } = harness({ documents: [document(), child] });
    const [source] = capture(document(), [1]);
    const [target] = capture(child, [2]);
    await assert.rejects(bindReferencePair({
      kind: "drag", source: descriptor(source), target: descriptor(target),
      expectedScope: pageScope(), lease: lease(), registry, resolveRoute,
    }), { code: "REFERENCE_PAIR_SCOPE_MISMATCH" });
    assert.equal(registry.stats().actionContexts, 0);
  }
  {
    const { registry, capture } = harness();
    const [source, target] = capture(document(), [1, 2]);
    const resolveRoute = (identity) => ({
      identity,
      nativeSessionKey: "native-root",
      nativeSessionGeneration: identity.backendNodeId,
    });
    await assert.rejects(bindReferencePair({
      kind: "drag", source: descriptor(source), target: descriptor(target),
      expectedScope: pageScope(), lease: lease(), registry, resolveRoute,
    }), { code: "REFERENCE_PAIR_ROUTE_MISMATCH" });
    assert.equal(registry.stats().actionContexts, 0);
  }
});

test("cleans the first binding when the second binding fails", async () => {
  const { registry, capture, resolveRoute } = harness({ maxActionContexts: 1 });
  const [source, target] = capture(document(), [1, 2]);
  await assert.rejects(bindReferencePair({
    kind: "drag", source: descriptor(source), target: descriptor(target),
    expectedScope: pageScope(), lease: lease(), registry, resolveRoute,
  }), { code: "ACTION_CONTEXT_CAPACITY_EXCEEDED" });
  assert.equal(registry.stats().actionContexts, 0);
});

test("navigation during the second asynchronous bind releases both contexts", async () => {
  let entered;
  let resume;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  const identity = document();
  const state = harness({
    revalidateAction: async ({ phase, identity: candidate }) => {
      if (phase === "bind" && candidate.backendNodeId === 2) {
        entered();
        await gate;
      }
    },
  });
  const [source, target] = state.capture(identity, [1, 2]);
  const pending = bindReferencePair({
    kind: "drag", source: descriptor(source), target: descriptor(target),
    expectedScope: pageScope(), lease: lease(), registry: state.registry, resolveRoute: state.resolveRoute,
  });
  await enteredPromise;
  state.current.delete(documentKey(identity));
  resume();
  await assert.rejects(pending, { code: "REFERENCE_DOCUMENT_NOT_CURRENT" });
  assert.equal(state.registry.stats().actionContexts, 0);
});

test("release while asynchronous pair revalidation is pending leaves no contexts", async () => {
  let gateEnabled = false;
  let entered;
  let resume;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  const state = harness({
    revalidateAction: async ({ phase }) => {
      if (gateEnabled && phase === "use") {
        entered();
        await gate;
      }
    },
  });
  const [source, target] = state.capture(document(), [1, 2]);
  const pair = await bindReferencePair({
    kind: "drag", source: descriptor(source), target: descriptor(target),
    expectedScope: pageScope(), lease: lease(), registry: state.registry, resolveRoute: state.resolveRoute,
  });
  gateEnabled = true;
  const pending = revalidateReferencePair(pair);
  await enteredPromise;
  assert.equal(releaseReferencePair(pair), true);
  resume();
  await assert.rejects(pending, { code: "ACTION_CONTEXT_INVALID" });
  assert.equal(state.registry.stats().actionContexts, 0);
});

test("lease revocation or route generation change while awaiting revalidation releases the pair", async () => {
  for (const mode of ["lease", "route"]) {
    let gateEnabled = false;
    let entered;
    let resume;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { resume = resolve; });
    let revoked = false;
    const state = harness({
      revalidateAction: async ({ phase }) => {
        if (gateEnabled && phase === "use") {
          entered();
          await gate;
          if (mode === "lease" && revoked) throw Object.assign(new Error("lease revoked"), { code: "ACTION_CONTEXT_MISMATCH" });
        }
      },
    });
    const [source, target] = state.capture(document(), [1, 2]);
    const pair = await bindReferencePair({
      kind: "drag", source: descriptor(source), target: descriptor(target),
      expectedScope: pageScope(), lease: lease(), registry: state.registry, resolveRoute: state.resolveRoute,
    });
    gateEnabled = true;
    const pending = revalidateReferencePair(pair);
    await enteredPromise;
    if (mode === "lease") revoked = true;
    else state.routeState.generation += 1;
    resume();
    await assert.rejects(pending, mode === "lease"
      ? { code: "ACTION_CONTEXT_MISMATCH" }
      : { code: "REFERENCE_PAIR_ROUTE_MISMATCH" });
    assert.equal(state.registry.stats().actionContexts, 0);
  }
});

test("changed caller lease makes synchronous final assertion fail closed and release both", async () => {
  const state = harness();
  const [source, target] = state.capture(document(), [1, 2]);
  const pair = await bindReferencePair({
    kind: "drag", source: descriptor(source), target: descriptor(target),
    expectedScope: pageScope(), lease: lease(), registry: state.registry, resolveRoute: state.resolveRoute,
  });
  assert.throws(() => assertReferencePairCurrent(pair, { lease: lease({ leaseEpoch: 4 }) }), {
    code: "REFERENCE_PAIR_SCOPE_MISMATCH",
  });
  assert.equal(state.registry.stats().actionContexts, 0);
  assert.equal(releaseReferencePair(pair), false);
});
