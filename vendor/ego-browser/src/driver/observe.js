import { join } from "node:path";
import { tmpdir } from "node:os";
import { state } from "../state.js";
import { cdp, evaluate } from "../cdp-eval.js";
import { pageInfo } from "./nav.js";
import {
  browserEgo,
  browserSnapshotRefsToRefMap,
  clearPendingDialog,
  drainBrowserEvents,
  ensureSession,
  isBrowserRuntime,
  pendingDialog
} from "../browser-runtime.js";
import { buildEgoError } from "../ego-errors.js";
import { resolveElementCenter } from "../element-resolver.js";
import {
  browserRefMap,
  ensureRefMapForRef,
  registerSnapshotForRefRefresh
} from "../ref-state.js";
async function drainEvents() {
  return drainBrowserEvents();
}
async function dialogInfo() {
  const sessionId = await ensureSession();
  const dialog = pendingDialog(sessionId);
  return dialog ? { ...dialog } : null;
}
async function handleDialog(options = {}) {
  const sessionId = await ensureSession();
  const dialog = pendingDialog(sessionId);
  if (!dialog) throw new Error("No JavaScript dialog is open");
  const responseSessionId = dialog.sourceSessionId || sessionId;
  await cdp("Page.handleJavaScriptDialog", {
    accept: options.accept !== false,
    ...options.promptText !== void 0 ? { promptText: options.promptText } : {}
  }, responseSessionId);
  clearPendingDialog(responseSessionId, dialog.generation);
  return { handled: true, accept: options.accept !== false, type: dialog.type, message: dialog.message };
}
async function snapshotRaw(options = {}) {
  let result;
  try {
    result = await browserEgo().snapshot(options);
  } catch (err) {
    throw buildEgoError(err, "snapshot");
  }
  browserSnapshotRefsToRefMap(browserRefMap, result);
  return result;
}
registerSnapshotForRefRefresh(() => snapshotRaw());
export function sdkSnapshotOptions(options = {}) {
  return {
    scope: options.scope ?? "full_page",
    includeActionMarks: options.includeActionMarks ?? true,
    includeStableLocator: options.includeStableLocator ?? true,
    ...options.maxResultLength === void 0 ? {} : { maxResultLength: options.maxResultLength }
  };
}
async function snapshot(options = {}) {
  const result = await snapshotRaw(sdkSnapshotOptions(options));
  return result.content || "";
}
async function elementCenter(selectorOrRef) {
  await ensureRefMapForRef(selectorOrRef);
  return resolveElementCenter(
    { sendRaw: cdp },
    void 0,
    browserRefMap,
    selectorOrRef
  );
}
let screenshotSeq = 0;
async function screenshot(options = {}) {
  const path = options.path ?? join(tmpdir(), `ego-browser-shot-${process.pid}-${++screenshotSeq}.png`);
  const full = options.fullPage ?? false;
  const raw = options.raw ?? false;
  const params = {
    format: "png",
    captureBeyondViewport: full
  };
  if (raw) {
    if (options.clip) {
      params.clip = { ...options.clip };
    }
  } else {
    if (isBrowserRuntime()) {
      await ensureSession();
    }
    if (!pendingDialog()) {
      const dpr = Number(await evaluate("window.devicePixelRatio")) || 1;
      const cssScale = 1 / dpr;
      if (options.clip) {
        params.clip = { scale: cssScale, ...options.clip };
      } else {
        const info = await pageInfo();
        if ("dialog" in info) {
          return screenshot({ ...options, path, raw: true });
        }
        params.clip = {
          x: 0,
          y: 0,
          width: full ? info.pw : info.w,
          height: full ? info.ph : info.h,
          scale: cssScale
        };
      }
    }
  }
  const result = await cdp("Page.captureScreenshot", params);
  await state.writeFile(path, Buffer.from(result.data, "base64"));
  return path;
}
async function scopedElementScreenshot(binding, rootSessionId, options = {}) {
  if (!binding?.sessionId || binding.sessionId !== rootSessionId) {
    throw Object.assign(new Error("Scoped element screenshots are limited to the top-level native session; use a page screenshot for child frames"), {
      error_code: "EGO_FRAME_UNAVAILABLE"
    });
  }
  const box = await cdp("DOM.getBoxModel", { backendNodeId: binding.backendNodeId }, rootSessionId);
  const bounds = quadBounds(box?.model?.border);
  const metrics = await cdp("Page.getLayoutMetrics", {}, rootSessionId);
  const viewport = metrics?.cssVisualViewport;
  const pageX = Number(viewport?.pageX);
  const pageY = Number(viewport?.pageY);
  const zoom = Number(viewport?.zoom);
  if (![pageX, pageY, zoom].every(Number.isFinite) || zoom <= 0) {
    throw Object.assign(new Error("Scoped element screenshot metrics are unavailable"), {
      error_code: "EGO_FRAME_UNAVAILABLE"
    });
  }
  const clip = {
    x: (bounds.x + pageX) * zoom,
    y: (bounds.y + pageY) * zoom,
    width: bounds.width * zoom,
    height: bounds.height * zoom,
    scale: 1
  };
  if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.width <= 0 || clip.height <= 0) {
    throw Object.assign(new Error("Scoped element screenshot clip is invalid"), {
      error_code: "EGO_FRAME_UNAVAILABLE"
    });
  }
  const result = await cdp("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip
  }, rootSessionId);
  if (typeof result?.data !== "string" || !result.data) {
    throw new Error("Scoped element screenshot returned no image data");
  }
  const path = options.path ?? join(tmpdir(), `ego-browser-shot-${process.pid}-${++screenshotSeq}.png`);
  await state.writeFile(path, Buffer.from(result.data, "base64"));
  return path;
}
function quadBounds(quad) {
  if (!Array.isArray(quad) || quad.length !== 8 || !quad.every((value) => Number.isFinite(Number(value)))) {
    throw Object.assign(new Error("Scoped element screenshot border quad is unavailable"), {
      error_code: "EGO_FRAME_UNAVAILABLE"
    });
  }
  const xs = [Number(quad[0]), Number(quad[2]), Number(quad[4]), Number(quad[6])];
  const ys = [Number(quad[1]), Number(quad[3]), Number(quad[5]), Number(quad[7])];
  const left = Math.min(...xs), right = Math.max(...xs);
  const top = Math.min(...ys), bottom = Math.max(...ys);
  if (!(right > left && bottom > top)) {
    throw Object.assign(new Error("Scoped element screenshot border quad is empty"), {
      error_code: "EGO_FRAME_UNAVAILABLE"
    });
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
export {
  drainEvents,
  dialogInfo,
  handleDialog,
  elementCenter,
  screenshot,
  scopedElementScreenshot,
  snapshot,
  snapshotRaw
};
