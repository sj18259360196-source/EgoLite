import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolvePackEntry } from "./cos-runtime.mjs";

export class CosCompanion extends EventEmitter {
  #worker;
  #options;
  #pending = new Map();
  #stopping = false;
  #epoch = 0;
  #restartFlight;
  #stopFlight;
  #session = {};
  #startFlight;

  constructor(options) { super(); this.#options = options; }

  start() {
    if (this.#startFlight) return this.#startFlight;
    if (this.#worker) throw new Error("CoS companion already started");
    this.#stopping = false;
    this.#startFlight = this.#startWorker(++this.#epoch).finally(() => { this.#startFlight = undefined; });
    return this.#startFlight;
  }
  async #startWorker(epoch) {
    const manifest = JSON.parse(await readFile(join(this.#options.directory, "source/extension/manifest.json"), "utf8"));
    const pack = JSON.parse(await readFile(join(this.#options.directory, "manifest.json"), "utf8"));
    if (typeof pack.entries?.companion !== "string") throw new Error("CoS package is missing its hosted browser companion");
    if (epoch !== this.#epoch || this.#stopping) throw new Error("CoS companion startup was cancelled");
    const worker = new Worker(new URL("./cos-companion-worker.mjs", import.meta.url), {
      workerData: {
        entry: resolvePackEntry(this.#options.directory, pack.entries.companion),
        extensionDirectory: join(this.#options.directory, "source/extension"),
        storagePath: join(this.#options.dataDirectory, "browser-companion.json"),
        debuggerEnabled: this.#options.debuggerEnabled === true,
        manifest,
        session: this.#session,
      },
    });
    this.#worker = worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CoS companion startup timed out")), 30_000);
      worker.on("error", error => { clearTimeout(timer); reject(error); this.emit("diagnostic", error.message); });
      worker.on("exit", () => {
        clearTimeout(timer);
        if (this.#worker === worker) this.#worker = undefined;
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("CoS companion exited"));
        }
        this.#pending.clear();
        reject(new Error("CoS companion exited before ready"));
      });
      worker.on("message", message => {
        if (message.type === "ready") {
          clearTimeout(timer);
          if (epoch !== this.#epoch || this.#stopping) reject(new Error("CoS companion startup was cancelled"));
          else resolve();
        }
        else if (message.type === "call") void this.#call(worker, message);
        else if (message.type === "page-reply") {
          const pending = this.#pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.#pending.delete(message.id);
            pending.resolve(message.value);
          }
        } else if (message.type === "preferences") this.emit("preferences", message.changes);
        else if (message.type === "stopped") {
          this.#session = message.session || {};
          this.emit("stopped");
        } else if (message.type === "restart-requested") {
          if (!this.#stopping) void this.restart().catch(error => this.emit("diagnostic", error.message));
        }
        else this.emit("diagnostic", message.error || message.type);
      });
    });
  }
  async #call(worker, message) {
    try {
      if (this.#stopping) throw new Error("CoS companion is stopping");
      const value = await this.#options.call(message.method, message.args);
      if (worker === this.#worker) worker.postMessage({ type: "reply", id: message.id, value });
    } catch (error) {
      if (worker === this.#worker) worker.postMessage({ type: "reply", id: message.id, error: error.message });
    }
  }
  event(name, ...args) { if (!this.#stopping) this.#worker?.postMessage({ type: "event", name, args }); }
  wake() { if (!this.#stopping) this.#worker?.postMessage({ type: "wake" }); }
  message(message, sender = {}) {
    return this.#request("page-message", message, sender);
  }
  preferences(keys) { return this.#request("page-preferences", keys); }
  #request(type, message, sender = {}) {
    if (!this.#worker || this.#stopping) return Promise.reject(new Error("CoS companion is not running"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("CoS page message timed out; outcome unknown"));
      }, 200_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#worker.postMessage({ type, id, message, sender });
    });
  }
  async stop() {
    ++this.#epoch;
    this.#stopping = true;
    await this.#stopWorker();
    await Promise.allSettled([this.#restartFlight, this.#startFlight]);
  }
  restart() {
    if (this.#restartFlight) return this.#restartFlight;
    if (this.#stopping || !this.#worker) return Promise.reject(new Error("CoS companion is not running"));
    const epoch = ++this.#epoch;
    this.#restartFlight = (async () => {
      await this.#stopWorker();
      if (epoch !== this.#epoch) return false;
      this.#stopping = false;
      await this.#startWorker(epoch);
      this.emit("restarted");
      return true;
    })().finally(() => { this.#restartFlight = undefined; });
    return this.#restartFlight;
  }
  #stopWorker() {
    if (this.#stopFlight) return this.#stopFlight;
    this.#stopFlight = this.#stopCurrentWorker().finally(() => { this.#stopFlight = undefined; });
    return this.#stopFlight;
  }
  async #stopCurrentWorker() {
    const worker = this.#worker;
    if (!worker) return;
    this.#stopping = true;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.off("stopped", finish); worker.off("exit", finish); resolve(); };
      const timer = setTimeout(finish, 3000);
      this.once("stopped", finish);
      worker.once("exit", finish);
      worker.postMessage({ type: "stop" });
    });
    await worker.terminate();
  }
}
