import test from "node:test";
import assert from "node:assert/strict";
import { CosBrowser } from "./cos-browser.mjs";
import { EventEmitter } from "node:events";

function setup(overrides = {}) {
  const calls = [];
  const tabs = [
    { taskId: "cos", targetId: "own", webContentsId: 1, url: "https://chatgpt.com/c/example", active: true },
    { taskId: "ordinary", targetId: "other", webContentsId: 2, url: "https://example.com", active: true },
  ];
  const browser = new CosBrowser({
    enabled: () => true, taskId: () => "cos", windowId: () => 10, tabs: () => tabs,
    contents: tab => ({ getURL: () => tab.url, getTitle: () => "Page", isLoading: () => false }),
    runMutation: work => work(),
    create: async () => { calls.push("create"); return { targetId: "own" }; },
    remove: async id => { calls.push(id); },
    event: () => {},
    update: (id, patch) => { Object.assign(tabs.find(tab => tab.targetId === id), patch); },
    reorder: ids => { ids.forEach((id, order) => { tabs.find(tab => tab.targetId === id).order = order; }); },
    ...overrides,
  });
  return { browser, calls, tabs };
}

test("CoS tab discovery excludes ordinary workspaces", async () => {
  const { browser } = setup();
  assert.deepEqual((await browser.call("tabs.query")).map(tab => tab.id), [1]);
  assert.deepEqual((await browser.call("tabs.query", [{ url: "https://chatgpt.com/*" }])).map(tab => tab.id), [1]);
  assert.deepEqual(await browser.call("tabs.query", [{ url: "https://example.com/*" }]), []);
  await assert.rejects(browser.call("tabs.get", [2]), /outside/);
  await assert.rejects(browser.call("tabs.remove", [2]), /outside/);
});

test('CoS tab groups persist through adapter recreation and never include foreign tabs', async () => {
  const { browser, tabs } = setup();
  const id = await browser.call('tabs.group', [{ tabIds: [1], createProperties: { windowId: 10 } }]);
  await browser.call('tabGroups.update', [id, { title: 'Chat On Steroids', color: 'grey', collapsed: true }]);
  assert.equal((await browser.call('tabs.get', [1])).groupId, id);
  assert.deepEqual((await browser.call('tabGroups.query', [{ title: 'Chat On Steroids' }])).map(group => group.id), [id]);
  assert.equal((await browser.call('tabGroups.get', [id])).collapsed, true);
  const restored = setup({ tabs: () => tabs }).browser;
  assert.equal((await restored.call('tabGroups.get', [id])).title, 'Chat On Steroids');
  await assert.rejects(browser.call('tabs.group', [{ groupId: id, tabIds: [1, 2] }]), /outside/);
  await assert.rejects(browser.call('tabs.group', [{ tabIds: [1], createProperties: { windowId: 99 } }]), /outside/);
  await assert.rejects(browser.call('tabGroups.update', [999, { title: 'foreign' }]), /outside/);
  await assert.rejects(browser.call('tabGroups.update', [id, { color: 'bad' }]), /color/);
  assert.equal(tabs[1].groupId, undefined);
  await browser.call('tabs.ungroup', [1]);
  assert.equal((await browser.call('tabs.get', [1])).groupId, -1);
  assert.deepEqual(await browser.call('tabGroups.query'), []);
});

test('CoS window discovery and adopting an existing tab stay in the workspace', async () => {
  const { browser, calls } = setup();
  assert.deepEqual((await browser.call('windows.getAll', [{ populate: true }])).map(window => window.id), [10]);
  assert.equal((await browser.call('windows.getLastFocused')).id, 10);
  assert.deepEqual(await browser.call('windows.getAll', [{ windowTypes: ['popup'] }]), []);
  const adopted = await browser.call('windows.create', [{ tabId: 1, focused: false }]);
  assert.deepEqual(adopted.tabs.map(tab => tab.id), [1]);
  assert.deepEqual(calls, []);
  await assert.rejects(browser.call('windows.create', [{ tabId: 2 }]), /outside/);
});

test("CoS resume prepares only awake pages in its own workspace", async () => {
  const { browser, tabs } = setup();
  tabs.push({ taskId: "cos", webContentsId: 3, targetId: "sleeping", sleeping: true });
  const prepared = [];
  browser.prepareTab = async tab => prepared.push(tab.webContentsId);
  await browser.resumePages();
  assert.deepEqual(prepared, [1]);
  await browser.stop();
  await assert.rejects(browser.resumePages(), /stopped/);
});

test("CoS stop cancels resume waiting for control", async () => {
  let resume;
  const pending = new Promise(resolve => { resume = resolve; });
  const { browser } = setup({ runMutation: async work => { await pending; return work(); } });
  const prepared = [];
  browser.prepareTab = async tab => prepared.push(tab.webContentsId);
  const restoring = browser.resumePages();
  await browser.stop();
  resume();
  await assert.rejects(restoring, /stopped/);
  assert.deepEqual(prepared, []);
});

test("CoS background windows remain inside their own workspace", async () => {
  const { browser } = setup();
  const created = await browser.call("windows.create", [{ url: "https://chatgpt.com", focused: false }]);
  assert.equal(created.id, 10);
  assert.equal(created.tabs[0].id, 1);
  assert.equal((await browser.call("windows.update", [10, { state: "minimized" }])).id, 10);
  await assert.rejects(browser.call("windows.update", [20, {}]), /outside/);
  await assert.rejects(browser.call("tabs.create", [{ windowId: 20 }]), /outside/);
});

