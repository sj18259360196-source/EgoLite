import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, rmdirSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CollectionService } from "@ego-compat/broker-core";
import { SqliteTaskSpaceStore } from "./sqlite-task-store.ts";

test("SQLite migration backs up originals once and atomically restores folders, order and trash after restart", () => {
  const root = resolve(import.meta.dirname, "../../..", ".tmp/codex/bookmark-persistence");
  const existed = existsSync(root);
  mkdirSync(root, { recursive: true });
  const work = mkdtempSync(join(root, "run-"));
  const file = join(work, "state.db");
  let store: SqliteTaskSpaceStore | undefined;
  try {
    store = new SqliteTaskSpaceStore(file);
    const original = [{ id: "original", text: "Preserved excerpt", group: "A / B", tags: ["research"], createdAt: "2020-01-01" }];
    store.saveCollections(original);
    const service = new CollectionService(store);
    const folder = service.folderSave("Empty", "bar");
    const child = service.folderSave("Nested", folder.id);
    const bookmark = service.bookmark({ title: "Page", url: "https://a.test/", folderId: child.id });
    service.trash([folder.id]);
    const expected = service.snapshot();
    store.close();
    store = new SqliteTaskSpaceStore(file);
    const restored = new CollectionService(store);
    assert.deepEqual(restored.snapshot().folders, expected.folders);
    assert.deepEqual(restored.snapshot().items.sort((a, b) => a.id.localeCompare(b.id)), expected.items.sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(restored.list().length, 1);
    restored.restore([folder.id]);
    assert.equal(restored.list().find(item => item.id === bookmark.id)?.folderId, child.id);
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const backup = database.prepare("SELECT items_json FROM collection_migration_backup WHERE id = 1").get();
      assert.deepEqual(JSON.parse(String(backup?.items_json)), original);
    } finally { database.close(); }
  } finally {
    store?.close();
    const rel = relative(root, resolve(work));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe cleanup");
    rmSync(work, { recursive: true, force: true });
    if (!existed && readdirSync(root).length === 0) rmdirSync(root);
  }
});
