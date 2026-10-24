import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import test from "node:test";

import type { TaskSpaceRecord } from "@ego-compat/protocol";
import { BrokerCore, TaskSpaceService } from "@ego-compat/broker-core";

import { CompanionBackend } from "./companion-backend.ts";

test("companion backend routes commands and task-scoped CDP events", { timeout: 8_000 }, async (t) => {
  const pipeName = `\\\\.\\pipe\\ego-companion-test-${process.pid}-${Date.now()}`;
  const secret = randomBytes(32);
  const backend = new CompanionBackend(pipeName, secret);
  await backend.start();
  t.after(() => backend.dispose());
  const extension = await FakeExtension.connect(pipeName, secret);
  t.after(() => extension.close());

  extension.respond("space.create", {});
  extension.respond("space.state", {});
  await backend.createSpace(space("task-a"));

  extension.respond("tab.list", [
    { targetId: "ego-tab-41", title: "Fixture", url: "https://example.test", active: true },
  ]);
  assert.equal((await backend.listTabs("task-a"))[0]?.targetId, "ego-tab-41");

  extension.respond("cdp.send", JSON.stringify({ id: 7, result: { value: 42 } }));
  assert.equal(
    await backend.sendCdp("task-a", JSON.stringify({ id: 7, method: "Runtime.evaluate" })),
    JSON.stringify({ id: 7, result: { value: 42 } }),
  );

  const event = new Promise<string>((resolve) => backend.onCdpMessage((_taskId, payload) => resolve(payload)));
  extension.emit("cdp.event", {
    taskId: "task-a",
    payload: JSON.stringify({ method: "Page.loadEventFired", params: {} }),
  });
  assert.match(await event, /Page\.loadEventFired/);

  const selection = new Promise<string>((resolve) =>
    backend.onTextSelectionChanged((_taskId, value) => resolve(value.text)),
  );
  extension.emit("text.selectionChanged", {
    taskId: "task-a",
    selection: {
      text: "Selected companion text",
      sourceUrl: "https://example.test",
      pageTitle: "Fixture",
      favicon: null,
    },
  });
  assert.equal(await selection, "Selected companion text");

  await extension.close();
  const disconnectedAt = Date.now();
  await assert.rejects(
    () => backend.listTabs("task-a"),
    (error: unknown) =>
      error instanceof Error &&
      "error_code" in error &&
      error.error_code === "EGO_BROWSER_UNAVAILABLE",
  );
  assert.ok(Date.now() - disconnectedAt < 3_500);
  await backend.dispose();
});

