import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RUNTIME_KEEPALIVE_INTERVAL_MS,
  startRuntimeKeepalive,
  type RuntimeKeepaliveScheduler,
  type RuntimeKeepaliveTimer,
} from "./keepalive.ts";
import type { RuntimeTransport } from "./transport.ts";

class ManualScheduler implements RuntimeKeepaliveScheduler {
  callback: (() => void) | undefined;
  intervalMs = 0;
  cleared = false;
  unrefed = false;

  setInterval(callback: () => void, intervalMs: number): RuntimeKeepaliveTimer {
    this.callback = callback;
    this.intervalMs = intervalMs;
    return { unref: () => { this.unrefed = true; } };
  }

  clearInterval(): void {
    this.cleared = true;
  }
}

test("runtime keepalive renews both agent presence and the selected task lease", async () => {
  const scheduler = new ManualScheduler();
  const transportCalls: Array<{ method: string; params: unknown }> = [];
  let taskHeartbeats = 0;
  const transport: RuntimeTransport = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      transportCalls.push({ method, params });
      return undefined as T;
    },
    onEvent() {
      return () => {};
    },
  };
  const keepalive = startRuntimeKeepalive(
    { async heartbeatTaskSpace() { taskHeartbeats += 1; return true; } },
    transport,
    "agent-a",
    { scheduler },
  );

  assert.equal(scheduler.intervalMs, DEFAULT_RUNTIME_KEEPALIVE_INTERVAL_MS);
  assert.equal(scheduler.unrefed, true);
  await keepalive.pulse();
  assert.deepEqual(transportCalls, [
    { method: "agent.heartbeat", params: { clientId: "agent-a" } },
  ]);
  assert.equal(taskHeartbeats, 1);

  keepalive.stop();
  assert.equal(scheduler.cleared, true);
});

test("runtime keepalive coalesces slow pulses and contains heartbeat failures", async () => {
  const scheduler = new ManualScheduler();
  let agentHeartbeats = 0;
  let taskHeartbeats = 0;
  let releaseTaskHeartbeat: (() => void) | undefined;
  const taskHeartbeatDone = new Promise<void>((resolve) => {
    releaseTaskHeartbeat = resolve;
  });
  const transport: RuntimeTransport = {
    async request<T>(): Promise<T> {
      agentHeartbeats += 1;
      throw new Error("broker heartbeat failed");
    },
    onEvent() {
      return () => {};
    },
  };
  const keepalive = startRuntimeKeepalive(
    {
      async heartbeatTaskSpace() {
        taskHeartbeats += 1;
        await taskHeartbeatDone;
        throw new Error("task heartbeat failed");
      },
    },
    transport,
    "agent-a",
    { scheduler },
  );

  const first = keepalive.pulse();
  const second = keepalive.pulse();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agentHeartbeats, 1);
  assert.equal(taskHeartbeats, 1);

  releaseTaskHeartbeat?.();
  await Promise.all([first, second]);
  keepalive.stop();
});
