import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import { EGO_ERROR_CODES, EgoProtocolError, type EgoErrorCode } from "@ego-compat/protocol";

export interface CompanionCommand {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface CompanionEvent {
  method: string;
  params: Record<string, unknown>;
}

export type CompanionRequestHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export class CompanionBridgeServer {
  readonly #server: Server;
  readonly #pending = new Map<string, PendingCommand>();
  readonly #listeners = new Set<(event: CompanionEvent) => void>();
  readonly #connectionWaiters = new Set<() => void>();
  #requestHandler: CompanionRequestHandler | undefined;
  #socket: Socket | undefined;
  #buffer = "";
  #hasConnected = false;
  readonly #authSecret: Buffer | undefined;

  constructor(authSecret?: Buffer) {
    this.#authSecret = authSecret;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  get connected(): boolean {
    return Boolean(this.#socket && !this.#socket.destroyed);
  }

  listen(pipeName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(pipeName, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
  }

  onEvent(listener: (event: CompanionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setRequestHandler(handler: CompanionRequestHandler): void {
    this.#requestHandler = handler;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socket = await this.#waitForConnection();
    if (!socket || socket.destroyed) {
      throw new EgoProtocolError(
        "EGO_BROWSER_UNAVAILABLE",
        "Companion extension is not connected",
      );
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new EgoProtocolError("EGO_CDP_SEND_FAILED", `Companion timed out: ${method}`));
      }, 15_000);
      this.#pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, method, params } satisfies CompanionCommand)}\n`);
    });
  }

  close(): Promise<void> {
    this.#socket?.destroy();
    this.#failPending(new Error("Companion bridge closed"));
    return new Promise((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  #accept(socket: Socket): void {
    socket.setEncoding("utf8");
    if (!this.#authSecret) {
      this.#activate(socket);
      return;
    }
    const nonce = randomBytes(32);
    let buffer = "";
    const timer = setTimeout(() => socket.destroy(), 5_000);
    socket.write(`${JSON.stringify({ method: "auth.challenge", params: { nonce: nonce.toString("base64") } })}\n`);
    const authenticate = (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.off("data", authenticate);
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as {
          method?: string;
          params?: { proof?: string };
        };
        const proof = Buffer.from(response.params?.proof ?? "", "base64");
        const expected = createHmac("sha256", this.#authSecret!).update(nonce).digest();
        if (response.method !== "auth.response" || proof.length !== expected.length || !timingSafeEqual(proof, expected)) {
          socket.destroy();
          return;
        }
        const remainder = buffer.slice(newline + 1);
        socket.write(`${JSON.stringify({ method: "auth.ok", params: {} })}\n`, () => {
          this.#activate(socket);
          if (remainder) this.#receive(remainder);
        });
      } catch {
        socket.destroy();
      }
    };
    socket.on("data", authenticate);
  }

  #activate(socket: Socket): void {
    this.#socket?.destroy();
    this.#socket = socket;
    this.#hasConnected = true;
    for (const resolve of this.#connectionWaiters) resolve();
    this.#connectionWaiters.clear();
    this.#buffer = "";
    for (const listener of this.#listeners) {
      listener({ method: "bridge.connected", params: {} });
    }
    socket.on("data", (chunk: string) => this.#receive(chunk));
    socket.once("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#failPending(new Error("Companion extension disconnected"));
      for (const listener of this.#listeners) listener({ method: "bridge.disconnected", params: {} });
    });
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as {
        id?: string;
        result?: unknown;
        error?: { code?: string; message?: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) {
          if (message.method && message.params && this.#requestHandler) {
            void this.#handleRequest(message.id, message.method, message.params);
          }
          continue;
        }
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(
            new EgoProtocolError(
              normalizeErrorCode(message.error.code),
              message.error.message ?? "Companion command failed",
            ),
          );
        } else {
          pending.resolve(message.result);
        }
      } else if (message.method && message.params) {
        for (const listener of this.#listeners) {
          listener({ method: message.method, params: message.params });
        }
      }
    }
  }

  async #handleRequest(
    id: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      const result = await this.#requestHandler!(method, params);
      this.#socket?.write(`${JSON.stringify({ id, result })}\n`);
    } catch (error) {
      const value = error as { error_code?: unknown };
      this.#socket?.write(`${JSON.stringify({
        id,
        error: {
          code: typeof value.error_code === "string" ? value.error_code : "EGO_OPERATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      })}\n`);
    }
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #waitForConnection(timeoutMs = 10_000): Promise<Socket | undefined> {
    if (this.#socket && !this.#socket.destroyed) return this.#socket;
    const waitMs = this.#hasConnected ? Math.min(timeoutMs, 3_000) : timeoutMs;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#connectionWaiters.delete(onConnected);
        resolve();
      }, waitMs);
      const onConnected = () => {
        clearTimeout(timer);
        resolve();
      };
      this.#connectionWaiters.add(onConnected);
    });
    return this.#socket;
  }
}

function normalizeErrorCode(value: string | undefined): EgoErrorCode {
  return EGO_ERROR_CODES.includes(value as EgoErrorCode)
    ? (value as EgoErrorCode)
    : "EGO_OPERATION_FAILED";
}
