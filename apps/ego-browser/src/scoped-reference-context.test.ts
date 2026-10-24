import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { browserCdp, browserSnapshotRefsToRefMap, clearPageSessionAliases, clearPendingDialog, pendingDialog, registerPageSessionAlias } from "../../../vendor/ego-browser/src/browser-runtime.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { fill } from "../../../vendor/ego-browser/src/driver/keyboard.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { check, dispatchEvent, focus, pressOnSelector, pressSequentially, selectOption } from "../../../vendor/ego-browser/src/driver/keyboard.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { click, dblclick, drag, hover, scrollIntoViewIfNeeded } from "../../../vendor/ego-browser/src/driver/pointer.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { setInputFiles } from "../../../vendor/ego-browser/src/driver/files.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { count, evaluateAll, evaluateLocator, getAttribute, isVisible, textContent } from "../../../vendor/ego-browser/src/driver/locator.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { waitForSelector } from "../../../vendor/ego-browser/src/driver/waits.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { browserRefMap, clearScopedReferenceState } from "../../../vendor/ego-browser/src/ref-state.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { RefMap } from "../../../vendor/ego-browser/src/ref-map.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { state } from "../../../vendor/ego-browser/src/state.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { dialogInfo, handleDialog } from "../../../vendor/ego-browser/src/driver/observe.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { withScopedReferenceAction } from "../../../vendor/ego-browser/src/scoped-reference-context.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { helperContext } from "../../../vendor/ego-browser/src/helpers.js";

test("scoped click binds the selected page and carries one action through final input", async () => {
  const fixture = installScopedRuntime({ nowMs: 1_000_000, sessionId: "public-child-alias" });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(700, "snapshot-page"));
  try {
    await click("@700", { timeout: 5_000 });
    assert.equal(fixture.bindRequests.length, 1);
    assert.equal(fixture.bindRequests[0].expectedScope.pageId, "selected-page");
    assert.equal(fixture.bindRequests[0].deadlineAt, fixture.nowMs + 35_000);
    assert.equal(fixture.releaseCalls.length, 1);
    assert.ok(fixture.cdpCalls.length > 0);
    assert.ok(fixture.cdpCalls.every((call) => call.action?.token === "token-700"));
    const box = fixture.cdpCalls.find((call) => call.request.method === "DOM.getBoxModel");
    assert.equal(box?.request.params.backendNodeId, 9700);
    assert.equal(box?.request.sessionId, "public-child-alias");
    assert.ok(fixture.cdpCalls.some((call) => call.request.method === "Input.dispatchMouseEvent"));
  } finally {
    fixture.restore();
  }
});

test("hidden native activation stays bound and does not dispatch a second pointer click", async () => {
  const fixture = installScopedRuntime({ runtimeCallValues: [true, { activated: true }] });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(700, "selected-page"));
  try {
    await click("@700", { activation: "auto" });
    assert.equal(fixture.bindRequests.length, 1);
    const activation = fixture.cdpCalls.find((call) => call.request.method === "Runtime.callFunctionOn" && call.request.params.functionDeclaration.includes("visibilityState"));
    assert.equal(activation?.action?.token, "token-700");
    assert.match(activation?.request.params.functionDeclaration, /visibilityState !== "hidden"/);
    assert.equal(fixture.cdpCalls.some((call) => call.request.method.startsWith("Input.")), false);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally { fixture.restore(); }
});

test("focused visible native controls retain the pointer route in automatic activation", async () => {
  const fixture = installScopedRuntime({ runtimeCallValues: [true, { activated: false }] });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(700, "selected-page"));
  try {
    await click("@700", { activation: "auto" });
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 3);
    assert.equal(fixture.bindRequests.length, 1);
  } finally { fixture.restore(); }
});

test("automatic activation handles unfocused visible native controls without replay or custom-control activation", async () => {
  const fixture = installScopedRuntime({ runtimeCallValues: [true, { activated: true }] });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(700, "selected-page"));
  let source: string;
  try {
    await click("@700", { activation: "auto" });
    source = fixture.cdpCalls.find((call) => call.request.method === "Runtime.callFunctionOn"
      && call.request.params.functionDeclaration.includes("visibilityState"))!.request.params.functionDeclaration;
  } finally { fixture.restore(); }
  for (const variant of ["focused", "unfocused", "hidden", "disabled", "custom", "inert", "zero-size"]) {
    let clicks = 0;
    class NativeButton {}
    const control = Object.assign(variant === "custom" ? {} : new NativeButton(), {
      ownerDocument: { visibilityState: variant === "hidden" ? "hidden" : "visible", hasFocus: () => variant === "focused" },
      isConnected: true, disabled: variant === "disabled", getAttribute: () => null,
      closest: () => variant === "inert" ? {} : null, matches: () => false,
      scrollIntoView: () => {}, getBoundingClientRect: () => ({ width: variant === "zero-size" ? 0 : 80, height: 24 }),
      click: () => { clicks++; },
    });
    const result = runInNewContext(`(${source!}).call(control)`, {
      control, HTMLButtonElement: NativeButton, HTMLAnchorElement: class {}, HTMLInputElement: class {},
      getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }),
    });
    assert.equal(result.activated, ["unfocused", "hidden"].includes(variant), variant);
    assert.equal(clicks, result.activated ? 1 : 0, variant);
  }
});

test("automatic activation with a missing result never falls through to pointer input", async () => {
  for (const value of [undefined, null, {}, { activated: "false" }]) {
    const fixture = installScopedRuntime({ runtimeCallValues: [true, value] });
    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(700, "selected-page"));
    try {
      await assert.rejects(click("@700", { activation: "auto" }),
        (error: any) => error?.error_code === "EGO_ACTION_RESULT_UNKNOWN");
      assert.equal(fixture.cdpCalls.some((call) => call.request.method.startsWith("Input.")), false);
      assert.equal(fixture.releaseCalls.length, 1);
    } finally { fixture.restore(); }
  }
});

test("automatic activation exceptions report unknown outcome without replay", async () => {
  const fixture = installScopedRuntime({ runtimeCallValues: [true], runtimeExceptionAt: 2 });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(700, "selected-page"));
  try {
    await assert.rejects(click("@700", { activation: "auto" }),
      (error: any) => error?.error_code === "EGO_ACTION_RESULT_UNKNOWN");
    assert.equal(fixture.cdpCalls.some((call) => call.request.method.startsWith("Input.")), false);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally { fixture.restore(); }
});