test("only explicit host user links request visible tabs; background browser calls do not steal focus", async () => {
  const requests = [];
  const { browser } = setup({ create: async (url, options) => {
    requests.push({ url, ...options });
    return { targetId: "own" };
  } });
  await browser.call("tabs.create", [{ url: "https://chatgpt.com", active: true, visual: true }]);
  await browser.call("tabs.create", [{ url: "https://example.com", active: true }], { visual: true });
  assert.equal(requests[0].visual, false);
  assert.equal(requests[1].visual, true);
  assert.equal(requests[1].active, true);
});

test("CoS stop fences an action still awaiting authorization", async () => {
  let resume;
  const wait = new Promise(resolve => { resume = resolve; });
  const { browser, calls } = setup({ runMutation: async work => { await wait; return work(); } });
  const pending = browser.call("tabs.create", [{ url: "https://chatgpt.com" }]);
  browser.stop();
  resume();
  await assert.rejects(pending, /stopped/);
  assert.deepEqual(calls, []);
  await assert.rejects(browser.call("tabs.query"), /stopped/);
});

test("CoS reports only its provided browser permissions", async () => {
  const { browser } = setup();
  assert.equal(await browser.call("permissions.contains", [{ permissions: ["debugger", "tabs"] }]), true);
  assert.equal(await browser.call("permissions.contains", [{ permissions: ["nativeMessaging"] }]), false);
});

test("CoS rejects unsupported or malformed document targets instead of executing on another page", async () => {
  const { browser } = setup();
  for (const documentIds of [[], [""], [4], "one"]) {
    await assert.rejects(browser.call("scripting.executeScript", [{
      target: { tabId: 1, documentIds }, functionSource: "() => true",
    }]), /valid document IDs/);
  }
  await assert.rejects(browser.call("scripting.executeScript", [{
    target: { tabId: 1, documentIds: ["previous-document"] }, functionSource: "() => true",
  }]), /document targeting is unavailable/);
});

test("CoS tab protection is visible and released when stopped", async () => {
  const { browser, tabs } = setup();
  const protectedTab = await browser.call("tabs.update", [1, { autoDiscardable: false }]);
  assert.equal(protectedTab.autoDiscardable, false);
  assert.equal((await browser.call("tabs.move", [1, { index: -1 }])).index, 0);
  await assert.rejects(browser.call("tabs.move", [1, { index: -2 }]), /index/);
  await browser.stop();
  assert.equal(tabs[0].autoDiscardable, true);
});

test("multiple window URLs create ordered workspace tabs and batch moves preserve order", async () => {
  const requests = [];
  const { browser, tabs } = setup({ create: async (url, options) => {
    const id = tabs.length + 1;
    tabs.push({ taskId: "cos", targetId: `new-${id}`, webContentsId: id, url, active: options.active });
    requests.push(options);
    return { targetId: `new-${id}` };
  } });
  const window = await browser.call("windows.create", [{ url: ["https://a.test", "https://b.test"] }]);
  assert.deepEqual(window.tabs.map(tab => tab.url), ["https://a.test", "https://b.test"]);
  assert.deepEqual(requests.map(item => item.active), [true, false]);
  const moved = await browser.call("tabs.move", [[4, 3], { index: 0 }]);
  assert.deepEqual(moved.map(tab => tab.id), [4, 3]);
  assert.deepEqual(moved.map(tab => tab.index), [0, 1]);
  await assert.rejects(browser.call("tabs.create", [{ url: ["https://a.test"] }]), /Invalid/);
});

test("muting and cache-bypassing reload invoke Chromium instead of only changing metadata", async () => {
  const calls = [];
  let muted = false;
  const { browser } = setup({ contents: tab => ({ getURL: () => tab.url, getTitle: () => "Page", isLoading: () => false,
    setAudioMuted: value => { muted = value; }, isAudioMuted: () => muted,
    reload: () => calls.push("reload"), reloadIgnoringCache: () => calls.push("fresh"),
  }) });
  assert.equal((await browser.call("tabs.update", [1, { muted: true }])).mutedInfo.muted, true);
  await browser.call("tabs.reload", [1, { bypassCache: true }]);
  await browser.call("tabs.reload", [1]);
  assert.deepEqual(calls, ["fresh", "reload"]);
});

test("hidden-page layout sync preserves CDP clipping, format and scale", async () => {
  const calls = [];
  const debuggerApi = Object.assign(new EventEmitter(), { isAttached: () => true });
  const { browser } = setup({ contents: () => ({ debugger: debuggerApi }), prepareCapture: async () => calls.push("layout"),
    sendCommand: async (_contents, method, params) => { calls.push({ method, params }); return { data: "image" }; } });
  await browser.call("debugger.attach", [{ tabId: 1 }]);
  const params = { format: "jpeg", quality: 80, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 500, height: 900, scale: 0.5 } };
  await browser.call("debugger.sendCommand", [{ tabId: 1 }, "Page.captureScreenshot", params]);
  assert.deepEqual(calls, ["layout", { method: "Page.captureScreenshot", params }]);
  await browser.stop();
});

test('a stalled plain screenshot falls back to compositor capture without activating a tab', async () => {
  const debuggerApi = Object.assign(new EventEmitter(), { isAttached: () => true });
  let captures = 0;
  const { browser } = setup({ contents: () => ({ debugger: debuggerApi, capturePage: async (_rect, options) => {
    assert.equal(options.stayAwake, true);
    captures++;
    return { isEmpty: () => false, toPNG: () => Buffer.from('fixture-image') };
  } }), sendCommand: () => new Promise(() => {}), activate: () => { throw new Error('Screenshot must not activate'); } });
  await browser.call('debugger.attach', [{ tabId: 1 }]);
  const image = await browser.call('debugger.sendCommand', [{ tabId: 1 }, 'Page.captureScreenshot', { format: 'png' }]);
  assert.equal(Buffer.from(image.data, 'base64').toString(), 'fixture-image');
  assert.equal(captures, 1);
  await browser.stop();
});
