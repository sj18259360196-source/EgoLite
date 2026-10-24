import { browserCommandForInput } from "./public/browser-shortcuts.js";
import { formatElementContext, initializeFrontendExpression, inspectNodeExpression, selectedElementExpression } from "./developer-tools-context.mjs";

export class DeveloperTools {
  #entries = new Map();
  #options;

  constructor(options) {
    this.#options = options;
  }

  state() {
    return [...this.#entries.values()].map(entry => ({
      webContentsId: entry.target.id, ready: entry.loaded, panel: entry.panel,
    }));
  }

  #publish() { this.#options.onState?.(this.state()); }

  async toggle(target) {
    if (this.#entries.has(target.id)) {
      this.close(target);
      return false;
    }
    await this.open(target);
    return true;
  }

  async open(target, { panel, inspect = false, point } = {}) {
    if (target.isDestroyed()) throw new Error("该页面已经关闭");
    if (panel && !["elements", "sources"].includes(panel)) throw new Error("不支持的开发者工具面板");
    let hit;
    if (point) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("检查位置无效");
      // Capture before docking changes the page width and responsive layout.
      hit = await this.#options.resolvePoint(target, { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: true });
      if (!hit?.backendNodeId) throw new Error("未找到该位置的元素");
    }
    let entry = this.#entries.get(target.id);
    if (!entry) {
      entry = this.#create(target);
      panel ||= "elements";
    }
    await entry.ready;
    if (this.#entries.get(target.id) !== entry) return false;
    const contents = entry.view.webContents;
    entry.initialized ||= contents.executeJavaScript(initializeFrontendExpression);
    await entry.initialized;
    if (this.#entries.get(target.id) !== entry) return false;
    if (panel) {
      await contents.executeJavaScript(`(async () => {
        const UI = await import("./ui/legacy/legacy.js");
        await UI.InspectorView.InspectorView.instance().showPanel(${JSON.stringify(panel)});
        return true;
      })()`);
      entry.panel = panel;
    }
    if (hit) {
      await contents.executeJavaScript(inspectNodeExpression(hit));
      entry.panel = "elements";
    }
    if (inspect) {
      await contents.executeJavaScript("DevToolsAPI.enterInspectElementMode(); true");
      entry.panel = "elements";
      target.focus();
    } else if (entry.visible) contents.focus();
    this.#publish();
    return true;
  }

  layout({ webContentsId, bounds, visible }) {
    const parent = this.#options.getParent();
    if (!parent || parent.isDestroyed()) return false;
    const [width, height] = parent.getContentSize();
    const zoom = parent.webContents.getZoomFactor();
    const valid = bounds && ["x", "y", "width", "height"].every(key => Number.isFinite(bounds[key]));
    const x = valid ? Math.max(0, Math.min(width, Math.round(bounds.x * zoom))) : 0;
    const y = valid ? Math.max(0, Math.min(height, Math.round(bounds.y * zoom))) : 0;
    const w = valid ? Math.min(width - x, Math.max(0, Math.round(bounds.width * zoom))) : 0;
    const h = valid ? Math.min(height - y, Math.max(0, Math.round(bounds.height * zoom))) : 0;
    for (const entry of this.#entries.values()) {
      entry.visible = visible === true && entry.loaded && entry.target.id === webContentsId && w > 0 && h > 0;
      if (entry.visible) entry.view.setBounds({ x, y, width: w, height: h });
      entry.view.setVisible(entry.visible);
    }
    return true;
  }

  async copySelected(target) {
    const entry = this.#entries.get(target.id);
    if (!entry) throw new Error("请先打开开发者工具并选中一个元素");
    await entry.ready;
    const generation = entry.generation;
    if (this.#entries.get(target.id) !== entry || target.isDestroyed()) throw new Error("检查面板已经关闭");
    const context = await entry.view.webContents.executeJavaScript(selectedElementExpression);
    if (this.#entries.get(target.id) !== entry || target.isDestroyed()) throw new Error("检查面板已经关闭");
    if (generation !== entry.generation) throw new Error("页面已变化，请重新选取元素");
    this.#options.writeClipboard(formatElementContext(context));
    this.#options.onCopied?.();
    return true;
  }

  close(target) { this.#entries.get(target.id)?.dispose(); }

  dispose() { for (const entry of [...this.#entries.values()]) entry.dispose(); }

  #create(target) {
    const parent = this.#options.getParent();
    const view = this.#options.createView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const contents = view.webContents;
    const entry = { view, target, loaded: false, visible: false, panel: "elements", generation: 0 };
    this.#entries.set(target.id, entry);
    view.setVisible(false);
    parent.contentView.addChildView(view);
    let resolveReady;
    let rejectReady;
    let timer;
    entry.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const onOpened = () => {
      entry.loaded = true;
      clearTimeout(timer);
      this.#publish();
      resolveReady();
    };
    const onNavigation = (_event, _url, inPlace) => { if (!inPlace) entry.generation += 1; };
    const report = error => this.#options.onError?.(error);
    const run = promise => { void promise.catch(report); };
    const onInput = (event, input) => {
      const command = browserCommandForInput(input);
      if (command === "toggle-devtools") {
        event.preventDefault();
        if (!input.isAutoRepeat) this.close(target);
      } else if (command === "inspect-element") {
        event.preventDefault();
        if (!input.isAutoRepeat) run(this.open(target, { inspect: true }));
      } else if (["keyDown", "rawKeyDown"].includes(input.type) && (input.control || input.meta) && input.shift && !input.alt && String(input.key).toLowerCase() === "x") {
        event.preventDefault();
        if (!input.isAutoRepeat) run(this.copySelected(target));
      }
    };
    entry.dispose = () => {
      if (this.#entries.get(target.id) !== entry) return;
      this.#entries.delete(target.id);
      clearTimeout(timer);
      target.removeListener("devtools-opened", onOpened);
      target.removeListener("devtools-closed", entry.dispose);
      target.removeListener("destroyed", entry.dispose);
      target.removeListener("did-start-navigation", onNavigation);
      contents.removeListener("before-input-event", onInput);
      contents.removeListener("destroyed", entry.dispose);
      contents.removeListener("render-process-gone", entry.dispose);
      if (!entry.loaded) rejectReady(new Error("开发者工具已关闭"));
      if (!parent.isDestroyed()) parent.contentView.removeChildView(view);
      if (!target.isDestroyed()) target.closeDevTools();
      if (!contents.isDestroyed()) contents.close();
      this.#publish();
    };
    target.once("devtools-opened", onOpened);
    target.on("devtools-closed", entry.dispose);
    target.once("destroyed", entry.dispose);
    target.on("did-start-navigation", onNavigation);
    contents.on("before-input-event", onInput);
    contents.once("destroyed", entry.dispose);
    contents.once("render-process-gone", entry.dispose);
    timer = setTimeout(() => {
      rejectReady(new Error("开发者工具启动超时，请重试"));
      entry.dispose();
    }, this.#options.openTimeoutMs ?? 15000);
    this.#publish();
    try {
      target.setDevToolsWebContents(contents);
      // The frontend is embedded in our child view; Electron must not create its own window.
      target.openDevTools({ mode: "detach", activate: false });
    } catch (error) {
      rejectReady(error);
      entry.dispose();
    }
    return entry;
  }
}
