import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readCosPack } from "./cos-archive.mjs";

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function inventory(root) {
  const rows = [];
  if (!await exists(root)) return null;
  async function walk(path, name = "") {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) {
      throw new Error(`CoS data snapshot requires regular files: ${name}`);
    }
    if (info.isDirectory()) {
      rows.push({ path: name, kind: "directory" });
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), name ? `${name}/${entry}` : entry);
    } else {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      rows.push({ path: name, size: info.size, sha256: hash.digest("hex") });
    }
  }
  await walk(root);
  return rows;
}

export class CosUpdateStore {
  constructor({ registryPath, dataDirectory }) {
    this.registryPath = resolve(registryPath);
    this.dataDirectory = resolve(dataDirectory);
    this.root = join(dirname(this.registryPath), "updates");
    this.pendingPath = join(dirname(this.registryPath), "update-pending.json");
    for (const [parent, child] of [[this.root, this.dataDirectory], [this.dataDirectory, this.root]]) {
      const inside = relative(parent, child);
      if (!inside || !inside.startsWith("..") && !isAbsolute(inside)) throw new Error("CoS update and data directories must be separate");
    }
  }

  async checkpointBuiltin(before, directory) {
    if (before.source !== 'builtin' || !before.packVersion) return before;
    const manifest = await readCosPack(directory);
    if (before.packVersion === manifest.packVersion || before.builtinCheckpoint?.packVersion === manifest.packVersion) return before;
    const record = { id: randomUUID(), phase: 'builtin-checkpoint', dataDirectory: this.dataDirectory,
      before: structuredClone(before), candidate: { directory: resolve(directory), packVersion: manifest.packVersion },
      createdAt: new Date().toISOString() };
    const backupDirectory = this.directory(record.id);
    try {
      await this.journal(record);
      const expected = await inventory(this.dataDirectory);
      const snapshot = join(backupDirectory, 'before-data');
      if (expected !== null) await cp(this.dataDirectory, snapshot, { recursive: true, force: false, errorOnExist: true });
      if (JSON.stringify(await inventory(snapshot)) !== JSON.stringify(expected)) throw new Error('CoS builtin data checkpoint verification failed');
      await writeJson(join(backupDirectory, 'snapshot.json'), expected);
      const next = { ...before, builtinCheckpoint: { backupDirectory, packVersion: manifest.packVersion } };
      await writeJson(this.registryPath, next);
      return next;
    } catch (error) {
      await rm(backupDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  directory(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid CoS update identifier");
    return join(this.root, id);
  }
  async journal(record) { await writeJson(join(this.directory(record.id), "transaction.json"), record); }
  async readJournal(id) {
    const record = JSON.parse(await readFile(join(this.directory(id), "transaction.json"), "utf8"));
    if (record.id !== id || record.dataDirectory !== this.dataDirectory) throw new Error("CoS update data identity changed");
    return record;
  }
  async clearPending(id) {
    const pending = JSON.parse(await readFile(this.pendingPath, "utf8"));
    if (pending.id !== id) throw new Error("CoS update ownership changed");
    await rm(this.pendingPath);
  }

  async restoreData(record) {
    const directory = this.directory(record.id);
    const snapshot = join(directory, "before-data");
    const expected = JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8"));
    if (JSON.stringify(await inventory(snapshot)) !== JSON.stringify(expected)) {
      throw new Error("CoS data snapshot failed integrity validation; current data was not replaced");
    }
    // Prepare a complete restored copy before moving the current data aside.
    const restored = join(directory, `restore-${randomUUID()}`);
    if (expected !== null) await cp(snapshot, restored, { recursive: true, force: false, errorOnExist: true });
    if (JSON.stringify(await inventory(restored)) !== JSON.stringify(expected)) throw new Error("CoS restored data verification failed");
    const preserved = join(directory, `preserved-${randomUUID()}`);
    if (await exists(this.dataDirectory)) await rename(this.dataDirectory, preserved);
    if (expected !== null) await rename(restored, this.dataDirectory);
    record.preservedData = [...(record.preservedData || []), preserved];
    await this.journal(record);
  }

  async recover() {
    if (!await exists(this.pendingPath)) return null;
    const { id } = JSON.parse(await readFile(this.pendingPath, "utf8"));
    const record = await this.readJournal(id);
    if (!["committed", "rolled-back", "aborted"].includes(record.phase)) {
      if (record.phase !== "snapshotting") await this.restoreData(record);
      await writeJson(this.registryPath, { ...record.before,
        ...(typeof record.rollbackEnabled === "boolean" ? { enabled: record.rollbackEnabled } : {}) });
      record.phase = "rolled-back";
      record.recoveredAt = new Date().toISOString();
      await this.journal(record);
    }
    await this.clearPending(id);
    return JSON.parse(await readFile(this.registryPath, "utf8"));
  }

  async update({ before, directory, stop, activate }) {
    if (await exists(this.pendingPath)) throw new Error("An interrupted CoS update must be recovered first");
    const manifest = await readCosPack(directory);
    await readCosPack(before.directory);
    if (resolve(directory) === resolve(before.directory)) throw new Error("CoS update requires a separate candidate directory");
    await stop();
    const record = {
      id: randomUUID(), phase: "snapshotting", dataDirectory: this.dataDirectory,
      before: structuredClone(before), createdAt: new Date().toISOString(),
      candidate: { directory: resolve(directory), packVersion: manifest.packVersion },
    };
    try {
      await this.journal(record);
      await writeJson(this.pendingPath, { id: record.id });
      const snapshot = join(this.directory(record.id), "before-data");
      const expected = await inventory(this.dataDirectory);
      if (expected !== null) await cp(this.dataDirectory, snapshot, { recursive: true, force: false, errorOnExist: true });
      if (JSON.stringify(await inventory(snapshot)) !== JSON.stringify(expected)) throw new Error("CoS snapshot verification failed");
      await writeJson(join(this.directory(record.id), "snapshot.json"), expected);
      record.phase = "testing";
      await this.journal(record);
      const next = { ...before, ...record.candidate, enabled: false, previousDirectory: before.directory, lastUpdateId: record.id };
      await writeJson(this.registryPath, next);
      const config = await activate(next, before.enabled === true);
      await writeJson(this.registryPath, config);
      record.phase = "committed";
      record.completedAt = new Date().toISOString();
      await this.journal(record);
      await this.clearPending(record.id);
      return { config, id: record.id, backupDirectory: this.directory(record.id) };
    } catch (error) {
      if (record.phase === "committed") throw error;
      try {
        await stop();
        if (record.phase !== "snapshotting") await this.restoreData(record);
        await writeJson(this.registryPath, before);
        const restored = await activate(structuredClone(before), before.enabled === true);
        await writeJson(this.registryPath, restored);
        record.phase = "rolled-back";
        record.error = error.message;
        await this.journal(record);
        if (await exists(this.pendingPath)) await this.clearPending(record.id);
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "CoS update failed and recovery needs attention; all data was retained");
      }
      throw new Error(`CoS update failed; previous program and data restored: ${error.message}`, { cause: error });
    }
  }

  async rollback({ current, stop, activate }) {
    if (await exists(this.pendingPath)) throw new Error("An interrupted CoS update must be recovered first");
    if (!current.lastUpdateId) throw new Error("CoS has no recorded update to roll back");
    const record = await this.readJournal(current.lastUpdateId);
    if (record.phase !== "committed") throw new Error("CoS update is not available for rollback");
    if (resolve(current.directory) !== resolve(record.candidate.directory)) throw new Error("CoS active package does not match the recorded update");
    await readCosPack(record.before.directory);
    await stop();
    await writeJson(this.pendingPath, { id: record.id });
    record.phase = "rolling-back";
    record.rollbackEnabled = current.enabled === true;
    await this.journal(record);
    await this.restoreData(record);
    const previous = { ...record.before, enabled: current.enabled === true };
    await writeJson(this.registryPath, { ...previous, enabled: false });
    const config = await activate(previous, current.enabled === true);
    await writeJson(this.registryPath, config);
    record.phase = "rolled-back";
    await this.journal(record);
    await this.clearPending(record.id);
    return { config, id: record.id, backupDirectory: this.directory(record.id) };
  }
}