test("scoped action deadlines preserve zero, default zero, and 120s wait budgets", async () => {
  const fixture = installScopedRuntime({ nowMs: 2_000_000 });
  try {
    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(710, "selected-page"));
    await click("@710", { timeout: 0 });
    assert.equal(fixture.bindRequests.at(-1).deadlineAt, fixture.nowMs + 30_000);

    state.defaultTimeout = 0;
    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(711, "selected-page"));
    await fill("@711", "value");
    assert.equal(fixture.bindRequests.at(-1).deadlineAt, fixture.nowMs + 30_000);

    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(712, "selected-page"));
    await click("@712", { timeout: 120_000 });
    assert.equal(fixture.bindRequests.at(-1).deadlineAt, fixture.nowMs + 150_000);
  } finally {
    fixture.restore();
  }
});

test("offscreen scoped pure click scrolls the exact child binding before reading its box and dispatching input", async () => {
  const fixture = installScopedRuntime({ sessionId: "public-child-alias", offscreenUntilScroll: true });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(796, "selected-page"));
  try {
    await click("@796", { timeout: 5_000 });
    const scrolls = fixture.cdpCalls.filter((call) => call.request.method === "DOM.scrollIntoViewIfNeeded");
    assert.equal(scrolls.length, 1);
    const scroll = scrolls[0];
    assert.ok(scroll);
    assert.equal(scroll.request.params.backendNodeId, 9796);
    assert.equal(scroll.request.sessionId, "public-child-alias");
    assert.equal(scroll.action.token, "token-796");
    const scrollIndex = fixture.cdpCalls.indexOf(scroll);
    const boxIndex = fixture.cdpCalls.findIndex((call) => call.request.method === "DOM.getBoxModel");
    const inputIndex = fixture.cdpCalls.findIndex((call) => call.request.method === "Input.dispatchMouseEvent");
    assert.ok(scrollIndex < boxIndex && boxIndex < inputIndex);
    const inputs = fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent");
    assert.deepEqual(inputs.map((call) => call.request.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
    assert.ok(inputs.every((call) => call.request.params.y === 20 && call.request.sessionId === "public-child-alias" && call.action.token === "token-796"));
    assert.equal(fixture.bindRequests.length, 1);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("scoped native scrolling failure propagates before any box read or input dispatch", async () => {
  const fixture = installScopedRuntime({ sessionId: "public-child-alias", failMethod: "DOM.scrollIntoViewIfNeeded", errorCode: "EGO_FRAME_UNAVAILABLE" });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(797, "selected-page"));
  try {
    await assert.rejects(click("@797"), (error: any) => error?.error_code === "EGO_FRAME_UNAVAILABLE");
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "DOM.scrollIntoViewIfNeeded").length, 1);
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "DOM.getBoxModel").length, 0);
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method.startsWith("Input.")).length, 0);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("scoped click and group drag inputs share the original deadline as native time advances", async (t) => {
  for (const group of [false, true]) {
    await t.test(group ? "group" : "single", async () => {
      const fixture = installScopedRuntime({ nowMs: 1_000_000, sessionId: "public-child-alias" });
      const budgets = recordInputTimeouts(fixture, [825, 1_068]);
      browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(785, "selected-page"));
      if (group) browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(786, "selected-page"));
      try {
        if (group) await drag(["@785", "@786"], { timeout: 5_000 });
        else await click("@785", { timeout: 5_000 });
        assert.deepEqual(budgets.timeouts, [35_000, 34_175, 33_107]);
        assert.equal(group ? fixture.groupBindRequests.length : fixture.bindRequests.length, 1);
        assert.equal(fixture.releaseCalls.length, 1);
      } finally {
        budgets.restore();
        fixture.restore();
      }
    });
  }
});

test("an expired scoped input budget prevents the first Input packet", async () => {
  const fixture = installScopedRuntime({ nowMs: 1_000_000 });
  const originalSend = fixture.runtime.sendCDPMessage;
  fixture.runtime.sendCDPMessage = (payload: string, action: any) => {
    const request = JSON.parse(payload);
    if (request.method === "Runtime.evaluate" && request.params.expression.includes("const probe = {")) {
      fixture.advanceClock(30_000);
    }
    originalSend(payload, action);
  };
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(787, "selected-page"));
  try {
    await assert.rejects(click("@787", { timeout: 0 }), (error: any) => error?.error_code === "EGO_ACTION_EXPIRED" && error?.delivery === "not_sent");
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method.startsWith("Input.")).length, 0);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("non-finite scoped deadlines fail before Input while native refs retain the one-second timeout", async (t) => {
  for (const expiresAt of [NaN, Infinity]) {
    await t.test(String(expiresAt), async () => {
      const fixture = installScopedRuntime();
      const originalBind = fixture.runtime.bindReferenceAction;
      fixture.runtime.bindReferenceAction = async (request: any) => ({ ...await originalBind(request), expiresAt });
      browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(788, "selected-page"));
      try {
        await assert.rejects(click("@788"), (error: any) => error?.error_code === "EGO_ACTION_CONTEXT_INVALID");
        assert.equal(fixture.cdpCalls.filter((call) => call.request.method.startsWith("Input.")).length, 0);
      } finally {
        fixture.restore();
      }
    });
  }
  await t.test("native", async () => {
    const fixture = installScopedRuntime();
    const budgets = recordInputTimeouts(fixture, [825, 1_068]);
    browserSnapshotRefsToRefMap(browserRefMap, [{ backendNodeId: 789, role: "button", name: "Native" }]);
    try {
      await click("@789");
      assert.deepEqual(budgets.timeouts, [1_000, 1_000, 1_000]);
      assert.equal(fixture.bindRequests.length, 0);
      assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "DOM.scrollIntoViewIfNeeded").length, 0);
    } finally {
      budgets.restore();
      fixture.restore();
    }
  });
});

test("known lifetime cap rejects before bind or input without clamping", async () => {
  const fixture = installScopedRuntime({ maxLifetimeMs: 149_999, nowMs: 3_000_000 });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(713, "selected-page"));
  try {
    await assert.rejects(
      click("@713", { timeout: 120_000 }),
      (error: any) => error?.error_code === "EGO_ACTION_CONTEXT_INVALID"
        && error?.requestedLifetimeMs === 150_000
        && error?.maxLifetimeMs === 149_999,
    );
    assert.equal(fixture.bindRequests.length, 0);
    assert.equal(fixture.cdpCalls.length, 0);
  } finally {
    fixture.restore();
  }
});

