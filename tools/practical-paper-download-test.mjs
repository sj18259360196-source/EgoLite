import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { PipeRuntimeTransport } from "../packages/runtime-adapter/src/pipe-transport.ts";

const root = new URL("..", import.meta.url).pathname.slice(1).replaceAll("/", "\\");
const pipeName = process.env.EGO_COMPAT_PIPE || "\\\\.\\pipe\\ego-compat-desktop-broker";
const outputPath = join(root, "downloads", "attention-is-all-you-need.pdf");
const downloadsStatePath = join(process.env.LOCALAPPDATA || root, "EgoCompat", "desktop-downloads.json");
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string"));
env.EGO_COMPAT_PIPE = pipeName;
mkdirSync(dirname(outputPath), { recursive: true });
rmSync(outputPath, { force: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "apps", "ego-mcp-server", "src", "main.ts")],
  cwd: root,
  env,
  stderr: "pipe",
});
const client = new Client({ name: "ego-paper-download-test", version: "0.1.0" });
const report = { startedAt: new Date().toISOString(), paper: "Attention Is All You Need", steps: [] };
let selectedTask;

try {
  await client.connect(transport);
  const status = await call("ego_status");
  record("桌面 MCP 连接", status.backend?.ready === true, status.backend);

  selectedTask = await call("ego_task_use", { task: "科研论文下载实战" });
  record("科研任务空间", selectedTask?.name === "科研论文下载实战", selectedTask);

  await call("ego_open", { url: "https://arxiv.org/abs/1706.03762", wait: true });
  const info = await call("ego_page_info");
  const title = await call("ego_evaluate", { expression: "document.querySelector('h1.title')?.innerText || document.title" });
  record("打开论文详情页", /arxiv\.org/.test(info.url) && /Attention Is All You Need/i.test(String(title)), { ...info, paperTitle: title });

  await call("ego_evaluate", {
    expression: `(async () => {
      const response = await fetch('/pdf/1706.03762');
      if (!response.ok) throw new Error('PDF request failed: ' + response.status);
      const blob = await response.blob();
      const old = document.querySelector('#ego-paper-download-test');
      if (old) old.remove();
      const link = document.createElement('a');
      link.id = 'ego-paper-download-test';
      link.href = URL.createObjectURL(blob);
      link.download = 'attention-is-all-you-need.pdf';
      link.textContent = '下载论文 PDF（Ego 实战测试）';
      link.style.cssText = 'position:fixed;left:20px;top:20px;z-index:2147483647;padding:12px;background:white;color:black;border:2px solid black';
      document.body.appendChild(link);
      return { type: blob.type, size: blob.size };
    })()`,
  });
  const snapshot = await callText("ego_snapshot", { scope: "viewport", stableLocators: true });
  const downloadRef = snapshot.match(/link "下载论文 PDF（Ego 实战测试）" \[(@\d+)\]/)?.[1];
  if (!downloadRef) throw new Error("论文下载链接未出现在页面快照中");

  const downloaded = await call("ego_download", { target: downloadRef, saveAs: outputPath, timeout: 60_000 });
  record("浏览器下载事件", downloaded?.suggestedFilename === "attention-is-all-you-need.pdf", downloaded);

  const bytes = existsSync(outputPath) ? statSync(outputPath).size : 0;
  const header = existsSync(outputPath) ? readFileSync(outputPath).subarray(0, 5).toString("ascii") : "";
  record("PDF 文件完整性", header === "%PDF-" && bytes > 100_000, { path: outputPath, bytes, header });

  const downloadsState = existsSync(downloadsStatePath) ? JSON.parse(readFileSync(downloadsStatePath, "utf8")) : { downloads: [] };
  const downloadRecord = downloadsState.downloads?.find((item) => item.savePath === outputPath || item.filename === "attention-is-all-you-need.pdf");
  record("下载中心记录", downloadRecord?.state === "completed", downloadRecord || { stateFile: downloadsStatePath, found: false });
} finally {
  await client.close().catch(() => {});
}

if (selectedTask?.taskId) {
  const rpc = await PipeRuntimeTransport.connect(pipeName);
  try {
    const operations = await rpc.request("operation.list", {
      clientId: "ego-paper-download-audit",
      taskId: selectedTask.taskId,
      limit: 100,
    });
    const downloadOperation = operations.find((item) => item.tool === "ego_download" && item.status === "completed");
    record("Codex 下载操作记录", Boolean(downloadOperation), downloadOperation || { found: false });
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
