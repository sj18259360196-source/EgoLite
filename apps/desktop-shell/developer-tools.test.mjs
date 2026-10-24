import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DeveloperTools } from "./developer-tools.mjs";
import { contextMenuInspectionPoint, formatElementContext, pointWithinQuad, resolveInspectionPoint, selectedElementExpression } from "./developer-tools-context.mjs";

const context = {
  selector: "#save", frameUrl: "https://example.test/editor", html: '<button id="save">Save</button>',
  bounds: { x: 10, y: 20, width: 100, height: 40 }, styles: { color: "rgb(0, 0, 0)" },
  viewport: { width: 1200, height: 900, devicePixelRatio: 1 }, shadowHosts: [],
};

function harness(options = {}) {
  const windows = [];
  const copied = [];
  const errors = [];
  const states = [];
  const parent = {
    isDestroyed: () => false, getContentSize: () => [1200, 900],
    webContents: { getZoomFactor: () => 1 },
    contentView: {
      children: [],
      addChildView(view) { this.children.push(view); },
      removeChildView(view) { this.children = this.children.filter(item => item !== view); },
    },
  };
  class View extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.expressions = [];
      this.webContents = new EventEmitter();
      this.webContents.isDestroyed = () => this.destroyed === true;
      this.webContents.close = () => { this.destroyed = true; this.webContents.emit("destroyed"); };
      this.webContents.focus = () => { this.focused = true; };
      this.webContents.executeJavaScript = async expression => {
        this.expressions.push(expression);
        return expression === selectedElementExpression ? this.context : true;
      };
      windows.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
    isDestroyed() { return this.destroyed === true; }
    destroy() { this.webContents.close(); }
  }
  const manager = new DeveloperTools({
    createView: config => new View(config),
    resolvePoint: async (_target, point) => ({ backendNodeId: 17, frameId: "main", ...point }),
    getParent: () => parent, writeClipboard: text => copied.push(text),
    onState: state => states.push(state), onError: error => errors.push(error), ...options,
  });
  const page = id => {
    const target = new EventEmitter();
    Object.assign(target, {
      id, opened: false, title: `Tab ${id}`, destroyed: false, openCount: 0, closeCount: 0,
      isDestroyed() { return this.destroyed; },
      getTitle() { return this.title; },
      isDevToolsOpened() { return this.opened; },
      setDevToolsWebContents(contents) { this.tools = contents; },
      openDevTools() {
        this.opened = true;
        this.openCount += 1;
        if (!options.holdOpen) queueMicrotask(() => this.emit("devtools-opened"));
      },
      closeDevTools() { this.opened = false; this.closeCount += 1; this.emit("devtools-closed"); },
      inspectElement(x, y) { this.point = { x, y }; },
      focus() { this.focused = true; },
    });
    return target;
  };
  return { manager, windows, page, parent, copied, errors, states };
}

test("F12 embeds a child view in the existing browser without creating a window", async () => {
  const { manager, windows, page, parent } = harness();
  const target = page(1);
  assert.equal(await manager.toggle(target), true);
  assert.equal(target.tools, windows[0].webContents);
  assert.ok(windows[0].expressions.some(value => value.includes('showPanel("elements")')));
  assert.equal(windows[0].config.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].config.webPreferences.sandbox, true);
  assert.deepEqual(parent.contentView.children, [windows[0]]);
  assert.equal(windows[0].visible, false);
  assert.deepEqual(manager.state(), [{ webContentsId: 1, ready: true, panel: "elements" }]);
  assert.equal(await manager.toggle(target), false);
  assert.equal(windows[0].destroyed, true);
  assert.equal(target.closeCount, 1);
  assert.equal(target.listenerCount("devtools-opened"), 0);
  assert.equal(target.listenerCount("devtools-closed"), 0);
  assert.equal(target.listenerCount("destroyed"), 0);
  assert.equal(parent.contentView.children.length, 0);
});

test("concurrent opens share one view and allow selecting the sources panel", async () => {
  const { manager, windows, page } = harness();
  const target = page(1);
  await Promise.all([manager.open(target), manager.open(target, { panel: "sources" })]);
  assert.equal(windows.length, 1);
  assert.equal(target.openCount, 1);
  assert.ok(windows[0].expressions.some(value => value.includes('showPanel("sources")')));
  manager.dispose();
});