test("pressSequentially budgets actual cadence and delay into one scoped token", async () => {
  const fixture = installScopedRuntime({ nowMs: 4_000_000 });
  try {
    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(714, "selected-page"));
    await pressSequentially("@714", "ab", { timeout: 5_000, delay: 100 });
    assert.equal(fixture.bindRequests.length, 1);
    assert.equal(fixture.releaseCalls.length, 1);
    assert.equal(fixture.bindRequests[0].deadlineAt, fixture.nowMs + 35_250);
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchKeyEvent").length, 4);

    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(715, "selected-page"));
    await pressSequentially("@715", "😀a", { timeout: 0, delay: 10 });
    assert.equal(fixture.bindRequests.at(-1).deadlineAt, fixture.nowMs + 30_045);
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.insertText").length, 1);
  } finally {
    fixture.restore();
  }
});

test("pressSequentially rejects over cap before focus/input and never renews after partial delivery", async () => {
  const capped = installScopedRuntime({ maxLifetimeMs: 30_044, nowMs: 5_000_000 });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(716, "selected-page"));
  try {
    await assert.rejects(
      pressSequentially("@716", "😀a", { timeout: 0, delay: 10 }),
      (error: any) => error?.error_code === "EGO_ACTION_CONTEXT_INVALID"
        && error?.requestedLifetimeMs === 30_045,
    );
    assert.equal(capped.bindRequests.length, 0);
    assert.equal(capped.cdpCalls.length, 0);
  } finally {
    capped.restore();
  }

  const failed = installScopedRuntime({ errorCode: "EGO_ACTION_RESULT_UNKNOWN", failInputAt: 4 });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(717, "selected-page"));
  try {
    await assert.rejects(
      pressSequentially("@717", "abc", { delay: 0 }),
      (error: any) => error?.error_code === "EGO_ACTION_RESULT_UNKNOWN",
    );
    assert.equal(failed.bindRequests.length, 1);
    assert.equal(failed.releaseCalls.length, 1);
    assert.equal(failed.cdpCalls.filter((call) => call.request.method === "Input.dispatchKeyEvent").length, 4);
  } finally {
    failed.restore();
  }
});

test("page keyboard numeric text remains legacy and does not bind a ref", async () => {
  const fixture = installScopedRuntime();
  try {
    await pressSequentially("123", { delay: 0 });
    assert.equal(fixture.bindRequests.length, 0);
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchKeyEvent").length, 6);
  } finally {
    fixture.restore();
  }
});

test("scoped locator evaluate exceptions are result-unknown without replay", async () => {
  for (const [refId, operation] of [
    [718, (target: string) => evaluateLocator(target, () => { throw new Error("boom"); })],
    [719, (target: string) => evaluateAll(target, () => { throw new Error("boom"); })],
  ] as const) {
    const fixture = installScopedRuntime({ runtimeExceptionAt: 1 });
    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(refId, "selected-page"));
    try {
      await assert.rejects(
        operation(`@${refId}`),
        (error: any) => error?.error_code === "EGO_ACTION_RESULT_UNKNOWN",
      );
      assert.equal(fixture.runtimeCallCount, 1);
      assert.equal(fixture.bindRequests.length, 1);
      assert.equal(fixture.releaseCalls.length, 1);
    } finally {
      fixture.restore();
    }
  }
});

test("legacy locator evaluate exception keeps its original generic error", async () => {
  const fixture = installScopedRuntime({ runtimeExceptionAt: 1 });
  browserSnapshotRefsToRefMap(browserRefMap, [{ backendNodeId: 880, role: "button", name: "legacy" }]);
  try {
    await assert.rejects(
      evaluateLocator("@880", () => { throw new Error("boom"); }),
      (error: any) => !error?.error_code && /JavaScript evaluation failed/.test(error?.message),
    );
    assert.equal(fixture.bindRequests.length, 0);
  } finally {
    fixture.restore();
  }
});

test("same-frame scoped drag uses one exact source-target group token", async () => {
  const fixture = installScopedRuntime({ groupSessionId: "public-child-alias" });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(780, "selected-page"));
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(781, "selected-page"));
  try {
    await drag(["@780", "@781"], { delay: 0 });
    assert.equal(fixture.groupBindRequests.length, 1);
    assert.equal(fixture.bindRequests.length, 0);
    assert.equal(fixture.releaseCalls.length, 1);
    assert.deepEqual(fixture.groupBindRequests[0], {
      kind: "drag",
      source: { refId: 780, runtimeId: "runtime-1" },
      target: { refId: 781, runtimeId: "runtime-1" },
      expectedScope: { pageId: "selected-page" },
      deadlineAt: fixture.nowMs + 40_000,
    });
    const boxes = fixture.cdpCalls.filter((call) => call.request.method === "DOM.getBoxModel");
    assert.deepEqual(boxes.map((call) => call.request.params.backendNodeId), [9780, 9781]);
    assert.ok(boxes.every((call) => call.request.sessionId === "public-child-alias"));
    const input = fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent");
    assert.deepEqual(input.map((call) => call.request.params.type), ["mousePressed", "mouseMoved", "mouseReleased"]);
    assert.ok(input.every((call) => call.action?.token === "drag-token-780-781"));
    const finishProbe = fixture.cdpCalls.findLast((call) => call.request.method === "Runtime.evaluate"
      && call.request.params.expression?.includes("delete probes"));
    assert.match(finishProbe?.request.params.expression ?? "", /if \(!false\) return/);
  } finally {
    fixture.restore();
  }
});

test("scoped drag rejects mixed and cross-frame groups before mouseDown", async () => {
  const mixed = installScopedRuntime();
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(782, "selected-page"));
  try {
    await assert.rejects(
      drag(["@782", "#target"]),
      (error: any) => error?.error_code === "EGO_ACTION_SCOPE_MISMATCH",
    );
    browserRefMap.add("900", 900, "button", "legacy");
    await assert.rejects(
      drag(["@782", "@900"]),
      (error: any) => error?.error_code === "EGO_ACTION_SCOPE_MISMATCH",
    );
    assert.equal(mixed.groupBindRequests.length, 0);
    assert.equal(mixed.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 0);
  } finally {
    mixed.restore();
  }

  const crossFrame = installScopedRuntime({ groupBindError: "EGO_ACTION_SCOPE_MISMATCH" });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(783, "selected-page"));
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(784, "selected-page"));
  try {
    await assert.rejects(
      drag(["@783", "@784"]),
      (error: any) => error?.error_code === "EGO_ACTION_SCOPE_MISMATCH",
    );
    assert.equal(crossFrame.groupBindRequests.length, 1);
    assert.equal(crossFrame.releaseCalls.length, 0);
    assert.equal(crossFrame.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 0);
  } finally {
    crossFrame.restore();
  }
});

