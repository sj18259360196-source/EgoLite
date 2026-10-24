import { state } from "../state.js";
import { cdp, runtimeValue } from "../cdp-eval.js";
import { resolveHandle, releaseHandle } from "./element-ops.js";
import { ElementResolutionError } from "../element-resolver.js";
import { waitForDocumentLoad } from "./load.js";
import { drainEvents } from "./observe.js";
import { ensureSession, getPageSessionAliases, pageIdForSessionAlias, waitForBrowserEvent } from "../browser-runtime.js";
import { parseRef } from "../ref-map.js";
import { browserRefMap, ensureRefMapForRef } from "../ref-state.js";
import { withScopedReferenceAction } from "../scoped-reference-context.js";
let networkEventUsers = 0;
let networkEnableInFlight = null;
async function waitForTimeout(ms = 1e3) {
  await state.sleep(ms);
}
async function waitForFunction(pageFunction, argOrOptions = void 0, options = {}) {
  const [arg, effectiveOptions] = normalizeWaitForFunctionArgs(
    arguments.length,
    argOrOptions,
    options
  );
  const timeout = effectiveOptions.timeout ?? state.defaultTimeout;
  const polling = effectiveOptions.polling ?? 100;
  const deadline = state.now() + timeout;
  const expression = buildWaitForFunctionExpression(pageFunction, arg);
  while (state.now() < deadline) {
    const response = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    const value = runtimeValue(response, expression);
    if (value) {
      return value;
    }
    await state.sleep(polling);
  }
  return false;
}
async function waitForURL(url, options = {}) {
  const timeout = options.timeout ?? state.defaultTimeout;
  const deadline = state.now() + timeout;
  while (state.now() < deadline) {
    const current = runtimeValue(
      await cdp("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
        awaitPromise: false
      }),
      "location.href"
    );
    if (urlMatches(current, url)) {
      const waitUntil = options.waitUntil ?? "load";
      return waitUntil === "commit" || current === "about:blank" && waitUntil !== "networkidle" ? true : waitForLoadState(waitUntil, {
        timeout: Math.max(0, deadline - state.now())
      });
    }
    await state.sleep(100);
  }
  return false;
}
async function waitForRequest(urlOrPredicate, options = {}) {
  return waitForNetworkMatch("request", urlOrPredicate, options);
}
async function waitForResponse(urlOrPredicate, options = {}) {
  return waitForNetworkMatch("response", urlOrPredicate, options);
}
async function waitForLoadState(loadState = "load", options = {}) {
  const [stateName, effectiveOptions] = normalizeLoadStateArgs(
    loadState,
    options
  );
  if (stateName === "networkidle") {
    return waitForNetworkIdle(effectiveOptions);
  }
  return waitForDocumentLoad({
    timeout: effectiveOptions.timeout,
    until: stateName === "domcontentloaded" ? "domcontentloaded" : "load"
  });
}
function normalizeLoadStateArgs(loadState, options) {
  if (loadState && typeof loadState === "object") {
    return ["load", loadState];
  }
  return [loadState || "load", options];
}
function normalizeWaitForFunctionArgs(length, argOrOptions, options) {
  if (length >= 3) {
    return [argOrOptions, options];
  }
  if (isWaitForFunctionOptions(argOrOptions)) {
    return [void 0, argOrOptions];
  }
  return [argOrOptions, {}];
}
function isWaitForFunctionOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return "timeout" in value || "polling" in value;
}
function buildWaitForFunctionExpression(pageFunction, arg) {
  if (typeof pageFunction === "function") {
    return `(${pageFunction.toString()})(${JSON.stringify(arg)})`;
  }
  if (typeof pageFunction !== "string") {
    throw new TypeError(
      `waitForFunction expects a string expression or function, got ${pageFunction === null ? "null" : typeof pageFunction}`
    );
  }
  return `(${pageFunction})`;
}
function urlMatches(current, matcher) {
  if (matcher instanceof RegExp) {
    return matcher.test(current);
  }
  if (typeof matcher === "function") {
    return Boolean(matcher(new URL(current)));
  }
  if (typeof matcher !== "string") {
    throw new TypeError(
      `waitForURL expects a string, RegExp, or function matcher, got ${matcher === null ? "null" : typeof matcher}`
    );
  }
  if (matcher.includes("*")) {
    return globToRegExp(matcher).test(current);
  }
  return current === matcher;
}
function globToRegExp(glob) {
  let source = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}