test("inspection uses native picker and captures the node before opening the panel", async () => {
  let resolvedPoint;
  const { manager, windows, page } = harness({
    resolvePoint: async (_target, point) => {
      assert.equal(windows.length, 1);
      resolvedPoint = point;
      return { backendNodeId: 17, frameId: "main" };
    },
  });
  const target = page(1);
  await manager.open(target, { inspect: true });
  assert.ok(windows[0].expressions.includes("DevToolsAPI.enterInspectElementMode(); true"));
  assert.equal(target.focused, true);
  await manager.open(target, { point: { x: 41.2, y: 58.8 } });
  assert.deepEqual(resolvedPoint, { x: 41, y: 59, includeUserAgentShadowDOM: true });
  assert.ok(windows[0].expressions.some(value => value.includes('"backendNodeId":17') && value.includes("DeferredDOMNode")));
  await assert.rejects(manager.open(target, { point: { x: NaN, y: 0 } }), /位置无效/);
  manager.dispose();
});

test("tool views remain bound to their own tab and closing one leaves the other intact", async () => {
  const { manager, windows, page } = harness();
  const a = page(1), b = page(2);
  await manager.open(a);
  await manager.open(b);
  manager.close(a);
  assert.equal(windows[0].destroyed, true);
  assert.notEqual(windows[1].destroyed, true);
  assert.equal(b.opened, true);
  manager.dispose();
  assert.equal(windows[1].destroyed, true);
});

test("closing a page, native tools or child view releases listeners and owned web contents", async () => {
  for (const source of ["target", "tools", "window"]) {
    const { manager, windows, page } = harness();
    const target = page(1);
    await manager.open(target);
    if (source === "target") { target.destroyed = true; target.emit("destroyed"); }
    if (source === "tools") { target.opened = false; target.emit("devtools-closed"); }
    if (source === "window") windows[0].destroy();
    assert.equal(windows[0].destroyed, true, source);
    assert.equal(target.listenerCount("page-title-updated"), 0, source);
    assert.equal(windows[0].webContents.listenerCount("before-input-event"), 0, source);
    manager.dispose();
  }
});

test("F12 also works when tools have focus and key repeat does not toggle", async () => {
  const { manager, windows, page } = harness();
  const target = page(1);
  await manager.open(target);
  let prevented = 0;
  const event = { preventDefault() { prevented += 1; } };
  windows[0].webContents.emit("before-input-event", event, { type: "keyDown", key: "F12", isAutoRepeat: true });
  assert.equal(target.opened, true);
  windows[0].webContents.emit("before-input-event", event, { type: "keyDown", key: "F12" });
  assert.equal(target.opened, false);
  assert.equal(prevented, 2);
});

