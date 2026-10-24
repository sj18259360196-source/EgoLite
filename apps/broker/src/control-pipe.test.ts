import assert from "node:assert/strict";
import test from "node:test";
import { PipeRuntimeTransport, createEgoRuntime } from "@ego-compat/runtime-adapter";
import { BrokerPipeServer } from "./server.ts";

test("real pipe wait preserves selection, supports cancellation and resumes only after desktop approval", async () => {
  const token = "control-test-token-at-least-32-bytes-long";
  const server = new BrokerPipeServer(undefined, undefined, undefined, undefined, { desktopControlToken: token });
  const pipe = `\\\\.\\pipe\\ego-control-${process.pid}-${Date.now()}`;
  await server.listen(pipe);
  const a = await PipeRuntimeTransport.connect(pipe);
  const b = await PipeRuntimeTransport.connect(pipe);
  const desktop = await PipeRuntimeTransport.connect(pipe);
  const writer = createEgoRuntime(a, { clientId: "agent-a" });
  const observer = createEgoRuntime(b, { clientId: "agent-b" });
  try {
    await desktop.request("agent.register", { clientId: "desktop-test", clientKind: "desktop-ui", controlToken: token });
    const original = await observer.createTaskSpace("Observer");
    const target = await writer.createTaskSpace("Writer");
    await desktop.request("space.userTakeover", { clientId: "desktop-test", id: target.id });
    await observer.observeTaskSpace!(target.id);
    await assert.rejects(observer.takeOverTaskSpace(target.id));
    assert.equal(server.broker.spaces.selected("agent-b").id, original.id);
    await assert.rejects(observer.waitForAgentControl!(target.id, { timeout: 25 }), /timed out/);
    assert.equal(server.broker.spaces.selected("agent-b").id, original.id);
    const controller = new AbortController();
    const cancelled = observer.waitForAgentControl!(target.id, { signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    assert.equal(server.broker.spaces.selected("agent-b").id, original.id);
    const request = await observer.requestControl!(target.id);
    await assert.rejects(b.request("space.approveControl", { clientId: "agent-b", id: target.id, requestId: request.id }));
    const waiting = observer.waitForAgentControl!(target.id, { timeout: 2_000 });
    await desktop.request("space.approveControl", { clientId: "desktop-test", id: target.id, requestId: request.id });
    await waiting;
    assert.equal(server.broker.spaces.selected("agent-b").id, target.id);
    await observer.createTab("https://approved.test");
    await assert.rejects(writer.createTab("https://revoked.test"));
  } finally {
    await a.close(); await b.close(); await desktop.close(); await server.close();
  }
});
