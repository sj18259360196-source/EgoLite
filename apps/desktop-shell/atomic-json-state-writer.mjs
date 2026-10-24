import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export class AtomicJsonStateWriter {
  #path;
  #fs;
  #retryDelays;
  #schedule;
  #cancel;
  #onCommit;
  #onFailure;
  #pending;
  #retryIndex = 0;
  #timer;
  #failureReported = false;

  constructor(path, options = {}) {
    this.#path = path;
    this.#fs = options.fs || { mkdirSync, renameSync, rmSync, writeFileSync };
    this.#retryDelays = options.retryDelays || [25, 100, 250];
    this.#schedule = options.schedule || setTimeout;
    this.#cancel = options.cancel || clearTimeout;
    this.#onCommit = options.onCommit || (() => {});
    this.#onFailure = options.onFailure || (() => {});
  }

  write(value) {
    if (this.#pending === undefined) {
      this.#retryIndex = 0;
      this.#failureReported = false;
    }
    this.#pending = value;
    if (this.#timer !== undefined) {
      this.#cancel(this.#timer);
      this.#timer = undefined;
    }
    return this.#attempt({ allowRetry: true, throwFailure: true });
  }

  flush() {
    if (this.#timer !== undefined) {
      this.#cancel(this.#timer);
      this.#timer = undefined;
    }
    if (this.#pending === undefined) return true;
    return this.#attempt({ allowRetry: false, throwFailure: false, forceReport: true });
  }

  #attempt({ allowRetry, throwFailure, forceReport = false }) {
    if (this.#pending === undefined) return true;
    const value = this.#pending;
    const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      this.#fs.mkdirSync(dirname(this.#path), { recursive: true });
      this.#fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
      try {
        this.#fs.renameSync(temporaryPath, this.#path);
      } catch (error) {
        this.#removeTemporary(temporaryPath);
        if (allowRetry && TRANSIENT_RENAME_CODES.has(error?.code) && this.#retryIndex < this.#retryDelays.length) {
          const delay = this.#retryDelays[this.#retryIndex++];
          this.#timer = this.#schedule(() => {
            this.#timer = undefined;
            this.#attempt({ allowRetry: true, throwFailure: false });
          }, delay);
          this.#timer?.unref?.();
          return false;
        }
        throw error;
      }
      if (this.#pending === value) this.#pending = undefined;
      this.#retryIndex = 0;
      this.#failureReported = false;
      this.#onCommit(value);
      return true;
    } catch (error) {
      this.#removeTemporary(temporaryPath);
      if (!this.#failureReported || forceReport) {
        this.#failureReported = true;
        this.#onFailure(error, { path: this.#path, pending: this.#pending !== undefined });
      }
      if (throwFailure) throw error;
      return false;
    }
  }

  #removeTemporary(path) {
    try {
      this.#fs.rmSync(path, { force: true });
    } catch {
      // The unique path cannot collide with a later attempt. Failure is reported
      // through the original write/rename error rather than masking it here.
    }
  }
}
