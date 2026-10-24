import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";

test("native host converts browser frames to companion pipe lines and back", { timeout: 15_000 }, async (t) => {
  const pipeLeaf = `ego-native-host-test-${process.pid}-${Date.now()}`;
  const pipePath = `\\\\.\\pipe\\${pipeLeaf}`;
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const exe = new URL("./bin/Release/net8.0-windows/ego-native-host.exe", import.meta.url);
  const exePath = exe.pathname.slice(1);
  const config = await readBrokerConfig(exePath);
  const child = spawn(exePath, [], {
    env: { ...process.env, EGO_COMPANION_PIPE_NAME: pipeLeaf },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => child.kill());
  const [socket] = await within(once(server, "connection"), "native host connection");
  await authenticate(socket, Buffer.from(config.authSecret, "base64"));

  const browserMessage = JSON.stringify({ id: "one", method: "tab.list", params: {} });
  child.stdin.write(nativeFrame(browserMessage));
  const line = await within(readLine(socket), "browser frame forwarding");
  assert.equal(line, browserMessage);

  const pipeMessage = JSON.stringify({ id: "one", result: [] });
  socket.write(`${pipeMessage}\n`);
  assert.equal(await within(readNativeFrame(child.stdout), "pipe frame forwarding"), pipeMessage);

  socket.destroy();
  child.stdin.end();
  await within(once(child, "exit"), "native host exit");
});

function nativeFrame(value) {
  const body = Buffer.from(value, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function readBrokerConfig(exePath) {
  const child = spawn(exePath, ["--broker-config"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  await once(child, "exit");
  return JSON.parse(output);
}

async function authenticate(socket, secret) {
  const nonce = randomBytes(32);
  socket.write(`${JSON.stringify({ method: "auth.challenge", params: { nonce: nonce.toString("base64") } })}\n`);
  const response = JSON.parse(await within(readLine(socket), "native host authentication"));
  const expected = createHmac("sha256", secret).update(nonce).digest("base64");
  assert.equal(response.method, "auth.response");
  assert.equal(response.params.proof, expected);
  socket.write(`${JSON.stringify({ method: "auth.ok", params: {} })}\n`);
}

function readLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Pipe closed before line arrived"));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("close", onClose);
    };
    stream.on("data", onData);
    stream.once("close", onClose);
  });
}

async function readNativeFrame(stream) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4) continue;
    const size = buffer.readUInt32LE(0);
    if (buffer.length >= size + 4) return buffer.subarray(4, size + 4).toString("utf8");
  }
  throw new Error("Native host closed before frame arrived");
}

function within(promise, label, timeoutMs = 3_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs)),
  ]);
}
