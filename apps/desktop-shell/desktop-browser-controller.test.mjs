import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  DesktopBrowserController,
  normalizeSnapshotOptions,
  serializeSnapshot,
  serializeSnapshotCandidates,
} from "./desktop-browser-controller.mjs";

test("scoped root keyboard uses native events once without focusing or CDP replay", async () => {
  const events = [];
  const target = {
    id: 92,
    sendInputEvent: (event) => events.push(event),
    focus() { throw new Error("Must not steal focus"); },
    debugger: { isAttached() { throw new Error("Must not attach for native platform input"); } },
  };
  const controller = new DesktopBrowserController();
  const send = (params) => controller.sendNativeCommand(target, "Input.dispatchKeyEvent", params, undefined, { allowRootElectronKey: true });
  await send({ type: "keyDown", key: "C", text: "C", modifiers: 0 });
  await send({ type: "keyUp", key: "C", modifiers: 0 });
  await send({ type: "keyDown", key: "Tab", text: "\t", modifiers: 8 });
  await send({ type: "keyDown", key: "a", text: "a", modifiers: 2 });
  assert.deepEqual(events.map((event) => [event.type, event.keyCode]), [
    ["keyDown", "C"], ["char", "C"], ["keyUp", "C"], ["keyDown", "Tab"], ["keyDown", "a"],
  ]);
  assert.deepEqual(events[3].modifiers, ["shift"]);
  assert.deepEqual(events[4].modifiers, ["control"]);
});

function domSnapshot(records, scale = 1) {
  const strings = [];
  const stringIndex = (value) => {
    let index = strings.indexOf(value);
    if (index < 0) { strings.push(value); index = strings.length - 1; }
    return index;
  };
  return {
    strings,
    documents: [{
      contentWidth: 300 * scale,
      contentHeight: 1880 * scale,
      nodes: {
        backendNodeId: records.map((record) => record.id),
        nodeName: records.map((record) => stringIndex(record.nodeName || "BUTTON")),
        attributes: records.map((record) => Object.entries(record.attributes || {}).flatMap(([key, value]) => [stringIndex(key), stringIndex(value)])),
      },
      layout: {
        nodeIndex: records.filter((record) => record.bounds).map((_record, index) => index),
        bounds: records.filter((record) => record.bounds).map((record) => record.bounds.map((value) => value * scale)),
      },
    }],
  };
}

function targetFixture(pageY = 0, coordinateScale = 1) {
  const nodes = [
    { nodeId: "1", backendDOMNodeId: 1, role: { value: "button" }, name: { value: "Top" } },
    { nodeId: "2", backendDOMNodeId: 2, role: { value: "StaticText" }, name: { value: "Intro" } },
    { nodeId: "3", backendDOMNodeId: 3, role: { value: "button" }, name: { value: "BottomUnique" } },
    { nodeId: "4", backendDOMNodeId: 4, role: { value: "button" }, name: { value: "Hidden" } },
    { nodeId: "5", backendDOMNodeId: 5, role: { value: "button" }, name: { value: "Duplicate" } },
    { nodeId: "6", backendDOMNodeId: 6, role: { value: "button" }, name: { value: "Duplicate" } },
  ];
  const dom = domSnapshot([
    { id: 1, bounds: [10, 10, 80, 30], attributes: { id: "top-action" } },
    { id: 2, bounds: [10, 50, 80, 20] },
    { id: 3, bounds: [10, 1000, 100, 30], attributes: { "data-testid": "bottom" } },
    { id: 4, bounds: [0, 0, 0, 0] },
    { id: 5, bounds: [10, 70, 80, 20] },
    { id: 6, bounds: [110, 70, 80, 20] },
  ], coordinateScale);
  const calls = [];
  let attached = false;
  const debuggerApi = {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    async sendCommand(method) {
      calls.push(method);
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes };
      if (method === "DOMSnapshot.captureSnapshot") return dom;
      if (method === "Page.getLayoutMetrics") return {
        contentSize: { width: 300 * coordinateScale, height: 1880 * coordinateScale },
        cssContentSize: { width: 300, height: 1880 },
        cssVisualViewport: { pageX: 0, pageY, clientWidth: 300, clientHeight: 100 },
        layoutViewport: { pageX: 0, pageY: pageY * coordinateScale, clientWidth: 300 * coordinateScale, clientHeight: 100 * coordinateScale },
      };
      throw new Error(`Unexpected command ${method}`);
    },
  };
  return {
    calls,
    target: { id: 1, debugger: debuggerApi, getTitle: () => "Fixture", getURL: () => "https://fixture.test" },
  };
}

test("default snapshot remains full-page and keeps named static refs", async () => {
  const fixture = targetFixture();
  const snapshot = await new DesktopBrowserController().snapshot(fixture.target);
  assert.match(snapshot.content, /button "Top" \[@1\]/);
  assert.match(snapshot.content, /StaticText "Intro" \[@2\]/);
  assert.match(snapshot.content, /BottomUnique/);
  assert.doesNotMatch(snapshot.content, /Hidden/);
  assert.equal(snapshot.refs.some((ref) => ref.backendNodeId === 2), true);
  assert.equal(snapshot.refs.some((ref) => ref.stableLocator), false);
});

