import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AtomicJsonStateWriter } from "./atomic-json-state-writer.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "egolite-state-writer-"));
  const path = join(directory, "desktop-tabs.json");
  writeFileSync(path, JSON.stringify({ revision: 1 }), "utf8");
  return { directory, path };
}

test("transient rename failure preserves the old file and retry commits atomically", () => {
  const { directory, path } = fixture();
  const scheduled = [];
  let renameCalls = 0;
  const writer = new AtomicJsonStateWriter(path, {
    fs: {
      mkdirSync: () => {},
      writeFileSync,
      rmSync,
      renameSync(source, destination) {
        renameCalls += 1;
        if (renameCalls === 1) throw Object.assign(new Error("busy"), { code: "EPERM" });
        renameSync(source, destination);
      },
    },
    retryDelays: [1],
    schedule(callback) {
      scheduled.push(callback);
      return { unref() {} };
    },
    cancel() {},
  });
  try {
    assert.equal(writer.write({ revision: 2 }), false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { revision: 1 });
    scheduled[0]();
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { revision: 2 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stale retry cannot overwrite a newer successful revision", () => {
  const { directory, path } = fixture();
  const scheduled = [];
  let renameCalls = 0;
  const writer = new AtomicJsonStateWriter(path, {
    fs: {
      mkdirSync: () => {}, writeFileSync, rmSync,
      renameSync(source, destination) {
        renameCalls += 1;
        if (renameCalls === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        renameSync(source, destination);
      },
    },
    retryDelays: [1],
    schedule(callback) {
      scheduled.push(callback);
      return { unref() {} };
    },
    cancel() {},
  });
  try {
    assert.equal(writer.write({ revision: 2 }), false);
    assert.equal(writer.write({ revision: 3 }), true);
    scheduled[0]();
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { revision: 3 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("permanent rename failure is thrown and never removes the committed file", () => {
  const { directory, path } = fixture();
  const writer = new AtomicJsonStateWriter(path, {
    fs: {
      mkdirSync: () => {}, writeFileSync, rmSync,
      renameSync() { throw Object.assign(new Error("disk failure"), { code: "EIO" }); },
    },
  });
  try {
    assert.throws(() => writer.write({ revision: 2 }), /disk failure/);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { revision: 1 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("flush cancels delayed retry and reports unresolved durability", () => {
  const { directory, path } = fixture();
  const failures = [];
  let cancelled = 0;
  const writer = new AtomicJsonStateWriter(path, {
    fs: {
      mkdirSync: () => {}, writeFileSync, rmSync,
      renameSync() { throw Object.assign(new Error("locked"), { code: "EACCES" }); },
    },
    retryDelays: [1],
    schedule() { return { unref() {} }; },
    cancel() { cancelled += 1; },
    onFailure(error, details) { failures.push({ error, details }); },
  });
  try {
    assert.equal(writer.write({ revision: 2 }), false);
    assert.equal(writer.flush(), false);
    assert.equal(cancelled, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].details.pending, true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { revision: 1 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("continuous updates share a bounded retry budget and report once while retaining the latest", () => {
  const { directory, path } = fixture();
  const failures = [];
  let locked = true;
  const writer = new AtomicJsonStateWriter(path, {
    fs: {
      mkdirSync: () => {}, writeFileSync, rmSync,
      renameSync(source, destination) {
        if (locked) throw Object.assign(new Error("locked"), { code: "EPERM" });
        renameSync(source, destination);
      },
    },
    retryDelays: [1, 2],
    schedule() { return { unref() {} }; },
    cancel() {},
    onFailure(error) { failures.push(error); },
  });
  try {
    assert.equal(writer.write({ revision: 2 }), false);
    assert.equal(writer.write({ revision: 3 }), false);
    assert.throws(() => writer.write({ revision: 4 }), /locked/);
    assert.throws(() => writer.write({ revision: 5 }), /locked/);
    assert.equal(failures.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { revision: 1 });

    locked = false;
    assert.equal(writer.write({ revision: 6 }), true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { revision: 6 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
