import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { DesktopRpcClient } from "./client.ts";

test("desktop RPC client reconnects when EgoLite restarts", async () => {
  const pipeName = `\\\\.\\pipe\\ego-desktop-client-reconnect-${randomUUID()}`;
  let sockets = new Set<Socket>();
  let requestSeen: (() => void) | undefined;
  let server = await startServer(pipeName, 1, sockets, () => requestSeen?.());
  const client = new DesktopRpcClient(pipeName);
  let reconnects = 0;
  client.onReconnect(() => { reconnects += 1; });

  assert.equal(await client.request<number>("instance"), 1);

  const seen = new Promise<void>((resolve) => { requestSeen = resolve; });
  const interrupted = client.request<number>("do-not-answer");
  await seen;
  for (const socket of sockets) socket.destroy();
  await assert.rejects(interrupted, /connection closed|socket/i);
  await closeServer(server);

  const reconnecting = client.request<number>("instance");
  await new Promise((resolve) => setTimeout(resolve, 150));
  sockets = new Set<Socket>();
  server = await startServer(pipeName, 2, sockets);
  assert.equal(await reconnecting, 2);
  assert.equal(reconnects, 1);

  client.close();
  for (const socket of sockets) socket.destroy();
  await closeServer(server);
});

test("concurrent first requests share one desktop connection", async () => {
  const pipeName = `\\\\.\\pipe\\ego-desktop-client-concurrent-${randomUUID()}`;
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = await startServer(pipeName, 7, sockets, undefined, () => { connections += 1; });
  const client = new DesktopRpcClient(pipeName);

  assert.deepEqual(await Promise.all([
    client.request<number>("instance"),
    client.request<number>("instance"),
    client.request<number>("instance"),
  ]), [7, 7, 7]);
  assert.equal(connections, 1);

  client.close();
  for (const socket of sockets) socket.destroy();
  await closeServer(server);
});

test("closing during retry promptly rejects pending connection", async () => {
  const pipeName = `\\\\.\\pipe\\ego-desktop-client-close-${randomUUID()}`;
  const client = new DesktopRpcClient(pipeName);
  const pending = client.request("instance");
  await new Promise((resolve) => setTimeout(resolve, 25));
  client.close();
  await assert.rejects(Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), 250)),
  ]), /client closed/i);
});

test("desktop RPC client survives a malformed response", async () => {
  const pipeName = `\\\\.\\pipe\\ego-desktop-client-malformed-${randomUUID()}`;
  const sockets = new Set<Socket>();
  const server = await startServer(pipeName, 11, sockets, undefined, undefined, "malformed");
  const client = new DesktopRpcClient(pipeName);

  await assert.rejects(client.request("malformed"), /JSON|Unexpected token|property name/i);
  assert.equal(await client.request<number>("instance"), 11);

  client.close();
  for (const socket of sockets) socket.destroy();
  await closeServer(server);
});

function startServer(
  pipeName: string,
  result: number,
  sockets: Set<Socket>,
  onRequest?: () => void,
  onConnection?: () => void,
  malformedMethod?: string,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      onConnection?.();
      sockets.add(socket);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const request = JSON.parse(line) as { id: string; method: string };
          onRequest?.();
          if (request.method === "do-not-answer") continue;
          if (request.method === malformedMethod) {
            socket.write("{malformed\n");
            continue;
          }
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
      socket.once("close", () => sockets.delete(socket));
    });
    server.once("error", reject);
    server.listen(pipeName, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