test("scoped drag failure after mouseDown is result-unknown without fallback or replay", async () => {
  const fixture = installScopedRuntime({
    errorCode: "EGO_ACTION_SCOPE_MISMATCH",
    failInputAt: 2,
  });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(785, "selected-page"));
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(786, "selected-page"));
  try {
    await assert.rejects(
      drag(["@785", "@786"]),
      (error: any) => error?.error_code === "EGO_ACTION_RESULT_UNKNOWN"
        && error?.cause?.error_code === "EGO_ACTION_SCOPE_MISMATCH",
    );
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 2);
    assert.equal(fixture.groupBindRequests.length, 1);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("generic coordinate drag remains unbound", async () => {
  const fixture = installScopedRuntime();
  try {
    await drag([[10, 10], [20, 20]], { delay: 0 });
    assert.equal(fixture.groupBindRequests.length, 0);
    assert.equal(fixture.bindRequests.length, 0);
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 3);
  } finally {
    fixture.restore();
  }
});

test("multi-point drag rejects any scoped ref before input while native refs remain legacy", async () => {
  const scoped = installScopedRuntime();
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(787, "selected-page"));
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(788, "selected-page"));
  try {
    await assert.rejects(
      drag(["@787", [15, 15], "@788"]),
      (error: any) => error?.error_code === "EGO_ACTION_CONTEXT_INVALID"
        && /exactly one source ref and one target ref/.test(error?.message),
    );
    assert.equal(scoped.groupBindRequests.length, 0);
    assert.equal(scoped.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 0);
  } finally {
    scoped.restore();
  }

  const legacy = installScopedRuntime();
  browserRefMap.beginSnapshot("native-v0");
  browserRefMap.add("901", 901, "button", "one");
  browserRefMap.add("902", 902, "button", "two");
  browserRefMap.add("903", 903, "button", "three");
  try {
    await drag(["@901", "@902", "@903"], { delay: 0 });
    assert.equal(legacy.groupBindRequests.length, 0);
    assert.equal(legacy.bindRequests.length, 0);
    assert.equal(legacy.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 4);
  } finally {
    legacy.restore();
  }
});

test("top-level scoped locator screenshot uses border quad and trusted root metrics", async () => {
  const fixture = installScopedRuntime({
    boxBorder: [10, 20, 110, 20, 110, 70, 10, 70],
    screenshotMetrics: { pageX: 100, pageY: 200, zoom: 1.5 },
    sessionId: "root-session",
  });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(790, "selected-page"));
  try {
    const page = helperContext().page;
    assert.equal(await page.locator("@790").screenshot({ path: "A:\\scoped-element.png" }), "A:\\scoped-element.png");
    const capture = fixture.cdpCalls.find((call) => call.request.method === "Page.captureScreenshot");
    assert.equal(capture?.request.sessionId, "root-session");
    assert.deepEqual(capture?.request.params.clip, {
      x: 165,
      y: 330,
      width: 150,
      height: 75,
      scale: 1,
    });
    assert.equal(capture?.request.params.captureBeyondViewport, true);
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.bindRequests.length, 1);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("scoped locator screenshot rejects child alias before capture without fallback", async () => {
  const fixture = installScopedRuntime({
    boxBorder: [0, 0, 50, 0, 50, 20, 0, 20],
    screenshotMetrics: { pageX: 0, pageY: 0, zoom: 1 },
    sessionId: "public-child-alias",
  });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(791, "selected-page"));
  try {
    const page = helperContext().page;
    await assert.rejects(
      page.locator("@791").screenshot({ path: "A:\\unsupported.png" }),
      (error: any) => error?.error_code === "EGO_FRAME_UNAVAILABLE" && /page screenshot/i.test(error?.message),
    );
    assert.equal(fixture.cdpCalls.some((call) => call.request.method === "Page.captureScreenshot"), false);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.bindRequests.length, 1);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("native ref locator screenshot keeps the legacy clip path without scoped binding", async () => {
  const fixture = installScopedRuntime({ runtimeCallValues: [{ x: 1, y: 2, width: 3, height: 4 }] });
  browserRefMap.beginSnapshot("native-v0");
  browserRefMap.add("792", 792, "button", "legacy");
  try {
    const page = helperContext().page;
    await page.locator("@792").screenshot({ path: "A:\\legacy-element.png" });
    assert.equal(fixture.bindRequests.length, 0);
    assert.equal(fixture.groupBindRequests.length, 0);
    const capture = fixture.cdpCalls.find((call) => call.request.method === "Page.captureScreenshot");
    assert.deepEqual(capture?.request.params.clip, { x: 1, y: 2, width: 3, height: 4, scale: 1 });
  } finally {
    fixture.restore();
  }
});

test("partial scoped snapshots merge while complete-page and document changes invalidate", async () => {
  const fixture = installScopedRuntime();
  try {
    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(720, "selected-page", {
      completeness: "complete-page",
    }));
    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(721, "selected-page", {
      completeness: "partial",
    }));
    assert.ok(browserRefMap.get("720"));
    assert.ok(browserRefMap.get("721"));
    await click("@720");

    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(721, "selected-page", {
      completeness: "complete-page",
    }));
    await assert.rejects(click("@720"), (error: any) => error?.error_code === "EGO_REFERENCE_STALE");
    assert.ok(browserRefMap.get("721"));

    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(722, "selected-page", {
      completeness: "partial",
      documentEpoch: 2,
      documentId: "document-2",
    }));
    await assert.rejects(click("@721"), (error: any) => error?.error_code === "EGO_REFERENCE_STALE");
    assert.ok(browserRefMap.get("722"));
  } finally {
    fixture.restore();
  }
});

test("missing scoped completeness is partial and scoped cache growth is bounded", () => {
  const map = new RefMap();
  map.beginSnapshot("scoped-v1", {
    runtimeId: "runtime-cache",
    pageId: "page-cache",
    documentId: "document-cache",
    documentEpoch: 1,
  });
  for (let refId = 1; refId <= 10_005; refId++) {
    map.addScoped(String(refId), {
      backendNodeId: refId,
      pageId: "page-cache",
      frameId: "frame-cache",
      documentId: "document-cache",
      documentEpoch: 1,
      role: "button",
      name: String(refId),
    }, "runtime-cache");
  }
  assert.equal(map.map.size, 10_000);
  assert.equal(map.get("1"), undefined);
  assert.ok(map.get("10005"));
});

