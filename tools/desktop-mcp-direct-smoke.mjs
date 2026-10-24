import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "apps", "desktop-mcp-server", "src", "main.ts")],
  cwd: root,
  env: {
    ...process.env,
    EGO_DESKTOP_AUTOMATION_PIPE: process.env.EGO_DESKTOP_AUTOMATION_PIPE || "\\\\.\\pipe\\ego-compat-desktop",
  },
  stderr: "pipe",
});
const client = new Client({ name: "desktop-mcp-direct-smoke", version: "0.1.0" });
let createdTarget = "";

try {
  await client.connect(transport);
  const status = jsonOf(await call("ego_desktop_status"));
  if (!status.ready) throw new Error(`EgoLite desktop is unavailable: ${JSON.stringify(status)}`);

  const html = `<!doctype html><title>Desktop MCP direct smoke</title>
    <input aria-label="Name"><button id="apply">Apply</button><h1>Ready</h1>
    <div style="height:1500px"></div><h2>Bottom marker</h2>
    <script>apply.onclick=()=>document.querySelector('h1').textContent=document.querySelector('input').value<\/script>`;
  const created = jsonOf(await call("ego_desktop_new_tab", { url: `data:text/html,${encodeURIComponent(html)}` }));
  createdTarget = created.targetId;
  if (!createdTarget) throw new Error(`New tab did not return a target id: ${JSON.stringify(created)}`);

  await call("ego_desktop_wait", { loadComplete: true, text: "Apply", timeout: 10_000 });
  const snapshot = textOf(await call("ego_desktop_snapshot"));
  const textbox = snapshot.match(/textbox "Name" \[(@\d+)\]/)?.[1];
  const button = snapshot.match(/button "Apply" \[(@\d+)\]/)?.[1];
  if (!textbox || !button) throw new Error(`Action refs are missing: ${snapshot}`);

  await call("ego_desktop_fill", { target: textbox, value: "Direct MCP" });
  await call("ego_desktop_hover", { target: button });
  await call("ego_desktop_click", { target: button });
  const clickedHeading = jsonOf(await call("ego_desktop_evaluate", { expression: "document.querySelector('h1').textContent" }));

  const statementResult = jsonOf(await call("ego_desktop_evaluate", { expression: "document.querySelector('input').focus(); return true;" }));
  await call("ego_desktop_press", { key: "Control+A" });
  await call("ego_desktop_type", { text: "Typed MCP" });
  await call("ego_desktop_press", { key: "Tab" });
  await call("ego_desktop_press", { key: "Enter" });
  const typedHeading = jsonOf(await call("ego_desktop_evaluate", { expression: "document.querySelector('h1').textContent" }));

  await call("ego_desktop_scroll", { deltaX: 0, deltaY: 900 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const scrollY = jsonOf(await call("ego_desktop_evaluate", { expression: "scrollY" }));
  const tabs = jsonOf(await call("ego_desktop_tabs"));

  const checks = {
    statusReady: status.ready === true,
    tabCreated: tabs.some((tab) => tab.targetId === createdTarget),
    clickWorked: clickedHeading === "Direct MCP",
    statementsWorked: statementResult === true,
    keyboardWorked: typedHeading === "Typed MCP",
    scrollWorked: Number(scrollY) > 0,
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(`Desktop MCP direct smoke failed: ${JSON.stringify({ checks, clickedHeading, typedHeading, scrollY })}`);
  console.log(JSON.stringify({ passed: true, ...checks }, null, 2));
} finally {
  if (createdTarget) await call("ego_desktop_close_tab", { targetId: createdTarget }).catch(() => {});
  await client.close().catch(() => {});
}

function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function textOf(result) {
  const content = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "";
  if (result.isError) throw new Error(content || `${result} failed`);
  return content;
}

function jsonOf(result) {
  return JSON.parse(textOf(result));
}
