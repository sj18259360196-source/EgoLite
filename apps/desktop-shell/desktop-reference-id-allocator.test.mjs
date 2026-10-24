import assert from "node:assert/strict";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DurableReferenceIdAllocator,
  ReferenceIdAllocationError,
} from "./desktop-reference-id-allocator.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "egolite-reference-ids-"));
  return { directory, path: join(directory, "reference-ids.json") };
}

function nativeFs(overrides = {}) {
  return {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
    ...overrides,
  };
}

test("reserves durable blocks before use and never reuses IDs after restart", () => {
  const { directory, path } = fixture();
  try {
    const first = new DurableReferenceIdAllocator(path, { blockSize: 3 });
    assert.deepEqual([first.allocate(), first.allocate()], [1, 2]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, reservedThrough: 3 });

    const restarted = new DurableReferenceIdAllocator(path, { blockSize: 3 });
    assert.equal(restarted.allocate(), 4);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, reservedThrough: 6 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("allocating past a block reserves the next block before returning its first ID", () => {
  const { directory, path } = fixture();
  try {
    const allocator = new DurableReferenceIdAllocator(path, { blockSize: 2 });
    assert.deepEqual([allocator.allocate(), allocator.allocate(), allocator.allocate()], [1, 2, 3]);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).reservedThrough, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupt or out-of-range state fails closed and poisons the allocator", () => {
  const { directory, path } = fixture();
  try {
    writeFileSync(path, JSON.stringify({ version: 1, reservedThrough: "12" }), "utf8");
    const allocator = new DurableReferenceIdAllocator(path);
    assert.throws(
      () => allocator.allocate(),
      (error) => error instanceof ReferenceIdAllocationError && error.code === "REFERENCE_ID_STATE_CORRUPT",
    );
    writeFileSync(path, JSON.stringify({ version: 1, reservedThrough: 20 }), "utf8");
    assert.throws(() => allocator.allocate(), { code: "REFERENCE_ID_STATE_CORRUPT" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const failurePoint of ["write", "temp-fsync", "rename", "committed-fsync"]) {
  test(`${failurePoint} failure issues no ID and fails closed`, () => {
    const { directory, path } = fixture();
    let fsyncCalls = 0;
    const allocator = new DurableReferenceIdAllocator(path, {
      blockSize: 2,
      fs: nativeFs({
        writeFileSync(...args) {
          if (failurePoint === "write") throw Object.assign(new Error("denied"), { code: "EACCES" });
          return writeFileSync(...args);
        },
        fsyncSync(...args) {
          fsyncCalls += 1;
          if ((failurePoint === "temp-fsync" && fsyncCalls === 1)
            || (failurePoint === "committed-fsync" && fsyncCalls === 2)) {
            throw Object.assign(new Error("sync denied"), { code: "EIO" });
          }
          return fsyncSync(...args);
        },
        renameSync(...args) {
          if (failurePoint === "rename") throw Object.assign(new Error("rename denied"), { code: "EPERM" });
          return renameSync(...args);
        },
      }),
    });
    try {
      assert.throws(() => allocator.allocate(), { code: "REFERENCE_ID_RESERVATION_FAILED" });
      assert.throws(() => allocator.allocate(), { code: "REFERENCE_ID_RESERVATION_FAILED" });
      if (failurePoint !== "committed-fsync") assert.equal(readFileIfPresent(path), undefined);
      else {
        assert.equal(JSON.parse(readFileSync(path, "utf8")).reservedThrough, 2);
        assert.equal(new DurableReferenceIdAllocator(path, { blockSize: 2 }).allocate(), 3);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("exhaustion is explicit after the last safe ID", () => {
  const { directory, path } = fixture();
  try {
    const allocator = new DurableReferenceIdAllocator(path, { blockSize: 2, maxId: 3 });
    assert.deepEqual([allocator.allocate(), allocator.allocate(), allocator.allocate()], [1, 2, 3]);
    assert.throws(() => allocator.allocate(), { code: "REFERENCE_ID_EXHAUSTED" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rename failure leaves an existing committed high-water file unchanged", () => {
  const { directory, path } = fixture();
  try {
    writeFileSync(path, JSON.stringify({ version: 1, reservedThrough: 8 }), "utf8");
    const allocator = new DurableReferenceIdAllocator(path, {
      fs: nativeFs({
        renameSync() { throw Object.assign(new Error("busy"), { code: "EPERM" }); },
      }),
    });
    assert.throws(() => allocator.allocate(), { code: "REFERENCE_ID_RESERVATION_FAILED" });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, reservedThrough: 8 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("POSIX reservations fsync the parent directory after the committed file", () => {
  const { directory, path } = fixture();
  const directoryDescriptor = -12345;
  let directorySyncs = 0;
  const fs = nativeFs({
    openSync(target, flags, mode) {
      if (target === directory) return directoryDescriptor;
      return openSync(target, flags, mode);
    },
    fsyncSync(descriptor) {
      if (descriptor === directoryDescriptor) { directorySyncs += 1; return; }
      return fsyncSync(descriptor);
    },
    closeSync(descriptor) {
      if (descriptor === directoryDescriptor) return;
      return closeSync(descriptor);
    },
  });
  try {
    const allocator = new DurableReferenceIdAllocator(path, { blockSize: 2, platform: "linux", fs });
    assert.equal(allocator.allocate(), 1);
    assert.equal(directorySyncs, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("known POSIX parent-directory fsync failure issues no ID and poisons the instance", () => {
  const { directory, path } = fixture();
  const directoryDescriptor = -12345;
  const fs = nativeFs({
    openSync(target, flags, mode) {
      if (target === directory) return directoryDescriptor;
      return openSync(target, flags, mode);
    },
    fsyncSync(descriptor) {
      if (descriptor === directoryDescriptor) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
      return fsyncSync(descriptor);
    },
    closeSync(descriptor) {
      if (descriptor === directoryDescriptor) return;
      return closeSync(descriptor);
    },
  });
  try {
    const allocator = new DurableReferenceIdAllocator(path, { blockSize: 2, platform: "linux", fs });
    assert.throws(() => allocator.allocate(), { code: "REFERENCE_ID_RESERVATION_FAILED" });
    assert.throws(() => allocator.allocate(), { code: "REFERENCE_ID_RESERVATION_FAILED" });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).reservedThrough, 2);
    assert.equal(new DurableReferenceIdAllocator(path, { blockSize: 2 }).allocate(), 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readFileIfPresent(path) {
  try { return readFileSync(path, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}
