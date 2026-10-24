import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ScanSciService } from "./scansci-service.mjs";

test("reuses a healthy ScanSci instance without spawning another process", async () => {
  const fixture = createFixture();
  let spawnCount = 0;
  let terminatedPid = null;
  try {
    const service = new ScanSciService({
      projectDirectory: fixture,
      fetch: async () => jsonResponse({ status: "ok", project: { root: fixture } }),
      spawnProcess: () => { spawnCount += 1; return fakeChild(); },
      findListeningPid: () => 4422,
      terminatePid: (pid) => { terminatedPid = pid; return true; },
    });
    const status = await service.ensure();
    assert.equal(status.online, true);
    assert.equal(status.managed, true);
    assert.equal(status.pid, 4422);
    assert.equal(spawnCount, 0);
    service.dispose();
    assert.equal(terminatedPid, 4422);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("starts an offline ScanSci service and keeps ownership of its process", async () => {
  const fixture = createFixture();
  let online = false;
  let child;
  try {
    const service = new ScanSciService({
      projectDirectory: fixture,
      startTimeoutMs: 2_000,
      fetch: async () => {
        if (!online) throw new Error("offline");
        return jsonResponse({ status: "ok" });
      },
      probeCommand: () => ({ status: 0 }),
      spawnProcess: (_command, args, options) => {
        child = fakeChild(args, options);
        online = true;
        return child;
      },
    });
    const status = await service.ensure();
    assert.equal(status.online, true);
    assert.equal(status.managed, true);
    assert.equal(status.pid, child.pid);
    assert.equal(child.options.windowsHide, true);
    assert.match(child.args.join(" "), /scansci_pdf\.main web --host 127\.0\.0\.1 --port 8765/);
    service.dispose();
    assert.equal(child.killed, true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("checks every configured download channel after the service is ready", async () => {
  const fixture = createFixture();
  const checked = [];
  try {
    const service = new ScanSciService({
      projectDirectory: fixture,
      fetch: async (url, init = {}) => {
        if (String(url).endsWith("/api/ping")) return jsonResponse({ status: "ok", project: { root: fixture } });
        if (String(url).endsWith("/api/dashboard")) return jsonResponse({ status: "ok" });
        const payload = JSON.parse(init.body);
        checked.push(payload.channel);
        return jsonResponse({ channel: payload.channel, status: "ok" });
      },
    });
    const report = await service.checkAll();
    assert.equal(report.checked, 8);
    assert.equal(report.passed, 8);
    assert.deepEqual(report.failed, []);
    assert.deepEqual(checked.sort(), ["carsi", "egolite", "elsevier", "ezproxy", "grey", "oa", "tor", "webvpn"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("records an unexpected child-process exit", async () => {
  const fixture = createFixture();
  let online = false;
  let child;
  try {
    const service = new ScanSciService({
      projectDirectory: fixture,
      fetch: async () => {
        if (!online) throw new Error("offline");
        return jsonResponse({ status: "ok" });
      },
      probeCommand: () => ({ status: 0 }),
      spawnProcess: (_command, args, options) => {
        child = fakeChild(args, options);
        online = true;
        return child;
      },
    });
    await service.ensure();
    online = false;
    child.exitCode = 9;
    child.emit("exit", 9, null);
    const status = await service.status();
    assert.equal(status.online, false);
    assert.equal(status.managed, false);
    assert.match(status.error, /已退出/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function createFixture() {
  const parent = join(import.meta.dirname, "..", "..", ".tmp", "codex", "scansci-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  const source = join(root, "src", "scansci_pdf");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "web.py"), "# fixture\n", "utf8");
  return root;
}

test("packaged ScanSci uses its interpreter and isolated writable data", async () => {
  const fixture = createFixture();
  let child;
  let online = false;
  const pythonCommand = join(fixture, "python.exe");
  writeFileSync(pythonCommand, "fixture");
  const service = new ScanSciService({
    projectDirectory: fixture, pythonCommand, dataDirectory: join(fixture, "data"), runtimeDirectory: fixture,
    pipeName: "test-pipe",
    fetch: async () => { if (!online) throw new Error("offline"); return jsonResponse({ status: "ok" }); },
    probeCommand: () => { throw new Error("Must not probe system Python"); },
    spawnProcess: (command, args, options) => {
      assert.equal(command, pythonCommand);
      child = fakeChild(args, options); online = true; return child;
    },
  });
  try {
    await service.ensure();
    assert.equal(child.options.env.PYTHONPATH, join(fixture, "src"));
    assert.equal(child.options.env.SCANSCI_PDF_DATA_DIR, join(fixture, "data"));
    assert.equal(child.options.env.EGO_COMPAT_PIPE, "test-pipe");
  } finally { service.dispose(); rmSync(fixture, { recursive: true, force: true }); }
});

test("managed ScanSci restarts after a crash and cancels recovery on disposal", async () => {
  const fixture = createFixture();
  let child;
  let online = false;
  let starts = 0;
  const service = new ScanSciService({
    projectDirectory: fixture, autoRestart: true, restartDelayMs: 10,
    probeCommand: () => ({ status: 0 }),
    fetch: async () => { if (!online) throw new Error("offline"); return jsonResponse({ status: "ok" }); },
    spawnProcess: () => { starts++; online = true; child = fakeChild(); return child; },
  });
  try {
    await service.ensure();
    online = false; child.emit("exit", 9, null);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(starts, 2);
    online = false; child.emit("exit", 9, null); service.dispose();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(starts, 2);
  } finally { service.dispose(); rmSync(fixture, { recursive: true, force: true }); }
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeChild(args = [], options = {}) {
  const child = new EventEmitter();
  child.pid = 32109;
  child.args = args;
  child.options = options;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.signalCode = "SIGTERM";
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
    return true;
  };
  return child;
}
