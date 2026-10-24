import type { LeaseAwareEgoRuntime } from "./adapter.ts";
import type { RuntimeTransport } from "./transport.ts";

export const DEFAULT_RUNTIME_KEEPALIVE_INTERVAL_MS = 5_000;

export interface RuntimeKeepaliveTimer {
  unref?(): void;
}

export interface RuntimeKeepaliveScheduler {
  setInterval(callback: () => void, intervalMs: number): RuntimeKeepaliveTimer;
  clearInterval(timer: RuntimeKeepaliveTimer): void;
}

export interface RuntimeKeepaliveOptions {
  intervalMs?: number;
  scheduler?: RuntimeKeepaliveScheduler;
}

export interface RuntimeKeepaliveController {
  pulse(): Promise<void>;
  stop(): void;
}

const systemScheduler: RuntimeKeepaliveScheduler = {
  setInterval(callback, intervalMs) {
    return setInterval(callback, intervalMs);
  },
  clearInterval(timer) {
    clearInterval(timer as NodeJS.Timeout);
  },
};

/**
 * Keeps both the broker agent record and the selected task lease alive while
 * an Agent is doing non-browser work such as fetch batches or local parsing.
 */
export function startRuntimeKeepalive(
  runtime: Pick<LeaseAwareEgoRuntime, "heartbeatTaskSpace">,
  transport: RuntimeTransport,
  clientId: string,
  options: RuntimeKeepaliveOptions = {},
): RuntimeKeepaliveController {
  const intervalMs = options.intervalMs ?? DEFAULT_RUNTIME_KEEPALIVE_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("Runtime keepalive interval must be greater than zero");
  }

  const scheduler = options.scheduler ?? systemScheduler;
  let stopped = false;
  let inFlight: Promise<void> | undefined;

  const pulse = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (!inFlight) {
      inFlight = Promise.allSettled([
        Promise.resolve().then(() => transport.request("agent.heartbeat", { clientId })),
        Promise.resolve().then(() => runtime.heartbeatTaskSpace()),
      ])
        .then(() => undefined)
        .finally(() => {
          inFlight = undefined;
        });
    }
    return inFlight;
  };

  const timer = scheduler.setInterval(() => {
    void pulse();
  }, intervalMs);
  timer.unref?.();

  return {
    pulse,
    stop() {
      if (!stopped) {
        stopped = true;
        scheduler.clearInterval(timer);
      }
    },
  };
}
