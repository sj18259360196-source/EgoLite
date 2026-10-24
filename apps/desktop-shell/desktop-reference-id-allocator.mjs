import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const STATE_VERSION = 1;

export class ReferenceIdAllocationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ReferenceIdAllocationError";
    this.code = code;
  }
}

// This allocator assumes one desktop main-process writer for each state file.
// It prevents reuse across a normal process restart when the committed state is
// readable. Crash and power-loss behavior remains subject to the host OS and
// filesystem guarantees for fsync and atomic rename. POSIX hosts also fsync the
// parent directory. Node cannot portably flush Windows directory handles, so a
// successful Windows reservation is limited to the committed-file fsync.
export class DurableReferenceIdAllocator {
  #path;
  #blockSize;
  #maxId;
  #fs;
  #platform;
  #nextId = 1;
  #blockEnd = 0;
  #failure;

  constructor(path, options = {}) {
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError("Reference ID state path must be a non-empty string");
    }
    const blockSize = options.blockSize ?? 4096;
    const maxId = options.maxId ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(blockSize) || blockSize <= 0) {
      throw new TypeError("Reference ID blockSize must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxId) || maxId <= 0) {
      throw new TypeError("Reference ID maxId must be a positive safe integer");
    }
    this.#path = path;
    this.#blockSize = blockSize;
    this.#maxId = maxId;
    this.#platform = options.platform ?? process.platform;
    if (typeof this.#platform !== "string" || this.#platform.length === 0) {
      throw new TypeError("platform must be a non-empty string");
    }
    this.#fs = options.fs || {
      closeSync,
      fsyncSync,
      mkdirSync,
      openSync,
      readFileSync,
      renameSync,
      rmSync,
      writeFileSync,
    };
  }

  allocate() {
    if (this.#failure) throw this.#failure;
    if (this.#nextId > this.#blockEnd) this.#reserveBlock();
    const allocated = this.#nextId;
    this.#nextId += 1;
    return allocated;
  }

  #reserveBlock() {
    let temporaryPath;
    let descriptor;
    let renamed = false;
    try {
      const reservedThrough = this.#readHighWater();
      if (reservedThrough >= this.#maxId) {
        throw new ReferenceIdAllocationError(
          "REFERENCE_ID_EXHAUSTED",
          "Reference ID space is exhausted",
        );
      }
      const blockStart = reservedThrough + 1;
      const blockEnd = Math.min(this.#maxId, reservedThrough + this.#blockSize);
      const state = `${JSON.stringify({ version: STATE_VERSION, reservedThrough: blockEnd }, null, 2)}\n`;

      this.#fs.mkdirSync(dirname(this.#path), { recursive: true });
      temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
      descriptor = this.#fs.openSync(temporaryPath, "wx", 0o600);
      this.#fs.writeFileSync(descriptor, state, "utf8");
      this.#fs.fsyncSync(descriptor);
      this.#fs.closeSync(descriptor);
      descriptor = undefined;

      this.#fs.renameSync(temporaryPath, this.#path);
      renamed = true;
      temporaryPath = undefined;

      // Windows rejects FlushFileBuffers for a read-only file handle.
      descriptor = this.#fs.openSync(this.#path, "r+");
      this.#fs.fsyncSync(descriptor);
      this.#fs.closeSync(descriptor);
      descriptor = undefined;

      if (this.#platform !== "win32") {
        descriptor = this.#fs.openSync(dirname(this.#path), "r");
        this.#fs.fsyncSync(descriptor);
        this.#fs.closeSync(descriptor);
        descriptor = undefined;
      }

      this.#nextId = blockStart;
      this.#blockEnd = blockEnd;
    } catch (cause) {
      if (descriptor !== undefined) {
        try { this.#fs.closeSync(descriptor); } catch {}
      }
      if (!renamed && temporaryPath) {
        try { this.#fs.rmSync(temporaryPath, { force: true }); } catch {}
      }
      const failure = cause instanceof ReferenceIdAllocationError
        ? cause
        : new ReferenceIdAllocationError(
          "REFERENCE_ID_RESERVATION_FAILED",
          "Reference ID block reservation did not commit durably",
          { cause },
        );
      this.#failure = failure;
      throw failure;
    }
  }

  #readHighWater() {
    let raw;
    try {
      raw = this.#fs.readFileSync(this.#path, "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") return 0;
      throw new ReferenceIdAllocationError(
        "REFERENCE_ID_STATE_UNREADABLE",
        "Reference ID state cannot be read",
        { cause },
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new ReferenceIdAllocationError(
        "REFERENCE_ID_STATE_CORRUPT",
        "Reference ID state is not valid JSON",
        { cause },
      );
    }
    if (!parsed || parsed.version !== STATE_VERSION
      || !Number.isSafeInteger(parsed.reservedThrough)
      || parsed.reservedThrough < 0
      || parsed.reservedThrough > this.#maxId) {
      throw new ReferenceIdAllocationError(
        "REFERENCE_ID_STATE_CORRUPT",
        "Reference ID state has an invalid version or high-water mark",
      );
    }
    return parsed.reservedThrough;
  }
}
