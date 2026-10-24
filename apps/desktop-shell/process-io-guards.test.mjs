import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { installProcessIoGuards, isBrokenPipeError } from "./process-io-guards.mjs";

test("recognizes broken pipe errors", () => {
  assert.equal(isBrokenPipeError(Object.assign(new Error("broken pipe"), { code: "EPIPE" })), true);
  assert.equal(isBrokenPipeError(Object.assign(new Error("denied"), { code: "EACCES" })), false);
});

test("ignores EPIPE from process output streams", () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  installProcessIoGuards({ stdout, stderr });

  assert.doesNotThrow(() => stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
  assert.doesNotThrow(() => stderr.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
});

test("preserves non-EPIPE stream failures and installs once", () => {
  const stdout = new EventEmitter();
  installProcessIoGuards({ stdout, stderr: null });
  installProcessIoGuards({ stdout, stderr: null });

  assert.equal(stdout.listenerCount("error"), 1);
  assert.throws(
    () => stdout.emit("error", Object.assign(new Error("denied"), { code: "EACCES" })),
    { code: "EACCES" },
  );
});
