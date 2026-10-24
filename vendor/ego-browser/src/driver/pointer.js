import { cdp, evaluate } from "../cdp-eval.js";
import { browserCdp, pendingDialog } from "../browser-runtime.js";
import { elementCenter } from "./observe.js";
import { resolveAndCall } from "./element-ops.js";
import { waitForSelector } from "./waits.js";
import { parseRef } from "../ref-map.js";
import { browserRefMap, ensureRefMapForRef } from "../ref-state.js";
import { state } from "../state.js";
import {
  currentScopedReferenceAction,
  withScopedReferenceAction,
  withScopedReferenceGroup
} from "../scoped-reference-context.js";
const INPUT_EVENT_DELAY_MS = 25;
const INPUT_DISPATCH_TIMEOUT_MS = 1e3;
let currentMousePoint = { x: 0, y: 0, sessionId: void 0 };
async function click(target, options = {}) {
  return withScopedReferenceAction(target, options.timeout, () => clickOnce(target, options));
}
async function clickOnce(target, options = {}) {
  if (options.activation === "auto" && typeof target === "string" && (!options.button || options.button === "left") && (options.clickCount ?? 1) === 1) {
    await waitForSelector(target, { timeout: options.timeout, state: "visible" });
    let activation;
    try {
      const { result } = await resolveAndCall(target, `function () {
      if (this.ownerDocument.visibilityState !== "hidden" && this.ownerDocument.hasFocus()) return { activated: false };
      const nativeControl = this instanceof HTMLButtonElement || this instanceof HTMLAnchorElement
        || (this instanceof HTMLInputElement && ["button", "submit", "reset"].includes(this.type));
      if (!nativeControl || !this.isConnected || this.disabled || this.getAttribute("aria-disabled") === "true"
        || this.closest("[inert]") || this.matches(":disabled")) return { activated: false };
      const style = getComputedStyle(this);
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return { activated: false };
      this.scrollIntoView({ block: "center", inline: "center" });
      const rect = this.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return { activated: false };
      this.click();
      return { activated: true };
      }`);
      activation = result.result?.value?.activated;
    } catch (error) {
      if (error?.error_code) throw error;
      throw Object.assign(new Error("Automatic click result is unknown after activation may have run"), {
        error_code: "EGO_ACTION_RESULT_UNKNOWN", cause: error
      });
    }
    if (activation === true) return;
    // Only an explicit refusal proves that native input cannot duplicate activation.
    if (activation !== false) {
      throw Object.assign(new Error("Automatic click returned no definitive activation result"), {
        error_code: "EGO_ACTION_RESULT_UNKNOWN"
      });
    }
  }
  const point = await resolveMouseTarget(target, options.timeout);
  rememberMousePoint(point);
  const button = options.button || "left";
  const buttons = pressedButtons(button);
  const clickCount = options.clickCount ?? 1;
  const scopedAction = currentScopedReferenceAction();
  maybeHighlight(point, options.label);
  const probeId = button === "left" ? await installClickProbe(point) : null;
  let dispatchError = null;
  let inputStarted = false;
  try {
    await dispatchMouse(point, "mouseMoved", {
      button: "none",
      buttons: 0
    });
    await inputEventDelay();
    await dispatchMouse(point, "mousePressed", {
      button,
      buttons,
      clickCount
    });
    inputStarted = true;
    await inputEventDelay();
    await dispatchMouse(point, "mouseReleased", {
      button,
      buttons: 0,
      clickCount
    });
  } catch (error) {
    if (!isInputDispatchTimeout(error) && !error?.error_code) throw error;
    dispatchError = error;
  }
  if (pendingDialog(point.sessionId)) return;
  const completed = await finishClickProbe(point, probeId, clickCount, !scopedAction);
  if (!dispatchError && scopedAction && completed === false) {
    throw Object.assign(new Error("Scoped click was dispatched but its target did not observe a click event"), {
      error_code: "EGO_ACTION_RESULT_UNKNOWN"
    });
  }
  if (dispatchError && !completed) {
    if (
      scopedAction
      && dispatchError?.error_code !== "EGO_ACTION_RESULT_UNKNOWN"
      && (inputStarted || isInputDispatchTimeout(dispatchError))
    ) {
      throw Object.assign(new Error("Scoped click result is unknown after input may have been dispatched"), {
        error_code: "EGO_ACTION_RESULT_UNKNOWN",
        cause: dispatchError
      });
    }
    throw dispatchError;
  }
}
async function dblclick(target, options = {}) {
  return withScopedReferenceAction(target, options.timeout, async () => {
    await click(target, { ...options, clickCount: 1 });
    await inputEventDelay();
    await click(target, { ...options, clickCount: 2 });
  });
}
async function hover(target, options = {}) {
  return withScopedReferenceAction(target, options.timeout, () => hoverOnce(target, options));
}
async function hoverOnce(target, options = {}) {
  const point = await resolveMouseTarget(target, options.timeout);
  rememberMousePoint(point);
  maybeHighlight(point, options.label);
  const probeId = await installHoverProbe(point);
  let dispatchError = null;
  try {
    await dispatchMouse(point, "mouseMoved", { buttons: 0 });
  } catch (error) {
    if (!isInputDispatchTimeout(error) && !error?.error_code) throw error;
    dispatchError = error;
  }
  const scopedAction = currentScopedReferenceAction();
  const completed = await finishHoverProbe(point, probeId, !scopedAction);
  if (dispatchError && !completed) {
    if (scopedAction && isInputDispatchTimeout(dispatchError)) {
      throw Object.assign(new Error("Scoped hover result is unknown after input may have been dispatched"), {
        error_code: "EGO_ACTION_RESULT_UNKNOWN",
        cause: dispatchError
      });
    }
    throw dispatchError;
  }
}
async function drag(points, options = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("drag requires at least two points");
  }
  if (points.length === 2) {
    const source = typeof points[0] === "object" && points[0]?.selector ? points[0].selector : points[0];
    const target = typeof points[1] === "object" && points[1]?.selector ? points[1].selector : points[1];
    return withScopedReferenceGroup(source, target, options.timeout, () => dragOnce(points, options));
  }
  await rejectUnsupportedScopedMultiPointDrag(points);
  return dragOnce(points, options);
}
async function rejectUnsupportedScopedMultiPointDrag(points) {
  for (const point of points) {
    const target = typeof point === "object" && point?.selector ? point.selector : point;
    if (typeof target !== "string") continue;
    const refId = parseRef(target);
    if (!refId) continue;
    await ensureRefMapForRef(target);
    if (browserRefMap.get(refId)?.refFormat === "scoped-v1") {
      throw Object.assign(new Error("Scoped drag currently requires exactly one source ref and one target ref"), {
        error_code: "EGO_ACTION_CONTEXT_INVALID"
      });
    }
  }
}
async function dragOnce(points, options = {}) {
  const resolved = [];
  for (const point of points) {
    resolved.push(await resolveMouseTarget(point, options.timeout));
  }
  const button = options.button || "left";
  const buttons = pressedButtons(button);
  const first = resolved[0];
  const last = resolved.at(-1);
  if (resolved.some((point) => point.sessionId !== first.sessionId)) {
    throw new Error("drag across different frame sessions is not supported");
  }
  if (last) {
    rememberMousePoint(last);
  }
  maybeHighlight(first, options.label);
  const probeId = await installMouseUpProbe(last);
  let dispatchError = null;
  let inputStarted = false;
  try {
    await dispatchMouse(first, "mousePressed", {
      button,
      buttons,
      clickCount: 1
    });
    inputStarted = true;
    await inputEventDelay();
    for (let i = 1; i < resolved.length; i += 1) {
      const point = resolved[i];
      await dispatchMouse(
        { ...point, sessionId: point.sessionId ?? first.sessionId },
        "mouseMoved",
        {
          button,
          buttons
        }
      );
      await inputEventDelay(options.delay > 0 ? options.delay : void 0);
    }
    await dispatchMouse(
      { ...last, sessionId: last.sessionId ?? first.sessionId },
      "mouseReleased",
      {
        button,
        buttons: 0,
        clickCount: 1
      }
    );
  } catch (error) {
    if (!isInputDispatchTimeout(error) && !error?.error_code) throw error;
    dispatchError = error;
  }
  const scopedAction = currentScopedReferenceAction();
  const completed = await finishDragProbe(resolved, probeId, button, !scopedAction);
  if (dispatchError && !completed) {
    if (
      scopedAction
      && dispatchError?.error_code !== "EGO_ACTION_RESULT_UNKNOWN"
      && (inputStarted || isInputDispatchTimeout(dispatchError))
    ) {
      throw Object.assign(new Error("Scoped drag result is unknown after input may have been dispatched"), {
        error_code: "EGO_ACTION_RESULT_UNKNOWN",
        cause: dispatchError
      });
    }
    throw dispatchError;
  }
}
async function down(options = {}) {
  const button = options.button || "left";
  await dispatchMouse(currentMousePoint, "mousePressed", {
    button,
    buttons: pressedButtons(button),
    clickCount: options.clickCount ?? 1
  });
}
async function up(options = {}) {
  const button = options.button || "left";
  await dispatchMouse(currentMousePoint, "mouseReleased", {
    button,
    buttons: 0,
    clickCount: options.clickCount ?? 1
  });
}
function inputEventDelay(ms = INPUT_EVENT_DELAY_MS) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function installClickProbe(point) {
  if (!canProbeInputFallback()) return null;
  const id = `click_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("click", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
        returnByValue: true,
        awaitPromise: false
      },
      point.sessionId
    );
    return result.result?.value ? id : null;
  } catch {
    return null;
  }
}
async function finishClickProbe(point, id, clickCount, allowFallback = true) {
  if (!id) return null;
  await inputEventDelay(50);
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("click", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen || !probe.target) return { seen: probe.seen, fallback: false };
        if (!${JSON.stringify(allowFallback)}) return { seen: false, fallback: false };
        const target = probe.target;
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: ${JSON.stringify(point.x)},
          clientY: ${JSON.stringify(point.y)},
          button: 0,
        };
        target.dispatchEvent(new MouseEvent("mousemove", { ...init, buttons: 0, detail: 0 }));
        target.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1, detail: ${JSON.stringify(clickCount)} }));
        target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0, detail: ${JSON.stringify(clickCount)} }));
        target.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0, detail: ${JSON.stringify(clickCount)} }));
        if (${JSON.stringify(clickCount)} > 1) {
          target.dispatchEvent(new MouseEvent("dblclick", { ...init, buttons: 0, detail: 2 }));
        }
        return { seen: false, fallback: true };
      })()`,
        returnByValue: true,
        awaitPromise: false
      },
      point.sessionId
    );
    const value = result.result?.value;
    return Boolean(value?.seen || value?.fallback);
  } catch {
    // Navigation may replace the probe document after an acknowledged click.
    return null;
  }
}
async function installMouseUpProbe(point) {
  if (!canProbeInputFallback()) return null;
  const id = `drag_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("mouseup", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
        returnByValue: true,
        awaitPromise: false
      },
      point.sessionId
    );
    return result.result?.value ? id : null;
  } catch {
    return null;
  }
}
async function installHoverProbe(point) {
  if (!canProbeInputFallback()) return null;
  const id = `hover_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("mousemove", probe.handler, true);
        document.addEventListener("mouseover", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
        returnByValue: true,
        awaitPromise: false
      },
      point.sessionId
    );
    return result.result?.value ? id : null;
  } catch {
    return null;
  }
}
async function finishHoverProbe(point, id, allowFallback = true) {
  if (!id) return false;
  await inputEventDelay(50);
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("mousemove", probe.handler, true);
        document.removeEventListener("mouseover", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen || !probe.target) return { seen: probe.seen, fallback: false };
        if (!${JSON.stringify(allowFallback)}) return { seen: false, fallback: false };
        const target = probe.target;
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: ${JSON.stringify(point.x)},
          clientY: ${JSON.stringify(point.y)},
          button: 0,
          buttons: 0,
        };
        target.dispatchEvent(new MouseEvent("mousemove", init));
        target.dispatchEvent(new MouseEvent("mouseover", init));
        return { seen: false, fallback: true };
      })()`,
        returnByValue: true,
        awaitPromise: false
      },
      point.sessionId
    );
    const value = result.result?.value;
    return Boolean(value?.seen || value?.fallback);
  } catch {
    return false;
  }
}
async function finishDragProbe(points, id, button, allowFallback = true) {
  if (!id) return false;
  await inputEventDelay(50);
  const first = points[0];
  const last = points.at(-1);
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("mouseup", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen) return { seen: true, fallback: false };
        if (!${JSON.stringify(allowFallback)}) return { seen: false, fallback: false };
        const mouseButton = ${JSON.stringify(button === "left" ? 0 : button === "middle" ? 1 : 2)};
        const eventFor = (type, point, buttons) => {
          const target = document.elementFromPoint(point.x, point.y) || document.body;
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: point.x,
            clientY: point.y,
            button: mouseButton,
            buttons,
            detail: type === "mousemove" ? 0 : 1,
          }));
        };
        const points = ${JSON.stringify(points.map(({ x, y }) => ({ x, y })))};
        eventFor("mousedown", points[0], 1);
        for (const point of points.slice(1)) eventFor("mousemove", point, 1);
        eventFor("mouseup", points.at(-1), 0);
        return { seen: false, fallback: true };
      })()`,
        returnByValue: true,
        awaitPromise: false
      },
      last.sessionId ?? first.sessionId
    );
    const value = result.result?.value;
    return Boolean(value?.seen || value?.fallback);
  } catch {
    return false;
  }
}
function canProbeInputFallback() {
  return Boolean(globalThis.ego?.sendCDPMessage);
}
async function wheel(deltaX = 0, deltaY = 300, options = {}) {
  const x = numberValue(options.x ?? 0);
  const y = numberValue(options.y ?? 0);
  const dx = numberValue(deltaX);
  const dy = numberValue(deltaY);
  if (await isVisibleAndFocused()) {
    await browserCdp(
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy },
      void 0,
      inputDispatchTimeout()
    );
    return;
  }
  await dispatchSyntheticWheel(x, y, dx, dy);
}
async function isVisibleAndFocused() {
  try {
    return Boolean(
      await evaluate(
        "document.visibilityState === 'visible' && document.hasFocus()"
      )
    );
  } catch {
    return true;
  }
}
async function dispatchSyntheticWheel(x, y, deltaX, deltaY) {
  await evaluate(`(() => {
    const target = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)})
      || document.scrollingElement || document.body;
    if (!target) return;
    const notPrevented = target.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: ${JSON.stringify(deltaX)},
      deltaY: ${JSON.stringify(deltaY)},
      clientX: ${JSON.stringify(x)},
      clientY: ${JSON.stringify(y)}
    }));
    if (notPrevented) {
      window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)});
    }
  })()`);
}
async function scrollIntoViewIfNeeded(selector) {
  return withScopedReferenceAction(selector, void 0, () => resolveAndCall(
    selector,
    "function(){ if (typeof this.scrollIntoViewIfNeeded === 'function') { this.scrollIntoViewIfNeeded(true); } else { this.scrollIntoView({ block: 'center', inline: 'center' }); } }"
  ));
}
function maybeHighlight(point, label) {
  const ego = globalThis.ego;
  if (!ego) return;
  ego.animationHighlightMouseToPosition?.(point.x, point.y);
  if (label) {
    ego.setAgentTaskState?.(label);
  }
}
function rememberMousePoint(point) {
  currentMousePoint = { ...point };
}
async function dispatchMouse(point, type, options = {}) {
  await browserCdp(
    "Input.dispatchMouseEvent",
    {
      type,
      x: point.x,
      y: point.y,
      ...options
    },
    point.sessionId,
    inputDispatchTimeout()
  );
}
function inputDispatchTimeout() {
  const binding = currentScopedReferenceAction()?.binding;
  if (!binding) return INPUT_DISPATCH_TIMEOUT_MS;
  const remaining = binding.expiresAt - state.now();
  if (!Number.isFinite(binding.expiresAt) || !Number.isFinite(remaining)) {
    throw Object.assign(new Error("Scoped input deadline is invalid"), { error_code: "EGO_ACTION_CONTEXT_INVALID" });
  }
  if (remaining <= 0) {
    throw Object.assign(new Error("Scoped input deadline expired before dispatch"), {
      error_code: "EGO_ACTION_EXPIRED", delivery: "not_sent"
    });
  }
  return remaining;
}
function isInputDispatchTimeout(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /CDP request timed out: Input\.dispatchMouseEvent/.test(message);
}
async function resolveMouseTarget(target, timeout = void 0) {
  if (typeof target === "string") {
    await waitForSelector(target, { timeout, state: "visible" });
    return elementCenter(target);
  }
  if (Array.isArray(target)) {
    return pointFrom(target);
  }
  if (target && typeof target === "object") {
    if ("selector" in target && typeof target.selector === "string" && target.selector) {
      if (target.x === void 0 && target.y === void 0) {
        await waitForSelector(target.selector, { timeout, state: "visible" });
        return elementCenter(target.selector);
      }
      await waitForSelector(target.selector, { timeout, state: "visible" });
      const [topLeft, center] = await Promise.all([
        elementTopLeft(target.selector),
        elementCenter(target.selector)
      ]);
      return {
        x: topLeft.x + numberValue(target.x),
        y: topLeft.y + numberValue(target.y),
        sessionId: center.sessionId
      };
    }
    if (target.x !== void 0 || target.y !== void 0) {
      return pointFrom(target);
    }
  }
  throw new Error(`invalid mouse target: ${JSON.stringify(target)}`);
}
async function elementTopLeft(selectorOrRef) {
  const { result } = await resolveAndCall(
    selectorOrRef,
    "function(){const rect=this.getBoundingClientRect();return {x:rect.left,y:rect.top};}"
  );
  const value = result.result?.value;
  if (typeof value?.x !== "number" || typeof value?.y !== "number") {
    throw new Error(`element top-left unavailable: ${selectorOrRef}`);
  }
  return { x: value.x, y: value.y };
}
function pointFrom(point) {
  const x = Array.isArray(point) ? point[0] : point?.x;
  const y = Array.isArray(point) ? point[1] : point?.y;
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    throw new Error(`invalid mouse target: ${JSON.stringify(point)}`);
  }
  return { x: Number(x), y: Number(y), sessionId: void 0 };
}
function numberValue(value) {
  const out = value === void 0 ? 0 : Number(value);
  if (!Number.isFinite(out)) {
    throw new Error(`invalid mouse offset: ${JSON.stringify(value)}`);
  }
  return out;
}
function pressedButtons(button) {
  if (button === "left") {
    return 1;
  }
  if (button === "right") {
    return 2;
  }
  if (button === "middle") {
    return 4;
  }
  throw new Error(`unsupported mouse button: ${button}`);
}
export {
  click,
  dblclick,
  down,
  drag,
  hover,
  scrollIntoViewIfNeeded,
  up,
  wheel
};
