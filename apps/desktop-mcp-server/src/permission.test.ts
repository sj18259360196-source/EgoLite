import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import { BrokerPipeServer } from "../../broker/src/server.ts";
import { DesktopRpcClient } from "./client.ts";

test("desktop MCP registers its Agent and binds each mutation to the preflight lease", async (t) => {
  const brokerPipe = `\\\\.\\pipe\\desktop-permission-broker-${randomUUID()}`;
  const automationPipe = `\\\\.\\pipe\\desktop-permission-automation-${randomUUID()}`;
  const previous = process.env.EGO_COMPAT_PIPE;
  process.env.EGO_COMPAT_PIPE = brokerPipe;
  t.after(() => { if (previous === undefined) delete process.env.EGO_COMPAT_PIPE; else process.env.EGO_COMPAT_PIPE = previous; });
  const broker = new BrokerPipeServer();
  await broker.listen(brokerPipe);
  const client = new DesktopRpcClient(automationPipe);
  const space = await broker.broker.createTaskSpace("MCP permission", client.clientId);
  let writes = 0;
  const sockets = new Set<Socket>();
  const automation = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const request = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        try {
          assert.equal(request.params.__egoClientId, client.clientId);
          if (request.method === "mutation.context") {
            broker.broker.assertMutationAllowed(client.clientId, space.leaseEpoch, space.id);
            socket.write(JSON.stringify({ id: request.id, result: { taskId: space.taskId, taskSpaceId: space.id, leaseEpoch: space.leaseEpoch } }) + "\n");
          } else {
            assert.equal(request.params.__egoMutation.leaseEpoch, space.leaseEpoch);
            assert.equal(request.params.taskId, space.taskId);
            writes++;
            socket.write(JSON.stringify({ id: request.id, result: 42 }) + "\n");
          }
        } catch (error) {
          socket.write(JSON.stringify({ id: request.id, error: { message: String(error) } }) + "\n");
        }
      }
    });
  });
  await new Promise<void>((resolve) => automation.listen(automationPipe, resolve));
  try {
    assert.equal(await client.captureScopedSnapshot({ scope: "full_page" }), null);
    assert.equal(await client.request("page.evaluate", { expression: "42" }), 42);
    assert.notEqual(broker.broker.agents.get(client.clientId)?.status, "offline");
    await broker.broker.userTakeoverTaskSpace(space.id);
    await assert.rejects(client.request("page.evaluate", { expression: "unsafe" }));
    assert.equal(writes, 1);
  } finally {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => automation.close(() => resolve()));
    await broker.close();
  }
});
