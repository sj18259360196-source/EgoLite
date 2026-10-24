import { runtimeValue } from "../cdp-eval.js";
import { browserCdp, ensureSession, invalidateSession, isSessionLostError } from "../browser-runtime.js";
import { state } from "../state.js";
async function waitForDocumentLoad(options = {}) {
  const timeout = options.timeout ?? 15e3;
  const ready = options.until === "domcontentloaded" ? ["interactive", "complete"] : ["complete"];
  const deadline = options.deadline ?? state.now() + timeout;
  const immediateCheck = timeout === 0;
  if (!state.sessionTargetId) await ensureSession(options.expectedTargetId);
  const expectedTargetId = options.expectedTargetId ?? state.sessionTargetId;
  let checked = false;
  while (immediateCheck ? !checked : state.now() < deadline) {
    checked = true;
    let sessionId;
    try {
      sessionId = await ensureSession(expectedTargetId);
    } catch {
      if (immediateCheck) return false;
      await readinessDelay(deadline);
      continue;
    }
    if (!immediateCheck && state.now() >= deadline) return false;
    let committed = true;
    try {
      const tree = await readinessRead("Page.getFrameTree", {}, sessionId, deadline, immediateCheck);
      const frame = tree.frameTree?.frame;
      const url = frame?.url || "";
      committed = url !== "" && url !== ":" && url !== "about:blank";
      if (options.previousLoaderId || options.previousFrameId) {
        committed = committed && (
          (options.previousLoaderId && frame?.loaderId && frame.loaderId !== options.previousLoaderId)
          || (options.previousFrameId && frame?.id && frame.id !== options.previousFrameId)
        );
      }
    } catch (error) {
      if (isReadinessSessionLost(error) && state.sessionId === sessionId) invalidateSession();
      committed = false;
    }
    if (!immediateCheck && state.now() >= deadline) return false;
    if (committed) {
      if (options.until === "commit") return true;
      try {
        const response = await readinessRead("Runtime.evaluate", {
          expression: "document.readyState", returnByValue: true, awaitPromise: true
        }, sessionId, deadline, immediateCheck);
        if (!immediateCheck && state.now() > deadline) return false;
        if (ready.includes(runtimeValue(response, "document.readyState"))) return true;
      } catch (error) {
        if ((!immediateCheck && state.now() >= deadline) || error?.message === "CDP request timed out: Runtime.evaluate") return false;
        if (!isReadinessSessionLost(error)) throw error;
        if (state.sessionId === sessionId) invalidateSession();
      }
    }
    if (immediateCheck) return false;
    await readinessDelay(deadline);
  }
  return false;
}
async function readinessRead(method, params, sessionId, deadline, immediateCheck) {
  const response = await browserCdp(method, params, sessionId,
    immediateCheck ? void 0 : Math.max(1, deadline - state.now()));
  return state.cdpOverride ? response : response.result || {};
}
function isReadinessSessionLost(error) {
  return isSessionLostError(error) || /^(?:Error: )?No target available$/.test(error?.message || "");
}
function readinessDelay(deadline) {
  return state.sleep(Math.min(300, Math.max(0, deadline - state.now())));
}
export {
  waitForDocumentLoad
};
