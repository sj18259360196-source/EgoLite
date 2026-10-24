const ACTIONABLE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

export class DesktopBrowserController {
  #automatedInputUntil = new Map();

  isAutomatedInput(target) {
    return (this.#automatedInputUntil.get(target?.id) || 0) > Date.now();
  }

  markAutomatedInput(target, durationMs = 500) {
    this.#automatedInputUntil.set(target.id, Date.now() + durationMs);
  }

  #observers = new Map();
  #fallbackCapture;

  constructor(options = {}) {
    this.#fallbackCapture = options.fallbackCapture;
  }

  async pageInfo(target) {
    return {
      id: target.id,
      title: target.getTitle(),
      url: target.getURL(),
      loading: target.isLoading(),
      canGoBack: target.navigationHistory.canGoBack(),
      canGoForward: target.navigationHistory.canGoForward(),
    };
  }

  async snapshot(target, requestedOptions = {}) {
    const captured = await this.captureSnapshotCandidates(target, requestedOptions);
    return {
      title: captured.title,
      url: captured.url,
      ...serializeSnapshotCandidates(captured.candidates, captured.options),
    };
  }

  async captureSnapshotCandidates(target, requestedOptions = {}, frameId) {
    const options = normalizeSnapshotOptions(requestedOptions);
    return this.#withDebugger(target, async (debuggerApi) => {
      await debuggerApi.sendCommand("Accessibility.enable");
      const domCapture = debuggerApi.sendCommand("DOMSnapshot.captureSnapshot", {
        computedStyles: [],
        includeDOMRects: true,
        includePaintOrder: true,
      });
      const [axResult, domResult, metricsResult] = await Promise.all([
        debuggerApi.sendCommand("Accessibility.getFullAXTree", frameId ? { frameId } : {}),
        options.scope === "full_page"
          ? domCapture.catch(() => ({ documents: [], strings: [] }))
          : domCapture,
        options.scope === "only_within_viewport"
          ? debuggerApi.sendCommand("Page.getLayoutMetrics")
          : Promise.resolve(undefined),
      ]);
      const geometry = readSnapshotGeometry(metricsResult, domResult?.documents?.[0]);
      if (options.scope === "only_within_viewport" && !geometry?.viewport) {
        throw new Error("Viewport snapshot is unavailable because page geometry could not be resolved");
      }
      const dom = buildDomIndex(domResult, geometry?.boundsScale);
      if (options.scope === "only_within_viewport" && (axResult.nodes || []).length > 0 && dom.size === 0) {
        throw new Error("Viewport snapshot is unavailable because DOM geometry is empty");
      }
      return {
        title: target.getTitle(),
        url: target.getURL(),
        options,
        candidates: buildSnapshotCandidates(axResult.nodes || [], dom, geometry?.viewport, options),
      };
    });
  }

  async captureRoutedFrameCandidates(sendCommand, route, requestedOptions = {}, candidateLimit = 600) {
    const options = normalizeSnapshotOptions(requestedOptions);
    await sendCommand("Accessibility.enable", {});
    const axResult = await sendCommand("Accessibility.getFullAXTree", { frameId: route.identity.frameId });
    const allCandidates = buildSnapshotCandidates(
      axResult.nodes || [],
      new Map(),
      undefined,
      { ...options, scope: "full_page", includeStableLocator: false },
    );
    const candidates = allCandidates.slice(0, candidateLimit);
    if (options.scope !== "only_within_viewport") {
      return { candidates, totalCandidates: allCandidates.length, complete: true };
    }
    let metrics;
    try {
      metrics = await sendCommand("Page.getLayoutMetrics", {});
    } catch {
      return { candidates: [], totalCandidates: allCandidates.length, complete: false };
    }
    const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport;
    const width = Number(viewport?.clientWidth);
    const height = Number(viewport?.clientHeight);
    if (!(width > 0 && height > 0)) return { candidates: [], totalCandidates: allCandidates.length, complete: false };
    const visible = [];
    for (const candidate of candidates) {
      try {
        const result = await sendCommand("DOM.getBoxModel", { backendNodeId: candidate.backendNodeId });
        const quad = result?.model?.border || result?.model?.content;
        if (!Array.isArray(quad) || quad.length < 8) continue;
        const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
        const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
        const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
        if (right > 0 && bottom > 0 && left < width && top < height) visible.push(candidate);
      } catch {
        // Nodes without a box are not rendered in this frame realm.
      }
    }
    return { candidates: Object.freeze(visible), totalCandidates: allCandidates.length, complete: true };
  }

  async click(target, backendNodeId) {
    return this.#callOnNode(target, backendNodeId, `function () {
      this.scrollIntoView({ block: "center", inline: "center" });
      this.click();
      return true;
    }`);
  }

  async fill(target, backendNodeId, value) {
    return this.#callOnNode(target, backendNodeId, `function (nextValue) {
      this.scrollIntoView({ block: "center", inline: "center" });
      this.focus();
      const prototype = this instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(this, nextValue);
      else this.value = nextValue;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return this.value;
    }`, [String(value)]);
  }

  async hover(target, backendNodeId) {
    const point = await this.#callOnNode(target, backendNodeId, `function () {
      this.scrollIntoView({ block: "center", inline: "center" });
      const rect = this.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }`);
    target.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y, movementX: 0, movementY: 0 });
    return true;
  }

  async press(target, shortcut) {
    this.#automatedInputUntil.set(target.id, Date.now() + 500);
    const parts = String(shortcut).split("+").map((part) => part.trim()).filter(Boolean);
    if (!parts.length) throw new Error("Keyboard shortcut is empty");
    const keyCode = parts.pop();
    const modifierMap = new Map([
      ["ctrl", "control"], ["control", "control"], ["shift", "shift"],
      ["alt", "alt"], ["option", "alt"], ["cmd", "meta"],
      ["command", "meta"], ["meta", "meta"],
    ]);
    const modifiers = parts.map((part) => modifierMap.get(part.toLowerCase())).filter(Boolean);
    if (modifiers.length !== parts.length) throw new Error(`Unsupported keyboard shortcut: ${shortcut}`);
    target.focus();
    const normalizedKey = keyCode.toLowerCase();
    if ((modifiers.includes("control") || modifiers.includes("meta")) && normalizedKey === "a") {
      return target.executeJavaScript(`(() => {
        const element = document.activeElement;
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.select();
          return true;
        }
        document.execCommand("selectAll");
        return true;
      })()`);
    }
    if (normalizedKey === "tab") {
      const backwards = modifiers.includes("shift");
      return target.executeJavaScript(`(() => {
        const focusable = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')]
          .filter((element) => !element.disabled && element.getClientRects().length);
        if (!focusable.length) return false;
        const current = focusable.indexOf(document.activeElement);
        const next = ${backwards ? "current <= 0 ? focusable.length - 1 : current - 1" : "current < 0 || current >= focusable.length - 1 ? 0 : current + 1"};
        focusable[next].focus();
        return true;
      })()`);
    }
    if (normalizedKey === "enter") {
      return target.executeJavaScript(`(() => {
        const element = document.activeElement;
        if (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement) {
          element.click();
          return true;
        }
        if (element instanceof HTMLInputElement && element.form) {
          element.form.requestSubmit();
          return true;
        }
        element?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
        element?.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
        return Boolean(element);
      })()`);
    }
    target.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    target.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    return true;
  }

  async typeText(target, text) {
    target.focus();
    const result = await this.sendCommand(target, "Input.insertText", { text });
    return result.result?.value ?? true;
  }

  async scroll(target, deltaX, deltaY) {
    target.focus();
    return target.executeJavaScript(
      `(() => { window.scrollBy({ left: ${Number(deltaX) || 0}, top: ${Number(deltaY) || 0}, behavior: "instant" }); return { x: scrollX, y: scrollY }; })()`,
    );
  }

  async waitFor(target, options = {}) {
    const timeout = Math.min(60_000, Math.max(100, Number(options.timeout) || 10_000));
    const deadline = Date.now() + timeout;
    const expectedText = typeof options.text === "string" ? options.text : "";
    const expectedUrl = typeof options.urlContains === "string" ? options.urlContains : "";
    const requireLoaded = options.loadComplete === true;
    while (Date.now() < deadline) {
      const urlMatches = !expectedUrl || target.getURL().includes(expectedUrl);
      const loadMatches = !requireLoaded || !target.isLoading();
      let textMatches = !expectedText;
      if (expectedText) {
        try {
          textMatches = await target.executeJavaScript(
            `document.body?.innerText?.includes(${JSON.stringify(expectedText)}) === true`,
          );
        } catch {
          textMatches = false;
        }
      }
      if (urlMatches && loadMatches && textMatches) return this.pageInfo(target);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for the page condition");
  }

  async evaluate(target, expression) {
    return this.#withDebugger(target, async (debuggerApi) => {
      const source = JSON.stringify(String(expression));
      const response = await debuggerApi.sendCommand("Runtime.evaluate", {
        expression: `(() => {
          const source = ${source};
          let execute;
          try {
            execute = new Function("return (async () => (" + source + "))()");
          } catch {
            execute = new Function("return (async () => {" + source + "})()");
          }
          return Promise.resolve(execute()).then((value) =>
            JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item));
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Evaluation failed");
      }
      const serialized = response.result?.value;
      return serialized === undefined ? null : JSON.parse(serialized);
    });
  }

  async goto(target, url) {
    await target.loadURL(url);
    return this.pageInfo(target);
  }

  async navigate(target, action) {
    if (action === "back") {
      if (target.navigationHistory.canGoBack()) target.navigationHistory.goBack();
    } else if (action === "forward") {
      if (target.navigationHistory.canGoForward()) target.navigationHistory.goForward();
    } else if (action === "reload") {
      target.reload();
    } else {
      throw new Error(`Unsupported navigation action: ${action}`);
    }
    await waitForLoad(target);
    return this.pageInfo(target);
  }

  async screenshot(target) {
    let primaryError;
    try {
      const image = await withTimeout(target.capturePage(), 5_000, "Page capture timed out");
      if (!image.isEmpty()) {
        return {
          data: image.toPNG().toString("base64"),
          mimeType: "image/png",
          captureMethod: "webcontents",
          degraded: false,
        };
      }
    } catch (error) {
      primaryError = error;
      // CDP can still capture a valid page when Electron's compositor capture stalls.
    }
    try {
      const result = await withTimeout(
        this.#withDebugger(target, (debuggerApi) => debuggerApi.sendCommand("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        })),
        3_000,
        "CDP page capture timed out",
      );
      if (!result?.data) throw new Error("Page screenshot returned no image data");
      return {
        data: result.data,
        mimeType: "image/png",
        captureMethod: "cdp",
        degraded: false,
      };
    } catch (cdpError) {
      if (!this.#fallbackCapture) throw cdpError;
      const image = await withTimeout(this.#fallbackCapture(target), 5_000, "Visible page crop timed out");
      if (image.isEmpty()) throw new Error("Visible page crop returned an empty image");
      return {
        data: image.toPNG().toString("base64"),
        mimeType: "image/png",
        captureMethod: "window-crop",
        degraded: true,
        warning: [primaryError, cdpError]
          .filter(Boolean)
          .map((error) => error instanceof Error ? error.message : String(error))
          .join("; "),
      };
    }
  }

  async sendCommand(target, method, params = {}) {
    if (method.startsWith("Input.")) this.markAutomatedInput(target);
    if (!target.debugger.isAttached()) target.debugger.attach("1.3");
    if (method === "Page.captureScreenshot") {
      const screenshot = await this.screenshot(target);
      return { data: screenshot.data };
    }
    if (method === "Page.reload") {
      target.reload();
      return {};
    }
    if (method === "Input.insertText") {
      const text = JSON.stringify(String(params.text || ""));
      return target.debugger.sendCommand("Runtime.evaluate", {
        expression: `(() => {
          const element = document.activeElement;
          const text = ${text};
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            const start = element.selectionStart ?? element.value.length;
            const end = element.selectionEnd ?? start;
            element.setRangeText(text, start, end, "end");
            element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
            return true;
          }
          if (element?.isContentEditable) {
            document.execCommand("insertText", false, text);
            return true;
          }
          return false;
        })()`,
        returnByValue: true,
      });
    }
    return target.debugger.sendCommand(method, params);
  }

  sendNativeCommand(target, method, params = {}, sessionId, options = {}) {
    if (method.startsWith("Input.")) {
      this.markAutomatedInput(target);
    }
    if (options.allowRootElectronInsert === true && sessionId === undefined && method === "Input.insertText") {
      target.insertText(String(params.text || ""));
      return Promise.resolve({});
    }
    if (options.allowRootElectronKey === true && sessionId === undefined && method === "Input.dispatchKeyEvent") {
      const modifiers = [[1, "alt"], [2, "control"], [4, "meta"], [8, "shift"]]
        .filter(([bit]) => (Number(params.modifiers) & bit) !== 0).map(([, name]) => name);
      const aliases = { ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Escape: "Escape" };
      const keyCode = aliases[params.key] || params.key;
      if (typeof keyCode !== "string" || !keyCode || !["keyDown", "rawKeyDown", "keyUp", "char"].includes(params.type)) {
        throw new Error("Unsupported native keyboard event");
      }
      target.sendInputEvent({ type: params.type === "rawKeyDown" ? "keyDown" : params.type, keyCode, modifiers });
      if (params.type === "keyDown" && typeof params.text === "string" && params.text
        && !["Tab", "Enter"].includes(params.key) && !(Number(params.modifiers) & 6)) {
        target.sendInputEvent({ type: "char", keyCode: params.text, modifiers });
      }
      return Promise.resolve({});
    }
    if (options.allowRootElectronReload === true && sessionId === undefined && method === "Page.reload") {
      if (params.ignoreCache === true) target.reloadIgnoringCache();
      else target.reload();
      return Promise.resolve({});
    }
    if (options.allowRootElectronEvaluate === true && sessionId === undefined && method === "Runtime.evaluate") {
      return target.executeJavaScript(String(params.expression || ""), true).then((value) => ({
        result: {
          type: value === null ? "object" : typeof value,
          ...(value === undefined ? {} : { value }),
        },
      }));
    }
    if (!target.debugger.isAttached()) target.debugger.attach("1.3");
    return sessionId === undefined
      ? target.debugger.sendCommand(method, params)
      : target.debugger.sendCommand(method, params, sessionId);
  }

  waitForNativeReady(target) {
    return waitForLoad(target);
  }

  observe(target, listener, options = {}) {
    const targetId = target.id;
    const existing = this.#observers.get(targetId);
    if (existing) return existing.dispose;
    // WebContents.debugger throws after destruction; retain the emitter for cleanup.
    const debuggerApi = target.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    const onMessage = (_event, method, params, sessionId) => listener(method, params, sessionId);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      this.#observers.delete(targetId);
      debuggerApi.removeListener("message", onMessage);
      debuggerApi.removeListener("detach", onDetach);
    };
    const onDetach = (_event, reason) => {
      try {
        options.onDetach?.(reason || "debugger_detached");
      } finally {
        dispose();
      }
    };
    debuggerApi.on("message", onMessage);
    debuggerApi.once("detach", onDetach);
    this.#observers.set(targetId, { dispose });
    return dispose;
  }

  isObserving(target) {
    return this.#observers.has(target.id);
  }

  async #callOnNode(target, backendNodeId, functionDeclaration, args = []) {
    return this.#withDebugger(target, async (debuggerApi) => {
      const resolved = await debuggerApi.sendCommand("DOM.resolveNode", { backendNodeId });
      const objectId = resolved.object?.objectId;
      if (!objectId) throw new Error(`Unable to resolve backend node ${backendNodeId}`);
      try {
        const response = await debuggerApi.sendCommand("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration,
          arguments: args.map((value) => ({ value })),
          awaitPromise: true,
          returnByValue: true,
        });
        if (response.exceptionDetails) {
          throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Element action failed");
        }
        return response.result?.value ?? true;
      } finally {
        await debuggerApi.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
      }
    });
  }

  async #withDebugger(target, operation) {
    const attachedHere = !target.debugger.isAttached();
    if (attachedHere) target.debugger.attach("1.3");
    try {
      return await operation(target.debugger);
    } finally {
      if (attachedHere && target.debugger.isAttached()) target.debugger.detach();
    }
  }
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function valueOf(property) {
  return typeof property?.value === "string" ? property.value : "";
}