test("single-ref pointer, key, DOM, upload, and locator reads each keep one binding", async () => {
  const fixture = installScopedRuntime();
  let nextRef = 730;
  const run = async (operation: (target: string) => Promise<unknown>) => {
    const refId = nextRef++;
    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(refId, "selected-page"));
    const binds = fixture.bindRequests.length;
    const releases = fixture.releaseCalls.length;
    await operation(`@${refId}`);
    assert.equal(fixture.bindRequests.length, binds + 1);
    assert.equal(fixture.releaseCalls.length, releases + 1);
  };
  try {
    await run((target) => dblclick(target));
    await run((target) => hover(target));
    await run((target) => pressOnSelector(target, "Enter"));
    await run((target) => focus(target));
    await run((target) => check(target));
    await run((target) => selectOption(target, ["one"]));
    await run((target) => dispatchEvent(target, "change"));
    await run((target) => scrollIntoViewIfNeeded(target));
    await run((target) => setInputFiles(target, ["A:\\fixture.txt"]));
    await run((target) => textContent(target));
    await run((target) => isVisible(target));
    await run((target) => getAttribute(target, "name"));
    await run(async (target) => { assert.equal(await count(target), 1); });

    const keyEvents = fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchKeyEvent");
    assert.equal(keyEvents.length, 2);
    assert.ok(keyEvents.every((call) => call.request.sessionId === "public-child-alias"));
    assert.ok(fixture.cdpCalls.some((call) => call.request.method === "DOM.setFileInputFiles"
      && call.request.sessionId === "public-child-alias"));
    const hoverFinish = fixture.cdpCalls.findLast((call) =>
      call.request.method === "Runtime.evaluate"
      && call.request.params.expression?.includes("delete probes")
      && call.request.params.expression?.includes("mouseover"));
    assert.match(hoverFinish?.request.params.expression ?? "", /if \(!false\) return/);
  } finally {
    fixture.restore();
  }
});

test("inspect-style multiple locator reads share one scoped binding", async () => {
  const fixture = installScopedRuntime();
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(747, "selected-page"));
  try {
    await withScopedReferenceAction("@747", undefined, async () => {
      await textContent("@747");
      await isVisible("@747");
      await getAttribute("@747", "name");
      await count("@747");
    });
    assert.equal(fixture.bindRequests.length, 1);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("Tab press keeps one binding while keyDown may move focus before keyUp", async () => {
  const fixture = installScopedRuntime();
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(748, "selected-page"));
  try {
    await pressOnSelector("@748", "Tab");
    const events = fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchKeyEvent");
    assert.deepEqual(events.map((call) => call.request.params.type), ["keyDown", "keyUp"]);
    assert.ok(events.every((call) => call.request.sessionId === "public-child-alias"));
    assert.equal(fixture.bindRequests.length, 1);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("acknowledged navigation click succeeds when observational probe cleanup sees stale document", async () => {
  const fixture = installScopedRuntime({ finishProbeErrorCode: "EGO_REFERENCE_STALE" });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(749, "selected-page"));
  try {
    await click("@749");
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 3);
    assert.equal(fixture.bindRequests.length, 1);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("unobserved scoped click is unknown even when native dispatch acknowledges it", async () => {
  const fixture = installScopedRuntime({ unobservedClick: true });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(749, "selected-page"));
  try {
    await assert.rejects(click("@749"), (error: any) => error?.error_code === "EGO_ACTION_RESULT_UNKNOWN");
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 3);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally { fixture.restore(); }
});

test("scoped wait polls with one released read binding at a time", async () => {
  const fixture = installScopedRuntime({ advanceSleep: true, runtimeCallValues: [false, true] });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(750, "selected-page"));
  try {
    assert.equal(await waitForSelector("@750", { state: "visible", timeout: 1_000 }), true);
    assert.equal(fixture.bindRequests.length, 2);
    assert.equal(fixture.releaseCalls.length, 2);
    assert.equal(fixture.maxConcurrentBindings, 1);
  } finally {
    fixture.restore();
  }
});

test("explicit detached signal satisfies detached and hidden but propagates for visible", async () => {
  for (const stateName of ["detached", "hidden"] as const) {
    const fixture = installScopedRuntime({ errorCode: "EGO_REFERENCE_DETACHED", failMethod: "DOM.resolveNode" });
    browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(751, "selected-page"));
    try {
      assert.equal(await waitForSelector("@751", { state: stateName, timeout: 1_000 }), true);
    } finally {
      fixture.restore();
    }
  }
  const fixture = installScopedRuntime({ errorCode: "EGO_REFERENCE_DETACHED", failMethod: "DOM.resolveNode" });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(752, "selected-page"));
  try {
    await assert.rejects(
      waitForSelector("@752", { state: "visible", timeout: 1_000 }),
      (error: any) => error?.error_code === "EGO_REFERENCE_DETACHED",
    );
  } finally {
    fixture.restore();
  }
});

test("empty partial page metadata stays bounded and page eviction revokes retained refs", () => {
  const refs = new RefMap();
  const first = scopedSnapshot(780, "metadata-first-page");
  browserSnapshotRefsToRefMap(refs, first);
  assert.ok(refs.get("780"));
  for (let index = 0; index <= 10_000; index++) {
    browserSnapshotRefsToRefMap(refs, {
      ...scopedSnapshot(781, `metadata-empty-page-${index}`),
      refs: [],
    });
  }
  assert.equal(refs.scopedPageDocuments.size, 10_000);
  assert.equal(refs.get("780"), undefined);
  assert.equal(refs.isStaleScoped("780"), true);
  browserSnapshotRefsToRefMap(refs, { ...first, refs: [], documentEpoch: 2 });
  assert.equal(refs.scopedPageDocuments.size, 10_000);
  assert.equal(refs.get("780"), undefined);
  assert.equal(refs.isStaleScoped("780"), true);
});

test("partial cache tracks root document separately from child ref documents", () => {
  const map = new RefMap();
  const rootScope = {
    runtimeId: "runtime-frames",
    pageId: "page-frames",
    documentId: "root-document",
    documentEpoch: 1,
    completeness: "partial",
  };
  map.beginSnapshot("scoped-v1", rootScope);
  map.addScoped("760", {
    backendNodeId: 760,
    pageId: "page-frames",
    frameId: "root-frame",
    documentId: "root-document",
    documentEpoch: 1,
    role: "button",
    name: "root",
  }, "runtime-frames");
  map.beginSnapshot("scoped-v1", rootScope);
  map.addScoped("761", {
    backendNodeId: 761,
    pageId: "page-frames",
    frameId: "child-frame",
    documentId: "child-document",
    documentEpoch: 9,
    role: "textbox",
    name: "child",
  }, "runtime-frames");
  map.beginSnapshot("scoped-v1", rootScope);
  assert.equal(map.get("760")?.documentId, "root-document");
  assert.equal(map.get("761")?.documentId, "child-document");
});

test("scoped fill keeps one token across resolve, mutation, input, and cleanup", async () => {
  const fixture = installScopedRuntime();
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(701, "selected-page"));
  try {
    await fill("@701", "value");
    assert.equal(fixture.bindRequests.length, 1);
    assert.equal(fixture.releaseCalls.length, 1);
    assert.ok(fixture.cdpCalls.every((call) => call.action?.token === "token-701"));
    assert.ok(fixture.cdpCalls.some((call) => call.request.method === "DOM.resolveNode"
      && call.request.params.backendNodeId === 9701));
    const focusIndex = fixture.cdpCalls.findIndex((call) => call.request.method === "DOM.focus");
    const inputIndex = fixture.cdpCalls.findIndex((call) => call.request.method === "Input.insertText");
    assert.ok(focusIndex >= 0 && focusIndex < inputIndex);
    assert.equal(fixture.cdpCalls[focusIndex]?.request.params.backendNodeId, 9701);
    assert.equal(fixture.cdpCalls[focusIndex]?.request.sessionId, "public-child-alias");
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.insertText").length, 1);
  } finally {
    fixture.restore();
  }
});

