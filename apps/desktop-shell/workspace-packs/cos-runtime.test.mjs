import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { CosRuntime, resolvePackEntry } from "./cos-runtime.mjs";
import { encodeWire, decodeWire } from "./cos-wire.cjs";

class Child extends EventEmitter {
  pid = 1234;
  connected = true;
  exitCode = null;
  sent = [];
  send(message, callback) { this.sent.push(decodeWire(message)); callback?.(); }
  emit(event, ...args) { return super.emit(event, ...(event === "message" ? [encodeWire(args[0])] : args)); }
  exit(code = 0) {
    this.connected = false;
    this.exitCode = code;
    this.emit("exit", code, null);
  }
  kill() { this.exit(); }
}

async function setup(t, child = new Child(), options = {}) {
  const base = resolve(".tmp/codex/cos-integration/unit");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    id: "cos", hostApiVersion: 1, ipcEncoding: "cos-json-v1", entries: { electron: "electron.exe", main: "source/main.js" },
  }));
  const runtime = new CosRuntime({
    directory, dataDirectory: join(directory, "data"),
    spawnProcess: () => {
      setImmediate(() => child.emit("message", { type: "cos:ready", protocol: 1, channels: ["state:get"] }));
      return child;
    },
    startTimeoutMs: 1000, stopTimeoutMs: 1000, ...options,
  });
  return { runtime, child };
}

test("pack entries reject traversal and absolute paths", () => {
  const root = resolve("packs/cos");
  assert.equal(resolvePackEntry(root, "source/main.js"), join(root, "source/main.js"));
  for (const entry of ["../other", "..\\other", "", null, resolve("outside")]) {
    assert.throws(() => resolvePackEntry(root, entry));
  }
});

test("maintenance probe rejects older packs before starting any process", async t => {
  let spawned = false;
  const { runtime } = await setup(t, undefined, {
    probeOnly: true, spawnProcess: () => { spawned = true; throw new Error("must not launch"); },
  });
  await assert.rejects(runtime.start(), /non-executing maintenance probe/);
  assert.equal(spawned, false);
  assert.equal(runtime.state, "stopped");
});

test("runtime routes replies and rejects unsupported methods", async t => {
  const { runtime, child } = await setup(t);
  await runtime.start();
  assert.equal(runtime.state, "ready");
  await assert.rejects(runtime.invoke("not-registered"), /Unsupported/);
  await assert.rejects(runtime.invoke("state:get", new Map()), /Unsupported/);
  const request = runtime.invoke("state:get");
  const sent = child.sent.at(-1);
  child.emit("message", { type: "cos:reply", id: sent.id, result: { ok: true } });
  assert.deepEqual(await request, { ok: true });
  const stopped = runtime.stop();
  child.exit();
  await stopped;
  assert.equal(runtime.state, "stopped");
  assert.equal(runtime.pid, undefined);
});

test("stop fences late ready messages and rejects pending calls", async t => {
  const { runtime, child } = await setup(t);
  await runtime.start();
  const pending = runtime.invoke("state:get");
  const rejected = assert.rejects(pending, /runtime exited/);
  const stopping = runtime.stop();
  child.emit("message", { type: "cos:ready", protocol: 1, channels: ["state:get"] });
  assert.equal(runtime.state, "stopping");
  await assert.rejects(runtime.invoke("state:get"), /not ready/);
  child.exit();
  await stopping;
  await rejected;
});

test("duplicate start and stop requests use one child lifecycle", async t => {
  const { runtime, child } = await setup(t);
  await Promise.all([runtime.start(), runtime.start()]);
  const stops = [runtime.stop(), runtime.stop()];
  assert.equal(child.sent.filter(message => message.type === "cos:stop").length, 1);
  child.exit();
  await Promise.all(stops);
});

test("request timeout reports unknown outcome without retrying", async t => {
  const { runtime, child } = await setup(t);
  await runtime.start();
  await assert.rejects(runtime.invoke("state:get", {}, 10), /outcome unknown/);
  assert.equal(child.sent.filter(message => message.type === "cos:invoke").length, 1);
  const stopped = runtime.stop();
  child.exit();
  await stopped;
});