export function normalizeSnapshotOptions(options = {}) {
  const rawScope = options?.scope;
  let scope;
  if (rawScope === undefined || rawScope === "full_page") scope = "full_page";
  else if (rawScope === "viewport" || rawScope === "only_within_viewport") scope = "only_within_viewport";
  else throw new Error(`Unsupported snapshot scope: ${String(rawScope)}`);

  let maxResultLength;
  if (options?.maxResultLength !== undefined) {
    maxResultLength = Number(options.maxResultLength);
    if (!Number.isInteger(maxResultLength) || maxResultLength < 64) {
      throw new Error("maxResultLength must be an integer of at least 64");
    }
  }
  return {
    scope,
    includeActionMarks: options?.includeActionMarks !== false,
    includeStableLocator: options?.includeStableLocator === true,
    ...(maxResultLength ? { maxResultLength } : {}),
  };
}

export function serializeSnapshot(nodes, dom, viewport, options) {
  return serializeSnapshotCandidates(buildSnapshotCandidates(nodes, dom, viewport, options), options);
}

export function buildSnapshotCandidates(nodes, dom, viewport, options) {
  const roleNameCounts = new Map();
  for (const node of nodes) {
    if (node.ignored || !node.backendDOMNodeId) continue;
    const role = valueOf(node.role) || "generic";
    const name = valueOf(node.name).trim();
    const key = `${role.toLowerCase()}\u0000${name}`;
    roleNameCounts.set(key, (roleNameCounts.get(key) || 0) + 1);
  }
  const attributeCounts = countLocatorAttributes(dom);
  const candidates = [];
  for (const node of nodes) {
    if (node.ignored || !node.backendDOMNodeId) continue;
    const role = valueOf(node.role) || "generic";
    const name = valueOf(node.name).trim();
    if (!name && !ACTIONABLE_ROLES.has(role.toLowerCase())) continue;
    const domNode = dom.get(node.backendDOMNodeId);
    if (domNode?.bounds && !isRendered(domNode)) continue;
    if (options.scope === "only_within_viewport") {
      if (!domNode?.bounds || !intersects(domNode.bounds, viewport)) continue;
    }
    const stableLocator = options.includeStableLocator
      ? deriveStableLocator(role, name, domNode, attributeCounts, roleNameCounts)
      : undefined;
    candidates.push(Object.freeze({
      backendNodeId: node.backendDOMNodeId,
      role,
      name,
      ...(stableLocator ? { stableLocator } : {}),
    }));
  }
  return Object.freeze(candidates);
}

