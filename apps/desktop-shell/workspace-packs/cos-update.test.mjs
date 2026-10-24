import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CosUpdateStore } from "./cos-update.mjs";

async function fixture(t) {
  const base = resolve(".tmp/codex/cos-integration/unit");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = join(root, "state");
  const registryPath = join(root, "registry.json");
  await mkdir(dataDirectory);
  await writeFile(join(dataDirectory, "settings.json"), "original-data");
  const packs = [];
  for (const version of ["old", "new"]) {
    const directory = join(root, "packs", version);
    await mkdir(join(directory, "source"), { recursive: true });
    await writeFile(join(directory, "source/package.json"), JSON.stringify({ name: "chat-on-steroids", version: "2.1.20" }));
    const manifest = {
      id: "cos", schemaVersion: 1, hostApiVersion: 1, ipcEncoding: "cos-json-v1",
      upstreamVersion: "2.1.20", packVersion: version,
      entries: { main: "main.js", renderer: "ui.html", preload: "preload.js", companion: "worker.mjs", electron: "electron.exe" },
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    for (const name of Object.values(manifest.entries)) await writeFile(join(directory, name), "");
    packs.push(directory);
  }
  const before = { directory: packs[0], enabled: true, workspace: { taskId: "same-space" } };
  await writeFile(registryPath, JSON.stringify(before));
  const store = new CosUpdateStore({ dataDirectory, registryPath });
  const activate = async (config, enabled) => ({ ...config, enabled });
  return { root, dataDirectory, registryPath, packs, before, store, activate, stop: async () => {} };
}

test("CoS update snapshots data and explicit rollback preserves newer data", async t => {
  const f = await fixture(t);
  const result = await f.store.update({ ...f, directory: f.packs[1] });
  assert.equal(result.config.directory, f.packs[1]);
  assert.equal(result.config.enabled, true);
  assert.equal(await readFile(join(result.backupDirectory, "before-data/settings.json"), "utf8"), "original-data");
  await writeFile(join(f.dataDirectory, "settings.json"), "new-data");
  await writeFile(join(f.dataDirectory, "new-session.json"), "new-session");
  const rolled = await f.store.rollback({ ...f, current: { ...result.config, enabled: false } });
  assert.equal(rolled.config.directory, f.packs[0]);
  assert.equal(rolled.config.enabled, false);
  assert.equal(await readFile(join(f.dataDirectory, "settings.json"), "utf8"), "original-data");
  const journal = await f.store.readJournal(result.id);
  assert.equal(await readFile(join(journal.preservedData[0], "new-session.json"), "utf8"), "new-session");
  await assert.rejects(readFile(f.store.pendingPath), { code: "ENOENT" });
});

test('builtin version changes checkpoint data before startup without duplicating the snapshot', async t => {
  const f = await fixture(t);
  const before = { ...f.before, source: 'builtin', packVersion: 'old' };
  const next = await f.store.checkpointBuiltin(before, f.packs[1]);
  assert.equal(next.packVersion, 'old');
  assert.equal(next.builtinCheckpoint.packVersion, 'new');
  assert.equal(await readFile(join(next.builtinCheckpoint.backupDirectory, 'before-data/settings.json'), 'utf8'), 'original-data');
  await writeFile(join(f.dataDirectory, 'settings.json'), 'later-data');
  assert.deepEqual(await f.store.checkpointBuiltin(next, f.packs[1]), next);
  assert.equal(await readFile(join(next.builtinCheckpoint.backupDirectory, 'before-data/settings.json'), 'utf8'), 'original-data');
  assert.deepEqual(await f.store.checkpointBuiltin({ ...before, source: 'updated' }, f.packs[1]), { ...before, source: 'updated' });
});

test("CoS failed candidate startup restores both program and data", async t => {
  const f = await fixture(t);
  const activations = [];
  await assert.rejects(f.store.update({
    ...f, directory: f.packs[1],
    activate: async (config, enabled) => {
      activations.push(config.directory);
      if (config.directory === f.packs[1]) {
        await writeFile(join(f.dataDirectory, "settings.json"), "migration-wrote-new-data");
        throw new Error("native module failed");
      }
      assert.equal(await readFile(join(f.dataDirectory, "settings.json"), "utf8"), "original-data");
      return f.activate(config, enabled);
    },
  }), /previous program and data restored: native module failed/);
  assert.deepEqual(activations, [f.packs[1], f.packs[0]]);
  assert.equal(JSON.parse(await readFile(f.registryPath)).directory, f.packs[0]);
});

test("CoS interrupted migration can recover on the next host startup", async t => {
  const f = await fixture(t);
  let stops = 0;
  await assert.rejects(f.store.update({
    ...f, directory: f.packs[1],
    stop: async () => { if (++stops === 2) throw new Error("host interrupted"); },
    activate: async () => {
      await writeFile(join(f.dataDirectory, "settings.json"), "interrupted-migration");
      throw new Error("candidate crash");
    },
  }), /recovery needs attention/);
  const recovery = new CosUpdateStore(f);
  const config = await recovery.recover();
  assert.deepEqual(config, f.before);
  assert.equal(await readFile(join(f.dataDirectory, "settings.json"), "utf8"), "original-data");
  assert.equal(await recovery.recover(), null);
});

test("CoS detects damaged snapshots before replacing current data", async t => {
  const f = await fixture(t);
  const result = await f.store.update({ ...f, directory: f.packs[1] });
  await writeFile(join(f.dataDirectory, "settings.json"), "current-data");
  await writeFile(join(result.backupDirectory, "before-data/settings.json"), "damaged");
  await assert.rejects(f.store.rollback({ ...f, current: result.config }), /integrity/);
  assert.equal(await readFile(join(f.dataDirectory, "settings.json"), "utf8"), "current-data");
});

test("CoS invalid candidate is rejected without stopping the current version", async t => {
  const f = await fixture(t);
  let stops = 0;
  await assert.rejects(f.store.update({ ...f, directory: f.packs[0], stop: async () => { stops++; } }), /separate candidate/);
  await rm(join(f.packs[1], "main.js"));
  await assert.rejects(f.store.update({ ...f, directory: f.packs[1], stop: async () => { stops++; } }));
  assert.equal(stops, 0);
  assert.equal(await readFile(join(f.dataDirectory, "settings.json"), "utf8"), "original-data");
});

test("CoS snapshot rejects linked data without traversing or changing its target", async t => {
  const f = await fixture(t);
  const external = join(f.root, "linked-target");
  await mkdir(external);
  await writeFile(join(external, "keep.txt"), "untouched");
  await symlink(external, join(f.dataDirectory, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.store.update({ ...f, directory: f.packs[1] }), /regular files/);
  assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "untouched");
  assert.equal(JSON.parse(await readFile(f.registryPath)).directory, f.packs[0]);
});

test("CoS does not place its snapshots inside the data being copied", async t => {
  const f = await fixture(t);
  assert.throws(() => new CosUpdateStore({ registryPath: join(f.dataDirectory, "registry.json"), dataDirectory: f.dataDirectory }), /separate/);
  assert.throws(() => f.store.directory("../escape"), /identifier/);
  assert.ok((await readdir(f.root)).includes("state"));
});

test("CoS rollback refuses a different active package before stopping", async t => {
  const f = await fixture(t);
  const result = await f.store.update({ ...f, directory: f.packs[1] });
  let stops = 0;
  await assert.rejects(f.store.rollback({ ...f, current: { ...result.config, directory: f.packs[0] },
    stop: async () => { stops++; } }), /does not match/);
  assert.equal(stops, 0);
});

test("CoS interrupted manual rollback preserves the user's disabled state", async t => {
  const f = await fixture(t);
  const result = await f.store.update({ ...f, directory: f.packs[1] });
  await assert.rejects(f.store.rollback({ ...f, current: { ...result.config, enabled: false },
    activate: async () => { throw new Error("host exited during rollback"); } }), /host exited/);
  const config = await new CosUpdateStore(f).recover();
  assert.equal(config.enabled, false);
  assert.equal(config.directory, f.before.directory);
  assert.equal(await readFile(join(f.dataDirectory, "settings.json"), "utf8"), "original-data");
});

test("CoS snapshot journal failure restarts the old package without changing data", async t => {
  const f = await fixture(t);
  const journal = f.store.journal.bind(f.store);
  let first = true, restored = false;
  f.store.journal = async record => {
    if (first) { first = false; throw new Error("disk full"); }
    return journal(record);
  };
  await assert.rejects(f.store.update({ ...f, directory: f.packs[1],
    activate: async (config, enabled) => { restored = true; return f.activate(config, enabled); } }), /previous program and data restored/);
  assert.equal(restored, true);
  assert.equal(await readFile(join(f.dataDirectory, "settings.json"), "utf8"), "original-data");
  await assert.rejects(readFile(f.store.pendingPath), { code: "ENOENT" });
});