test("viewport alias filters by visual viewport and follows scrolling", async () => {
  const top = await new DesktopBrowserController().snapshot(targetFixture(0).target, { scope: "viewport" });
  assert.match(top.content, /Top/);
  assert.doesNotMatch(top.content, /BottomUnique/);
  const bottom = await new DesktopBrowserController().snapshot(targetFixture(950).target, { scope: "only_within_viewport" });
  assert.doesNotMatch(bottom.content, /Top/);
  assert.match(bottom.content, /BottomUnique/);
});

test("viewport normalizes DOMSnapshot layout units across DPI and page zoom", async () => {
  const dpi2 = await new DesktopBrowserController().snapshot(targetFixture(950, 2).target, { scope: "viewport" });
  assert.match(dpi2.content, /BottomUnique/);
  assert.doesNotMatch(dpi2.content, /Top/);

  const dpi2Zoom15 = await new DesktopBrowserController().snapshot(targetFixture(950, 3).target, { scope: "viewport" });
  assert.match(dpi2Zoom15.content, /BottomUnique/);
  assert.doesNotMatch(dpi2Zoom15.content, /Top/);
});

test("action marks and conservative stable locators are independently controlled", async () => {
  const snapshot = await new DesktopBrowserController().snapshot(targetFixture().target, {
    includeActionMarks: false,
    includeStableLocator: true,
  });
  assert.doesNotMatch(snapshot.content, /\[@\d+\]/);
  assert.match(snapshot.content, /loc="css:\[id=\\"top-action\\"\]"/);
  assert.equal(snapshot.refs.length, 5);
  assert.equal(snapshot.refs.find((ref) => ref.backendNodeId === 1).stableLocator, 'css:[id="top-action"]');
  assert.equal(snapshot.refs.find((ref) => ref.backendNodeId === 5).stableLocator, undefined);
});

test("CSS stable locators safely quote leading digits, whitespace, and controls", () => {
  const nodes = [{ backendDOMNodeId: 1, role: { value: "button" }, name: { value: "Odd id" } }];
  const dom = new Map([[1, {
    nodeName: "BUTTON",
    attributes: { id: "123 odd\nvalue" },
    bounds: [0, 0, 10, 10],
  }]]);
  const snapshot = serializeSnapshot(nodes, dom, undefined, normalizeSnapshotOptions({ includeStableLocator: true }));
  assert.equal(snapshot.refs[0].stableLocator, 'css:[id="123 odd\\a value"]');
});

test("unknown scopes and unsafe tiny result limits fail explicitly", () => {
  assert.throws(() => normalizeSnapshotOptions({ scope: "visible" }), /Unsupported snapshot scope/);
  assert.throws(() => normalizeSnapshotOptions({ maxResultLength: 20 }), /at least 64/);
});

test("full-page capture falls back to AX when DOM geometry is unavailable, while viewport fails", async () => {
  const fullFixture = targetFixture();
  const fullSend = fullFixture.target.debugger.sendCommand;
  fullFixture.target.debugger.sendCommand = (method) => method === "DOMSnapshot.captureSnapshot"
    ? Promise.reject(new Error("DOM snapshot unavailable"))
    : fullSend(method);
  const full = await new DesktopBrowserController().snapshot(fullFixture.target);
  assert.match(full.content, /BottomUnique/);

  const viewportFixture = targetFixture();
  const viewportSend = viewportFixture.target.debugger.sendCommand;
  viewportFixture.target.debugger.sendCommand = (method) => method === "DOMSnapshot.captureSnapshot"
    ? Promise.reject(new Error("DOM snapshot unavailable"))
    : viewportSend(method);
  await assert.rejects(
    new DesktopBrowserController().snapshot(viewportFixture.target, { scope: "viewport" }),
    /DOM snapshot unavailable/,
  );
});

test("node and length limits truncate at line boundaries with consistent refs", () => {
  const nodes = [];
  const dom = new Map();
  for (let index = 1; index <= 605; index += 1) {
    nodes.push({ backendDOMNodeId: index, role: { value: "button" }, name: { value: `Action ${index}` } });
    dom.set(index, { nodeName: "BUTTON", attributes: {}, bounds: [0, index, 100, 1] });
  }
  const nodeLimited = serializeSnapshot(nodes, dom, undefined, normalizeSnapshotOptions({}));
  assert.equal(nodeLimited.refs.length, 600);
  assert.deepEqual(nodeLimited.truncation.reasons, ["node_limit"]);
  assert.match(nodeLimited.content, /snapshot truncated: 5 of 605 lines omitted/);

  const lengthLimited = serializeSnapshot(nodes, dom, undefined, normalizeSnapshotOptions({ maxResultLength: 128 }));
  assert.ok(lengthLimited.content.length <= 128);
  assert.deepEqual(lengthLimited.truncation.reasons, ["node_limit", "max_result_length"]);
  assert.match(lengthLimited.content, /snapshot truncated:/);
  for (const ref of lengthLimited.refs) assert.match(lengthLimited.content, new RegExp(`\\[@${ref.backendNodeId}\\]`));
  assert.equal(lengthLimited.content.split("\n").some((line) => line && !line.startsWith("-") && !line.startsWith("[snapshot")), false);
});

