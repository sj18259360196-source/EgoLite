import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { migrateMissingLegacyCos } from "./cos-migration.mjs";

async function fixture(t) {
  const base = resolve(".tmp/codex/cos-migration-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { builtin: true, defaultDirectory: join(root, "builtin"), registryPath: join(root, "registry.json"), installRoot: join(root, "updates") };
  await mkdir(join(options.defaultDirectory, "source"), { recursive: true });
  const manifest = { id: "cos", schemaVersion: 1, hostApiVersion: 1, ipcEncoding: "cos-json-v1", packVersion: "v1", upstreamVersion: "2.1.20",
    entries: { main: "main.js", renderer: "ui.html", preload: "preload.js", companion: "worker.mjs", electron: "electron.exe" } };
  for (const entry of Object.values(manifest.entries)) await writeFile(join(options.defaultDirectory, entry), "fixture");
  await writeFile(join(options.defaultDirectory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(options.defaultDirectory, "source/package.json"), JSON.stringify({ name: "chat-on-steroids", version: "2.1.20" }));
  const config = { directory: join(root, "removed-install", "packs", "cos"), packVersion: "v1", enabled: true, workspace: { id: 465, taskId: "existing-task" }, previousDirectory: "old", custom: { retain: true } };
  await writeFile(options.registryPath, JSON.stringify(config));
  await writeFile(join(root, "session-data"), "do-not-touch");
  return { root, options, config };
}

test("missing legacy install migrates once, backs up exact registry, preserves workspace, enabled state and data", async t => {
  const { root, options, config } = await fixture(t);
  const original = await readFile(options.registryPath, "utf8");
  const migrated = await migrateMissingLegacyCos(options, config);
  assert.equal(migrated.source, "builtin");
  assert.equal(migrated.enabled, true);
  assert.deepEqual(migrated.workspace, config.workspace);
  assert.deepEqual(migrated.custom, config.custom);
  assert.equal(await readFile(migrated.migration.backup, "utf8"), original);
  assert.equal(await readFile(join(root, "session-data"), "utf8"), "do-not-touch");
  assert.equal(await migrateMissingLegacyCos(options, migrated), migrated);
  assert.deepEqual(JSON.parse(await readFile(options.registryPath, "utf8")), migrated);
});

test("existing legacy and explicit updated components are never replaced", async t => {
  const { options, config } = await fixture(t);
  const updated = { ...config, source: "updated" };
  assert.equal(await migrateMissingLegacyCos(options, updated), updated);
  await mkdir(config.directory, { recursive: true });
  assert.equal(await migrateMissingLegacyCos(options, config), config);
});

test("explicitly supported previous adapter can migrate to the new builtin", async t => {
  const { options, config } = await fixture(t);
  config.packVersion = "reviewed-previous-adapter";
  await writeFile(options.registryPath, JSON.stringify(config));
  options.builtinReplaces = [config.packVersion];
  const migrated = await migrateMissingLegacyCos(options, config);
  assert.equal(migrated.source, "builtin");
  assert.deepEqual(migrated.workspace, config.workspace);
});

test("bad builtin, different version and concurrent registry change do not overwrite registration", async t => {
  const { options, config } = await fixture(t);
  const original = await readFile(options.registryPath, "utf8");
  await assert.rejects(migrateMissingLegacyCos(options, { ...config, packVersion: "newer" }), /版本/);
  await assert.rejects(migrateMissingLegacyCos(options, { ...config, enabled: false }), /登记已变化/);
  await rm(join(options.defaultDirectory, "main.js"));
  await assert.rejects(migrateMissingLegacyCos(options, config), /ENOENT/);
  assert.equal(await readFile(options.registryPath, "utf8"), original);
});
