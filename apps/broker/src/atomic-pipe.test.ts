import assert from "node:assert/strict";
import test from "node:test";
import { PipeRuntimeTransport, createEgoRuntime } from "@ego-compat/runtime-adapter";
import { BrokerPipeServer } from "./server.ts";

test("CLI and MCP aliases share atomic work over simultaneous real pipe connections", async () => {
  const server = new BrokerPipeServer();
  const name = `\\\\.\\pipe\\ego-atomic-${process.pid}-${Date.now()}`;
  await server.listen(name);
  const first = await PipeRuntimeTransport.connect(name);
  const second = await PipeRuntimeTransport.connect(name);
  const digest = "0123456789abcdef01234567";
  const cli = createEgoRuntime(first, { clientId: `codex-cli-${digest}` });
  const mcp = createEgoRuntime(second, { clientId: `codex-mcp-${digest}` });
  try {
    const [a, b] = await Promise.all([cli.useOrCreateTaskSpace!("pipe shared"), mcp.useOrCreateTaskSpace!("pipe shared")]);
    assert.equal(a.id, b.id);
    const tabs = await Promise.all([cli.openOrReuseTab!("https://example.test"), mcp.openOrReuseTab!("https://example.test")]);
    assert.equal(tabs[0].targetId, tabs[1].targetId);
    assert.equal(tabs.filter((tab) => !tab.reused).length, 1);
    assert.equal(server.broker.agents.list().length, 1);
    assert.equal(server.broker.agents.list()[0]?.clientId, `codex-${digest}`);
    await second.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await cli.openOrReuseTab!("https://example.test")).reused, true);
    assert.notEqual(server.broker.agents.get(`codex-${digest}`)?.status, "offline");
  } finally {
    await first.close(); await second.close(); await server.close();
  }
});
