import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

interface CdpRequest {
  id: number;
  method: string;
  params?: unknown;
  sessionId?: string;
}

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface Pending {
  resolve(message: CdpMessage): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface EdgeLaunchOptions {
  executablePath: string;
  profilePath: string;
  headless?: boolean;
  startupTimeoutMs?: number;
}

export class CdpPipeTransport {
  readonly #child: ChildProcess;
  readonly #input: Writable;
  readonly #output: Readable;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(message: CdpMessage) => void>();
  #nextId = 1;
  #buffer = Buffer.alloc(0);
  #closed = false;

  private constructor(child: ChildProcess, input: Writable, output: Readable) {
    this.#child = child;
    this.#input = input;
    this.#output = output;
    output.on("data", (chunk: Buffer) => this.#receive(chunk));
    child.once("exit", (code, signal) => {
      this.#closed = true;
      this.#failAll(new Error(`Managed Edge exited (${code ?? signal ?? "unknown"})`));
    });
    child.once("error", (error) => this.#failAll(error));
  }

  static async launch(options: EdgeLaunchOptions): Promise<CdpPipeTransport> {
    await mkdir(options.profilePath, { recursive: true });
    const args = [
      `--user-data-dir=${options.profilePath}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--disable-default-apps",
      "--disable-component-update",
      "--site-per-process",
      "about:blank",
    ];
    if (options.headless) args.unshift("--headless=new");
    const child = spawn(options.executablePath, args, {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const input = child.stdio[3] as Writable | null;
    const output = child.stdio[4] as Readable | null;
    if (!input || !output) {
      child.kill();
      throw new Error("Managed Edge CDP handles 3 and 4 were not created");
    }
    const transport = new CdpPipeTransport(child, input, output);
    await transport.send("Browser.getVersion", {}, undefined, options.startupTimeoutMs ?? 10_000);
    return transport;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  onMessage(listener: (message: CdpMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async send(
    method: string,
    params: unknown = {},
    sessionId?: string,
    timeoutMs = 15_000,
  ): Promise<CdpMessage> {
    if (this.#closed) throw new Error("Managed Edge CDP pipe is closed");
    const id = this.#nextId++;
    const request: CdpRequest = { id, method, params };
    if (sessionId) request.sessionId = sessionId;
    return new Promise<CdpMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#input.write(`${JSON.stringify(request)}\0`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.send("Browser.close", {}, undefined, 3_000);
    } catch {
      this.#child.kill();
    }
    await new Promise<void>((resolve) => {
      if (this.#closed) return resolve();
      const timer = setTimeout(() => {
        this.#child.kill();
        resolve();
      }, 3_000);
      timer.unref();
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const terminator = this.#buffer.indexOf(0);
      if (terminator < 0) return;
      const payload = this.#buffer.subarray(0, terminator).toString("utf8");
      this.#buffer = this.#buffer.subarray(terminator + 1);
      if (!payload) continue;
      this.#dispatch(JSON.parse(payload) as CdpMessage);
    }
  }

  #dispatch(message: CdpMessage): void {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "CDP command failed"));
      } else {
        pending.resolve(message);
      }
      return;
    }
    for (const listener of this.#listeners) listener(message);
  }

  #failAll(error: Error): void {
    const requests = [...this.#pending.values()];
    this.#pending.clear();
    for (const pending of requests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
