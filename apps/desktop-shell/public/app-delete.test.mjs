import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function extractFunction(name) {
  const marker = `async function ${name}(`;
  const start = appSource.indexOf(marker);
  assert.notEqual(start, -1, `找不到 ${name}`);
  const bodyStart = appSource.indexOf("{", start);
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
  const fn = vm.runInContext(`(${extractFunction(name)})`, context);
  return { context, fn };
}

function deletionGlobals(overrides = {}) {
  return {
    activeTaskId: "another-task",
    confirmAction: async () => true,
    conversations: new Map(),
    currentTab: null,
    invoke: async () => {},
    localizedError: (error) => String(error?.message || error),
    operationRecords: new Map(),
    refresh: async () => {},
    selectedTaskIds: new Set(),
    showToast: () => {},
    showWelcome: () => {},
    state: { spaces: [] },
    taskAgentRunning: () => false,
    ...overrides,
  };
}

test("单个任务空间直接关闭，不再调用控制权接管", async () => {
  const calls = [];
  const confirmations = [];
  const task = { id: 7, taskId: "task-7", name: "资料整理", ownership: "agent" };
  const globals = deletionGlobals({
    confirmAction: async (...args) => { confirmations.push(args); return true; },
    invoke: async (...args) => { calls.push(args); },
    selectedTaskIds: new Set([task.id]),
    taskAgentRunning: () => true,
  });
  const { fn: closeTask } = loadFunction("closeTask", globals);

  await closeTask(task);

  assert.deepEqual(calls.map(([method, payload]) => [method, payload.id]), [["task.close", task.id]]);
  assert.equal(confirmations[0][0], "删除任务空间");
  assert.match(confirmations[0][1], /立即终止该任务中的 Agent 操作/);
  assert.match(confirmations[0][1], /关闭全部标签页/);
  assert.match(confirmations[0][1], /固定标签也会一并关闭/);
  assert.match(confirmations[0][1], /此操作无法撤销/);
  assert.equal(globals.selectedTaskIds.has(task.id), false);
});

test("普通单删明确说明任务空间、全部标签页和固定标签都会删除", async () => {
  const confirmations = [];
  const task = { id: 8, taskId: "task-8", name: "普通任务", ownership: "user" };
  const globals = deletionGlobals({
    confirmAction: async (...args) => { confirmations.push(args); return false; },
  });
  const { fn: closeTask } = loadFunction("closeTask", globals);

  await closeTask(task);

  assert.match(confirmations[0][1], /将删除“普通任务”及其中的全部标签页/);
  assert.match(confirmations[0][1], /固定标签也会一并关闭/);
  assert.match(confirmations[0][1], /此操作无法撤销/);
  assert.doesNotMatch(confirmations[0][1], /Agent/);
});

test("批量删除逐项直接关闭，并提示会终止关联的 Agent 操作", async () => {
  const calls = [];
  const confirmations = [];
  const tasks = [
    { id: 11, taskId: "task-11", name: "自动任务", ownership: "agent" },
    { id: 12, taskId: "task-12", name: "普通任务", ownership: "user" },
  ];
  const selectedTaskIds = new Set(tasks.map((task) => task.id));
  const globals = deletionGlobals({
    confirmAction: async (...args) => { confirmations.push(args); return true; },
    invoke: async (...args) => { calls.push(args); },
    selectedTaskIds,
    state: { spaces: tasks },
  });
  const { fn: closeSelectedTasks } = loadFunction("closeSelectedTasks", globals);

  await closeSelectedTasks();

  assert.deepEqual(calls.map(([method, payload]) => [method, payload.id]), [
    ["task.close", 11],
    ["task.close", 12],
  ]);
  assert.match(confirmations[0][1], /其中 1 个任务仍有 Agent 执行或持有控制权/);
  assert.match(confirmations[0][1], /立即终止这些任务中的 Agent 操作/);
  assert.match(confirmations[0][1], /固定标签也会一并关闭/);
  assert.match(confirmations[0][1], /此操作无法撤销/);
  assert.equal(selectedTaskIds.size, 0);
});

test("普通批量删除明确说明全部标签页和固定标签都会删除", async () => {
  const confirmations = [];
  const tasks = [
    { id: 21, taskId: "task-21", name: "任务一", ownership: "user" },
    { id: 22, taskId: "task-22", name: "任务二", ownership: "user" },
  ];
  const globals = deletionGlobals({
    confirmAction: async (...args) => { confirmations.push(args); return false; },
    selectedTaskIds: new Set(tasks.map((task) => task.id)),
    state: { spaces: tasks },
  });
  const { fn: closeSelectedTasks } = loadFunction("closeSelectedTasks", globals);

  await closeSelectedTasks();

  assert.match(confirmations[0][1], /将删除所选 2 个任务空间及其中的全部标签页/);
  assert.match(confirmations[0][1], /固定标签也会一并关闭/);
  assert.match(confirmations[0][1], /此操作无法撤销/);
  assert.doesNotMatch(confirmations[0][1], /Agent/);
});
