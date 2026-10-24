import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { BrokerCore, FakeBrowserBackend, TaskSpaceService } from "@ego-compat/broker-core";
import { PipeRuntimeTransport } from "@ego-compat/runtime-adapter";
import { BrokerPipeServer } from "./server.ts";

test("browser disconnect during CoS host shutdown does not crash the broker", async () => {
  const backend = new class extends FakeBrowserBackend {
    failUpdates = false;
    attempted = false;
    override async updateSpaceState(): Promise<void> {
      if (this.failUpdates) {
        this.attempted = true;
        throw new Error("test EPIPE: browser has exited");
      }
    }
  }();
  const broker = new BrokerCore(new TaskSpaceService(), backend);
  const server = new BrokerPipeServer(broker);
  const pipe = `\\\\.\\pipe\\ego-cos-disconnect-${randomUUID()}`;
  await server.listen(pipe);
  const agent = await PipeRuntimeTransport.connect(pipe);
  try {
    await agent.request("agent.register", { clientId: "cos-disconnect-test", clientKind: "codex", displayName: "CoS test" });
    const created = await agent.request<{ id: number }>("space.create", { clientId: "cos-disconnect-test", name: "CoS" });
    backend.failUpdates = true;
    await agent.close();
    for (let attempt = 0; attempt < 50 && !backend.attempted; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(backend.attempted, true);
    assert.notEqual(broker.spaces.byId(created.id).ownership, "agent");
    const observer = await PipeRuntimeTransport.connect(pipe);
    try {
      const result = await observer.request("agent.list", { clientId: "cos-observer-test" });
      assert.ok(result);
    } finally { await observer.close(); }
  } finally {
    await agent.close();
    await server.close();
  }
});