test("a mismatched authoritative binding is released before scope failure returns", async () => {
  const fixture = installScopedRuntime({ bindingPageId: "other-page" });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(704, "selected-page"));
  try {
    await assert.rejects(
      click("@704"),
      (error: any) => error?.error_code === "EGO_ACTION_SCOPE_MISMATCH",
    );
    assert.equal(fixture.cdpCalls.length, 0);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("cleared or unknown scoped refs fail stale without hidden snapshot refresh", async () => {
  const fixture = installScopedRuntime();
  let snapshots = 0;
  fixture.runtime.snapshot = async () => {
    snapshots++;
    return scopedSnapshot(702, "selected-page");
  };
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(702, "selected-page"));
  clearScopedReferenceState();
  try {
    await assert.rejects(
      click("@702"),
      (error: any) => error?.error_code === "EGO_REFERENCE_STALE",
    );
    await assert.rejects(
      click("@999"),
      (error: any) => error?.error_code === "EGO_REFERENCE_STALE",
    );
    assert.equal(snapshots, 0);
    assert.equal(fixture.bindRequests.length, 0);
  } finally {
    fixture.restore();
  }
});

test("scoped click does not retry or synthesize a click after input timeout", async () => {
  const fixture = installScopedRuntime({ failFirstInput: true, sessionId: undefined });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(703, "selected-page"));
  try {
    await assert.rejects(
      click("@703"),
      (error: any) => error?.error_code === "EGO_ACTION_RESULT_UNKNOWN",
    );
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 1);
    const finishProbe = fixture.cdpCalls.findLast((call) =>
      call.request.method === "Runtime.evaluate"
      && call.request.params.expression?.includes("delete probes"));
    assert.match(finishProbe?.request.params.expression ?? "", /if \(!false\) return/);
    assert.equal(fixture.bindRequests.length, 1);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("a child-session dialog is observed before scoped click timeout handling", async () => {
  const fixture = installScopedRuntime({
    dialogSourceSessionId: "root-session",
    dialogOnInputTimeout: true,
    failFirstInput: true,
    sessionId: "public-child-alias",
  });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(705, "selected-page"));
  try {
    await click("@705");
    assert.equal(pendingDialog("public-child-alias")?.message, "dialog");
    assert.equal((await dialogInfo())?.message, "dialog");
    await handleDialog({ accept: true });
    const handled = fixture.cdpCalls.find((call) => call.request.method === "Page.handleJavaScriptDialog");
    assert.equal(handled?.request.sessionId, "root-session");
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 1);
    assert.equal(fixture.releaseCalls.length, 1);
    assert.equal(fixture.cdpCalls.some((call) =>
      call.request.method === "Runtime.evaluate"
      && call.request.params.expression?.includes("delete probes")), false);
  } finally {
    fixture.restore();
  }
});

test("a released timed-out scoped command cannot reject a later CDP request", async () => {
  const fixture = installScopedRuntime();
  const originalSend = fixture.runtime.sendCDPMessage;
  const held: any[] = [];
  fixture.runtime.sendCDPMessage = (payload: string, action: any) => {
    const request = JSON.parse(payload);
    if (["Input.dispatchMouseEvent", "Runtime.evaluate"].includes(request.method)) {
      held.push(request);
      return;
    }
    originalSend(payload, action);
  };
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(799, "selected-page"));
  try {
    await assert.rejects(withScopedReferenceAction("@799", 0, () => browserCdp(
      "Input.dispatchMouseEvent", { type: "mouseReleased" }, "root-session", 5,
    )), /timed out/);
    assert.equal(fixture.releaseCalls.length, 1);
    const first = held[0];
    assert.ok(first);

    const second = browserCdp("Runtime.evaluate", {}, "root-session", 1_000);
    const secondRequest = held[1];
    assert.ok(secondRequest);
    fixture.runtime.onSendCDPMessageError("Late released action", "EGO_ACTION_CONTEXT_INVALID", first.id);
    fixture.runtime.onCDPMessage(JSON.stringify({ id: secondRequest.id, result: { value: "second" } }));
    assert.deepEqual(await second, { id: secondRequest.id, result: { value: "second" } });

    const ownFailure = browserCdp("Runtime.evaluate", {}, "root-session", 1_000);
    const ownRejected = assert.rejects(ownFailure, (error: any) => error?.error_code === "EGO_REFERENCE_STALE");
    fixture.runtime.onSendCDPMessageError("Own stale action", "EGO_REFERENCE_STALE", held[2].id);
    await ownRejected;

    const legacyFirst = browserCdp("Runtime.evaluate", {}, "root-session", 1_000);
    const legacySecond = browserCdp("Runtime.evaluate", {}, "root-session", 1_000);
    const legacyRejected = Promise.all([
      assert.rejects(legacyFirst, (error: any) => error?.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL"),
      assert.rejects(legacySecond, (error: any) => error?.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL"),
    ]);
    fixture.runtime.onSendCDPMessageError("Legacy connection failure", "EGO_TASK_SPACE_USER_IN_CONTROL");
    await legacyRejected;
  } finally {
    fixture.restore();
  }
});

test("dialog correlation stays isolated across trusted page aliases", async () => {
  const fixture = installScopedRuntime();
  try {
    await browserCdp("Runtime.enable", {}, "root-a");
    registerPageSessionAlias("root-a", "page-a");
    registerPageSessionAlias("child-a", "page-a");
    registerPageSessionAlias("root-b", "page-b");
    registerPageSessionAlias("child-b", "page-b");
    fixture.runtime.onCDPMessage(JSON.stringify({
      method: "Page.javascriptDialogOpening",
      sessionId: "root-a",
      params: { type: "alert", message: "A", url: "https://ignored-a.test" },
    }));
    fixture.runtime.onCDPMessage(JSON.stringify({
      method: "Page.javascriptDialogOpening",
      sessionId: "root-b",
      params: { type: "alert", message: "B", url: "https://ignored-b.test" },
    }));
    assert.equal(pendingDialog("child-a")?.message, "A");
    assert.equal(pendingDialog("child-b")?.message, "B");
    fixture.runtime.onCDPMessage(JSON.stringify({
      method: "Page.javascriptDialogClosed",
      sessionId: "root-a",
      params: { result: true },
    }));
    assert.equal(pendingDialog("child-a"), null);
    assert.equal(pendingDialog("child-b")?.message, "B");
  } finally {
    clearPageSessionAliases("page-a");
    clearPageSessionAliases("page-b");
    fixture.restore();
  }
});

test("classified host errors survive scoped node resolution", async (t) => {
  for (const errorCode of [
    "EGO_ACTION_CONTEXT_INVALID",
    "EGO_ACTION_EXPIRED",
    "EGO_ACTION_SCOPE_MISMATCH",
    "EGO_ACTION_RESULT_UNKNOWN",
    "EGO_FRAME_UNAVAILABLE",
    "EGO_REFERENCE_DETACHED",
    "EGO_TASK_SPACE_USER_IN_CONTROL",
  ]) {
    await t.test(errorCode, async () => {
      const fixture = installScopedRuntime({ errorCode, failMethod: "DOM.getBoxModel" });
      browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(706, "selected-page"));
      try {
        await assert.rejects(click("@706"), (error: any) => error?.error_code === errorCode);
        assert.equal(fixture.releaseCalls.length, 1);
      } finally {
        fixture.restore();
      }
    });
  }
});