export function serializeSnapshotCandidates(candidates, options, metadata = {}) {
  const entries = candidates.map((candidate) => {
    const refId = candidate.refId ?? candidate.backendNodeId;
    const label = candidate.name ? ` ${JSON.stringify(candidate.name)}` : "";
    const mark = options.includeActionMarks ? ` [@${refId}]` : "";
    const locator = candidate.stableLocator ? ` loc=${JSON.stringify(candidate.stableLocator)}` : "";
    return { line: `- ${candidate.role}${label}${mark}${locator}`, ref: { ...candidate } };
  });
  return truncateSnapshotEntries(entries, options.maxResultLength, metadata.totalLines);
}

function truncateSnapshotEntries(entries, maxResultLength, requestedTotalLines) {
  const NODE_LIMIT = 600;
  const totalLines = Math.max(entries.length, Number.isSafeInteger(requestedTotalLines) ? requestedTotalLines : entries.length);
  const reasons = [];
  let included = entries.slice(0, NODE_LIMIT);
  if (totalLines > included.length) reasons.push("node_limit");

  const contentFor = (selected, truncated) => {
    const lines = selected.map((entry) => entry.line);
    if (truncated) lines.push(`[snapshot truncated: ${totalLines - selected.length} of ${totalLines} lines omitted]`);
    return lines.join("\n");
  };

  let content = contentFor(included, reasons.length > 0);
  if (maxResultLength !== undefined && content.length > maxResultLength) {
    reasons.push("max_result_length");
    const selected = [];
    for (const entry of included) {
      const candidate = [...selected, entry];
      if (contentFor(candidate, true).length > maxResultLength) break;
      selected.push(entry);
    }
    included = selected;
    content = contentFor(included, true);
  }

  return {
    content,
    refs: included.map((entry) => entry.ref),
    ...(reasons.length ? {
      truncation: {
        reasons,
        ...(maxResultLength !== undefined ? { maxResultLength } : {}),
        totalLines,
        includedLines: included.length,
        omittedLines: totalLines - included.length,
      },
    } : {}),
  };
}