test("companion control loss fences the Broker lease", { timeout: 5_000 }, async (t) => {
  const pipeName = `\\\\.\\pipe\\ego-companion-control-${process.pid}-${Date.now()}`;
  const secret = randomBytes(32);
  const backend = new CompanionBackend(pipeName, secret);
  await backend.start();
  t.after(() => backend.dispose());
  const extension = await FakeExtension.connect(pipeName, secret);
  t.after(() => extension.close());
  const broker = new BrokerCore(new TaskSpaceService({ backend: "companion" }), backend);

  extension.respond("space.create", {});
  extension.respond("space.state", {});
  await broker.createTaskSpace("Control fixture", "agent-a");
  const epoch = broker.spaces.currentLease("agent-a").epoch;
  extension.respond("space.state", {});
  extension.emit("control.lost", { taskId: broker.spaces.selected("agent-a").taskId, reason: "user-requested" });
  const deadline = Date.now() + 1_000;
  while (broker.spaces.selected("agent-a").ownership !== "agentDelegatedToUser") {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for control loss");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  await assert.rejects(
    () => broker.createTab("agent-a", epoch),
    (error: unknown) =>
      error instanceof Error &&
      "error_code" in error &&
      error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
});

test("companion rejects a client with the wrong HMAC secret", { timeout: 2_000 }, async (t) => {
  const pipeName = `\\\\.\\pipe\\ego-companion-auth-${process.pid}-${Date.now()}`;
  const backend = new CompanionBackend(pipeName, randomBytes(32));
  await backend.start();
  t.after(() => backend.dispose());
  await assert.rejects(() => FakeExtension.connect(pipeName, randomBytes(32)));
});

test("Side Panel consent authorizes exactly one takeover", { timeout: 5_000 }, async (t) => {
  const pipeName = `\\\\.\\pipe\\ego-companion-consent-${process.pid}-${Date.now()}`;
  const secret = randomBytes(32);
  const backend = new CompanionBackend(pipeName, secret);
  await backend.start();
  t.after(() => backend.dispose());
  const extension = await FakeExtension.connect(pipeName, secret);
  t.after(() => extension.close());
  const broker = new BrokerCore(new TaskSpaceService({ backend: "companion" }), backend);

  extension.respond("space.create", {});
  extension.respond("space.state", {});
  const created = await broker.createTaskSpace("Consent fixture", "agent-a");
  extension.respond("space.handoff", {});
  extension.respond("space.state", {});
  await broker.handOffTaskSpace("agent-a");
  extension.emit("control.takeoverAuthorized", { taskId: created.taskId });
  await new Promise((resolve) => setTimeout(resolve, 10));
  extension.respond("space.state", {});
  const resumed = await broker.takeOverTaskSpace(created.id, "agent-a");
  assert.equal(resumed.ownership, "agent");

  await assert.rejects(
    () => broker.takeOverTaskSpace(created.id, "agent-a"),
    (error: unknown) =>
      error instanceof Error &&
      "error_code" in error &&
      error.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
});

class FakeExtension {
  readonly #socket: Socket;
  readonly #responses = new Map<string, unknown[]>();
  #buffer = "";

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
  }

  static connect(pipeName: string, secret?: Buffer): Promise<FakeExtension> {
    return new Promise((resolve, reject) => {
      const socket = connect(pipeName);
      socket.once("error", reject);
      socket.once("connect", () => {
        const extension = new FakeExtension(socket);
        if (!secret) {
          extension.#startReceiving();
          extension.emit("bridge.ready", { recoveredTaskIds: [], reason: "test-connected" });
          resolve(extension);
          return;
        }
        extension.#authenticate(secret).then(() => {
          extension.#startReceiving();
          extension.emit("bridge.ready", { recoveredTaskIds: [], reason: "test-connected" });
          resolve(extension);
        }, reject);
      });
    });
  }

  #authenticate(secret: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#socket.once("close", () => reject(new Error("Companion authentication rejected")));
      const onData = (chunk: string) => {
        this.#buffer += chunk;
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        this.#socket.off("data", onData);
        const challenge = JSON.parse(this.#buffer.slice(0, newline)) as {
          params: { nonce: string };
        };
        this.#buffer = this.#buffer.slice(newline + 1);
        const proof = createHmac("sha256", secret)
          .update(Buffer.from(challenge.params.nonce, "base64"))
          .digest("base64");
        this.#socket.write(`${JSON.stringify({ method: "auth.response", params: { proof } })}\n`, (error) => {
          if (error) reject(error);
        });
        const onConfirmation = (confirmationChunk: string) => {
          this.#buffer += confirmationChunk;
          const confirmationNewline = this.#buffer.indexOf("\n");
          if (confirmationNewline < 0) return;
          this.#socket.off("data", onConfirmation);
          const confirmation = JSON.parse(this.#buffer.slice(0, confirmationNewline)) as { method?: string };
          this.#buffer = this.#buffer.slice(confirmationNewline + 1);
          confirmation.method === "auth.ok"
            ? resolve()
            : reject(new Error("Companion authentication rejected"));
        };
        this.#socket.on("data", onConfirmation);
      };
      this.#socket.on("data", onData);
    });
  }

  #startReceiving(): void {
    this.#socket.on("data", (chunk: string) => this.#receive(chunk));
    if (this.#buffer) {
      const buffered = this.#buffer;
      this.#buffer = "";
      this.#receive(buffered);
    }
  }

  respond(method: string, result: unknown): void {
    const queue = this.#responses.get(method) ?? [];
    queue.push(result);
    this.#responses.set(method, queue);
  }

  emit(method: string, params: Record<string, unknown>): void {
    this.#socket.write(`${JSON.stringify({ method, params })}\n`);
  }

  close(): Promise<void> {
    if (this.#socket.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      this.#socket.once("close", resolve);
      this.#socket.destroy();
    });
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const command = JSON.parse(line) as { id: string; method: string };
      const queue = this.#responses.get(command.method) ?? [];
      if (!queue.length) throw new Error(`No fake response for ${command.method}`);
      this.#socket.write(`${JSON.stringify({ id: command.id, result: queue.shift() })}\n`);
    }
  }
}

function space(taskId: string): TaskSpaceRecord {
  const now = new Date().toISOString();
  return {
    taskId,
    id: 1,
    name: "Companion fixture",
    createdBy: "test",
    ownership: "agent",
    lifecycle: "active",
    backend: "companion",
    generation: 1,
    leaseEpoch: 1,
    createdAt: now,
    updatedAt: now,
  };
}