test("copy reads the selected node in the tools session and requires explicit selection", async () => {
  const { manager, windows, page, copied } = harness();
  const target = page(1);
  await assert.rejects(manager.copySelected(target), /先打开/);
  await manager.open(target);
  await assert.rejects(manager.copySelected(target), /先在/);
  assert.equal(copied.length, 0);
  windows[0].context = context;
  await manager.copySelected(target);
  assert.equal(copied.length, 1);
  assert.match(copied[0], /#save/);
  assert.match(copied[0], /color: rgb\(0, 0, 0\)/);
  assert.match(copied[0], /尚未定位到项目源文件/);
  manager.dispose();
});

test("copy never writes stale results after the inspected tab closes", async () => {
  const { manager, windows, page, copied } = harness();
  const target = page(1);
  await manager.open(target);
  let finish;
  windows[0].webContents.executeJavaScript = () => new Promise(resolve => { finish = resolve; });
  const pending = manager.copySelected(target);
  await Promise.resolve();
  manager.close(target);
  finish(context);
  await assert.rejects(pending, /已经关闭/);
  assert.equal(copied.length, 0);
});

test("layout only shows the current tab and clamps to the host content bounds", async () => {
  const { manager, windows, page } = harness();
  const target = page(1);
  await manager.open(target);
  await manager.open(page(2));
  manager.layout({ webContentsId: 1, visible: true, bounds: { x: 700, y: 150, width: 600, height: 800 } });
  assert.deepEqual(windows[0].bounds, { x: 700, y: 150, width: 500, height: 750 });
  assert.equal(windows[0].visible, true);
  assert.equal(windows[1].visible, false);
  manager.layout({ webContentsId: 2, visible: true, bounds: { x: 700, y: 150, width: 400, height: 600 } });
  assert.equal(windows[0].visible, false);
  assert.equal(windows[1].visible, true);
  manager.layout({ webContentsId: 2, visible: false });
  assert.equal(windows[1].visible, false);
  manager.layout({ webContentsId: 2, visible: true, bounds: { x: NaN, y: 0, width: 400, height: 600 } });
  assert.equal(windows[1].visible, false);
  manager.dispose();
});

test("copy rejects a result captured during navigation", async () => {
  const { manager, windows, page, copied } = harness();
  const target = page(1);
  await manager.open(target);
  let finish;
  windows[0].webContents.executeJavaScript = () => new Promise(resolve => { finish = resolve; });
  const pending = manager.copySelected(target);
  await Promise.resolve();
  target.emit("did-start-navigation", {}, "https://example.test/next", false, true);
  finish(context);
  await assert.rejects(pending, /页面已变化/);
  assert.equal(copied.length, 0);
  manager.dispose();
});

test("opening timeout releases the window and permits retry", async () => {
  const { manager, windows, page } = harness({ holdOpen: true, openTimeoutMs: 5 });
  const target = page(1);
  await assert.rejects(manager.open(target), /启动超时/);
  assert.equal(windows[0].destroyed, true);
  assert.equal(target.listenerCount("devtools-opened"), 0);
  const pending = manager.open(target);
  target.emit("devtools-opened");
  await pending;
  manager.dispose();
});

test("closing while tools load rejects pending actions without leaking a window", async () => {
  const { manager, windows, page } = harness({ holdOpen: true });
  const target = page(1);
  const pending = manager.open(target);
  assert.equal(await manager.toggle(target), false);
  await assert.rejects(pending, /已关闭/);
  assert.equal(windows[0].destroyed, true);
  await assert.rejects(manager.open({ isDestroyed: () => true }), /页面已经关闭/);
});

test("native startup failure is recoverable", async () => {
  const { manager, windows, page } = harness();
  const target = page(1);
  target.openDevTools = () => { throw new Error("fixture startup failure"); };
  await assert.rejects(manager.open(target), /fixture startup failure/);
  assert.equal(windows[0].destroyed, true);
  assert.equal(target.listenerCount("devtools-opened"), 0);
});

test("context formatting preserves shadow paths and safely fences page markup", () => {
  const result = formatElementContext({ ...context, shadowHosts: ["#editor", "#widget"], html: "<div>```</div>", truncated: true });
  assert.match(result, /Shadow DOM.*#editor.*#widget/);
  assert.match(result, /````html/);
  assert.match(result, /HTML 已截断/);
});

test("native context menu coordinates account for the webview offset and both zoom factors", () => {
  assert.deepEqual(contextMenuInspectionPoint({ x: 58, y: 243 }, { x: 14, y: 146 }), { x: 44, y: 97 });
  assert.deepEqual(contextMenuInspectionPoint({ x: 81, y: 301 }, { x: 14, y: 146 }, 1.5, 1.25), { x: 48, y: 65.6 });
  assert.throws(() => contextMenuInspectionPoint({ x: 1, y: 2 }, null), /网页位置/);
  assert.throws(() => contextMenuInspectionPoint({ x: 1, y: 2 }, { x: 0, y: 0 }, 1, 0), /网页位置/);
});

test("iframe hit testing converts transformed content quads to normalized child coordinates", async () => {
  assert.deepEqual(pointWithinQuad({ x: 60, y: 45 }, [10, 20, 110, 20, 110, 120, 10, 120]), { x: 0.5, y: 0.25 });
  assert.deepEqual(pointWithinQuad({ x: 85, y: 70 }, [110, 20, 110, 120, 10, 120, 10, 20]), { x: 0.5, y: 0.25 });
  assert.throws(() => pointWithinQuad({ x: 1, y: 1 }, [0, 0, 0, 0, 0, 0, 0, 0]), /不可见/);
  const calls = [];
  const hit = await resolveInspectionPoint(async (method, params) => {
    calls.push({ method, params });
    if (method === "DOM.getNodeForLocation") return { backendNodeId: 12, frameId: "parent" };
    if (method === "DOM.describeNode") return { node: { nodeName: "IFRAME", frameId: "child" } };
    return { model: { content: [10, 20, 110, 20, 110, 120, 10, 120] } };
  }, { x: 60, y: 45 });
  assert.deepEqual(hit, { backendNodeId: 12, frameId: "parent", childFrameId: "child", framePoint: { x: 0.5, y: 0.25 } });
  assert.equal(calls.length, 3);
});

test("developer tools are reachable through the authorized shell IPC and existing UI", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  assert.match(main, /event\.sender\.id !== mainWindow\?\.webContents\.id/);
  assert.match(main, /if \(!isEgoGuestContents\(target\)\) throw/);
  assert.match(main, /inspectContextMenuTarget\(target, params\)/);
  assert.match(main, /contextMenuInspectionPoint\(params, bounds, host\.getZoomFactor\(\), target\.getZoomFactor\(\)\)/);
  assert.match(main, /developerTools\.dispose\(\)/);
  for (const id of ["browser-devtools", "browser-inspect", "browser-copy-element"]) {
    assert.ok(html.includes(`id="${id}"`));
    assert.ok(app.includes(`$("#${id}").addEventListener`));
  }
});
