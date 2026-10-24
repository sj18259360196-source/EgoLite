import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ScanSciService } from "../apps/desktop-shell/scansci-service.mjs";

const root = resolve(import.meta.dirname, "..");
const parent = join(root, ".tmp/codex/scansci-host-smoke");
await mkdir(parent, { recursive: true });
const work = await mkdtemp(join(parent, "run-"));
const project = resolve(process.env.SCANSCI_TEST_RUNTIME || join(root, "integrations/scansci/runtime"));
const python = process.env.SCANSCI_TEST_PYTHON || join(root, "integrations/scansci/.venv/Scripts/python.exe");
const blocker = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"ok","service":"not-scansci"}'); });
await new Promise(resolveListen => blocker.listen(0, "127.0.0.1", resolveListen));
const occupiedPort = blocker.address().port;
const service = new ScanSciService({ projectDirectory: project, pythonCommand: python, dataDirectory: work, port: occupiedPort, hosted: true, autoRestart: true });
const checks = {};
let output;
try {
  await writeFile(join(work, "config.json"), JSON.stringify({ browser_backend: "egolite", email: "saved@example.invalid", custom_marker: "preserve", scihub_enabled: false, libgen_enabled: false, scibban_enabled: false, use_tor_for_scihub: false }));
  let status = await service.ensure();
  assert.equal(status.online, true);
  assert.equal(status.identity.version, "1.19.0");
  assert.notEqual(service.port, occupiedPort);
  checks.foreignPortPreserved = (await fetch(`http://127.0.0.1:${occupiedPort}`).then(r => r.json())).service === "not-scansci";
  checks.realOwnedProcess = status.managed && status.pid > 0;
  const settings = await fetch(status.settingsUrl);
  assert.equal(settings.status, 200);
  assert.match(await settings.text(), /ScanSci/i);
  assert.equal((await fetch(`${status.baseUrl}/api/config`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"key":"email","value":"bad"}' })).status, 403);
  checks.settingsAndAuthorization = true;
  const dashboard = await service.dashboard();
  assert.equal(dashboard.channels.egolite.backend, "egolite");
  const saved = await service.request("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "batch_workers", value: "3" }) });
  assert.equal(saved.success, true);
  checks.realSettingsSave = true;
  await service.stop();
  assert.equal((await service.status()).online, false);
  status = await service.ensure();
  const cfg = JSON.parse(await readFile(join(work, "config.json"), "utf8"));
  assert.equal(cfg.custom_marker, "preserve");
  assert.equal(cfg.email, "saved@example.invalid");
  assert.equal(cfg.batch_workers, 3);
  checks.restartPreservesData = true;
  if (process.argv.includes("--live")) {
    const search = await service.request("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "Attention Is All You Need", limit: 3 }) }, 90000);
    checks.liveSearch = search;
    const response = await fetch(`${service.baseUrl}/api/download`, { method: "POST", headers: { "content-type": "application/json", "x-ego-scansci-token": service.token }, body: JSON.stringify({ identifier: "1706.03762" }), signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Live download failed ${response.status}: ${(await response.text()).slice(0, 600)}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const pdf = join(work, "live.pdf");
    await writeFile(pdf, bytes);
    const { stdout } = await promisify(execFile)(python, ["-c", "import pymupdf,sys,json; d=pymupdf.open(sys.argv[1]); print(json.dumps({'pages': d.page_count, 'title': d.metadata.get('title', '')})); assert d.page_count>0", pdf], { windowsHide: true });
    checks.liveDownload = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), source: response.headers.get("x-scansci-source"), ...JSON.parse(stdout) };
  }
  output = { passed: true, checkedAt: new Date().toISOString(), version: "1.19.0", checks };
} catch (error) {
  output = { passed: false, checkedAt: new Date().toISOString(), checks, error: error.stack, logs: service.logs };
  process.exitCode = 1;
} finally {
  await service.stop();
  service.dispose();
  await new Promise(resolveClose => blocker.close(resolveClose));
  await rm(work, { recursive: true, force: true });
}
await mkdir(join(root, "docs/scansci-integration/evidence"), { recursive: true });
await writeFile(join(root, "docs/scansci-integration/evidence", process.argv.includes("--live") ? "host-live.json" : "host-local.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