test("unclassified native missing-node failures become stale ref errors", async () => {
  const fixture = installScopedRuntime({ failMethod: "DOM.getBoxModel" });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(707, "selected-page"));
  try {
    await assert.rejects(
      click("@707"),
      (error: any) => error?.error_code === "EGO_REFERENCE_STALE",
    );
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("classified failure after mousePressed reports uncertainty without replay", async () => {
  const fixture = installScopedRuntime({
    errorCode: "EGO_TASK_SPACE_USER_IN_CONTROL",
    failInputAt: 3,
  });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(708, "selected-page"));
  try {
    await assert.rejects(
      click("@708"),
      (error: any) => error?.error_code === "EGO_ACTION_RESULT_UNKNOWN"
        && error?.cause?.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
    );
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 3);
    assert.equal(fixture.releaseCalls.length, 1);
  } finally {
    fixture.restore();
  }
});

test("classified input rejection before dispatch remains classified", async () => {
  const fixture = installScopedRuntime({
    errorCode: "EGO_ACTION_CONTEXT_INVALID",
    failInputAt: 1,
  });
  browserSnapshotRefsToRefMap(browserRefMap, scopedSnapshot(709, "selected-page"));
  try {
    await assert.rejects(
      click("@709"),
      (error: any) => error?.error_code === "EGO_ACTION_CONTEXT_INVALID",
    );
    assert.equal(fixture.cdpCalls.filter((call) => call.request.method === "Input.dispatchMouseEvent").length, 1);
  } finally {
    fixture.restore();
  }
});

function scopedSnapshot(
  refId: number,
  pageId: string,
  overrides: {
    completeness?: "partial" | "complete-page";
    documentEpoch?: number;
    documentId?: string;
  } = {},
) {
  const documentId = overrides.documentId ?? "document-1";
  const documentEpoch = overrides.documentEpoch ?? 1;
  return {
    content: `button [ref=@${refId}]`,
    refFormat: "scoped-v1",
    ...(overrides.completeness ? { completeness: overrides.completeness } : {}),
    runtimeId: "runtime-1",
    pageId,
    documentId,
    documentEpoch,
    refs: [{
      refId,
      backendNodeId: refId + 100,
      pageId,
      frameId: "frame-1",
      documentId,
      documentEpoch,
      role: "button",
      name: "Submit",
    }],
  };
}