function buildDomIndex(snapshot, boundsScale = { x: 1, y: 1 }) {
  const index = new Map();
  // DOMSnapshot child-document bounds are relative to their own viewport. Until
  // frame transforms are modeled, only root-document geometry is safe to use.
  for (const document of (snapshot?.documents || []).slice(0, 1)) {
    const boundsByNodeIndex = new Map();
    for (let layoutIndex = 0; layoutIndex < (document.layout?.nodeIndex || []).length; layoutIndex += 1) {
      const nodeIndex = document.layout.nodeIndex[layoutIndex];
      const bounds = document.layout.bounds?.[layoutIndex];
      if (nodeIndex !== undefined && Array.isArray(bounds)) {
        boundsByNodeIndex.set(nodeIndex, [
          bounds[0] * boundsScale.x,
          bounds[1] * boundsScale.y,
          bounds[2] * boundsScale.x,
          bounds[3] * boundsScale.y,
        ]);
      }
    }
    for (let nodeIndex = 0; nodeIndex < (document.nodes?.backendNodeId || []).length; nodeIndex += 1) {
      const backendNodeId = document.nodes.backendNodeId[nodeIndex];
      if (backendNodeId === undefined) continue;
      const rawAttributes = document.nodes.attributes?.[nodeIndex] || [];
      const attributes = {};
      for (let attributeIndex = 0; attributeIndex < rawAttributes.length; attributeIndex += 2) {
        const key = snapshot.strings?.[rawAttributes[attributeIndex]];
        const value = snapshot.strings?.[rawAttributes[attributeIndex + 1]];
        if (key !== undefined && value !== undefined) attributes[key] = value;
      }
      index.set(backendNodeId, {
        nodeName: snapshot.strings?.[document.nodes.nodeName?.[nodeIndex]] || "",
        attributes,
        ...(boundsByNodeIndex.has(nodeIndex) ? { bounds: boundsByNodeIndex.get(nodeIndex) } : {}),
      });
    }
  }
  return index;
}

