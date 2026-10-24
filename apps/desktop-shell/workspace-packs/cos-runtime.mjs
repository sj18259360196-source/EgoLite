import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { encodeWire, decodeWire } from "./cos-wire.cjs";
import { COS_DIALOG_CHANNELS } from "./cos-dialogs.mjs";

export function resolvePackEntry(root, entry) {
  if (typeof entry !== "string" || !entry || isAbsolute(entry)) throw new Error("Invalid CoS pack entry");
  const path = resolve(root, entry);
  const subpath = relative(resolve(root), path);
  if (subpath.startsWith("..") || isAbsolute(subpath)) throw new Error("CoS pack entry escapes package directory");
  return path;
}

export class CosRuntime extends EventEmitter {
  #child;
  #pending = new Map();
  #channels = new Set();
  #start;
  #stop;
  #options;
  state = "stopped";
  manifest;

  constructor(options) { super(); this.#options = options; }
  get pid() { return this.#child?.pid; }
  get channels() { return [...this.#channels]; }

  async start() {
    if (this.state === "ready") return this.manifest;
    if (this.#start) return this.#start;
    if (this.#stop) await this.#stop;
    this.#start = this.#launch();
    try { return await this.#start; } finally { this.#start = undefined; }
  }

  async #launch() {
    const { directory, dataDirectory, spawnProcess = spawn } = this.#options;
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    if (manifest.id !== "cos" || manifest.hostApiVersion !== 1) throw new Error("Unsupported CoS package protocol");
    if (manifest.ipcEncoding !== "cos-json-v1") throw new Error("CoS IPC format is incompatible; rebuild the adapted pack");
    if (this.#options.probeOnly && manifest.features?.maintenanceProbe !== 1) throw new Error("CoS package does not support a non-executing maintenance probe");
    for (const entry of Object.values(manifest.entries)) resolvePackEntry(directory, entry);
    this.manifest = manifest;
    this.state = "starting";
    this.emit("state", this.state);
    const env = {
      ...process.env, COS_EGO_HOSTED: "1", COS_EGO_DATA: resolve(dataDirectory),
      COS_EGO_RESOURCES: resolve(directory, "source/resources"),
      COS_EGO_PROBE: this.#options.probeOnly ? "1" : "0",
      ...(this.#options.statusFile ? { COS_EGO_STATUS_FILE: this.#options.statusFile } : {}),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnProcess(resolvePackEntry(directory, manifest.entries.electron),
      [resolve(directory, "source")], {
        cwd: join(directory, "source"), env, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    this.#child = child;
    child.stdout?.on("data", chunk => this.emit("log", String(chunk)));
    child.stderr?.on("data", chunk => this.emit("log", String(chunk)));
    return new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        rejectReady(new Error("CoS hosted startup timed out"));
        void this.stop().catch(error => this.emit("runtime-error", error));
      }, this.#options.startTimeoutMs ?? 60_000);
      child.on("error", error => {
        clearTimeout(timer);
        rejectReady(error);
        if (!child.pid && this.#child === child) {
          this.#child = undefined;
          this.state = "failed";
          this.emit("state", this.state);
        }
        this.emit("runtime-error", error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        rejectReady(new Error(`CoS exited before ready (${code ?? signal})`));
        if (this.#child === child) {
          this.#child = undefined;
          this.#channels.clear();
          this.state = this.state === "stopping" ? "stopped" : "failed";
          this.emit("state", this.state);
        }
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("CoS runtime exited"));
        }
        this.#pending.clear();
      });
      child.on("message", raw => {
        let message;
        try { message = decodeWire(raw); }
        catch (error) {
          clearTimeout(timer);
          const failure = new Error("CoS IPC format is incompatible; rebuild the adapted pack", { cause: error });
          rejectReady(failure);
          this.emit("runtime-error", failure);
          void this.stop().catch(cause => this.emit("runtime-error", cause));
          return;
        }
        if (this.#child !== child || !message || typeof message !== "object") return;
        if (message.type === "cos:ready") {
          if (this.state !== "starting") return;
          if (message.protocol !== 1 || !Array.isArray(message.channels)) {
            rejectReady(new Error("Invalid CoS hosted handshake"));
            void this.stop().catch(error => this.emit("runtime-error", error));
            return;
          }
          clearTimeout(timer);
          this.#channels = new Set(message.channels);
          this.state = "ready";
          this.emit("state", this.state);
          resolveReady(manifest);
        } else if (message.type === "cos:event") {
          this.emit("event", message.channel, message.args);
        } else if (message.type === "cos:reply") {
          const pending = this.#pending.get(message.id);
          if (!pending) return;
          this.#pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message.result);
        } else if (message.type === "ego:request") {
          void this.#hostRequest(child, message);
        }
      });
    });
  }

  async #hostRequest(child, message) {
    try {
      if (this.state !== "ready") throw new Error("CoS is not running");
      if (!this.#options.onHostRequest) throw new Error(`Ego service is unavailable: ${message.method}`);
      const result = await this.#options.onHostRequest(message.method, message.payload);
      if (child.connected) child.send(encodeWire({ type: "ego:reply", id: message.id, result }));
    } catch (error) {
      if (child.connected) child.send(encodeWire({ type: "ego:reply", id: message.id, error: error.message }));
    }
  }

  invoke(channel, payload, timeoutMs = COS_DIALOG_CHANNELS.has(channel) ? 0 : 60_000) {
    if (this.state !== "ready" || !this.#child?.connected) return Promise.reject(new Error("CoS runtime is not ready"));
    if (!this.#channels.has(channel)) return Promise.reject(new Error(`Unsupported CoS method: ${channel}`));
    const id = randomUUID();
    let message;
    try { message = encodeWire({ type: "cos:invoke", id, channel, payload }); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolveCall, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CoS request timed out; outcome unknown: ${channel}`));
      }, timeoutMs) : undefined;
      this.#pending.set(id, { resolve: resolveCall, reject, timer });
      this.#child.send(message, error => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  async stop() {
    if (this.#stop) return this.#stop;
    const child = this.#child;
    if (!child) return;
    this.state = "stopping";
    this.emit("state", this.state);
    this.#stop = new Promise((resolveStopped, reject) => {
      const timer = setTimeout(() => {
        // The host records failure instead of silently leaving a live background task.
        reject(new Error(`CoS shutdown timed out; process ${child.pid} still requires cleanup`));
      }, this.#options.stopTimeoutMs ?? 90_000);
      child.once("exit", () => { clearTimeout(timer); resolveStopped(); });
      if (child.connected) child.send(encodeWire({ type: "cos:stop" }), error => {
        if (error && child.exitCode === null) child.kill();
      });
      else child.kill();
    });
    try { await this.#stop; } finally { this.#stop = undefined; }
  }
}
