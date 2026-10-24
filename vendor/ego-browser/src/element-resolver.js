import { parseRef } from "./ref-map.js";
import { queryAllExpression } from "./locator-query.js";
import { scopedBindingForRef } from "./scoped-reference-context.js";
class ElementResolutionError extends Error {
  kind;
  constructor(message, kind) {
    super(message);
    this.name = "ElementResolutionError";
    this.kind = kind;
  }
}
async function queryRoleLocatorBackendNodeIds(cdp, sessionId, selectorOrRef) {
  const locator = parseLocator(selectorOrRef);
  if (locator?.kind !== "role") {
    return null;
  }
  const backendNodeIds = await findBackendNodeIdsByRoleName(
    cdp,
    sessionId,
    locator.role,
    locator.name
  );
  const nth = locator.nth;
  if (nth === void 0) {
    return backendNodeIds;
  }
  const nthIndex = nth === "last" ? backendNodeIds.length - 1 : nth;
  const backendNodeId = backendNodeIds[nthIndex];
  return backendNodeId === void 0 ? [] : [backendNodeId];
}
function exceptionText(result) {
  const d = result?.exceptionDetails;
  return d?.exception?.description || d?.text || "evaluation error";
}
function matchCountKind(message) {
  const m = /matched (\d+)/.exec(message);
  const n = m ? Number(m[1]) : 0;
  return n > 1 ? "permanent" : "transient";
}
function selectorResolutionError(selector, result) {
  const message = exceptionText(result);
  if (/\bmatched \d+ elements\b/.test(message)) {
    return new ElementResolutionError(message, matchCountKind(message));
  }
  return new ElementResolutionError(
    `Invalid selector: ${selector}: ${message}`,
    "permanent"
  );
}
async function resolveElementCenter(cdp, sessionId, refMap, selectorOrRef, iframeSessions = /* @__PURE__ */ new Map()) {
  const refId = parseRef(selectorOrRef);
  if (refId) {
    const entry = refMap.get(refId);
    if (!entry) {
      throw new ElementResolutionError(`Unknown ref: ${refId}`, "transient");
    }
    const scopedBinding = scopedBindingForRef(refId, entry);
    const effectiveSessionId = scopedBinding?.sessionId ?? resolveFrameSession(
      entry.frameId,
      sessionId,
      iframeSessions
    );
    if (scopedBinding) {
      try {
        await send(
          cdp,
          "DOM.scrollIntoViewIfNeeded",
          { backendNodeId: scopedBinding.backendNodeId },
          effectiveSessionId
        );
        const result3 = await send(
          cdp,
          "DOM.getBoxModel",
          { backendNodeId: scopedBinding.backendNodeId },
          effectiveSessionId
        );
        return {
          ...boxModelCenter(result3.model),
          sessionId: effectiveSessionId
        };
      } catch (error) {
        throw scopedResolutionError(refId, error);
      }
    }
    if (entry.backendNodeId !== void 0 && entry.backendNodeId !== null) {
      try {
        const result3 = await send(
          cdp,
          "DOM.getBoxModel",
          { backendNodeId: entry.backendNodeId },
          effectiveSessionId
        );
        return {
          ...boxModelCenter(result3.model),
          sessionId: effectiveSessionId
        };
      } catch (error) {
        if (error instanceof ElementResolutionError) {
          throw error;
        }
      }
    }
    const backendNodeId = await findBackendNodeIdByRoleName(
      cdp,
      sessionId,
      entry.role,
      entry.name,
      entry.nth,
      entry.frameId,
      iframeSessions
    );
    const result2 = await send(
      cdp,
      "DOM.getBoxModel",
      { backendNodeId },
      effectiveSessionId
    );
    return { ...boxModelCenter(result2.model), sessionId: effectiveSessionId };
  }
  const locator = parseLocator(selectorOrRef);
  if (locator) {
    return resolveLocatorCenter(cdp, sessionId, locator);
  }
  const result = await send(
    cdp,
    "Runtime.evaluate",
    {
      expression: buildSelectorCenterJs(selectorOrRef),
      returnByValue: true,
      awaitPromise: false
    },
    sessionId
  );
  if (result.exceptionDetails) {
    throw selectorResolutionError(selectorOrRef, result);
  }
  const value = result.result?.value;
  if (typeof value?.x !== "number" || typeof value?.y !== "number") {
    throw new ElementResolutionError(
      `Element not found: ${selectorOrRef}`,
      "transient"
    );
  }
  return { x: value.x, y: value.y, sessionId };
}
async function resolveElementObjectId(cdp, sessionId, refMap, selectorOrRef, iframeSessions = /* @__PURE__ */ new Map()) {
  const refId = parseRef(selectorOrRef);
  if (refId) {
    const entry = refMap.get(refId);
    if (!entry) {
      throw new ElementResolutionError(`Unknown ref: ${refId}`, "transient");
    }
    const scopedBinding = scopedBindingForRef(refId, entry);
    const effectiveSessionId = scopedBinding?.sessionId ?? resolveFrameSession(
      entry.frameId,
      sessionId,
      iframeSessions
    );
    if (scopedBinding) {
      try {
        const result3 = await send(
          cdp,
          "DOM.resolveNode",
          {
            backendNodeId: scopedBinding.backendNodeId,
            objectGroup: "ego-browser"
          },
          effectiveSessionId
        );
        const objectId3 = result3.object?.objectId;
        if (!objectId3) throw new Error(`No objectId for ref ${refId}`);
        return { objectId: objectId3, sessionId: effectiveSessionId };
      } catch (error) {
        throw scopedResolutionError(refId, error);
      }
    }
    if (entry.backendNodeId !== void 0 && entry.backendNodeId !== null) {
      try {
        const result3 = await send(
          cdp,
          "DOM.resolveNode",
          {
            backendNodeId: entry.backendNodeId,
            objectGroup: "ego-browser"
          },
          effectiveSessionId
        );
        const objectId3 = result3.object?.objectId;
        if (objectId3) {
          return { objectId: objectId3, sessionId: effectiveSessionId };
        }
      } catch {
      }
    }
    const backendNodeId = await findBackendNodeIdByRoleName(
      cdp,
      sessionId,
      entry.role,
      entry.name,
      entry.nth,
      entry.frameId,
      iframeSessions
    );
    const result2 = await send(
      cdp,
      "DOM.resolveNode",
      { backendNodeId, objectGroup: "ego-browser" },
      effectiveSessionId
    );
    const objectId2 = result2.object?.objectId;
    if (!objectId2) {
      throw new ElementResolutionError(
        `No objectId for ref ${refId}`,
        "permanent"
      );
    }
    return { objectId: objectId2, sessionId: effectiveSessionId };
  }
  const locator = parseLocator(selectorOrRef);
  if (locator) {
    return resolveLocatorObjectId(cdp, sessionId, locator);
  }
  const result = await send(
    cdp,
    "Runtime.evaluate",
    {
      expression: buildFindElementJs(selectorOrRef),
      returnByValue: false,
      awaitPromise: false,
      objectGroup: "ego-browser"
    },
    sessionId
  );
  if (result.exceptionDetails) {
    throw selectorResolutionError(selectorOrRef, result);
  }
  const objectId = result.result?.objectId;
  if (!objectId) {
    throw new ElementResolutionError(
      `Element not found: ${selectorOrRef}`,
      "transient"
    );
  }
  return { objectId, sessionId };
}
function scopedResolutionError(refId, cause) {
  if (cause && typeof cause === "object" && typeof cause.error_code === "string") {
    return cause;
  }
  return Object.assign(new ElementResolutionError(`Scoped ref ${refId} is stale`, "permanent"), {
    error_code: "EGO_REFERENCE_STALE",
    cause
  });
}
function resolveFrameSession(frameId, sessionId, iframeSessions) {
  if (!frameId) {
    return sessionId;
  }
  if (iframeSessions instanceof Map) {
    return iframeSessions.get(frameId) || sessionId;
  }
  return iframeSessions?.[frameId] || sessionId;
}
async function resolveLocatorCenter(cdp, sessionId, locator) {
  if (locator.kind === "role") {
    const backendNodeId = locator.nth === void 0 ? await findUniqueBackendNodeIdByRoleName(
      cdp,
      sessionId,
      locator.role,
      locator.name
    ) : await findBackendNodeIdByRoleName(
      cdp,
      sessionId,
      locator.role,
      locator.name,
      locator.nth
    );
    const result2 = await send(
      cdp,
      "DOM.getBoxModel",
      { backendNodeId },
      sessionId
    );
    return { ...boxModelCenter(result2.model), sessionId };
  }
  const result = await send(
    cdp,
    "Runtime.evaluate",
    {
      expression: buildLocatorCenterJs(locator),
      returnByValue: true,
      awaitPromise: false
    },
    sessionId
  );
  if (result.exceptionDetails) {
    throw new ElementResolutionError(
      `Invalid selector: ${locator.raw}: ${exceptionText(result)}`,
      "permanent"
    );
  }
  const value = result.result?.value;
  if (value?.error) {
    throw new ElementResolutionError(value.error, matchCountKind(value.error));
  }
  if (typeof value?.x !== "number" || typeof value?.y !== "number") {
    throw new ElementResolutionError(
      `Element not found: ${locator.raw}`,
      "transient"
    );
  }
  return { x: value.x, y: value.y, sessionId };
}
async function resolveLocatorObjectId(cdp, sessionId, locator) {
  if (locator.kind === "role") {
    const backendNodeId = locator.nth === void 0 ? await findUniqueBackendNodeIdByRoleName(
      cdp,
      sessionId,
      locator.role,
      locator.name
    ) : await findBackendNodeIdByRoleName(
      cdp,
      sessionId,
      locator.role,
      locator.name,
      locator.nth
    );
    const result2 = await send(
      cdp,
      "DOM.resolveNode",
      { backendNodeId, objectGroup: "ego-browser" },
      sessionId
    );
    const objectId2 = result2.object?.objectId;
    if (!objectId2) {
      throw new ElementResolutionError(
        `No objectId for locator ${locator.raw}`,
        "permanent"
      );
    }
    return { objectId: objectId2, sessionId };
  }
  const count = await locatorCount(cdp, sessionId, locator);
  if (count === 0) {
    throw new ElementResolutionError(
      `Locator ${locator.raw} matched 0 elements`,
      "transient"
    );
  }
  if (typeof locator.nth === "number" && count <= locator.nth) {
    throw new ElementResolutionError(
      `Locator ${locator.raw} matched 0 elements`,
      "transient"
    );
  }
  if (locator.nth === void 0 && count > 1) {
    throw new ElementResolutionError(
      `Locator ${locator.raw} matched ${count} elements`,
      "permanent"
    );
  }
  const result = await send(
    cdp,
    "Runtime.evaluate",
    {
      expression: buildLocatorFindJs(locator),
      returnByValue: false,
      awaitPromise: false,
      objectGroup: "ego-browser"
    },
    sessionId
  );
  const objectId = result.result?.objectId;
  if (!objectId) {
    throw new ElementResolutionError(
      `Element not found: ${locator.raw}`,
      "transient"
    );
  }
  return { objectId, sessionId };
}
async function locatorCount(cdp, sessionId, locator) {
  const result = await send(
    cdp,
    "Runtime.evaluate",
    {
      expression: buildLocatorCountJs(locator),
      returnByValue: true,
      awaitPromise: false
    },
    sessionId
  );
  if (result.exceptionDetails) {
    throw new ElementResolutionError(
      `Invalid selector: ${locator.raw}: ${exceptionText(result)}`,
      "permanent"
    );
  }
  return Number(result.result?.value || 0);
}
async function findBackendNodeIdByRoleName(cdp, sessionId, role, name, nth = void 0, frameId = void 0, iframeSessions = /* @__PURE__ */ new Map()) {
  const matches = await findBackendNodeIdsByRoleName(
    cdp,
    sessionId,
    role,
    name,
    frameId,
    iframeSessions
  );
  const nthIndex = nth === "last" ? matches.length - 1 : nth ?? 0;
  const match = matches[nthIndex];
  if (match !== void 0) {
    return match;
  }
  throw new ElementResolutionError(
    `Could not locate element with role=${role} name=${name}`,
    "transient"
  );
}
async function findBackendNodeIdsByRoleName(cdp, sessionId, role, name, frameId = void 0, iframeSessions = /* @__PURE__ */ new Map()) {
  const [params, effectiveSessionId] = resolveAxSession(
    frameId,
    sessionId,
    iframeSessions
  );
  const result = await send(
    cdp,
    "Accessibility.getFullAXTree",
    params,
    effectiveSessionId
  );
  const matches = [];
  for (const node of result.nodes || []) {
    if (node.ignored) {
      continue;
    }
    if (extractAxString(node.role) !== role) {
      continue;
    }
    if (name !== void 0 && !axNameMatches(extractAxString(node.name), name)) {
      continue;
    }
    const backendNodeId = node.backendDOMNodeId;
    if (backendNodeId === void 0 || backendNodeId === null) {
      throw new ElementResolutionError(
        `AX node has no backendDOMNodeId for role=${role} name=${name}`,
        "permanent"
      );
    }
    matches.push(backendNodeId);
  }
  return matches;
}
async function findUniqueBackendNodeIdByRoleName(cdp, sessionId, role, name) {
  const matches = await findBackendNodeIdsByRoleName(
    cdp,
    sessionId,
    role,
    name
  );
  if (matches.length === 0) {
    throw new ElementResolutionError(
      `Locator role:${role}[name=${JSON.stringify(name)}] matched 0 elements`,
      "transient"
    );
  }
  if (matches.length > 1) {
    throw new ElementResolutionError(
      `Locator role:${role}[name=${JSON.stringify(name)}] matched ${matches.length} elements`,
      "permanent"
    );
  }
  return matches[0];
}
function resolveAxSession(frameId, sessionId, iframeSessions) {
  if (!frameId) {
    return [{}, sessionId];
  }
  const iframeSession = iframeSessions instanceof Map ? iframeSessions.get(frameId) : iframeSessions?.[frameId];
  if (iframeSession) {
    return [{}, iframeSession];
  }
  return [{ frameId }, sessionId];
}
function buildFindElementJs(selector) {
  const matchError = JSON.stringify(`Locator ${String(selector)} matched `);
  return `(() => {
    const elements = ${queryAllExpression(selector)};
    if (elements.length > 1) throw new Error(${matchError} + elements.length + ' elements');
    return elements[0] || null;
  })()`;
}
function buildLocatorFindJs(locator) {
  if (locator.kind === "query") {
    return `(() => {
      const elements = ${queryAllExpression(locator.selector)};
      return elements[${locator.nth === "last" ? "elements.length - 1" : JSON.stringify(locator.nth ?? 0)}] || null;
    })()`;
  }
  if (locator.kind === "css") {
    const selector = `loc=css:${locator.selector}`;
    if (locator.nth !== void 0) {
      return `(() => {
        const elements = ${queryAllExpression(selector)};
        return elements[${locator.nth === "last" ? "elements.length - 1" : JSON.stringify(locator.nth)}] || null;
      })()`;
    }
    return `(() => ${queryAllExpression(selector)}[0] || null)()`;
  }
  if (locator.kind === "xpath") {
    return `(() => {
      const snapshot = document.evaluate(${JSON.stringify(locator.xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return snapshot.snapshotItem(${locator.nth === "last" ? "snapshot.snapshotLength - 1" : JSON.stringify(locator.nth ?? 0)});
    })()`;
  }
  if (locator.kind === "text" || locator.kind === "label" || locator.kind === "placeholder" || locator.kind === "alt" || locator.kind === "title" || locator.kind === "testid") {
    return `(() => {
      const elements = ${buildLocatorAllJs(locator)};
      return elements[${locator.nth === "last" ? "elements.length - 1" : JSON.stringify(locator.nth ?? 0)}] || null;
    })()`;
  }
  return locator.nth === "last" ? `(() => ${hrefElementsJs(locator.href)}.at(-1) || null)()` : `(() => ${hrefElementsJs(locator.href)}[${JSON.stringify(locator.nth ?? 0)}] || null)()`;
}
function buildLocatorCountJs(locator) {
  if (locator.kind === "query") {
    return `(() => ${queryAllExpression(locator.selector)}.length)()`;
  }
  if (locator.kind === "css") {
    return `(() => ${queryAllExpression(`loc=css:${locator.selector}`)}.length)()`;
  }
  if (locator.kind === "xpath") {
    return `(() => document.evaluate(${JSON.stringify(locator.xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength)()`;
  }
  if (locator.kind === "text" || locator.kind === "label" || locator.kind === "placeholder" || locator.kind === "alt" || locator.kind === "title" || locator.kind === "testid") {
    return `(() => ${buildLocatorAllJs(locator)}.length)()`;
  }
  return `(() => ${hrefElementsJs(locator.href)}.length)()`;
}
function buildLocatorCenterJs(locator) {
  if (locator.nth !== void 0) {
    return `(() => {
            const el = ${buildLocatorFindJs(locator)};
            if (!el) return { error: ${JSON.stringify(`Locator ${locator.raw} matched 0 elements`)} };
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`;
  }
  return `(() => {
            const count = ${buildLocatorCountJs(locator)};
            if (count !== 1) return { error: ${JSON.stringify(`Locator ${locator.raw} matched`)} + ' ' + count + ' elements' };
            const el = ${buildLocatorFindJs(locator)};
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`;
}
function hrefElementsJs(href) {
  return `Array.from(document.querySelectorAll('a[href]')).filter((el) => {
            try {
              const u = new URL(el.href, location.href);
              const path = u.pathname + u.search + u.hash;
              return path === ${JSON.stringify(href)} || u.href === ${JSON.stringify(href)};
            } catch {
              return false;
            }
          })`;
}
function buildLocatorAllJs(locator) {
  if (locator.kind === "text") {
    return textElementsJs(locator);
  }
  if (locator.kind === "label") {
    return labelElementsJs(locator);
  }
  if (locator.kind === "placeholder") {
    return attributeElementsJs(
      "input[placeholder], textarea[placeholder]",
      "placeholder",
      locator
    );
  }
  if (locator.kind === "alt") {
    return attributeElementsJs("img[alt], input[alt]", "alt", locator);
  }
  if (locator.kind === "title") {
    return attributeElementsJs("[title]", "title", locator);
  }
  if (locator.kind === "testid") {
    return attributeElementsJs("[data-testid]", "data-testid", locator);
  }
  throw new Error(`unsupported locator kind: ${locator.kind}`);
}
function textElementsJs(locator) {
  const match = textMatchJs(
    "el.innerText || el.textContent",
    locator.text,
    locator.exact
  );
  const childMatch = textMatchJs(
    "child.innerText || child.textContent",
    locator.text,
    locator.exact
  );
  return `Array.from(document.querySelectorAll('body *')).filter((el) => {
            if (!(${match})) return false;
            return !Array.from(el.children || []).some((child) => ${childMatch});
          })`;
}
function labelElementsJs(locator) {
  const labelMatch = textMatchJs(
    "label.innerText || label.textContent",
    locator.text,
    locator.exact
  );
  const ariaMatch = textMatchJs(
    "el.getAttribute('aria-label')",
    locator.text,
    locator.exact
  );
  const labelledByMatch = textMatchJs(
    "labelledBy",
    locator.text,
    locator.exact
  );
  return `(() => {
            const controls = [];
            for (const label of document.querySelectorAll('label')) {
              if (!(${labelMatch})) continue;
              const control = label.control || (label.getAttribute('for') ? document.getElementById(label.getAttribute('for')) : null);
              if (control) controls.push(control);
            }
            for (const el of document.querySelectorAll('input, textarea, select, button, [role]')) {
              if (el.getAttribute('aria-label') && ${ariaMatch}) controls.push(el);
              const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
              if (ids.length) {
                const labelledBy = ids.map((id) => document.getElementById(id)?.textContent || '').join(' ');
                if (${labelledByMatch}) controls.push(el);
              }
            }
            return Array.from(new Set(controls));
          })()`;
}
function attributeElementsJs(selector, attribute, locator) {
  const match = textMatchJs(
    `el.getAttribute(${JSON.stringify(attribute)})`,
    locator.text,
    locator.exact
  );
  return `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter((el) => ${match})`;
}
function textMatchJs(valueExpression, text, exact) {
  const needle = JSON.stringify(String(text).replace(/\s+/g, " ").trim());
  const normalized = `String(${valueExpression} || '').replace(/\\s+/g, ' ').trim()`;
  return exact ? `${normalized} === ${needle}` : `${normalized}.includes(${needle})`;
}
function buildSelectorCenterJs(selector) {
  const findExpr = buildFindElementJs(selector);
  return `(() => {
            const el = ${findExpr};
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`;
}
function parseLocator(input) {
  let value = String(input || "").trim();
  let nth;
  const nthMatch = /^internal:nth=(\d+);([\s\S]+)$/.exec(value);
  if (nthMatch) {
    nth = Number(nthMatch[1]);
    value = nthMatch[2];
  }
  const lastMatch = /^internal:last;([\s\S]+)$/.exec(value);
  if (lastMatch) {
    nth = "last";
    value = lastMatch[1];
  }
  if (value.startsWith("internal:scope:") || value.startsWith("internal:filter:")) {
    return { kind: "query", selector: value, raw: value, nth };
  }
  if (value.startsWith("loc=")) {
    value = value.slice(4);
  }
  if (value.startsWith("css:")) {
    const selector = value.slice(4);
    return selector ? { kind: "css", selector, raw: value, nth } : null;
  }
  if (value.startsWith("href:")) {
    const href = value.slice(5);
    return href ? { kind: "href", href, raw: value, nth } : null;
  }
  if (value.startsWith("text:")) {
    return {
      kind: "text",
      ...parseTextLocator(value.slice(5)),
      raw: value,
      nth
    };
  }
  if (value.startsWith("text=")) {
    return {
      kind: "text",
      text: value.slice(5),
      exact: false,
      raw: value,
      nth
    };
  }
  if (value.startsWith("label:")) {
    return {
      kind: "label",
      ...parseTextLocator(value.slice(6)),
      raw: value,
      nth
    };
  }
  if (value.startsWith("placeholder:")) {
    return {
      kind: "placeholder",
      ...parseTextLocator(value.slice(12)),
      raw: value,
      nth
    };
  }
  if (value.startsWith("alt:")) {
    return {
      kind: "alt",
      ...parseTextLocator(value.slice(4)),
      raw: value,
      nth
    };
  }
  if (value.startsWith("title:")) {
    return {
      kind: "title",
      ...parseTextLocator(value.slice(6)),
      raw: value,
      nth
    };
  }
  if (value.startsWith("testid:")) {
    return {
      kind: "testid",
      ...parseTextLocator(value.slice(7)),
      raw: value,
      nth
    };
  }
  const roleMatch = /^role:([A-Za-z0-9_-]+)(?:\[name=(.+)\])?$/.exec(value);
  if (roleMatch) {
    return {
      kind: "role",
      role: roleMatch[1],
      name: roleMatch[2] === void 0 ? void 0 : parseLocatorName(roleMatch[2]),
      raw: value,
      nth
    };
  }
  if (nth !== void 0) {
    if (value.startsWith("xpath=")) {
      return { kind: "xpath", xpath: value.slice(6), raw: value, nth };
    }
    return { kind: "css", selector: value, raw: value, nth };
  }
  return null;
}
function parseLocatorName(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isTextMatcher(parsed)) {
        return parsed;
      }
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
function parseTextLocator(raw) {
  if (raw.startsWith("exact:")) {
    return { text: parseLocatorName(raw.slice(6)), exact: true };
  }
  return { text: parseLocatorName(raw), exact: false };
}
function boxModelCenter(model = {}) {
  const content = model.content || [];
  if (content.length < 8) {
    throw new ElementResolutionError(
      "Element has no box model (not rendered or zero-sized)",
      "transient"
    );
  }
  return {
    x: (content[0] + content[2] + content[4] + content[6]) / 4,
    y: (content[1] + content[3] + content[5] + content[7]) / 4
  };
}
function extractAxString(value) {
  const raw = value?.value;
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  return "";
}
function axNameMatches(actual, expected) {
  if (isTextMatcher(expected)) {
    if (typeof expected.regex === "string") {
      try {
        return new RegExp(expected.regex, expected.flags || "").test(
          String(actual)
        );
      } catch {
        return false;
      }
    }
    const text = String(expected.text ?? "").replace(/\s+/g, " ").trim();
    const normalized = String(actual || "").replace(/\s+/g, " ").trim();
    return expected.exact ? normalized === text : normalized.includes(text);
  }
  return String(actual) === String(expected);
}
function isTextMatcher(value) {
  return Boolean(
    value && typeof value === "object" && (typeof value.regex === "string" || typeof value.text === "string")
  );
}
function send(cdp, method, params = {}, sessionId = void 0) {
  return cdp.sendRaw(method, params, sessionId);
}
export {
  ElementResolutionError,
  queryRoleLocatorBackendNodeIds,
  resolveElementCenter,
  resolveElementObjectId
};