function readSnapshotGeometry(result, document) {
  const cssViewport = result?.cssVisualViewport || result?.cssLayoutViewport;
  const cssContent = result?.cssContentSize;
  const documentWidth = Number(document?.contentWidth ?? result?.contentSize?.width);
  const documentHeight = Number(document?.contentHeight ?? result?.contentSize?.height);
  const scaleX = Number(cssContent?.width) / documentWidth;
  const scaleY = Number(cssContent?.height) / documentHeight;
  if (cssViewport && scaleX > 0 && scaleY > 0 && Number.isFinite(scaleX) && Number.isFinite(scaleY)) {
    const viewport = numericViewport(cssViewport);
    if (viewport) return { viewport, boundsScale: { x: scaleX, y: scaleY } };
  }

  // `visualViewport.pageY` can be CSS-valued while its width/height are legacy
  // layout units. `layoutViewport` is internally consistent with DOM bounds.
  const legacyViewport = numericViewport(result?.layoutViewport);
  return legacyViewport ? { viewport: legacyViewport, boundsScale: { x: 1, y: 1 } } : undefined;
}

function numericViewport(viewport) {
  if (!viewport) return undefined;
  const x = Number(viewport.pageX);
  const y = Number(viewport.pageY);
  const width = Number(viewport.clientWidth);
  const height = Number(viewport.clientHeight);
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : undefined;
}

