import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CosMaintenance } from "./cos-maintenance.mjs";
import { CosWorkspace } from "./cos-workspace.mjs";

async function setup(t) {
  const base = resolve(".tmp/codex/cos-maintenance-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const current = { enabled: true, version: "old", commit: "a".repeat(40) };
  const options = { root, describe: () => current, prepare: async () => {},
    request: async (method, params) => calls.push({ method, params }), update: async directory => calls.push({ update: directory }),
    validate: async () => {}, fetch: async () => ({ ok: true, json: async () => ({ sha: "b".repeat(40) }) }) };
  return { root, calls, current, options, maintenance: new CosMaintenance(options) };
}

test("built-in CoS is available without installation; legacy and updated paths survive restart", async t => {
  const { root } = await setup(t);
  const directory = join(root, "builtin");
  await mkdir(directory);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ packVersion: "v1" }));
  const options = { builtin: true, defaultDirectory: directory, registryPath: join(root, "registry.json"), dataDirectory: join(root, "state") };
  const fresh = new CosWorkspace(options).describe();
  assert.equal(fresh.installed, true);
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.version, "v1");
  for (const source of ["legacy", "updated"]) {
    await writeFile(options.registryPath, JSON.stringify({ directory: "existing", source, workspace: { id: 8 }, enabled: false }));
    const state = new CosWorkspace(options).describe();
    assert.equal(state.directory, "existing");
    assert.equal(state.workspace.id, 8);
  }
  await writeFile(options.registryPath, JSON.stringify({ directory: "old-install", source: "builtin", enabled: false }));
  assert.equal(new CosWorkspace(options).describe().directory, directory);
});

test("update check does not launch Agent; verified candidate waits for disabled component before applying", async t => {
  const { maintenance, current, calls } = await setup(t);
  assert.equal((await maintenance.check()).updateAvailable, true);
  assert.equal(calls.length, 0);
  await maintenance.start();
  await assert.rejects(maintenance.start(), /已有/);
  assert.equal(calls[0].method, "codex.stream.start");
  const state = maintenance.describe();
  const directory = join(state.directory, "candidate");
  await mkdir(directory);
  await writeFile(join(state.directory, "tests.log"), "fixture validation");
  await writeFile(join(state.directory, "candidate.json"), JSON.stringify({ directory, verified: true, evidence: ["tests.log"] }));
  await maintenance.event("codex.stream.complete", { requestId: state.id });
  assert.equal(maintenance.describe().phase, "ready");
  await assert.rejects(maintenance.apply(), /停用/);
  current.enabled = false;
  await maintenance.apply();
  assert.equal(maintenance.describe().phase, "complete");
  assert.equal(calls[1].update, directory);
});

test("missing verification, Agent disconnect and activation failure leave explicit recoverable state", async t => {
  const { maintenance, options, current } = await setup(t);
  await maintenance.start();
  await maintenance.event("codex.stream.complete", { requestId: maintenance.describe().id, text: "No tests available" });
  assert.equal(maintenance.describe().phase, "failed");
  await maintenance.start();
  maintenance.disconnected();
  assert.equal(maintenance.describe().phase, "interrupted");
  await maintenance.start();
  assert.equal(new CosMaintenance(options).describe().phase, "interrupted");
  current.enabled = false;
  maintenance.save({ phase: "ready", candidate: "candidate" });
  options.update = async () => { throw new Error("previous program and data restored"); };
  await assert.rejects(maintenance.apply(), /restored/);
  assert.equal(maintenance.describe().phase, "failed");
});