function installScopedRuntime(options: {
  bindingPageId?: string;
  boxBorder?: number[];
  dialogOnInputTimeout?: boolean;
  dialogSourceSessionId?: string;
  errorCode?: string;
  failInputAt?: number;
  failMethod?: string;
  finishProbeErrorCode?: string;
  unobservedClick?: boolean;
  groupBindError?: string;
  groupSessionId?: string;
  maxLifetimeMs?: number;
  nowMs?: number;
  advanceSleep?: boolean;
  runtimeCallValues?: unknown[];
  runtimeExceptionAt?: number;
  screenshotMetrics?: { pageX: number; pageY: number; zoom: number };
  failFirstInput?: boolean;
  offscreenUntilScroll?: boolean;
  sessionId?: string | undefined;
} = {}) {
  const previousEgo = (globalThis as any).ego;
  const previousState = {
    sessionId: state.sessionId,
    sessionTargetId: state.sessionTargetId,
    sessionAt: state.sessionAt,
    sessionInflight: state.sessionInflight,
    defaultTimeout: state.defaultTimeout,
    now: state.now,
    sleep: state.sleep,
    writeFile: state.writeFile,
  };
  let clockMs = options.nowMs ?? Date.now();
  const nowMs = clockMs;
  state.now = () => clockMs;
  if (options.advanceSleep) state.sleep = async (ms: number) => { clockMs += ms; };
  state.sessionId = "root-session";
  state.sessionTargetId = "selected-page";
  state.sessionAt = Date.now();
  state.sessionInflight = null;
  const bindRequests: any[] = [];
  const groupBindRequests: any[] = [];
  const releaseCalls: any[] = [];
  const cdpCalls: Array<{ request: any; action: any }> = [];
  const writes: Array<{ path: string; data: Buffer }> = [];
  state.writeFile = async (path: string, data: Buffer) => { writes.push({ path, data }); };
  let failedInput = false;
  let scrolled = false;
  let inputCount = 0;
  let runtimeCallCount = 0;
  let activeBindings = 0;
  let maxConcurrentBindings = 0;
  const runtimeCallValues = [...(options.runtimeCallValues ?? [])];
  const runtime: any = {
    listTabs: async () => ({ tabs: [{ targetId: "selected-page", active: true }] }),
    snapshot: async () => scopedSnapshot(1, "selected-page"),
    getReferenceActionMaxLifetimeMs: () => options.maxLifetimeMs ?? 300_000,
    async bindReferenceAction(request: any) {
      bindRequests.push(request);
      activeBindings++;
      maxConcurrentBindings = Math.max(maxConcurrentBindings, activeBindings);
      const refId = request.ref.refId;
      return {
        version: "scoped-v1",
        token: `token-${refId}`,
        expiresAt: request.deadlineAt,
        runtimeId: request.ref.runtimeId,
        pageId: options.bindingPageId ?? request.expectedScope.pageId,
        frameId: "frame-1",
        documentId: "document-1",
        documentEpoch: 1,
        backendNodeId: refId + 9_000,
        ...(Object.prototype.hasOwnProperty.call(options, "sessionId")
          ? (options.sessionId ? { sessionId: options.sessionId } : {})
          : { sessionId: "public-child-alias" }),
      };
    },
    async bindReferenceActionGroup(request: any) {
      groupBindRequests.push(request);
      if (options.groupBindError) {
        throw Object.assign(new Error("Scoped drag group rejected"), { error_code: options.groupBindError });
      }
      activeBindings++;
      maxConcurrentBindings = Math.max(maxConcurrentBindings, activeBindings);
      return {
        kind: "drag",
        version: "scoped-v1",
        token: `drag-token-${request.source.refId}-${request.target.refId}`,
        expiresAt: request.deadlineAt,
        runtimeId: request.source.runtimeId,
        pageId: request.expectedScope.pageId,
        frameId: "frame-1",
        documentId: "document-1",
        documentEpoch: 1,
        sessionId: options.groupSessionId ?? "public-child-alias",
        source: { refId: request.source.refId, backendNodeId: request.source.refId + 9_000 },
        target: { refId: request.target.refId, backendNodeId: request.target.refId + 9_000 },
      };
    },
    async releaseReferenceAction(action: any) {
      releaseCalls.push(action);
      activeBindings = Math.max(0, activeBindings - 1);
    },
    sendCDPMessage(payload: string, action: any) {
      const request = JSON.parse(payload);
      cdpCalls.push({ request, action });
      let result: any = {};
      let error: any;
      if (request.method === options.failMethod) {
        error = {
          message: `${request.method} failed`,
          ...(options.errorCode ? { error_code: options.errorCode } : {}),
        };
      } else if (request.method === "DOM.scrollIntoViewIfNeeded") {
        scrolled = true;
      } else if (request.method === "DOM.getBoxModel") {
        result = {
          model: {
            content: options.offscreenUntilScroll && !scrolled ? [0, 1_500, 100, 1_500, 100, 1_540, 0, 1_540] : [0, 0, 100, 0, 100, 40, 0, 40],
            border: options.boxBorder ?? [0, 0, 100, 0, 100, 40, 0, 40],
          },
        };
      } else if (request.method === "DOM.resolveNode") {
        result = { object: { objectId: "object-1" } };
      } else if (request.method === "Runtime.callFunctionOn") {
        runtimeCallCount++;
        if (options.runtimeExceptionAt === runtimeCallCount) {
          result = { result: { subtype: "error", description: "Error: boom" }, exceptionDetails: { text: "Uncaught" } };
        } else {
          result = { result: { value: runtimeCallValues.length ? runtimeCallValues.shift() : true } };
        }
      } else if (request.method === "Runtime.evaluate") {
        const finishing = request.params.expression?.includes("delete probes");
        if (finishing && options.finishProbeErrorCode) {
          error = { message: "Probe document changed", error_code: options.finishProbeErrorCode };
        } else {
          result = { result: { value: finishing ? { seen: inputCount >= 3 && !options.unobservedClick && !failedInput && !options.failInputAt, fallback: false } : true } };
        }
      } else if (["Input.dispatchMouseEvent", "Input.dispatchKeyEvent"].includes(request.method)) {
        inputCount++;
        if (options.failInputAt === inputCount) {
          error = {
            message: "Input dispatch rejected",
            ...(options.errorCode ? { error_code: options.errorCode } : {}),
          };
        } else if (request.method === "Input.dispatchMouseEvent" && options.failFirstInput && !failedInput) {
          failedInput = true;
          error = { message: "CDP request timed out: Input.dispatchMouseEvent" };
        }
      } else if (request.method === "Page.getLayoutMetrics") {
        result = { cssVisualViewport: options.screenshotMetrics ?? { pageX: 0, pageY: 0, zoom: 1 } };
      } else if (request.method === "Page.captureScreenshot") {
        result = { data: Buffer.from("png").toString("base64") };
      }
      queueMicrotask(() => runtime.onCDPMessage?.(JSON.stringify({
        ...(options.dialogOnInputTimeout && error ? {
          method: "Page.javascriptDialogOpening",
          sessionId: options.dialogSourceSessionId ?? request.sessionId,
          params: { type: "alert", message: "dialog" },
        } : {
          id: request.id,
          ...(error ? { error } : { result }),
        }),
      })));
      if (options.dialogOnInputTimeout && error) {
        queueMicrotask(() => runtime.onCDPMessage?.(JSON.stringify({ id: request.id, error })));
      }
    },
  };
  (globalThis as any).ego = runtime;
  return {
    runtime,
    nowMs,
    advanceClock(ms: number) { clockMs += ms; },
    get maxConcurrentBindings() { return maxConcurrentBindings; },
    get runtimeCallCount() { return runtimeCallCount; },
    bindRequests,
    groupBindRequests,
    releaseCalls,
    cdpCalls,
    writes,
    restore() {
      browserRefMap.beginSnapshot("native-v0");
      clearPendingDialog("public-child-alias");
      clearPendingDialog("root-session");
      clearPageSessionAliases("selected-page");
      Object.assign(state, previousState);
      if (previousEgo === undefined) delete (globalThis as any).ego;
      else (globalThis as any).ego = previousEgo;
    },
  };
}

function recordInputTimeouts(fixture: ReturnType<typeof installScopedRuntime>, nativeAdvances: number[]) {
  const originalTimer = globalThis.setTimeout;
  const originalSend = fixture.runtime.sendCDPMessage;
  let lastTimeout = 0;
  const timeouts: number[] = [];
  globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    lastTimeout = Number(ms);
    return originalTimer(callback, ms, ...args);
  }) as typeof setTimeout;
  fixture.runtime.sendCDPMessage = (payload: string, action: any) => {
    const request = JSON.parse(payload);
    if (request.method === "Input.dispatchMouseEvent") {
      timeouts.push(lastTimeout);
      fixture.advanceClock(nativeAdvances[timeouts.length - 1] ?? 0);
    }
    originalSend(payload, action);
  };
  return { timeouts, restore() { globalThis.setTimeout = originalTimer; fixture.runtime.sendCDPMessage = originalSend; } };
}
