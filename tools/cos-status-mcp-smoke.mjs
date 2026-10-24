import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const results = [];
for (const entry of ["apps/ego-mcp-server/src/main.ts", "apps/desktop-mcp-server/src/main.ts"]) {
  const client = new Client({ name: "cos-status-smoke", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(root, entry)], cwd: root,
    env: { ...process.env, EGO_DESKTOP_AUTOSTART: "0" }, stderr: "pipe",
  });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content.find(item => item.type === "text").text);
  };
  try {
    await client.connect(transport);
    const status = await call("ego_package_status");
    assert.equal(status.package.state, "ready");
    assert.equal(status.taskState, "observed");
    assert.equal((await call("ego_agent_status")).available, true);
    assert.equal((await call("ego_agent_status", { sourceScope: "codex-desktop" })).available, false);
    const events = await call("ego_package_wait");
    assert.ok(events.cursor);
    assert.ok(Array.isArray(events.events));
    results.push({ entry, passed: true });
  } finally {
    await client.close();
    await transport.close();
  }
}
console.log(JSON.stringify({ passed: true, results }));