async function waitForNetworkMatch(kind, matcher, options) {
  const timeout = networkTimeout(options);
  const requests = /* @__PURE__ */ new Map();
  const scoped = browserRefMap.isScopedMode();
  const pageSessions = scoped ? await getPageSessionAliases(await ensureSession()) : null;
  const networkEvents = acquireNetworkEvents(pageSessions);
  let matched;
  try {
    await networkEvents.ready;
    const sessionId = state.sessionId;
    const expectedAliases = pageSessions ? new Set(pageSessions.sessionIds) : null;
    await waitForBrowserEvent((event) => {
      const sourceSessionId = event?.sessionId ?? (scoped ? void 0 : sessionId);
      if (pageSessions) {
        if (!expectedAliases.has(sourceSessionId) || pageIdForSessionAlias(sourceSessionId) !== pageSessions.pageId) return false;
      } else {
        if (sessionId && event?.sessionId && event.sessionId !== sessionId) return false;
      }
      matched = processNetworkEvent(kind, matcher, event, requests, timeout, {
        sessionId: sourceSessionId,
        pageId: pageSessions?.pageId ?? pageIdForSessionAlias(sourceSessionId)
      });
      return Boolean(matched);
    }, browserEventTimeout(timeout));
    return matched;
  } catch (error) {
    if (/page\.waitForEvent timed out/i.test(error?.message || "")) {
      throw new Error(
        `page.waitFor${kind === "request" ? "Request" : "Response"} timed out after ${timeout}ms`
      );
    }
    throw error;
  } finally {
    await networkEvents.release();
  }
}
function processNetworkEvent(kind, matcher, event, requests, timeout, source) {
  const method = event?.method;
  const params = event?.params || {};
  const requestKey = JSON.stringify([source.sessionId ?? null, params.requestId]);
  if (method === "Network.requestWillBeSent") {
    const previousRequest = requests.get(requestKey);
    if (kind === "response" && params.redirectResponse) {
      const response = createResponseFacade(
        {
          requestId: params.requestId,
          ...source,
          response: params.redirectResponse,
          request: previousRequest
        },
        timeout
      );
      if (networkMatches(response, matcher, kind)) {
        return response;
      }
    }
    const request = createRequestInfo(params);
    requests.set(requestKey, request);
    if (kind === "request") {
      const facade = createRequestFacade(request);
      if (networkMatches(facade, matcher, kind)) {
        return facade;
      }
    }
    return null;
  }
  if (kind === "response" && method === "Network.responseReceived") {
    const response = createResponseFacade(
      {
        requestId: params.requestId,
        ...source,
        response: params.response || {},
        request: requests.get(requestKey)
      },
      timeout
    );
    if (networkMatches(response, matcher, kind)) {
      return response;
    }
  }
  return null;
}
function networkMatches(facade, matcher, kind) {
  if (typeof matcher === "string") {
    return facade.url() === matcher;
  }
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(facade.url());
  }
  if (typeof matcher === "function") {
    const result = matcher(facade);
    if (result && typeof result.then === "function") {
      throw new Error(
        `page.waitFor${kind === "request" ? "Request" : "Response"} does not support async predicates`
      );
    }
    return Boolean(result);
  }
  throw new TypeError(
    `page.waitFor${kind === "request" ? "Request" : "Response"} expects a string, RegExp, or function matcher, got ${matcher === null ? "null" : typeof matcher}`
  );
}
function createRequestInfo(params) {
  const request = params.request || {};
  return {
    requestId: params.requestId,
    url: request.url || "",
    method: request.method || "",
    headers: normalizeHeaders(request.headers),
    postData: request.postData ?? null,
    resourceType: String(params.type || "").toLowerCase()
  };
}
function createRequestFacade(info) {
  return {
    url: () => info.url,
    method: () => info.method,
    headers: () => ({ ...info.headers }),
    postData: () => info.postData,
    resourceType: () => info.resourceType
  };
}
function createResponseFacade(info, timeout) {
  const response = info.response || {};
  const request = info.request || createRequestInfo({
    requestId: info.requestId,
    request: {
      url: response.url || "",
      method: "",
      headers: response.requestHeaders || {}
    },
    type: response.type
  });
  const status = Number(response.status || 0);
  const headers = normalizeHeaders(response.headers);
  const facade = {
    url: () => response.url || request.url || "",
    status: () => status,
    statusText: () => response.statusText || "",
    ok: () => status >= 200 && status <= 299,
    headers: () => ({ ...headers }),
    request: () => createRequestFacade(request),
    body: async () => {
      const body = await readResponseBody(info.requestId, timeout, info);
      return body.base64Encoded ? Buffer.from(body.body || "", "base64") : Buffer.from(body.body || "", "utf8");
    },
    text: async () => {
      const body = await readResponseBody(info.requestId, timeout, info);
      return body.base64Encoded ? Buffer.from(body.body || "", "base64").toString("utf8") : body.body || "";
    }
  };
  facade.json = async () => JSON.parse(await facade.text());
  return facade;
}
async function readResponseBody(requestId, timeout, source) {
  if (!requestId) {
    throw new Error("response body is unavailable without a requestId");
  }
  const deadline = state.now() + timeout;
  let lastError;
  while (state.now() <= deadline) {
    if (source.pageId && pageIdForSessionAlias(source.sessionId) !== source.pageId) {
      throw Object.assign(new Error("Response source session is unavailable"), { error_code: "EGO_FRAME_UNAVAILABLE" });
    }
    try {
      return await cdp("Network.getResponseBody", { requestId }, source.sessionId);
    } catch (error) {
      if (error?.error_code) throw error;
      lastError = error;
      await state.sleep(Math.min(50, Math.max(0, deadline - state.now())));
    }
  }
  throw new Error(
    `response body is unavailable for request ${requestId}: ${lastError?.message || lastError}`
  );
}
function normalizeHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[String(name).toLowerCase()] = String(value);
  }
  return out;
}
function networkTimeout(options) {
  const timeout = options.timeout ?? state.defaultTimeout;
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new Error("network wait timeout must be a non-negative number");
  }
  return timeout;
}
function browserEventTimeout(timeout) {
  return timeout === 0 ? 2147483647 : Math.min(timeout, 2147483647);
}
function acquireNetworkEvents(pageSessions = null) {
  if (pageSessions) {
    return {
      ready: Promise.all(pageSessions.sessionIds.map((sessionId) => {
        if (pageIdForSessionAlias(sessionId) !== pageSessions.pageId) {
          throw Object.assign(new Error("Network source session is unavailable"), { error_code: "EGO_FRAME_UNAVAILABLE" });
        }
        return cdp("Network.enable", {}, sessionId);
      })),
      release: async () => {}
    };
  }
  if (networkEventUsers === 0) {
    networkEnableInFlight = cdp("Network.enable").catch(() => {
    }).finally(() => {
      networkEnableInFlight = null;
    });
  }
  networkEventUsers += 1;
  let released = false;
  return {
    ready: networkEnableInFlight || Promise.resolve(),
    release: async () => {
      if (released) return;
      released = true;
      networkEventUsers = Math.max(0, networkEventUsers - 1);
      if (networkEventUsers > 0) return;
      if (networkEnableInFlight) {
        await networkEnableInFlight;
      }
    }
  };
}
async function waitForSelector(selector, options = {}) {
  const timeout = options.timeout ?? state.defaultTimeout;
  const wantedState = options.state ?? "attached";
  if (!["attached", "visible", "hidden", "detached"].includes(wantedState)) {
    throw new Error(`waitForSelector: unsupported state ${JSON.stringify(wantedState)}`);
  }
  const refId = parseRef(selector);
  if (refId) {
    await ensureRefMapForRef(selector);
    if (browserRefMap.get(refId)?.refFormat === "scoped-v1") {
      return waitForScopedRef(selector, wantedState, timeout);
    }
  }
  if (wantedState === "detached" && parseRef(selector)) {
    return waitForRefDetached(selector, timeout);
  }
  const deadline = state.now() + timeout;
  const visibilityFn = "function(){if(typeof this.checkVisibility==='function')return this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});const s=getComputedStyle(this);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}";
  do {
    let handle;
    try {
      handle = await resolveHandle(selector);
    } catch (err) {
      if (err instanceof ElementResolutionError && err.kind === "transient") {
        if (wantedState === "hidden" || wantedState === "detached") return true;
        await state.sleep(300);
        continue;
      }
      throw err;
    }
    try {
      if (wantedState === "attached") return true;
      if (wantedState === "detached") {
        await state.sleep(300);
        continue;
      }
      const response = await cdp(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: visibilityFn,
          objectId: handle.objectId,
          returnByValue: true,
          awaitPromise: false
        },
        handle.sessionId
      );
      const visible = Boolean(response.result?.value);
      if (wantedState === "visible" ? visible : !visible) return true;
    } catch {
    } finally {
      await releaseHandle(handle.objectId, handle.sessionId);
    }
    await state.sleep(300);
  } while (state.now() < deadline);
  return false;
}
async function waitForScopedRef(selector, wantedState, timeout) {
  const deadline = state.now() + timeout;
  const visibilityFn = "function(){if(typeof this.checkVisibility==='function')return this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});const s=getComputedStyle(this);return this.isConnected===true&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}";
  do {
    try {
      const matched = await withScopedReferenceAction(selector, 0, async () => {
        const handle = await resolveHandle(selector);
        try {
          if (wantedState === "attached") return true;
          const response = await cdp(
            "Runtime.callFunctionOn",
            {
              functionDeclaration: visibilityFn,
              objectId: handle.objectId,
              returnByValue: true,
              awaitPromise: false
            },
            handle.sessionId
          );
          const visible = Boolean(response.result?.value);
          return wantedState === "visible" ? visible : wantedState === "hidden" ? !visible : false;
        } finally {
          await releaseHandle(handle.objectId, handle.sessionId);
        }
      });
      if (matched) return true;
    } catch (error) {
      if (error?.error_code === "EGO_REFERENCE_DETACHED") {
        if (wantedState === "detached" || wantedState === "hidden") return true;
      }
      throw error;
    }
    await state.sleep(wantedState === "detached" ? 100 : 300);
  } while (state.now() < deadline);
  return false;
}
async function waitForRefDetached(selector, timeout) {
  let handle;
  try {
    handle = await resolveHandle(selector);
  } catch (error) {
    if (error instanceof ElementResolutionError && error.kind === "transient") return true;
    throw error;
  }
  const deadline = state.now() + timeout;
  try {
    do {
      try {
        const response = await cdp(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: "function(){return Boolean(this.isConnected);}",
            objectId: handle.objectId,
            returnByValue: true,
            awaitPromise: false
          },
          handle.sessionId
        );
        if (!response.result?.value) return true;
      } catch {
        return true;
      }
      await state.sleep(100);
    } while (state.now() < deadline);
    return false;
  } finally {
    await releaseHandle(handle.objectId, handle.sessionId);
  }
}
async function waitForNetworkIdle(options = {}) {
  const timeout = options.timeout ?? 1e4;
  const idleMs = options.idleMs ?? 500;
  const deadline = state.now() + timeout;
  let lastActivity = state.now();
  const inflight = /* @__PURE__ */ new Set();
  const networkEvents = acquireNetworkEvents();
  await networkEvents.ready;
  try {
    while (state.now() < deadline) {
      for (const event of await drainEvents()) {
        const method = event.method || "";
        const params = event.params || {};
        if (method === "Network.requestWillBeSent") {
          inflight.add(params.requestId);
          lastActivity = state.now();
        } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
          inflight.delete(params.requestId);
          lastActivity = state.now();
        } else if (method.startsWith("Network.")) {
          lastActivity = state.now();
        }
      }
      if (inflight.size === 0 && state.now() - lastActivity >= idleMs) {
        return true;
      }
      await state.sleep(100);
    }
    return false;
  } finally {
    await networkEvents.release();
  }
}
export {
  waitForFunction,
  waitForLoadState,
  waitForRequest,
  waitForResponse,
  waitForSelector,
  waitForTimeout,
  waitForURL
};
