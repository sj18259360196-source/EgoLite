import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

import { PipeRuntimeTransport } from "../packages/runtime-adapter/src/pipe-transport.ts";

const root = new URL("..", import.meta.url).pathname.slice(1).replaceAll("/", "\\");
const pipeName = process.env.EGO_COMPAT_PIPE || "\\\\.\\pipe\\ego-compat-desktop-broker";
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string"));
env.EGO_COMPAT_PIPE = pipeName;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "apps", "ego-mcp-server", "src", "main.ts")],
  cwd: root,
  env,
  stderr: "pipe",
});
const client = new Client({ name: "ego-practical-desktop-test", version: "0.1.0" });
const report = { startedAt: new Date().toISOString(), steps: [] };
let selectedTask;

try {
  await client.connect(transport);
  const status = await call("ego_status");
  record("桌面完整 MCP 连接", status.backend?.ready === true, status.backend);

  selectedTask = await call("ego_task_use", { task: "实战测试 2026-08-14" });
  record("选择持久任务空间", selectedTask?.name === "实战测试 2026-08-14", selectedTask);

  await call("ego_open", { url: "https://www.wikipedia.org", wait: true });
  let snapshot = await callText("ego_snapshot", { scope: "viewport", stableLocators: true });
  const searchbox = snapshot.match(/searchbox "Search Wikipedia" \[(@\d+)\]/)?.[1];
  const searchButton = snapshot.match(/button "Search" \[(@\d+)\]/)?.[1];
  if (!searchbox) throw new Error("Wikipedia 搜索框未出现在页面快照中");
  if (!searchButton) throw new Error("Wikipedia 搜索按钮未出现在页面快照中");
  await call("ego_fill", { target: searchbox, value: "Windows 11" });
  await call("ego_click", { target: searchButton });
  await call("ego_wait_for", { target: "h1", text: "Windows 11", timeout: 20_000, polling: 100 });
  const article = await call("ego_page_info");
  const articleHeading = await call("ego_evaluate", { expression: "document.querySelector('h1')?.innerText || document.title" });
  record("真实网站搜索与跳转", /wikipedia\.org/.test(article.url) && /Windows 11/i.test(String(articleHeading)), {
    title: article.title,
    url: article.url,
    heading: articleHeading,
  });

  const inspected = await call("ego_inspect", { target: "h1", attributes: ["id", "class"] });
  record("页面元素检查", inspected?.visible === true && /Windows 11/i.test(inspected?.innerText || ""), inspected);

  await call("ego_open", { url: "https://example.com", wait: true });
  const tabsAfterOpen = await call("ego_tabs");
  const tabs = Array.isArray(tabsAfterOpen) ? tabsAfterOpen : tabsAfterOpen?.tabs || [];
  const exampleTab = tabs.find((tab) => tab.url?.includes("example.com"));
  const wikipediaTab = tabs.find((tab) => tab.url?.includes("wikipedia.org"));
  record("多标签页创建", Boolean(exampleTab && wikipediaTab), { count: tabs.length, tabs });

  try {
    const screenshot = await callText("ego_screenshot", { fullPage: false });
    const screenshotPath = screenshot.split(/\r?\n/).at(-1)?.trim();
    record("页面截图", Boolean(screenshotPath), { path: screenshotPath, page: "example.com" });
  } catch (error) {
    record("页面截图", false, { page: "example.com", error: error instanceof Error ? error.message : String(error) });
  }

  if (!wikipediaTab) throw new Error("未找到 Wikipedia 标签页");
  await call("ego_tab_select", { target: wikipediaTab.targetId || wikipediaTab.id || wikipediaTab.url });
  const selectedInfo = await call("ego_page_info");
  record("标签页切换", selectedInfo.url?.includes("wikipedia.org"), selectedInfo);

  if (exampleTab) {
    await call("ego_tab_close", { target: exampleTab.targetId || exampleTab.id || exampleTab.url });
  }
  const tabsAfterClose = await call("ego_tabs");
  const remaining = Array.isArray(tabsAfterClose) ? tabsAfterClose : tabsAfterClose?.tabs || [];
  record("标签页关闭", !remaining.some((tab) => tab.url?.includes("example.com")), { count: remaining.length });
} finally {
  await client.close().catch(() => {});
}

if (selectedTask?.taskId) {
  const rpc = await PipeRuntimeTransport.connect(pipeName);
  try {
    const operations = await rpc.request("operation.list", {
      clientId: "ego-practical-test-audit",
      taskId: selectedTask.taskId,
      limit: 100,
    });
    const completed = operations.filter((item) => item.status === "completed");
    record("Codex 操作记录持久化", completed.length >= 10, {
      total: operations.length,
      completed: completed.length,
      latest: operations.slice(0, 8).map(({ tool, title, status }) => ({ tool, title, status })),
    });
  } finally {
    await rpc.close();
  }
}

report.finishedAt = new Date().toISOString();
report.passed = report.steps.every((step) => step.passed);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;

async function call(name, args = {}) {
  return JSON.parse(await callText(name, args));
}

async function callText(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const value = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "";
  if (result.isError) throw new Error(`${name}: ${value}`);
  return value;
}

function record(name, passed, detail) {
  report.steps.push({ name, passed: Boolean(passed), detail });
}
