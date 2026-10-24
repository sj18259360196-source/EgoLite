import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../main.mjs", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../preload.cjs", import.meta.url), "utf8");

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers.map((marker) => appSource.indexOf(marker)).find((index) => index >= 0);
  assert.notEqual(start, undefined, `找不到 ${name}`);
  const argumentsStart = appSource.indexOf("(", start);
  let argumentDepth = 0;
  let bodyStart = -1;
  for (let index = argumentsStart; index < appSource.length; index += 1) {
    if (appSource[index] === "(") argumentDepth += 1;
    if (appSource[index] !== ")") continue;
    argumentDepth -= 1;
    if (argumentDepth === 0) {
      bodyStart = appSource.indexOf("{", index);
      break;
    }
  }
  assert.notEqual(bodyStart, -1, `${name} 缺少函数体`);
  let depth = 0;
  for (let index = bodyStart; index < appSource.length; index += 1) {
    if (appSource[index] === "{") depth += 1;
    if (appSource[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return appSource.slice(start, index + 1);
  }
  throw new Error(`${name} 函数不完整`);
}

function loadFunction(name, globals) {
  const context = vm.createContext(globals);
  context.pendingTabPreferences ||= new Map();
  vm.runInContext(extractFunction('retainPendingTabPreferences'), context);
  const fn = vm.runInContext(`(${extractFunction(name)})`, context);
  return { context, fn };
}

test("主进程把标签变化事件转发给桌面界面", () => {
  assert.match(mainSource, /const tabEvent = method === "tab\.changed";/);
  assert.match(mainSource, /!spaceEvent && !tabEvent/);
  assert.match(preloadSource, /method === "tab\.changed"/);
});

test("标签状态事件显式传递取消固定、取消静音和唤醒状态", () => {
  assert.match(mainSource, /pinned: tab\.pinned === true/);
  assert.match(mainSource, /muted: tab\.muted === true/);
  assert.match(mainSource, /sleeping: tab\.sleeping === true/);
  assert.match(mainSource, /groupId: tab\.groupId \|\| ""/);
});

test("WebView 注册会携带当前休眠状态，避免旧注册请求唤醒标签", async () => {
  const calls = [];
  const webview = {
    dataset: { targetId: "sleeping-tab" },
    getWebContentsId: () => 17,
    getURL: () => "https://sleeping.example",
    getTitle: () => "Sleeping",
  };
  const { fn: registerWebview } = loadFunction("registerWebview", {
    activeWebview: () => webview,
    currentTab: null,
    state: {
      tabs: [{ targetId: "sleeping-tab", taskId: "agent-task", sleeping: true }],
    },
    invoke: async (...args) => { calls.push(args); },
  });

  await registerWebview(webview);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "browser.register");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), {
    webContentsId: 17,
    targetId: "sleeping-tab",
    active: false,
    taskId: "agent-task",
    url: "https://sleeping.example",
    title: "Sleeping",
    sleeping: true,
  });
  assert.match(mainSource, /if \(typeof payload\.sleeping === "boolean"\) tab\.sleeping = payload\.sleeping;/);
  assert.doesNotMatch(mainSource, /tab\.webContentsId = activeWebviewId;\s*tab\.sleeping = false;/);
});

test("后台 Agent 活动不会自动切换用户当前工作区", () => {
  assert.doesNotMatch(extractFunction("handleAgentChanged"), /observeTaskByTaskId/);
  assert.doesNotMatch(extractFunction("handleOperationChanged"), /observeTaskByTaskId/);
});