test("global candidate serializer renders public IDs before coherent truncation", () => {
  const candidates = Array.from({ length: 20 }, (_, index) => ({
    backendNodeId: index + 1,
    refId: 90_000 + index,
    runtimeId: "runtime-1",
    pageId: "page-1",
    frameId: "frame-root",
    documentId: "document-1",
    documentEpoch: 1,
    role: "button",
    name: `Action ${index}`,
  }));
  const result = serializeSnapshotCandidates(candidates, normalizeSnapshotOptions({ maxResultLength: 128 }));
  assert.ok(result.content.length <= 128);
  assert.ok(result.truncation);
  for (const ref of result.refs) {
    assert.match(result.content, new RegExp(`\\[@${ref.refId}\\]`));
    assert.equal(ref.frameId, "frame-root");
  }
  assert.doesNotMatch(result.content, /\[@1\]/);
});

test("debugger detach is surfaced before observer cleanup so the host can replace page incarnation", () => {
  const debuggerApi = new EventEmitter();
  debuggerApi.isAttached = () => true;
  const target = { id: 44, debugger: debuggerApi };
  const reasons = [];
  const controller = new DesktopBrowserController();
  controller.observe(target, () => {}, { onDetach: (reason) => reasons.push(reason) });
  debuggerApi.emit("detach", {}, "target_closed");
  assert.deepEqual(reasons, ["target_closed"]);
  assert.equal(controller.isObserving(target), false);
});

test("observer cleanup survives destroyed WebContents and is idempotent", () => {
  const debuggerApi = new EventEmitter();
  debuggerApi.isAttached = () => true;
  let destroyed = false;
  const target = { id: 46, get debugger() {
    if (destroyed) throw new TypeError("Object has been destroyed");
    return debuggerApi;
  } };
  const controller = new DesktopBrowserController();
  const dispose = controller.observe(target, () => {});
  destroyed = true;
  assert.doesNotThrow(() => dispose());
  assert.doesNotThrow(() => dispose());
  assert.equal(controller.isObserving(target), false);
  assert.equal(debuggerApi.listenerCount("message"), 0);
  assert.equal(debuggerApi.listenerCount("detach"), 0);
});

test("observer cleanup completes when detach callback throws", () => {
  const debuggerApi = new EventEmitter();
  debuggerApi.isAttached = () => true;
  const target = { id: 47, debugger: debuggerApi };
  const controller = new DesktopBrowserController();
  controller.observe(target, () => {}, { onDetach() { throw new Error("host failure"); } });
  assert.throws(() => debuggerApi.emit("detach", {}, "target_closed"), /host failure/);
  assert.equal(controller.isObserving(target), false);
  assert.equal(debuggerApi.listenerCount("message"), 0);
  assert.equal(debuggerApi.listenerCount("detach"), 0);
});

test("verified root text input uses preselected Electron insertion without CDP fallback", async () => {
  const calls = [];
  const target = {
    id: 45,
    insertText(text) { calls.push(["insertText", text]); },
    debugger: {
      isAttached: () => true,
      async sendCommand(...args) {
        calls.push(args);
        return {};
      },
    },
  };
  const controller = new DesktopBrowserController();
  await controller.sendNativeCommand(target, "Input.insertText", { text: "native" }, undefined, { allowRootElectronInsert: true });
  assert.deepEqual(calls, [
    ["insertText", "native"],
  ]);
  assert.equal(controller.isAutomatedInput(target), true);
});

test("verified root reload selects Electron reload once without native Page.reload or replay", async () => {
  let reloads = 0;
  let nativeCalls = 0;
  const target = {
    id: 46,
    reload() { reloads += 1; },
    reloadIgnoringCache() { throw new Error("unexpected cache bypass"); },
    debugger: {
      isAttached() { throw new Error("platform reload must not touch debugger during guest replacement"); },
      sendCommand() { nativeCalls += 1; },
    },
  };
  await new DesktopBrowserController().sendNativeCommand(
    target,
    "Page.reload",
    { ignoreCache: false },
    undefined,
    { allowRootElectronReload: true },
  );
  assert.equal(reloads, 1);
  assert.equal(nativeCalls, 0);
});

test("platform evaluation executes once without attaching a replacing guest debugger", async () => {
  let evaluations = 0;
  const target = { id: 47,
    debugger: { isAttached() { throw new Error("No target available"); } },
    async executeJavaScript() { evaluations += 1; return "complete"; },
  };
  const result = await new DesktopBrowserController().sendNativeCommand(target, "Runtime.evaluate",
    { expression: "document.readyState" }, undefined, { allowRootElectronEvaluate: true });
  assert.equal(result.result.value, "complete");
  assert.equal(evaluations, 1);
});
