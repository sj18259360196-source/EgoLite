import assert from "node:assert/strict";
import test from "node:test";
import { BrokerCore, TaskSpaceService, FakeBrowserBackend } from "@ego-compat/broker-core";
import { PipeRuntimeTransport, PROTOCOL_VERSION } from "@ego-compat/runtime-adapter";
import { BrokerPipeServer } from "./server.ts";

test("autonomous RPC control requests grant shared access without a user approval queue", async () => {
  const broker = new BrokerCore(new TaskSpaceService(), new FakeBrowserBackend(), undefined, undefined, { controlMode: "agent" });
  const server = new BrokerPipeServer(broker);
  const pipe = `\\\\.\\pipe\\ego-autonomous-${process.pid}-${Date.now()}`;
  await server.listen(pipe);
  const a = await PipeRuntimeTransport.connect(pipe);
  const b = await PipeRuntimeTransport.connect(pipe);
  try {
    for (const [transport, clientId] of [[a, "shared-a"], [b, "shared-b"]] as const) {
      await transport.negotiateHello({ protocolVersion: PROTOCOL_VERSION, clientId, pid: process.pid });
    }
    const space = await a.request<{ id: number; leaseEpoch: number }>("space.create", { clientId: "shared-a", name: "shared" });
    const request = await b.request<{ status: string }>("space.requestControl", { clientId: "shared-b", id: space.id });
    assert.equal(request.status, "approved");
    assert.equal(broker.controlState(space.id).requests.length, 0);
    for (const [transport, clientId] of [[a, "shared-a"], [b, "shared-b"]] as const) {
      await transport.request("tab.create", { clientId, taskSpaceId: space.id, leaseEpoch: space.leaseEpoch, url: "https://example.test" });
    }
    broker.spaces.stopAgent(space.id);
    await assert.rejects(b.request("space.requestControl", { clientId: "shared-b", id: space.id }), /stopped|user control/);
  } finally {
    await a.close();
    await b.close();
    await server.close();
  }
});
