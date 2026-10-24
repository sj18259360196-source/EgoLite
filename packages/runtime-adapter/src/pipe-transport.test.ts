import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { PipeRuntimeTransport } from "./pipe-transport.ts";

test("pipe transport repeats configured hello before requests on a reconnected socket", async () => {
  const pipeName = `\\\\.\\pipe\\ego-runtime-hello-${randomUUID()}`;
  let sockets = new Set<Socket>();
  let helloCount = 0;
  let server = await startHelloServer(pipeName, sockets, () => { helloCount++; });
  const transport = await PipeRuntimeTransport.connect(pipeName);
  let reconnectCount = 0;
  transport.onReconnect(() => { reconnectCount++; });
  try {
    const hello = await transport.negotiateHello({
      protocolVersion: 1,
      clientId: "hello-client",
      pid: process.pid,
      capabilities: ["scoped-refs-v1"],
    });
    assert.deepEqual(hello.capabilities, ["scoped-refs-v1"]);
    assert.equal(transport.referenceActionMaxLifetimeMs, 300_000);
    assert.equal(await transport.request<number>("instance"), 1);
    assert.equal(helloCount, 1);

    const interrupted = transport.request("do-not-answer");
    await new Promise((resolve) => setImmediate(resolve));
    for (const socket of sockets) socket.destroy();
    await assert.rejects(interrupted, /Broker pipe closed|socket/i);
    await closeServer(server);
    sockets = new Set<Socket>();
    server = await startHelloServer(pipeName, sockets, () => { helloCount++; });

    assert.equal(await transport.request<number>("instance"), 1);
    assert.equal(helloCount, 2);
    assert.equal(reconnectCount, 1);
    assert.deepEqual(transport.negotiatedCapabilities, ["scoped-refs-v1"]);
  } finally {
    await transport.close();
    for (const socket of sockets) socket.destroy();
    await closeServer(server).catch(() => {});
  }
});

test("pipe transport reconnects after the broker restarts", async () => {
  const pipeName = `\\\\.\\pipe\\ego-runtime-reconnect-${randomUUID()}`;
  let sockets = new Set<Socket>();
  let received: (() => void) | undefined;
  let server = await startServer(pipeName, 1, sockets, () => received?.());
  const transport = await PipeRuntimeTransport.connect(pipeName);

  assert.equal(await transport.request<number>("instance"), 1);

  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const interrupted = transport.request<number>("do-not-answer");
  await requestReceived;
  for (const socket of sockets) socket.destroy();
  await assert.rejects(interrupted, /Broker pipe closed|socket/i);
  await closeServer(server);
  sockets = new Set<Socket>();
  server = await startServer(pipeName, 2, sockets);

  assert.equal(await transport.request<number>("instance"), 2);

  await transport.close();
  for (const socket of sockets) socket.destroy();
  await closeServer(server);
});

test("pipe transport closes promptly while reconnecting", async () => {
  const pipeName = `\\\\.\\pipe\\ego-runtime-close-${randomUUID()}`;
  const sockets = new Set<Socket>();
  const server = await startServer(pipeName, 1, sockets);
  const transport = await PipeRuntimeTransport.connect(pipeName);
  for (const socket of sockets) socket.destroy();
  await closeServer(server);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const pending = transport.request("instance");
  const rejected = assert.rejects(Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), 250)),
  ]), /Transport closed/i);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await transport.close();
  await rejected;
});

test("pipe transport rejects malformed frames and reconnects", async () => {
  const pipeName = `\\\\.\\pipe\\ego-runtime-malformed-${randomUUID()}`;
  const sockets = new Set<Socket>();
  const server = await startServer(pipeName, 9, sockets, undefined, "malformed");
  const transport = await PipeRuntimeTransport.connect(pipeName);

  await assert.rejects(transport.request("malformed"), /JSON|Unexpected token|property name/i);
  assert.equal(await transport.request<number>("instance"), 9);

  await transport.close();
  for (const socket of sockets) socket.destroy();
  await closeServer(server);
});

function startServer(
  pipeName: string,
  result: number,
  sockets: Set<Socket>,
  onRequest?: () => void,
  malformedMethod?: string,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
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

function startHelloServer(
  pipeName: string,
  sockets: Set<Socket>,
  onHello: () => void,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
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
          if (request.method === "hello") onHello();
          if (request.method === "do-not-answer") continue;
          const result = request.method === "hello"
            ? { protocolVersion: 1, sessionId: "test", capabilities: ["scoped-refs-v1"], referenceActionMaxLifetimeMs: 300_000 }
            : 1;
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
