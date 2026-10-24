import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

import type { HelloParams, HelloResult, RpcEvent, RpcResponse } from "@ego-compat/protocol";

import type { ClosableRuntimeTransport } from "./transport.ts";

interface PendingRequest {
  timer: ReturnType<typeof setTimeout>;
  generation: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class PipeRuntimeTransport implements ClosableRuntimeTransport {
  readonly #pipeName: string;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(method: string, params: unknown) => void>();
  readonly #reconnectListeners = new Set<() => void>();
  #socket: Socket | undefined;
  #connecting: Promise<Socket> | undefined;
  #dialingSocket: Socket | undefined;
  #cancelDial: ((error: Error) => void) | undefined;
  #cancelRetry: ((error: Error) => void) | undefined;
  #generation = 0;
  #closed = false;
  #helloParams: HelloParams | undefined;
  #helloResult: HelloResult | undefined;
  #helloGeneration = 0;
  #helloInflight: { generation: number; promise: Promise<HelloResult> } | undefined;

  private constructor(pipeName: string) {
    this.#pipeName = pipeName;
  }

  #attach(socket: Socket): Socket {
    const reconnecting = this.#generation > 0;
    const generation = ++this.#generation;
    this.#socket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.#dispatch(JSON.parse(line) as RpcResponse | RpcEvent, generation);
        } catch (error) {
          socket.destroy();
          this.#disconnect(socket, generation, error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });
    socket.on("error", (error) => this.#disconnect(socket, generation, error));
    socket.on("close", () => this.#disconnect(socket, generation, new Error("Broker pipe closed")));
    if (reconnecting) {
      queueMicrotask(() => {
        if (this.#generation !== generation || this.#socket !== socket) return;
        for (const listener of this.#reconnectListeners) {
          try { listener(); } catch {
            // One consumer must not break reconnect setup for the others.
          }
        }
      });
    }
    return socket;
  }

  static async connect(pipeName: string): Promise<PipeRuntimeTransport> {
    const transport = new PipeRuntimeTransport(pipeName);
    await transport.#ensureConnected();
    return transport;
  }

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    const socket = await this.#ensureConnected();
    if (method !== "hello" && this.#helloParams) await this.#ensureHello(socket);
    return this.#requestOnSocket<T>(socket, method, params, this.#generation);
  }

  async negotiateHello(params: HelloParams): Promise<HelloResult> {
    this.#helloParams = structuredClone(params);
    this.#helloResult = undefined;
    this.#helloGeneration = 0;
    const socket = await this.#ensureConnected();
    return this.#ensureHello(socket);
  }

  get negotiatedCapabilities(): readonly string[] {
    return this.#helloResult?.capabilities ?? [];
  }

  get referenceActionMaxLifetimeMs(): number | undefined {
    return this.#helloResult?.referenceActionMaxLifetimeMs;
  }

  #requestOnSocket<T>(socket: Socket, method: string, params: unknown, generation: number): Promise<T> {
    const id = randomUUID();
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Broker request timed out: ${method}`));
      }, 60_000);
      this.#pending.set(id, {
        timer,
        generation,
        resolve: (value) => resolve(value as T),
        reject,
      });
      socket.write(`${payload}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        this.#disconnect(socket, generation, error);
        reject(error);
      });
    });
  }

  #ensureHello(socket: Socket): Promise<HelloResult> {
    const generation = this.#generation;
    if (this.#helloResult && this.#helloGeneration === generation) {
      return Promise.resolve(this.#helloResult);
    }
    if (this.#helloInflight?.generation === generation) return this.#helloInflight.promise;
    if (!this.#helloParams) throw new Error("Hello negotiation is not configured");
    const promise = this.#requestOnSocket<HelloResult>(socket, "hello", this.#helloParams, generation)
      .then((result) => {
        if (this.#generation === generation) {
          this.#helloResult = result;
          this.#helloGeneration = generation;
        }
        return result;
      })
      .finally(() => {
        if (this.#helloInflight?.generation === generation) this.#helloInflight = undefined;
      });
    this.#helloInflight = { generation, promise };
    return promise;
  }

  onEvent(listener: (method: string, params: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onReconnect(listener: () => void): () => void {
    this.#reconnectListeners.add(listener);
    return () => this.#reconnectListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closedError = new Error("Transport closed");
    this.#cancelDial?.(closedError);
    this.#cancelRetry?.(closedError);
    this.#dialingSocket?.destroy();
    this.#dialingSocket = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#failAll(closedError);
    this.#reconnectListeners.clear();
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => socket.end(resolve));
  }

  #ensureConnected(): Promise<Socket> {
    if (this.#closed) return Promise.reject(new Error("Transport closed"));
    if (this.#socket && !this.#socket.destroyed && !this.#socket.writableEnded) {
      return Promise.resolve(this.#socket);
    }
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connectWithRetry().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connectWithRetry(): Promise<Socket> {
    const deadline = Date.now() + 25_000;
    let delay = 50;
    let lastError = new Error(`Unable to connect to ${this.#pipeName}`);
    while (!this.#closed) {
      try {
        return await this.#connectOnce();
      } catch (error) {
        if (this.#closed) throw new Error("Transport closed");
        lastError = error instanceof Error ? error : new Error(String(error));
        if (Date.now() >= deadline) throw lastError;
        await this.#waitForRetry(delay);
        delay = Math.min(delay * 2, 400);
      }
    }
    throw new Error("Transport closed");
  }

  #connectOnce(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.#pipeName);
      this.#dialingSocket = socket;
      let settled = false;
      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
        if (this.#dialingSocket === socket) this.#dialingSocket = undefined;
        if (this.#cancelDial === fail) this.#cancelDial = undefined;
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onError = (error: Error) => fail(error);
      const onClose = () => fail(new Error("Broker pipe closed while connecting"));
      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.#closed) {
          socket.destroy();
          reject(new Error("Transport closed"));
          return;
        }
        resolve(this.#attach(socket));
      };
      this.#cancelDial = fail;
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("connect", onConnect);
    });
  }

  #waitForRetry(delay: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#cancelRetry = undefined;
        resolve();
      }, delay);
      this.#cancelRetry = (error) => {
        clearTimeout(timer);
        this.#cancelRetry = undefined;
        reject(error);
      };
    });
  }

  #dispatch(message: RpcResponse | RpcEvent, generation: number): void {
    if ("id" in message) {
      const pending = this.#pending.get(message.id);
      if (!pending || pending.generation !== generation) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if ("error" in message) {
        pending.reject(
          Object.assign(new Error(message.error.message), {
            error_code: message.error.code,
            data: message.error.data,
          }),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    for (const listener of this.#listeners) {
      try {
        listener(message.method, message.params);
      } catch {
        // One consumer must not break the transport's message loop.
      }
    }
  }

  #failAll(error: Error, generation?: number): void {
    for (const [id, request] of this.#pending) {
      if (generation !== undefined && request.generation !== generation) continue;
      this.#pending.delete(id);
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  #disconnect(socket: Socket, generation: number, error: Error): void {
    this.#failAll(error, generation);
    if (this.#socket !== socket || this.#generation !== generation) return;
    this.#socket = undefined;
    if (this.#helloGeneration === generation) {
      this.#helloResult = undefined;
      this.#helloGeneration = 0;
    }
  }
}
