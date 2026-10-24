import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { browserCdp, invalidateSession } from "../../../vendor/ego-browser/src/browser-runtime.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { waitForDocumentLoad } from "../../../vendor/ego-browser/src/driver/load.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { state } from "../../../vendor/ego-browser/src/state.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { helperContext } from "../../../vendor/ego-browser/src/helpers.js";

test("retired alias retries one safe frame-tree read on the same page", async () => {
  const fixture = installRuntime(["Page.getFrameTree"]);
  try {
    const result = await browserCdp("Page.getFrameTree");
    assert.equal(result.result.frameTree.frame.url, "https://page-1.test");
    assert.equal(fixture.methodCalls("Page.getFrameTree"), 2);
    assert.deepEqual(fixture.attachTargets, ["page-1"]);
    assert.equal(state.sessionTargetId, "page-1");
  } finally {
    fixture.restore();
  }
});

test("retired alias never auto-replays reload, input, Runtime execution, or DOM mutation", async (t) => {
  for (const [method, params] of [
    ["Page.reload", {}],
    ["Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 }],
    ["Runtime.evaluate", { expression: "window.sideEffect = 1" }],
    ["Runtime.callFunctionOn", { objectId: "object-1", functionDeclaration: "function(){this.value='x'}" }],
    ["DOM.setAttributeValue", { nodeId: 1, name: "data-x", value: "1" }],
  ] as const) {
    await t.test(method, async () => {
      const fixture = installRuntime([method]);
      try {
        await assert.rejects(
          browserCdp(method, params),
          (error: any) => error?.error_code === "EGO_ACTION_SCOPE_MISMATCH"
            && /debugger_detached/.test(error?.message),
        );
        assert.equal(fixture.methodCalls(method), 1);
        assert.deepEqual(fixture.attachTargets, []);
        assert.equal(state.sessionId, null);
      } finally {
        fixture.restore();
      }
    });
  }
});

test("document readiness recovers a retired alias without attaching another active page", async () => {
  const fixture = installRuntime(["Runtime.evaluate"], { fakeClock: true });
  try {
    assert.equal(await waitForDocumentLoad({ timeout: 2_000 }), true);
    assert.equal(fixture.methodCalls("Runtime.evaluate"), 2);
    assert.deepEqual(fixture.attachTargets, ["page-1"]);
    assert.equal(state.sessionTargetId, "page-1");
  } finally {
    fixture.restore();
  }
});

test("only the fixed document readiness expression recovers native No target available on its original page", async () => {
  const fixture = installRuntime(["Runtime.evaluate"], { fakeClock: true, nativeError: true });
  try {
    assert.equal(await waitForDocumentLoad({ timeout: 2_000 }), true);
    assert.deepEqual(fixture.attachTargets, ["page-1"]);
    const reads = fixture.calls.filter((call) => call.method === "Runtime.evaluate");
    assert.equal(reads.length, 2);
    assert.ok(reads.every((call) => call.params.expression === "document.readyState"));
    assert.deepEqual(reads.map((call) => call.sessionId), ["retired-root-alias", "fresh-page-1"]);
  } finally {
    fixture.restore();
  }
});

test("readiness retries keep the original deadline when the original page disappears", async () => {
  const fixture = installRuntime(["Runtime.evaluate"], {
    fakeClock: true, nativeError: true, originalPageUnavailableAfterFailure: true,
  });
  try {
    assert.equal(await waitForDocumentLoad({ timeout: 1_000 }), false);
    assert.equal(fixture.clockMs, 1_000);
    assert.equal(fixture.methodCalls("Runtime.evaluate"), 1);
    assert.deepEqual(fixture.attachTargets, []);
  } finally {
    fixture.restore();
  }
});

test("ordinary Runtime execution does not retry native No target available", async () => {
  const fixture = installRuntime(["Runtime.evaluate"], { nativeError: true });
  try {
    await assert.rejects(browserCdp("Runtime.evaluate", { expression: "window.sideEffect = 1" }), /No target available/);
    assert.equal(fixture.methodCalls("Runtime.evaluate"), 1);
    assert.deepEqual(fixture.attachTargets, []);
  } finally {
    fixture.restore();
  }
});

test("late frame-tree and ready-state results cannot satisfy a completed readiness deadline", async (t) => {
  for (const method of ["Page.getFrameTree", "Runtime.evaluate"]) {
    await t.test(method, async () => {
      const fixture = installRuntime([], { fakeClock: true, lateMethod: method });
      try {
        assert.equal(await waitForDocumentLoad({ timeout: 1_000 }), false);
        assert.equal(fixture.methodCalls("Runtime.evaluate"), method === "Page.getFrameTree" ? 0 : 1);
        assert.equal(fixture.clockMs, 1_001);
        assert.deepEqual(fixture.attachTargets, []);
      } finally {
        fixture.restore();
      }
    });
  }
});

test("fixed readiness RPC timeout uses the remaining deadline without detaching the session", async () => {
  const fixture = installRuntime([], { holdReadiness: true });
  const startedAt = Date.now();
  try {
    assert.equal(await waitForDocumentLoad({ timeout: 30 }), false);
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(fixture.methodCalls("Runtime.evaluate"), 1);
    assert.equal(state.sessionId, "retired-root-alias");
  } finally {
    fixture.restore();
  }
});

test("zero readiness timeout performs one immediate check without polling", async (t) => {
  for (const readyState of ["complete", "loading"]) {
    await t.test(readyState, async () => {
      const fixture = installRuntime([], { fakeClock: true, readyState });
      try {
        assert.equal(await waitForDocumentLoad({ timeout: 0 }), readyState === "complete");
        assert.equal(fixture.methodCalls("Runtime.evaluate"), 1);
        assert.equal(fixture.clockMs, 0);
      } finally {
        fixture.restore();
      }
    });
  }
});

test("readiness keeps the original explicit alias when current SDK state switches between its two reads", async () => {
  const fixture = installRuntime([], { switchAfterFrameTree: true });
  try {
    assert.equal(await waitForDocumentLoad({ timeout: 1_000 }), true);
    assert.equal(fixture.calls.find((call) => call.method === "Runtime.evaluate")?.sessionId, "retired-root-alias");
    assert.equal(state.sessionTargetId, "page-2");
  } finally {
    fixture.restore();
  }
});

test("reload waits through old complete documents at the same URL before accepting a new root loader", async () => {
  const fixture = installRuntime([], { fakeClock: true, frameSequence: [oldFrame(), oldFrame(), oldFrame(), newFrame()] });
  try {
    assert.equal(await reloadPage().reload({ timeout: 2_000 }), true);
    assert.equal(fixture.methodCalls("Page.reload"), 1);
    assert.equal(fixture.methodCalls("Page.getFrameTree"), 4);
    assert.equal(fixture.methodCalls("Runtime.evaluate"), 1);
    assert.equal(fixture.clockMs, 600);
    assert.ok(fixture.calls.filter((call) => call.method === "Page.reload" || call.method === "Runtime.evaluate")
      .every((call) => call.sessionId === "retired-root-alias"));
  } finally {
    fixture.restore();
  }
});

test("reload commit waits for a new document without reading readyState and retains its historical return value", async () => {
  const fixture = installRuntime([], { fakeClock: true, frameSequence: [oldFrame(), oldFrame(), newFrame()] });
  try {
    assert.equal(await reloadPage().reload({ timeout: 2_000, waitUntil: "commit" }), false);
    assert.equal(fixture.methodCalls("Page.reload"), 1);
    assert.equal(fixture.methodCalls("Page.getFrameTree"), 3);
    assert.equal(fixture.methodCalls("Runtime.evaluate"), 0);
    assert.equal(fixture.clockMs, 300);
  } finally {
    fixture.restore();
  }
});

test("guest replacement root frame is a valid reload transition even without a new loader stamp", async () => {
  const fixture = installRuntime([], { fakeClock: true, frameSequence: [oldFrame(), { ...oldFrame(), id: "root-frame-2" }] });
  try {
    assert.equal(await reloadPage().reload({ timeout: 2_000 }), true);
    assert.equal(fixture.methodCalls("Page.reload"), 1);
  } finally {
    fixture.restore();
  }
});

test("reload readiness recovers a retired guest on the original page without resending reload", async () => {
  const fixture = installRuntime(["Page.getFrameTree"], {
    fakeClock: true, nativeError: true, failAfterReload: true, frameSequence: [oldFrame(), newFrame()],
  });
  try {
    assert.equal(await reloadPage().reload({ timeout: 2_000 }), true);
    assert.deepEqual(fixture.attachTargets, ["page-1"]);
    assert.equal(fixture.methodCalls("Page.reload"), 1);
    assert.equal(fixture.calls.find((call) => call.method === "Runtime.evaluate")?.sessionId, "fresh-page-1");
  } finally {
    fixture.restore();
  }
});

test("reload transition keeps the original deadline including preflight and reload time", async () => {
  const fixture = installRuntime([], { fakeClock: true, reloadLatencyMs: 900, frameSequence: [oldFrame()] });
  try {
    assert.equal(await reloadPage().reload({ timeout: 1_000 }), false);
    assert.equal(fixture.clockMs, 1_000);
    assert.equal(fixture.methodCalls("Page.reload"), 1);
    assert.equal(fixture.methodCalls("Runtime.evaluate"), 0);
  } finally {
    fixture.restore();
  }
});

test("zero reload timeout still performs one preflight, one reload and one transition check", async (t) => {
  for (const transitioned of [false, true]) {
    await t.test(String(transitioned), async () => {
      const fixture = installRuntime([], { fakeClock: true, frameSequence: [oldFrame(), transitioned ? newFrame() : oldFrame()] });
      try {
        assert.equal(await reloadPage().reload({ timeout: 0 }), transitioned);
        assert.equal(fixture.methodCalls("Page.reload"), 1);
        assert.equal(fixture.methodCalls("Page.getFrameTree"), 2);
        assert.equal(fixture.methodCalls("Runtime.evaluate"), transitioned ? 1 : 0);
        assert.equal(fixture.clockMs, 0);
      } finally {
        fixture.restore();
      }
    });
  }
});

test("reload without document stamps fails before input and a rejected reload is never replayed", async (t) => {
  await t.test("missing identity", async () => {
    const fixture = installRuntime([], { frameSequence: [{ url: "https://page-1.test" }] });
    try {
      await assert.rejects(reloadPage().reload({ timeout: 1_000 }), (error: any) => error?.error_code === "EGO_FRAME_UNAVAILABLE");
      assert.equal(fixture.methodCalls("Page.reload"), 0);
    } finally {
      fixture.restore();
    }
  });
  await t.test("rejected reload", async () => {
    const fixture = installRuntime(["Page.reload"], { frameSequence: [oldFrame()] });
    try {
      await assert.rejects(reloadPage().reload({ timeout: 1_000 }), (error: any) => error?.error_code === "EGO_ACTION_SCOPE_MISMATCH");
      assert.equal(fixture.methodCalls("Page.reload"), 1);
      assert.deepEqual(fixture.attachTargets, []);
    } finally {
      fixture.restore();
    }
  });
});

function reloadPage(): { reload(options: object): Promise<boolean> } {
  return helperContext({ cliLog() {} }).page;
}
function oldFrame() { return { id: "root-frame-1", loaderId: "root-loader-1", url: "https://page-1.test" }; }
function newFrame() { return { ...oldFrame(), loaderId: "root-loader-2" }; }

function installRuntime(failOnceMethods: string[], options: {
  fakeClock?: boolean;
  nativeError?: boolean;
  originalPageUnavailableAfterFailure?: boolean;
  lateMethod?: string;
  holdReadiness?: boolean;
  readyState?: string;
  switchAfterFrameTree?: boolean;
  frameSequence?: Array<{ id?: string; loaderId?: string; url?: string }>;
  failAfterReload?: boolean;
  reloadLatencyMs?: number;
} = {}) {
  const previousEgo = (globalThis as any).ego;
  const previous = {
    sessionId: state.sessionId,
    sessionTargetId: state.sessionTargetId,
    sessionAt: state.sessionAt,
    sessionInflight: state.sessionInflight,
    preferredTargetId: state.preferredTargetId,
    now: state.now,
    sleep: state.sleep,
  };
  state.sessionId = "retired-root-alias";
  state.sessionTargetId = "page-1";
  state.sessionAt = Date.now();
  state.sessionInflight = null;
  state.preferredTargetId = null;
  let clock = 0;
  if (options.fakeClock) {
    state.now = () => clock;
    state.sleep = async (ms: number) => { clock += ms; };
  }
  const failures = new Set(failOnceMethods);
  const calls: any[] = [];
  const attachTargets: string[] = [];
  let originalPageUnavailable = false;
  let frameReads = 0;
  let reloads = 0;
  const runtime: any = {
    async listTabs() {
      return {
        tabs: [
          { targetId: "page-2", active: true, url: "https://page-2.test" },
          ...originalPageUnavailable ? [] : [{ targetId: "page-1", active: false, url: "https://page-1.test" }],
        ],
      };
    },
    sendCDPMessage(payload: string) {
      const request = JSON.parse(payload);
      calls.push(request);
      let result: any = {};
      let error: any;
      if (request.method === "Target.attachToTarget") {
        attachTargets.push(request.params.targetId);
        result = { sessionId: `fresh-${request.params.targetId}` };
      } else if (failures.has(request.method) && request.sessionId === "retired-root-alias" && (!options.failAfterReload || reloads > 0)) {
        failures.delete(request.method);
        originalPageUnavailable = options.originalPageUnavailableAfterFailure === true;
        error = options.nativeError ? { message: "No target available" } : {
          message: "Session alias is unavailable (debugger_detached)",
          error_code: "EGO_ACTION_SCOPE_MISMATCH",
        };
      } else if (request.method === "Page.getFrameTree") {
        const sequence = options.frameSequence;
        result = { frameTree: { frame: sequence ? sequence[Math.min(frameReads++, sequence.length - 1)] : oldFrame() } };
      } else if (request.method === "Runtime.evaluate") {
        result = { result: { value: options.readyState ?? "complete" } };
      }
      if (request.method === "Page.reload") { reloads++; clock += options.reloadLatencyMs ?? 0; }
      if (request.method === options.lateMethod) clock = 1_001;
      if (request.method === "Page.getFrameTree" && options.switchAfterFrameTree) {
        state.sessionId = "other-page-alias";
        state.sessionTargetId = "page-2";
        state.sessionAt = Date.now();
      }
      if (request.method === "Runtime.evaluate" && options.holdReadiness) return;
      queueMicrotask(() => runtime.onCDPMessage?.(JSON.stringify({
        id: request.id,
        ...(error ? { error } : { result }),
      })));
    },
  };
  (globalThis as any).ego = runtime;
  return {
    attachTargets,
    calls,
    get clockMs() { return clock; },
    methodCalls(method: string) { return calls.filter((call) => call.method === method).length; },
    restore() {
      invalidateSession();
      Object.assign(state, previous);
      if (previousEgo === undefined) delete (globalThis as any).ego;
      else (globalThis as any).ego = previousEgo;
    },
  };
}