test("多个视觉工作区请求按到达顺序串行执行", async () => {
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const { context, fn: queueVisualTaskMutation } = loadFunction("queueVisualTaskMutation", {
    visualTaskMutationTail: Promise.resolve(),
  });

  const first = queueVisualTaskMutation(async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  const second = queueVisualTaskMutation(async () => {
    order.push("second");
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(JSON.stringify(order), JSON.stringify(["first-start"]));
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(JSON.stringify(order), JSON.stringify(["first-start", "first-end", "second"]));
  assert.ok(context.visualTaskMutationTail instanceof Promise);
});

test("visual task selection retries a superseded refresh without using stale state", async () => {
  let calls = 0;
  const state = { spaces: [{ taskId: "old" }] };
  const globals = {
    state, refreshRevision: 0, setTimeout: callback => callback(),
    refresh: async () => {
      calls++;
      globals.refreshRevision += calls === 1 ? 2 : 1;
      if (calls === 1) return false;
      state.spaces = [{ taskId: "new" }];
      return true;
    },
  };
  const { fn } = loadFunction("refreshVisualTask", globals);
  assert.equal((await fn("new")).taskId, "new");
  assert.equal(calls, 2);
});

test("visual task selection rejects authoritative absence without repeated refreshes", async () => {
  let calls = 0;
  const { fn } = loadFunction("refreshVisualTask", {
    state: { spaces: [] }, refreshRevision: 0, setTimeout: callback => callback(),
    refresh: async () => { calls++; return true; },
  });
  await assert.rejects(fn("missing"), /Task is unavailable/);
  assert.equal(calls, 1);
});

test("visual task selection bounds repeated superseded refreshes", async () => {
  let now = 0;
  let calls = 0;
  const globals = {
    state: { spaces: [] }, refreshRevision: 0, Date: { now: () => now }, setTimeout: callback => { now += 1000; callback(); },
    refresh: async () => { calls++; globals.refreshRevision += 2; return false; },
  };
  const { fn } = loadFunction("refreshVisualTask", globals);
  await assert.rejects(fn("missing"), /Task is unavailable/);
  assert.equal(calls, 2);
});

test("visual task selection does not repeatedly retry an actual refresh failure", async () => {
  let calls = 0;
  const globals = {
    state: { spaces: [] }, refreshRevision: 0,
    setTimeout: () => assert.fail("Must not wait after an authoritative refresh failure"),
    refresh: async () => { calls++; globals.refreshRevision++; return false; },
  };
  const { fn } = loadFunction("refreshVisualTask", globals);
  await assert.rejects(fn("missing"), /Task is unavailable/);
  assert.equal(calls, 1);
});

test("旧的操作列表响应不会覆盖事件更新或清空结果", () => {
  const operationStateRevisions = new Map([["task-1", 1]]);
  const operationClearRevisions = new Map();
  const operationRecords = new Map([["task-1", [{ id: "event-1", startedAt: "2026-09-07T00:00:02.000Z", status: "running" }]]]);
  const { fn: applyOperationSnapshot } = loadFunction("applyOperationSnapshot", {
    operationStateRevisions,
    operationClearRevisions,
    operationRecords,
  });

  const merged = applyOperationSnapshot(
    "task-1",
    [{ id: "list-1", startedAt: "2026-09-07T00:00:01.000Z", status: "completed" }],
    0,
    0,
  );
  assert.equal(JSON.stringify(merged.map((record) => record.id)), JSON.stringify(["list-1", "event-1"]));

  operationClearRevisions.set("task-1", 1);
  operationRecords.set("task-1", []);
  const afterClear = applyOperationSnapshot(
    "task-1",
    [{ id: "stale", startedAt: "2026-09-07T00:00:03.000Z" }],
    1,
    0,
  );
  assert.equal(JSON.stringify(afterClear), JSON.stringify([]));
});

test("新建桌面空间和新标签不会重复拼接历史记录", () => {
  assert.match(mainSource, /markFreshDesktopSpaceRestored\(payload\.taskId\)/);
  assert.match(mainSource, /function markFreshDesktopSpaceRestored\(taskId\)/);
  assert.match(mainSource, /return dedupeDesktopTabRecords\(value\.tabs\.filter/);
  assert.match(mainSource, /const tabs = dedupeDesktopTabRecords\(\[\.\.\.pending, \.\.\.live\]\)/);
  assert.match(mainSource, /if \(!options\.restoreRecord && !restoredDesktopTasks\.has\(taskId\)\) await ensureDesktopTabsRestored\(taskId\);/);
});

test("Agent 标签变化会更新标签标题和当前地址", () => {
  let renderCount = 0;
  const fields = { "#current-address": { value: "" }, "#omnibox": { value: "" } };
  const globals = {
    $: (selector) => fields[selector],
    isStartPageUrl: (url) => !url || url === "about:blank" || url === "ego://start",
    activeTaskId: "agent-task",
    currentTab: { targetId: "tab-1", taskId: "agent-task", url: "https://old.example" },
    renderBrowserTabs: () => { renderCount += 1; },
    state: {
      tabs: [{ targetId: "tab-1", taskId: "agent-task", title: "旧标题", url: "https://old.example" }],
    },
  };
  const { context, fn: handleTabChanged } = loadFunction("handleTabChanged", globals);

  handleTabChanged({ targetId: "tab-1", taskId: "agent-task", title: "新标题", url: "https://new.example" });

  assert.equal(context.state.tabs[0].title, "新标题");
  assert.equal(context.currentTab.url, "https://new.example");
  assert.equal(fields["#current-address"].value, "https://new.example");
  assert.equal(renderCount, 1);
});

test("新标签页事件保留 ego://start 地址显示", () => {
  const fields = { "#current-address": { value: "" }, "#omnibox": { value: "" } };
  const globals = {
    $: (selector) => fields[selector],
    isStartPageUrl: (url) => !url || url === "about:blank" || url === "ego://start",
    activeTaskId: "task-1",
    currentTab: { targetId: "tab-1", taskId: "task-1", url: "ego://start" },
    renderBrowserTabs: () => {},
    renderTasks: () => {},
    renderTaskBoard: () => {},
    state: { tabs: [{ targetId: "tab-1", taskId: "task-1", url: "ego://start" }] },
  };
  const { fn: handleTabChanged } = loadFunction("handleTabChanged", globals);

  handleTabChanged({ targetId: "tab-1", taskId: "task-1", url: "about:blank", title: "新建标签页" });

  assert.equal(fields["#current-address"].value, "ego://start");
  assert.equal(fields["#omnibox"].value, "");
});

test("后台 Agent 新增标签会刷新工作区计数，但不会抢占当前工作区", () => {
  let taskListRenders = 0;
  let boardRenders = 0;
  const globals = {
    $: () => ({ value: "" }),
    activeTaskId: "manual-task",
    currentTab: { targetId: "manual-tab", taskId: "manual-task", url: "https://manual.example" },
    renderBrowserTabs: () => { throw new Error("后台标签变化不应重绘当前标签栏"); },
    renderTasks: () => { taskListRenders += 1; },
    renderTaskBoard: () => { boardRenders += 1; },
    state: {
      tabs: [{ targetId: "manual-tab", taskId: "manual-task", title: "当前页面", url: "https://manual.example" }],
    },
  };
  const { context, fn: handleTabChanged } = loadFunction("handleTabChanged", globals);

  handleTabChanged({ targetId: "agent-tab", taskId: "agent-task", title: "后台页面", url: "https://agent.example" });

  assert.equal(context.activeTaskId, "manual-task");
  assert.equal(context.currentTab.targetId, "manual-tab");
  assert.equal(context.state.tabs.length, 2);
  assert.equal(taskListRenders, 1);
  assert.equal(boardRenders, 1);
});

test("观察执行中的 Agent 空间只切换界面，不抢占控制权", async () => {
  const shown = [];
  const agentTask = { id: 2, taskId: "agent-task", name: "公众号资料", ownership: "agent" };
  const tabs = [
    { targetId: "manual-tab", taskId: "manual-task", active: true },
    { targetId: "agent-tab", taskId: "agent-task", active: true },
  ];
  const globals = {
    activeTaskId: "manual-task",
    chatMode: "operations",
    ensureConversation: async () => {},
    ensureOperations: async () => {},
    fileAttachments: new Map([["old", {}]]),
    refresh: async () => {},
    renderActiveTaskSelect: () => {},
    renderAttachments: () => {},
    renderBrowserTabs: () => {},
    renderConversation: () => {},
    renderTaskBoard: () => {},
    renderTasks: () => {},
    restorePromptDraft: () => {},
    showTab: (tab) => shown.push(tab.targetId),
    showToast: () => {},
    showWelcome: () => {},
    automaticTabForTask: (items) => items.find((tab) => tab.active && !tab.sleeping)
      || items.find((tab) => !tab.sleeping && tab.url !== "ego://start")
      || items.find((tab) => !tab.sleeping),
    state: { spaces: [{ id: 1, taskId: "manual-task", name: "001" }, agentTask], tabs },
    tabsForTask: (taskId) => tabs.filter((tab) => tab.taskId === taskId),
    taskObservationRevision: 0,
  };
  const { context, fn: observeTaskByTaskId } = loadFunction("observeTaskByTaskId", globals);

  const result = await observeTaskByTaskId("agent-task", { quiet: true });

  assert.equal(result, true);
  assert.equal(context.activeTaskId, "agent-task");
  assert.deepEqual(shown, ["agent-tab"]);
  assert.equal(globals.fileAttachments.size, 0);
});

test("旧工作区不会沿用 Agent 在其他工作区的执行状态", () => {
  const agent = {
    clientId: "agent-a",
    clientKind: "codex",
    currentTaskId: "current-task",
    status: "executing",
  };
  const { fn: agentForTask } = loadFunction("agentForTask", {
    state: { agents: [agent] },
  });

  assert.equal(agentForTask({
    taskId: "old-task",
    lastAgentClientId: "agent-a",
    ownership: "agent",
  }), null);
  assert.equal(agentForTask({
    taskId: "current-task",
    lastAgentClientId: "agent-a",
    ownership: "agent",
  }).clientId, "agent-a");
});

test("活动记录上划后刷新会保留滚动位置", () => {
  const { fn: captureMessagesScrollState } = loadFunction("captureMessagesScrollState", {});
  const { fn: restoreMessagesScrollState } = loadFunction("restoreMessagesScrollState", {});
  const messages = { scrollHeight: 1200, scrollTop: 420, clientHeight: 600 };
  const state = captureMessagesScrollState(messages);
  messages.scrollHeight = 1500;
  messages.scrollTop = 0;
  restoreMessagesScrollState(messages, state);
  assert.equal(messages.scrollTop, 720);
});

test("活动记录在底部时刷新仍会跟随最新记录", () => {
  const { fn: captureMessagesScrollState } = loadFunction("captureMessagesScrollState", {});
  const { fn: restoreMessagesScrollState } = loadFunction("restoreMessagesScrollState", {});
  const messages = { scrollHeight: 1200, scrollTop: 576, clientHeight: 600 };
  const state = captureMessagesScrollState(messages);
  messages.scrollHeight = 1500;
  messages.scrollTop = 0;
  restoreMessagesScrollState(messages, state);
  assert.equal(messages.scrollTop, 900);
});

test("非浏览器视图会关闭 WebView 命中并移除焦点", () => {
  let blurred = 0;
  const attributes = new Map();
  const webview = {
    dataset: {},
    style: {},
    hidden: false,
    inert: false,
    blur: () => { blurred += 1; },
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const { fn: setWebviewVisibility } = loadFunction("setWebviewVisibility", {
    browserViewIsActive: () => false,
  });

  setWebviewVisibility(webview, true);

  assert.equal(webview.dataset.background, "true");
  assert.equal(webview.hidden, true);
  assert.equal(webview.style.pointerEvents, "none");
  assert.equal(webview.inert, true);
  assert.equal(attributes.get("aria-hidden"), "true");
  assert.equal(blurred, 1);
  assert.match(extractFunction("switchView"), /setBrowserInteractionEnabled\(name === "start"\)/);
});

test("明确的视觉请求会先切回浏览器视图", () => {
  const source = extractFunction("handleHostRequest");
  assert.match(source, /method === "tab\.visual-bounds"[\s\S]*?switchView\("start"\)/);
  assert.match(source, /if \(visual\) \{[\s\S]*?observeTaskByTaskId[\s\S]*?switchView\("start"\)/);
});

test("Agent 状态突发只安排一次界面重绘", () => {
  const timers = [];
  let taskRenders = 0;
  let boardRenders = 0;
  const { context, fn: scheduleAgentUiRender } = loadFunction("scheduleAgentUiRender", {
    agentUiRenderTimer: 0,
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    renderTasks: () => { taskRenders += 1; },
    renderTaskBoard: () => { boardRenders += 1; },
  });

  scheduleAgentUiRender();
  scheduleAgentUiRender();
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(context.agentUiRenderTimer, 0);
  assert.equal(taskRenders, 1);
  assert.equal(boardRenders, 1);
});

test("HUD 按最近完成时间选择操作状态", () => {
  const { fn: latestOperationRecord } = loadFunction("latestOperationRecord", {});
  const startedAt = "2026-09-08T01:00:00.000Z";
  const latest = latestOperationRecord([
    { id: "running", status: "running", startedAt },
    { id: "failed", status: "failed", startedAt, finishedAt: "2026-09-08T01:00:02.000Z" },
  ]);
  assert.equal(latest.id, "failed");
});

test("操作轮询保持单飞，避免慢响应重叠", async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const operationRefreshes = new Map();
  const operationRecords = new Map([["task-1", []]]);
  const globals = {
    operationRefreshes,
    operationRecords,
    operationStateRevisions: new Map(),
    operationClearRevisions: new Map(),
    invoke: async () => { calls += 1; await gate; return []; },
    applyOperationSnapshot: (_taskId, records) => records,
    operationSnapshotsEqual: () => true,
    scheduleOperationUiRender: () => {},
  };
  const { fn: refreshOperations } = loadFunction("refreshOperations", globals);

  const first = refreshOperations("task-1");
  const second = refreshOperations("task-1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(operationRefreshes.size, 0);
});

test("分栏拖拽在失去指针或窗口焦点时清理状态", () => {
  const source = extractFunction("bindAssistantResizer");
  assert.match(source, /lostpointercapture/);
  assert.match(source, /window\.addEventListener\("blur", finish\)/);
});
