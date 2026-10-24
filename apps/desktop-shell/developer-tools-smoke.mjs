import assert from "node:assert/strict";
import { BrowserWindow, clipboard, desktopCapturer, Menu, webContents } from "electron";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { captureElementContext, selectedElementExpression } from "./developer-tools-context.mjs";

export async function runDeveloperToolsSmoke({ window, developerTools, desktopBrowser, getTabs, getVisibleId, showContextMenu, output, fixtureUrl, exit }) {
  const checks = {};
  const evaluate = expression => window.webContents.executeJavaScript(expression);
  const invoke = (method, payload) => evaluate(`window.egoDesktop.invoke(${JSON.stringify(method)}, ${JSON.stringify(payload)})`);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, label) => {
    const deadline = Date.now() + 15000;
    let lastError;
    while (Date.now() < deadline) {
      try { const result = await condition(); if (result) return result; } catch (error) { lastError = error; }
      await sleep(50);
    }
    throw new Error(label, { cause: lastError });
  };
  const copied = [];
  const captureWindow = async name => {
    window.show();
    window.focus();
    await sleep(200);
    const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 2400, height: 1600 } });
    const source = sources.find(item => item.id === window.getMediaSourceId());
    assert.ok(source && !source.thumbnail.isEmpty(), "Native window capture unavailable");
    writeFileSync(join(dirname(output), name), source.thumbnail.toPNG());
  };
  const originalWrite = clipboard.writeText;
  clipboard.writeText = text => copied.push(text);
  let failed;
  let debug;
  const nativeContexts = [];
  try {
    await until(() => evaluate('document.querySelector("#connection")?.textContent === "本地运行中"'), "Shell not ready");
    const task = await invoke("task.create", { name: "Developer tools verification" });
    await invoke("tab.open", { taskId: task.taskId, url: fixtureUrl, visual: true });
    const tab = await until(() => getTabs().find(tab => tab.webContentsId === getVisibleId() && tab.url === fixtureUrl), "Fixture tab not visible");
    const target = webContents.fromId(tab.webContentsId);
    await until(() => target.executeJavaScript('!!document.querySelector("#inspect-button")'), "Fixture not ready");
    let detachments = 0;
    target.debugger.on("detach", () => { detachments += 1; });
    const payload = { targetId: tab.targetId, webContentsId: target.id };
    const key = (contents, key, modifiers = {}) => {
      let prevented = false;
      contents.emit("before-input-event", { preventDefault() { prevented = true; } }, { type: "keyDown", key, ...modifiers });
      assert.equal(prevented, true, `${key} was not handled`);
    };
    const select = async (selector, expression) => {
      const point = await target.executeJavaScript(expression || `(() => {
        const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      await developerTools.open(target, { point });
      return until(async () => {
        const selected = await target.devToolsWebContents.executeJavaScript(selectedElementExpression);
        return selected?.selector === selector ? selected : null;
      }, `Wrong selected element for ${selector}`);
    };
    window.show();
    window.focus();
    await until(() => evaluate('document.visibilityState === "visible"'), "Verification window not visible");
    key(window.webContents, "F12");
    const tools = await until(() => target.devToolsWebContents, "Shell F12 did not open tools");
    const toolView = await until(() => window.contentView.children.find(view => view.webContents === tools), "Tools are not docked in the browser");
    await until(() => toolView.getVisible(), "Tools not visible");
    assert.equal(BrowserWindow.getAllWindows().length, 1, "Developer tools created a separate window");
    const readLayout = () => evaluate(`(() => {
      const page = document.querySelector("webview:not([hidden])").getBoundingClientRect();
      const panel = document.querySelector("#devtools-pane").getBoundingClientRect();
      const host = document.querySelector("#devtools-host").getBoundingClientRect();
      return { page: page.toJSON(), panel: panel.toJSON(), host: host.toJSON() };
    })()`);
    let layout = await readLayout();
    assert.ok(Math.abs(layout.page.right - layout.panel.left) <= 2);
    assert.ok(layout.page.width >= 220);
    checks.rightDockedNoExtraWindow = true;
    checks.shellF12 = true;
    assert.equal(target.debugger.isAttached(), true);
    const context = await select("#inspect-button");
    assert.match(context.html, /Inspect this button/);
    assert.equal(context.styles["background-color"], "rgb(25, 122, 100)");
    await invoke("browser.devtools.copy", payload);
    assert.match(copied.at(-1), /#inspect-button/);
    checks.copyThroughAuthorizedIpc = true;
    checks.nativeElementsAndStyles = true;
    const nativeMenuBuilder = Menu.buildFromTemplate;
    let menu;
    try {
      Menu.buildFromTemplate = template => { menu = template; return { popup() {} }; };
      const point = await target.executeJavaScript(`(() => {
        const r = document.querySelector("#inspect-heading").getBoundingClientRect();
        return { x: Math.round(r.x + 10), y: Math.round(r.y + 10) };
      })()`);
      layout = await readLayout();
      showContextMenu(tab, target, {
        x: point.x + layout.page.x, y: point.y + layout.page.y,
        pageURL: fixtureUrl, mediaType: "none", isEditable: false,
      });
      const item = menu.find(item => item.label === "检查");
      assert.ok(item);
      item.click();
    } finally { Menu.buildFromTemplate = nativeMenuBuilder; }
    await until(async () => (await target.devToolsWebContents.executeJavaScript(selectedElementExpression))?.selector === "#inspect-heading", "Context menu inspection missed the clicked element");
    checks.contextMenuCoordinates = true;
    for (const zoom of [1, 1.25]) {
      target.setZoomFactor(zoom);
      await sleep(150);
      const nativePoint = await target.executeJavaScript(`(() => {
        const r = document.querySelector("#inspect-button").getBoundingClientRect();
        return { x: Math.round((r.x + 16) * ${zoom}), y: Math.round((r.bottom - 6) * ${zoom}) };
      })()`);
      menu = null;
      try {
        target.once("context-menu", (_event, params) => nativeContexts.push({
          zoom, nativePoint, params: { x: params.x, y: params.y, frameURL: params.frameURL, pageURL: params.pageURL },
        }));
        Menu.buildFromTemplate = template => { menu = template; return { popup() {} }; };
        target.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...nativePoint });
        target.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, ...nativePoint });
        await until(() => menu, "Native context menu was not emitted");
        menu.find(item => item.label === "检查").click();
        await until(async () => (await target.devToolsWebContents.executeJavaScript(selectedElementExpression))?.selector === "#inspect-button", `Native context menu selected the wrong element at zoom ${zoom}`);
      } finally { Menu.buildFromTemplate = nativeMenuBuilder; }
      await select("#inspect-heading");
    }
    target.setZoomFactor(1);
    checks.nativeContextMenuAt125Percent = true;
    key(target, "C", { control: true, shift: true });
    await sleep(250);
    const point = await target.executeJavaScript(`(() => {
      const r = document.querySelector("#inspect-button").getBoundingClientRect();
      return { x: Math.round(r.x + 20), y: Math.round(r.y + 15) };
    })()`);
    target.sendInputEvent({ type: "mouseMove", ...point });
    await sleep(100);
    target.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    target.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await until(async () => (await target.devToolsWebContents.executeJavaScript(selectedElementExpression))?.selector === "#inspect-button", "Native element picker did not select the button");
    assert.equal(await target.executeJavaScript("document.querySelector('#inspect-button').dataset.clicks || '0'"), "0");
    checks.pickerInterceptsClick = true;
    const snapshot = await desktopBrowser.snapshot(target);
    assert.ok(JSON.stringify(snapshot).includes("Inspect this button"));
    await desktopBrowser.sendNativeCommand(target, "Runtime.evaluate", { expression: "document.querySelector('#inspect-button').dataset.agent = 'verified'" });
    assert.equal(await target.executeJavaScript("document.querySelector('#inspect-button').dataset.agent"), "verified");
    assert.equal(detachments, 0);
    checks.agentAutomationWhileToolsOpen = true;
    await sleep(250);
    writeFileSync(join(dirname(output), "elements.png"), (await tools.capturePage()).toPNG());
    await captureWindow("browser-docked.png");
    await invoke("browser.devtools.sources", payload);
    const selectedPanel = () => tools.executeJavaScript(`(async () => {
      const UI = await import("./ui/legacy/legacy.js");
      return UI.InspectorView.InspectorView.instance().tabbedPane.selectedTabId;
    })()`);
    await until(async () => await selectedPanel() === "sources", "Sources panel did not open");
    writeFileSync(join(dirname(output), "sources.png"), (await tools.capturePage()).toPNG());
    checks.nativeSources = true;
    await developerTools.open(target, { panel: "elements" });
    window.unmaximize();
    window.setSize(900, 650);
    await until(async () => (await readLayout()).panel.width <= 480, "Compact layout did not settle");
    await select("#inspect-button");
    await sleep(250);
    layout = await readLayout();
    assert.ok(layout.page.width >= 220);
    assert.ok(layout.panel.width >= 280);
    assert.ok(Math.abs(layout.page.right - layout.panel.left) <= 2);
    const treeHeight = await tools.executeJavaScript(`(async () => {
      const Elements = await import("./panels/elements/elements.js");
      return Elements.ElementsPanel.ElementsPanel.instance().splitWidget.mainWidget().element.getBoundingClientRect().height;
    })()`);
    assert.ok(treeHeight >= 100, `Compact element tree collapsed to ${treeHeight}px`);
    await captureWindow("elements-compact.png");
    checks.compactWindow = true;
    window.maximize();
    await sleep(250);
    const shadow = await select("#shadow-button", `(() => {
      const r = document.querySelector("#shadow-host").shadowRoot.querySelector("button").getBoundingClientRect();
      return { x: Math.round(r.x + 15), y: Math.round(r.y + 10) };
    })()`);
    assert.deepEqual(shadow.shadowHosts, ["#shadow-host"]);
    checks.shadowDom = true;
    await until(() => target.executeJavaScript("document.querySelector('#same-frame').contentDocument?.querySelector('#same-button') != null"), "Same-origin frame not loaded");
    const same = await select("#same-button", `(() => {
      const frame = document.querySelector("#same-frame");
      const f = frame.getBoundingClientRect(), r = frame.contentDocument.querySelector("button").getBoundingClientRect();
      return { x: Math.round(f.x + r.x + 15), y: Math.round(f.y + r.y + 10) };
    })()`);
    assert.ok(same.frameUrl.includes("/same"));
    checks.sameOriginFrame = true;
    const cross = await select("#cross-button", `(() => {
      const f = document.querySelector("#cross-frame").getBoundingClientRect();
      return { x: Math.round(f.x + 25), y: Math.round(f.y + 20) };
    })()`);
    assert.ok(cross.frameUrl.includes("frame.test"));
    checks.crossOriginFrame = true;
    const sanitized = await target.executeJavaScript(`(${captureElementContext.toString()}).call(document.querySelector("#private-fixture"))`);
    for (const secret of ["password-value", "token-value", "textarea-value", "editable-value", "script-value", "query-secret"]) {
      assert.ok(!sanitized.html.includes(secret), `Leaked ${secret}`);
    }
    assert.ok(sanitized.html.includes("Public label"));
    checks.contextRedaction = true;
    await select("#inspect-button");
    await target.loadURL(fixtureUrl + "next");
    await until(() => target.executeJavaScript("document.title === 'Next document'"), "Navigation did not complete");
    const afterNavigation = await tools.executeJavaScript(selectedElementExpression);
    assert.notEqual(afterNavigation?.selector, "#inspect-button");
    assert.ok(!afterNavigation?.html?.includes("Inspect this button"));
    checks.navigationClearsOldSelection = true;
    key(tools, "F12");
    await until(() => tools.isDestroyed(), "F12 in tools did not release the child view");
    checks.toolsF12ClosesPanel = true;
    key(target, "I", { control: true, shift: true });
    await until(() => target.devToolsWebContents && !target.devToolsWebContents.isDestroyed(), "Guest Ctrl+Shift+I did not reopen tools");
    checks.guestShortcut = true;
    const nextTools = await until(() => target.devToolsWebContents, "Reopen failed");
    const nextView = await until(() => window.contentView.children.find(view => view.webContents === nextTools), "Reopen view missing");
    await until(() => nextView.getVisible(), "Reopened tools not visible");
    await invoke("tab.open", { taskId: task.taskId, url: fixtureUrl + "second", visual: true });
    const otherTab = await until(() => getTabs().find(tab => tab.webContentsId === getVisibleId() && tab.targetId !== payload.targetId), "Second tab not visible");
    const other = webContents.fromId(otherTab.webContentsId);
    await until(() => !other.isLoading(), "Second tab loading");
    await invoke("browser.devtools.toggle", { targetId: otherTab.targetId, webContentsId: other.id });
    const otherTools = other.devToolsWebContents;
    assert.notEqual(nextTools.id, otherTools.id);
    assert.equal(nextView.getVisible(), false);
    const otherView = window.contentView.children.find(view => view.webContents === otherTools);
    await until(() => otherView.getVisible(), "Second tab's tools not visible");
    await invoke("tab.close", { targetId: tab.targetId });
    await until(() => nextTools.isDestroyed(), "Closed tab left its tools view open");
    assert.equal(otherTools.isDestroyed(), false);
    checks.perTabIsolationAndCleanup = true;
    await evaluate("document.querySelector('#browser-more').click()");
    assert.equal(await evaluate("!document.querySelector('#browser-more-menu').hidden && !!document.querySelector('#browser-inspect svg')"), true);
    await until(() => !otherView.getVisible(), "Native tools cover browser menu");
    writeFileSync(join(dirname(output), "browser-menu.png"), (await window.webContents.capturePage()).toPNG());
    checks.browserMenu = true;
    await evaluate("document.querySelector('#browser-more').click()");
    await until(() => otherView.getVisible(), "Tools did not return after closing menu");
    await evaluate(`document.querySelector("#devtools-resizer").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))`);
    await until(async () => (await readLayout()).panel.width > 480, "Resize did not adjust panel width");
    checks.resizablePanel = true;
    layout = await readLayout();
    const oldWidth = layout.panel.width;
    const dividerPoint = { x: Math.round(layout.panel.x + 1), y: Math.round(layout.panel.y + 16) };
    window.webContents.sendInputEvent({ type: "mouseMove", ...dividerPoint });
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...dividerPoint });
    await until(() => !otherView.getVisible(), "Divider did not capture a real pointer drag");
    window.webContents.sendInputEvent({ type: "mouseMove", x: dividerPoint.x - 32, y: dividerPoint.y, modifiers: ["leftButtonDown"] });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: dividerPoint.x - 32, y: dividerPoint.y });
    await until(async () => (await readLayout()).panel.width >= oldWidth + 28 && otherView.getVisible(), "Pointer drag did not resize and restore the docked view");
    checks.pointerResize = true;
    await evaluate("document.querySelector('#devtools-close').click()");
    await until(() => otherTools.isDestroyed(), "Close button left native view alive");
    checks.closeButton = true;
    await assert.rejects(invoke("browser.devtools.toggle", { webContentsId: window.webContents.id }));
    checks.shellTargetRejected = true;
  } catch (error) {
    failed = error;
    const guest = webContents.fromId(getVisibleId());
    const inspector = guest?.devToolsWebContents;
    if (inspector && !inspector.isDestroyed()) {
      await inspector.capturePage().then(image => writeFileSync(join(dirname(output), "failure.png"), image.toPNG())).catch(() => {});
    }
    debug = {
      nativeContexts,
      tabs: getTabs(),
      contents: webContents.getAllWebContents().map(contents => ({ id: contents.id, type: contents.getType(), title: contents.getTitle(), tools: contents.isDevToolsOpened(), devtoolsId: contents.devToolsWebContents?.id })),
      shell: await evaluate(`({
        address: document.querySelector("#current-address").value,
        active: document.querySelector(".browser-tab.active")?.dataset.targetId,
        visibility: document.visibilityState,
        paneHidden: document.querySelector("#devtools-pane").hidden,
        startClass: document.querySelector("#start-view").className,
        views: [...document.querySelectorAll("webview")].map(view => ({ targetId: view.dataset.targetId, hidden: view.hidden, id: (() => { try { return view.getWebContentsId(); } catch { return 0; } })() })),
        toast: document.querySelector(".toast")?.textContent,
      })`).catch(() => null),
      selected: await inspector?.executeJavaScript(selectedElementExpression).catch(error => ({ error: error.message })),
      page: await guest?.executeJavaScript(`({
        button: document.querySelector("#inspect-button")?.getBoundingClientRect().toJSON(),
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      })`).catch(() => null),
    };
  } finally {
    clipboard.writeText = originalWrite;
    developerTools.dispose();
  }
  writeFileSync(output, JSON.stringify({ passed: !failed, checks, ...(failed ? { error: failed.stack, cause: failed.cause?.stack, debug } : {}) }, null, 2));
  exit(failed ? 1 : 0);
}
