import { state } from "./state.js";
import { assertNoEgoError, buildEgoError } from "./ego-errors.js";
import { currentScopedReferenceAction } from "./scoped-reference-context.js";
const RESPONSE_TIMEOUT_MS = 15e3;
const SESSION_TTL_MS = 2e3;
const MAX_BUFFERED_EVENTS = 1e4;
const SESSION_LOST = /Session (?:with given id )?not found|Target closed|No session/i;
const RETIRED_ALIAS = /Session alias is unavailable\s*\((?:debugger_detached|alias_retired|session_retired)\)/i;
const SAFE_SESSION_RETRY_METHODS = /* @__PURE__ */ new Set(["Page.getFrameTree"]);
const BROWSER_LEVEL = (method) => method.startsWith("Target.") || method.startsWith("Browser.");
let nextMessageId = 1;
const pending = /* @__PURE__ */ new Map();
const events = [];
const eventWaiters = [];
const pageEnabledSessions = /* @__PURE__ */ new Set();
const pendingDialogsByPage = /* @__PURE__ */ new Map();
const pageBySessionAlias = /* @__PURE__ */ new Map();
const sessionAliasesByPage = /* @__PURE__ */ new Map();
const MAX_SESSION_ALIASES = 1024;
let nextDialogGeneration = 1;
function isBrowserRuntime() {
  return Boolean(
    globalThis.ego && typeof globalThis.ego.sendCDPMessage === "function"
  );
}
function browserEgo() {
  if (!globalThis.ego) {
    throw new Error("browser runtime is not available");
  }
  return globalThis.ego;
}
function rawCdp(method, params = {}, sessionId = void 0, timeoutMs = RESPONSE_TIMEOUT_MS) {
  const runtime = browserEgo();
  runtime.onCDPMessage = handleMessage;
  runtime.onSendCDPMessageError = handleSendError;
  const id = nextMessageId++;
  const payload = JSON.stringify({
    id,
    method,
    params,
    ...sessionId ? { sessionId } : {}
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP request timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    try {
      runtime.sendCDPMessage(payload, currentScopedReferenceAction()?.wire);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}
async function browserCdp(method, params = {}, sessionId = void 0, timeoutMs = RESPONSE_TIMEOUT_MS) {
  if (state.cdpOverride) {
    return state.cdpOverride(method, params, sessionId);
  }
  const explicit = sessionId !== void 0;
  let effective = sessionId;
  if (!explicit && !BROWSER_LEVEL(method)) {
    effective = currentScopedReferenceAction()?.binding?.sessionId ?? await ensureSession();
  }
  try {
    return await rawCdp(method, params, effective, timeoutMs);
  } catch (error) {
    const lost = isSessionLostError(error);
    if (lost && !currentScopedReferenceAction() && !explicit && !BROWSER_LEVEL(method)) {
      const expectedTargetId = state.sessionTargetId;
      invalidateSession();
      if (SAFE_SESSION_RETRY_METHODS.has(method) && expectedTargetId) {
        const fresh = await ensureSession(expectedTargetId);
        return rawCdp(method, params, fresh, timeoutMs);
      }
    }
    throw error;
  }
}
function isSessionLostError(error) {
  const message = error?.message || "";
  if (SESSION_LOST.test(message)) return true;
  return ["EGO_ACTION_SCOPE_MISMATCH", "EGO_FRAME_UNAVAILABLE"].includes(error?.error_code)
    && RETIRED_ALIAS.test(message);
}
async function ensureSession(expectedTargetId = void 0) {
  if (state.sessionId && Date.now() - state.sessionAt < SESSION_TTL_MS
    && (!expectedTargetId || state.sessionTargetId === expectedTargetId)) {
    registerPageSessionAlias(state.sessionId, state.sessionTargetId);
    return state.sessionId;
  }
  if (state.sessionInflight) {
    const sessionId = await state.sessionInflight;
    if (!expectedTargetId || state.sessionTargetId === expectedTargetId) return sessionId;
    throw Object.assign(new Error(`Expected page is unavailable: ${expectedTargetId}`), {
      error_code: "EGO_WEB_CONTENTS_UNAVAILABLE"
    });
  }
  state.sessionInflight = (async () => {
    try {
      const result = assertNoEgoError(await browserEgo().listTabs());
      const tabs = result?.tabs || result?.targetInfos || [];
      const preferred = state.preferredTargetId ? tabs.find((t) => t.targetId === state.preferredTargetId) : null;
      const active = expectedTargetId
        ? tabs.find((t) => t.targetId === expectedTargetId)
        : preferred || tabs.find((t) => t.active) || tabs[tabs.length - 1];
      if (!active) {
        throw Object.assign(new Error(expectedTargetId
          ? `Expected page is unavailable: ${expectedTargetId}`
          : "no active tab to attach session"), {
          error_code: "EGO_WEB_CONTENTS_UNAVAILABLE"
        });
      }
      const targetId = active.targetId;
      if (targetId !== state.sessionTargetId || !state.sessionId) {
        const attached = await rawCdp(
          "Target.attachToTarget",
          { targetId, flatten: true },
          void 0
        );
        state.sessionId = attached.result?.sessionId || attached.sessionId;
        state.sessionTargetId = targetId;
      }
      registerPageSessionAlias(state.sessionId, targetId);
      await enablePageEvents(state.sessionId);
      state.sessionAt = Date.now();
      return state.sessionId;
    } finally {
      state.sessionInflight = null;
    }
  })();
  return state.sessionInflight;
}
function invalidateSession() {
  if (state.sessionId) {
    pageEnabledSessions.delete(state.sessionId);
    unregisterSessionAlias(state.sessionId);
  }
  state.sessionId = null;
  state.sessionTargetId = null;
  state.sessionAt = 0;
}
function setPreferredTarget(targetId) {
  state.preferredTargetId = targetId || null;
}
function clearPreferredTarget() {
  state.preferredTargetId = null;
}
function drainBrowserEvents() {
  const out = events.splice(0, events.length);
  return out;
}
function waitForBrowserEvent(predicate, timeoutMs = state.defaultTimeout) {
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = eventWaiters.indexOf(waiter);
        if (index >= 0) eventWaiters.splice(index, 1);
        reject(new Error("page.waitForEvent timed out"));
      }, timeoutMs)
    };
    eventWaiters.push(waiter);
  });
}
function pendingDialog(sessionId = state.sessionId) {
  const pageId = pageIdForSessionAlias(sessionId);
  const dialog = pageId ? pendingDialogsByPage.get(pageId) : void 0;
  return dialog ? { ...dialog } : null;
}
function clearPendingDialog(sessionId, generation = void 0) {
  const pageId = pageIdForSessionAlias(sessionId);
  if (!pageId) return false;
  const current = pendingDialogsByPage.get(pageId);
  if (!current || generation !== void 0 && current.generation !== generation) return false;
  pendingDialogsByPage.delete(pageId);
  return true;
}
function registerPageSessionAlias(sessionId, pageId) {
  if (!sessionId || !pageId) return;
  const previousPage = pageBySessionAlias.get(sessionId);
  if (previousPage && previousPage !== pageId) removeAliasFromPage(sessionId, previousPage);
  pageBySessionAlias.delete(sessionId);
  pageBySessionAlias.set(sessionId, pageId);
  const aliases = sessionAliasesByPage.get(pageId) || /* @__PURE__ */ new Set();
  aliases.add(sessionId);
  sessionAliasesByPage.set(pageId, aliases);
  while (pageBySessionAlias.size > MAX_SESSION_ALIASES) {
    const oldest = pageBySessionAlias.keys().next().value;
    if (!oldest) break;
    unregisterSessionAlias(oldest);
  }
}
function pageIdForSessionAlias(sessionId) {
  return sessionId ? pageBySessionAlias.get(sessionId) : void 0;
}
async function getPageSessionAliases(rootSessionId) {
  const pageId = pageIdForSessionAlias(rootSessionId);
  if (!pageId) throw pageSessionUnavailable("The root page session is unavailable");
  let response;
  try {
    response = await browserCdp("Ego.getPageSessions", {}, rootSessionId);
  } catch (error) {
    if (error?.error_code) throw error;
    throw Object.assign(pageSessionUnavailable("Page session enumeration is unavailable"), { cause: error });
  }
  const result = response?.result ?? response;
  if (result?.pageId !== pageId || pageIdForSessionAlias(rootSessionId) !== pageId) {
    throw Object.assign(new Error("Page session enumeration changed its page scope"), {
      error_code: "EGO_ACTION_SCOPE_MISMATCH"
    });
  }
  if (!Array.isArray(result.sessions) || result.sessions.length === 0 || result.sessions.length > MAX_SESSION_ALIASES
    || result.sessions.some((session) => typeof session?.sessionId !== "string" || !session.sessionId)
    || !result.sessions.some((session) => session.sessionId === rootSessionId)) {
    throw Object.assign(new Error("Invalid page session enumeration payload"), {
      error_code: "EGO_INVALID_RESULT_PAYLOAD"
    });
  }
  const sessionIds = [...new Set(result.sessions.map((session) => session.sessionId))];
  for (const sessionId of sessionIds) {
    const previousPage = pageIdForSessionAlias(sessionId);
    if (previousPage && previousPage !== pageId) {
      throw Object.assign(new Error("Page session alias belongs to another page"), {
        error_code: "EGO_ACTION_SCOPE_MISMATCH"
      });
    }
  }
  for (const sessionId of sessionIds) registerPageSessionAlias(sessionId, pageId);
  return { pageId, sessionIds };
}
function pageSessionUnavailable(message) {
  return Object.assign(new Error(message), { error_code: "EGO_FRAME_UNAVAILABLE" });
}
function unregisterSessionAlias(sessionId) {
  const pageId = pageBySessionAlias.get(sessionId);
  if (!pageId) return;
  pageBySessionAlias.delete(sessionId);
  removeAliasFromPage(sessionId, pageId);
  const pending = pendingDialogsByPage.get(pageId);
  if (pending?.sourceSessionId === sessionId || !sessionAliasesByPage.has(pageId)) {
    pendingDialogsByPage.delete(pageId);
  }
}
function removeAliasFromPage(sessionId, pageId) {
  const aliases = sessionAliasesByPage.get(pageId);
  if (!aliases) return;
  aliases.delete(sessionId);
  if (aliases.size === 0) sessionAliasesByPage.delete(pageId);
}
function clearPageSessionAliases(pageId) {
  const aliases = sessionAliasesByPage.get(pageId);
  if (aliases) {
    for (const sessionId of aliases) pageBySessionAlias.delete(sessionId);
  }
  sessionAliasesByPage.delete(pageId);
  pendingDialogsByPage.delete(pageId);
}
async function enablePageEvents(sessionId) {
  if (!sessionId || pageEnabledSessions.has(sessionId)) {
    return;
  }
  try {
    await rawCdp("Page.enable", {}, sessionId);
    pageEnabledSessions.add(sessionId);
  } catch {
  }
}
function handleSendError(message, error_code, requestId = void 0) {
  if (pending.size === 0) return;
  const error = buildEgoError({ error: message, error_code });
  if (requestId !== void 0) {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    entry.reject(error);
    return;
  }
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) entry.reject(error);
}
function handleMessage(message) {
  let data;
  try {
    data = JSON.parse(message);
  } catch {
    return;
  }
  if (Object.hasOwn(data, "id")) {
    const entry = pending.get(data.id);
    if (!entry) {
      return;
    }
    pending.delete(data.id);
    if (data.error) {
      entry.reject(Object.assign(
        new Error(data.error.message || data.error),
        typeof data.error.error_code === "string" ? { error_code: data.error.error_code } : {}
      ));
      return;
    }
    entry.resolve(data);
    return;
  }
  if (data.method === "Target.detachedFromTarget" || data.method === "Target.targetDestroyed") {
    const sessionId = data.params?.sessionId || data.sessionId;
    if (sessionId) {
      pageEnabledSessions.delete(sessionId);
      unregisterSessionAlias(sessionId);
    }
    const targetId = data.params?.targetId || data.params?.targetInfo?.targetId;
    if (targetId && targetId === state.sessionTargetId) {
      invalidateSession();
    }
    if (data.method === "Target.targetDestroyed" && targetId) clearPageSessionAliases(targetId);
  }
  if (data.method === "Page.javascriptDialogOpening") {
    const sourceSessionId = data.sessionId || state.sessionId;
    const pageId = pageIdForSessionAlias(sourceSessionId);
    if (sourceSessionId && pageId) {
      pendingDialogsByPage.set(pageId, {
        ...(data.params || {}),
        generation: nextDialogGeneration++,
        pageId,
        sourceSessionId
      });
    }
  } else if (data.method === "Page.javascriptDialogClosed") {
    const sourceSessionId = data.sessionId || state.sessionId;
    const pageId = pageIdForSessionAlias(sourceSessionId);
    if (pageId) pendingDialogsByPage.delete(pageId);
  }
  events.push(data);
  if (events.length > MAX_BUFFERED_EVENTS) {
    events.splice(0, events.length - MAX_BUFFERED_EVENTS);
  }
  for (const waiter of [...eventWaiters]) {
    let matched = false;
    try {
      matched = waiter.predicate(data);
    } catch (error) {
      clearTimeout(waiter.timer);
      eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
      waiter.reject(error);
      continue;
    }
    if (!matched) continue;
    clearTimeout(waiter.timer);
    eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
    waiter.resolve(data);
  }
}
function browserSnapshotRefsToRefMap(refMap, snapshot = []) {
  const result = Array.isArray(snapshot) ? { refs: snapshot } : snapshot || {};
  const refs = result.refs || [];
  const refFormat = result.refFormat === "scoped-v1" ? "scoped-v1" : "native-v0";
  refMap.beginSnapshot(refFormat, result);
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") {
      continue;
    }
    if (ref.backendNodeId === void 0 || ref.backendNodeId === null) {
      continue;
    }
    if (refFormat === "scoped-v1") {
      if (!Number.isSafeInteger(ref.refId) || ref.refId <= 0 || typeof result.runtimeId !== "string" || !result.runtimeId) {
        throw Object.assign(new Error("Invalid scoped snapshot reference payload"), {
          error_code: "EGO_INVALID_RESULT_PAYLOAD"
        });
      }
      refMap.addScoped(String(ref.refId), {
        ...ref,
        pageId: ref.pageId ?? result.pageId,
        documentId: ref.documentId ?? result.documentId,
        documentEpoch: ref.documentEpoch ?? result.documentEpoch
      }, result.runtimeId);
    } else {
      refMap.add(
        String(ref.backendNodeId),
        ref.backendNodeId,
        ref.role,
        ref.name,
        void 0
      );
    }
  }
}
export {
  browserCdp,
  browserEgo,
  browserSnapshotRefsToRefMap,
  clearPendingDialog,
  clearPreferredTarget,
  drainBrowserEvents,
  ensureSession,
  getPageSessionAliases,
  invalidateSession,
  isBrowserRuntime,
  isSessionLostError,
  pendingDialog,
  pageIdForSessionAlias,
  registerPageSessionAlias,
  clearPageSessionAliases,
  setPreferredTarget,
  waitForBrowserEvent
};
