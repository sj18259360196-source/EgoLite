import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolvePackEntry } from "./cos-runtime.mjs";
import { CosFrames, validateScriptTarget } from "./cos-frames.mjs";

export const COS_WORLD = "EgoCoSPage";
const BINDING = "__egoCosHost";

export async function disposeCosPageScripts(command, contextIds, scripts) {
  const failures = [];
  const operations = [
    ...contextIds.map(contextId => ["Runtime.evaluate", {
      contextId, expression: "globalThis.__egoCosPage?.stop();globalThis.__CLF_CONTENT_RECORDER__?.stop()",
    }]),
    ["Runtime.evaluate", { expression: "window.__cosUsageObserver?.dispose()" }],
    ...scripts.map(identifier => ["Page.removeScriptToEvaluateOnNewDocument", { identifier }]),
    ["Runtime.removeBinding", { name: BINDING }],
  ];
  for (const [method, params] of operations) {
    let timer;
    try {
      await Promise.race([
        command(method, params),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Page cleanup timed out")), 3000); }),
      ]);
    } catch (error) {
      if (!/Cannot find context|Execution context was destroyed|Target closed|Object has been destroyed/i.test(error.message)) failures.push(error.message);
    } finally { clearTimeout(timer); }
  }
  return failures;
}

// This function runs only in the named isolated world, never in the website world.
export function pageBootstrap(bindingName) {
  if (window !== top || location.protocol !== "https:"
    || !["chatgpt.com", "chat.openai.com"].includes(location.hostname)) return;
  if (globalThis.__egoCosPage && globalThis.chrome?.runtime?.id === "ego-cos-hosted") return;
  globalThis.__egoCosPage?.stop();
  const pending = new Map();
  const messages = new Set();
  const storageListeners = new Set();
  let sequence = 0;
  let live = true;
  function request(method, value) {
    if (!live) return Promise.reject(new Error("CoS page agent stopped"));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("CoS page request timed out; outcome unknown"));
      }, 200000);
      pending.set(id, { resolve, reject, timer });
      try { globalThis[bindingName](JSON.stringify({ id, method, value })); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  const event = listeners => ({
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    hasListener: listener => listeners.has(listener),
  });
  globalThis.chrome = {
    runtime: {
      id: "ego-cos-hosted",
      sendMessage: message => request("message", message),
      onMessage: event(messages),
    },
    storage: {
      local: { get: keys => request("preferences", keys) },
      onChanged: event(storageListeners),
    },
  };
  globalThis.__egoCosPage = {
    reply(id, value, error) {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      clearTimeout(call.timer);
      if (error) call.reject(new Error(error));
      else call.resolve(value);
    },
    async dispatch(message) {
      if (!live) throw new Error("CoS page agent stopped");
      return new Promise((resolve, reject) => {
        let waiting = false;
        let done = false;
        const timer = setTimeout(() => reject(new Error("CoS page response timed out")), 180000);
        const reply = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
        try {
          for (const listener of messages) {
            const result = listener(message, { id: "ego-cos-hosted" }, reply);
            if (result === true) waiting = true;
            else if (result?.then) {
              waiting = true;
              result.then(reply, error => { clearTimeout(timer); reject(error); });
            }
          }
          if (!waiting && !done) reply(undefined);
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    },
    preferences(changes) {
      if (live) for (const listener of storageListeners) listener(changes, "local");
    },
    stop() {
      live = false;
      chrome.runtime.id = undefined;
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("CoS page agent stopped"));
      }
      pending.clear();
      messages.clear();
      storageListeners.clear();
    },
  };
}

export class CosPageAgent {
  #options;
  #pages = new Map();
  #attaching = new Map();
  #sources;
  #stopped = false;
  constructor(options) { this.#options = options; }

  async #load() {
    if (!this.#sources) this.#sources = (async () => {
      const load = name => readFile(resolvePackEntry(this.#options.directory, `source/extension/${name}`), "utf8");
      const [usage, fiber, i18n, dom, content, css] = await Promise.all(
        ["usage.js", "fiber.js", "i18n.js", "chatgpt-dom.js", "content.js", "overlay.css"].map(load));
      const guard = 'window === top && location.protocol === "https:" && ["chatgpt.com","chat.openai.com"].includes(location.hostname)';
      const idle = code => `if (${guard}) { const run = () => { ${code}\n}; if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, {once:true}); else run(); }`;
      return {
        main: `if (${guard}) { ${usage}\n}\n${idle(fiber)}`,
        isolated: `(${pageBootstrap.toString()})(${JSON.stringify(BINDING)});\n${idle(
          `${i18n}\n${dom}\n${content}\nconst style=document.createElement("style");style.textContent=${JSON.stringify(css)};(document.head||document.documentElement).append(style);`)}`,
      };
    })();
    return this.#sources;
  }

  async attach(tab) {
    if (this.#stopped) throw new Error("CoS page agent stopped");
    if (this.#attaching.has(tab.webContentsId)) return this.#attaching.get(tab.webContentsId);
    if (this.#pages.has(tab.webContentsId)) return;
    const flight = this.#attach(tab);
    this.#attaching.set(tab.webContentsId, flight);
    try { await flight; } finally { this.#attaching.delete(tab.webContentsId); }
  }

  async #attach(tab) {
    const sources = await this.#load();
    if (this.#stopped) throw new Error("CoS page agent stopped");
    const contents = this.#options.contents(tab);
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    const page = { tabId: tab.webContentsId, contents, debugger: contents.debugger, contexts: new Map(), scripts: [], alive: true };
    page.backgroundThrottling = contents.getBackgroundThrottling();
    contents.setBackgroundThrottling(false);
    this.#pages.set(page.tabId, page);
    const command = (name, params = {}, sessionId) => this.#options.sendCommand(contents, name, params, sessionId);
    page.command = command;
    page.frames = new CosFrames(contents, command, () => {
      if (this.#stopped || !page.alive) throw new Error("CoS page agent stopped");
      this.#options.checkTab(page.tabId);
    }, this.#options.disposeFrames && (sessions => this.#options.disposeFrames(page.tabId, sessions)));
    page.message = (_event, method, params, sessionId) => {
      if (sessionId || !page.alive) return;
      if (method === "Runtime.executionContextCreated") {
        const context = params.context;
        if (context.name === COS_WORLD && context.auxData?.frameId === page.frameId) {
          page.contexts.set(context.id, { id: context.id, documentId: randomUUID(), origin: context.origin });
        }
      } else if (method === "Page.frameNavigated" && !params.frame.parentId) {
        page.frameId = params.frame.id;
        page.contexts.clear();
      } else if (method === "Runtime.executionContextDestroyed") page.contexts.delete(params.executionContextId);
      else if (method === "Runtime.executionContextsCleared") page.contexts.clear();
      else if (method === "Runtime.bindingCalled" && params.name === BINDING) {
        void this.#receive(page, params).catch(error => this.#options.diagnostic?.(error.message));
      }
    };
    page.destroyed = () => {
      this.#options.event?.("tabs.onRemoved", page.tabId, { windowId: this.#options.windowId?.(), isWindowClosing: false });
      this.#forget(page);
      void page.frames.stop();
    };
    page.updated = () => {
      if (!page.alive) return;
      try {
        const current = this.#options.checkTab(page.tabId);
        this.#options.event?.("tabs.onUpdated", page.tabId, { status: current.status, url: current.url }, current);
      } catch { /* Closing or moved tabs are no longer owned. */ }
    };
    contents.debugger.on("message", page.message);
    contents.once("destroyed", page.destroyed);
    contents.on("did-start-loading", page.updated);
    contents.on("did-finish-load", page.updated);
    contents.on("did-navigate-in-page", page.updated);
    try {
      await command("Page.enable");
      const tree = await command("Page.getFrameTree");
      page.frameId = tree.frameTree.frame.id;
      await command("Runtime.enable");
      await command("Runtime.addBinding", { name: BINDING, executionContextName: COS_WORLD });
      // An existing world survives disable; Runtime.enable may already be active.
      const world = await command("Page.createIsolatedWorld", { frameId: page.frameId, worldName: COS_WORLD });
      if (!page.contexts.has(world.executionContextId)) {
        const origin = await command("Runtime.evaluate", {
          contextId: world.executionContextId, expression: "location.origin", returnByValue: true,
        });
        if (origin.exceptionDetails || typeof origin.result?.value !== "string") throw new Error("CoS page origin is unavailable");
        page.contexts.set(world.executionContextId, {
          id: world.executionContextId, documentId: randomUUID(), origin: origin.result.value,
        });
      }
      for (const [source, worldName] of [[sources.main, undefined], [sources.isolated, COS_WORLD]]) {
        if (this.#stopped) throw new Error("CoS page agent stopped");
        const script = await command("Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true, ...(worldName ? { worldName } : {}) });
        page.scripts.push(script.identifier);
      }
      if (this.#stopped) throw new Error("CoS page agent stopped");
    } catch (error) {
      await this.#retire(page);
      throw error;
    }
  }

  #current(page, context) {
    if (this.#stopped || !page.alive || page.contexts.get(context.id) !== context) throw new Error("CoS page document is stale");
    this.#options.checkTab(page.tabId);
  }
  async #receive(page, params) {
    const context = page.contexts.get(params.executionContextId);
    if (!context || typeof params.payload !== "string" || params.payload.length > 8 * 1024 * 1024) return;
    this.#current(page, context);
    let origin;
    try { origin = new URL(context.origin).origin; } catch { return; }
    if (!["https://chatgpt.com", "https://chat.openai.com"].includes(origin)) return;
    const request = JSON.parse(params.payload);
    if (!Number.isSafeInteger(request.id)) return;
    let value, error;
    try {
      if (request.method === "message") {
        value = await this.#options.message(request.value, {
          tab: this.#options.checkTab(page.tabId), frameId: 0,
          documentId: context.documentId, origin,
        });
      } else if (request.method === "preferences") value = await this.#options.preferences(request.value);
      else throw new Error("Unknown CoS page request");
    } catch (cause) { error = cause.message; }
    await this.#options.runMutation(async () => {
      this.#current(page, context);
      await page.command("Runtime.evaluate", {
        contextId: context.id,
        expression: `globalThis.__egoCosPage?.reply(${request.id},${JSON.stringify(value) ?? "undefined"},${JSON.stringify(error) ?? "undefined"})`,
      });
    });
  }

  async send(tabId, message, options = {}) {
    const page = this.#pages.get(tabId);
    const context = page && [...page.contexts.values()].at(-1);
    if (!context || options.frameId && options.frameId !== 0
      || options.documentId && options.documentId !== context.documentId) throw new Error("CoS page receiver is unavailable or stale");
    this.#current(page, context);
    const result = await page.command("Runtime.evaluate", {
      contextId: context.id, awaitPromise: true, returnByValue: true,
      expression: `globalThis.__egoCosPage.dispatch(${JSON.stringify(message)})`,
    });
    this.#current(page, context);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  async evaluate(tab, expression, { documentId, world = "ISOLATED", metadata = false } = {}) {
    await this.attach(tab);
    const page = this.#pages.get(tab.webContentsId);
    let context = [...page.contexts.values()].at(-1);
    if (!context) {
      await page.command("Page.createIsolatedWorld", { frameId: page.frameId, worldName: COS_WORLD });
      context = [...page.contexts.values()].at(-1);
    }
    if (!context) throw new Error("CoS isolated page context is unavailable");
    this.#current(page, context);
    if (documentId && context.documentId !== documentId) throw new Error("CoS requested document is stale");
    const result = world === "MAIN"
      ? { result: { value: await page.contents.executeJavaScript(expression) } }
      : await page.command("Runtime.evaluate", {
      contextId: context.id, expression, awaitPromise: true, returnByValue: true,
    });
    this.#current(page, context);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return metadata ? { frameId: 0, documentId: context.documentId, result: result.result?.value } : result.result?.value;
  }

  async preferencesChanged(changes) {
    await Promise.all([...this.#pages.values()].map(async page => {
      for (const context of page.contexts.values()) {
        try {
          await this.#options.runMutation(async () => {
            this.#current(page, context);
            await page.command("Runtime.evaluate", {
              contextId: context.id, expression: `globalThis.__egoCosPage?.preferences(${JSON.stringify(changes)})`,
            });
          });
        } catch (error) { this.#options.diagnostic?.(error.message); }
      }
    }));
  }

  async execute(tab, expression, target, world = "ISOLATED", css) {
    validateScriptTarget(target);
    if (!["MAIN", "ISOLATED"].includes(world)) throw new Error("Unsupported CoS script world");
    if (css === undefined && !target.allFrames && !target.documentIds && (!target.frameIds || target.frameIds.every(id => id === 0))) {
      return [await this.evaluate(tab, expression, { world, metadata: true })];
    }
    await this.attach(tab);
    const page = this.#pages.get(tab.webContentsId);
    const top = await this.evaluate(tab, "undefined", { metadata: true });
    if (css === undefined && target.documentIds?.every(id => id === top.documentId)) {
      return [await this.evaluate(tab, expression, { world, metadata: true, documentId: top.documentId })];
    }
    const frames = await page.frames.refresh();
    frames.find(frame => frame.frameId === 0).documentId = top.documentId;
    let selected;
    if (target.allFrames) selected = frames;
    else if (target.documentIds) selected = [...new Set(target.documentIds)].map(id => {
      const frame = frames.find(frame => frame.documentId === id);
      if (!frame) throw new Error("CoS requested document is stale");
      return frame;
    });
    else selected = [...new Set(target.frameIds || [0])].map(id => {
      const frame = frames.find(frame => frame.frameId === id);
      if (!frame) throw new Error("CoS requested frame is unavailable");
      return frame;
    });
    const results = [];
    for (const frame of selected.sort((a, b) => a.frameId - b.frameId)) {
      await page.frames.current(frame);
      if (css !== undefined) {
        await page.frames.insertCSS(frame, css);
        continue;
      }
      results.push(frame.frameId === 0
        ? await this.evaluate(tab, expression, { documentId: frame.documentId, world, metadata: true })
        : await page.frames.execute(frame, expression, world));
    }
    return results;
  }

  #forget(page) {
    page.alive = false;
    page.contexts.clear();
    page.debugger.removeListener("message", page.message);
    page.contents.removeListener("destroyed", page.destroyed);
    page.contents.removeListener("did-start-loading", page.updated);
    page.contents.removeListener("did-finish-load", page.updated);
    page.contents.removeListener("did-navigate-in-page", page.updated);
    this.#pages.delete(page.tabId);
  }
  async #retire(page) {
    const contextIds = [...page.contexts.keys()];
    const scripts = [...page.scripts];
    this.#forget(page);
    await page.frames.stop();
    try {
      // Cancellation of owned scripts must still work after the browsing lease is revoked.
      const failures = this.#options.disposePage
        ? await this.#options.disposePage(page.tabId, contextIds, scripts, page.backgroundThrottling)
        : await disposeCosPageScripts(page.command, contextIds, scripts);
      for (const failure of failures) this.#options.diagnostic?.(`CoS page cleanup: ${failure}`);
      if (!this.#options.disposePage && !page.contents.isDestroyed()) page.contents.setBackgroundThrottling(page.backgroundThrottling);
    } catch (error) { this.#options.diagnostic?.(`CoS page cleanup: ${error.message}`); }
  }
  async stop() {
    this.#stopped = true;
    await Promise.allSettled(this.#attaching.values());
    await Promise.all([...this.#pages.values()].map(page => this.#retire(page)));
  }
}
