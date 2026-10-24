import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPackageStatusTools } from "./package-status-tools.ts";

test("Package status MCP tools are read-only and dispatch without a selected page", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const server = new McpServer({ name: "status-test", version: "1" });
  registerPackageStatusTools(server, async (method, params) => {
    calls.push({ method, params });
    return { available: false, sourceScope: params.sourceScope };
  });
  const client = new Client({ name: "status-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 3);
    assert.ok(tools.every(tool => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
    await client.callTool({ name: "ego_package_status", arguments: {} });
    assert.deepEqual(calls.at(-1), { method: "package.status", params: { packageId: "cos" } });
    const agents = await client.callTool({ name: "ego_agent_status", arguments: { sourceScope: "codex-desktop" } });
    assert.equal(calls.at(-1)?.method, "agent.knownStatus");
    assert.match(JSON.stringify(agents), /available.*false/);
    await client.callTool({ name: "ego_package_wait", arguments: { afterCursor: "epoch:1", timeoutMs: 25 } });
    assert.deepEqual(calls.at(-1), { method: "package.wait", params: { afterCursor: "epoch:1", timeoutMs: 25 } });
    const before = calls.length;
    for (const args of [{ timeoutMs: 25001 }, { timeoutMs: -1 }, { instanceId: "other" }]) {
      const response = await client.callTool({ name: "ego_package_wait", arguments: args });
      assert.equal(response.isError, true);
    }
    assert.equal(calls.length, before);
  } finally {
    await client.close();
    await server.close();
  }
});