function isRendered(node) {
  return Boolean(node.bounds && node.bounds[2] > 0 && node.bounds[3] > 0);
}

function intersects([x, y, width, height], viewport) {
  return width > 0 && height > 0
    && x + width > viewport.x && y + height > viewport.y
    && x < viewport.x + viewport.width && y < viewport.y + viewport.height;
}

function countLocatorAttributes(dom) {
  const counts = new Map();
  for (const node of dom.values()) {
    for (const key of ["data-testid", "data-test", "data-qa", "id", "name", "placeholder"]) {
      const value = node.attributes?.[key];
      if (!value) continue;
      const signature = `${key}\u0000${key === "name" ? node.nodeName.toLowerCase() : ""}\u0000${value}`;
      counts.set(signature, (counts.get(signature) || 0) + 1);
    }
  }
  return counts;
}

function deriveStableLocator(role, name, node, attributeCounts, roleNameCounts) {
  if (!node) return undefined;
  const attributes = node?.attributes || {};
  for (const key of ["data-testid", "data-test", "data-qa"]) {
    const value = attributes[key];
    if (value && attributeCounts.get(`${key}\u0000\u0000${value}`) === 1) {
      return key === "data-testid"
        ? `testid:${JSON.stringify(value)}`
        : `css:[${key}=${cssString(value)}]`;
    }
  }
  if (attributes.id && !looksGenerated(attributes.id)
    && attributeCounts.get(`id\u0000\u0000${attributes.id}`) === 1) {
    return `css:[id=${cssString(attributes.id)}]`;
  }
  const nodeName = node?.nodeName?.toLowerCase() || "*";
  if (attributes.name && attributeCounts.get(`name\u0000${nodeName}\u0000${attributes.name}`) === 1) {
    return `css:${nodeName}[name=${cssString(attributes.name)}]`;
  }
  if (attributes.placeholder && attributeCounts.get(`placeholder\u0000\u0000${attributes.placeholder}`) === 1) {
    return `placeholder:${JSON.stringify(attributes.placeholder)}`;
  }
  if (name && roleNameCounts.get(`${role.toLowerCase()}\u0000${name}`) === 1) {
    return `role:${role}[name=${JSON.stringify(name)}]`;
  }
  return undefined;
}

function looksGenerated(value) {
  return value.length > 48 || /[a-f\d]{12,}/i.test(value);
}

function cssString(value) {
  let escaped = '"';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (character === '"' || character === "\\") escaped += `\\${character}`;
    else if (code === 0) escaped += "\\fffd ";
    else if (code < 0x20 || code === 0x7f) escaped += `\\${code.toString(16)} `;
    else escaped += character;
  }
  return `${escaped}"`;
}

function waitForLoad(target) {
  if (!target.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, 20_000);
    target.once("did-stop-loading", done);
    function done() {
      clearTimeout(timer);
      target.removeListener("did-stop-loading", done);
      resolve();
    }
  });
}
