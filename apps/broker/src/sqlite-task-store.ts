import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CollectionStore, TaskSpaceStore } from "@ego-compat/broker-core";
import type { CodexOperationRecord, CollectionItem, CollectionFolder, TaskSpaceRecord } from "@ego-compat/protocol";

export interface CodexOperationStore {
  listOperations(taskId: string, limit?: number): CodexOperationRecord[];
  saveOperation(record: CodexOperationRecord): void;
  clearOperations(taskId: string): void;
}

export class SqliteTaskSpaceStore implements TaskSpaceStore, CollectionStore, CodexOperationStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS task_spaces (
        id INTEGER PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collections (
        id TEXT PRIMARY KEY,
        item_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collection_library (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        folders_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collection_migration_backup (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        items_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_operations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS codex_operations_task_started
        ON codex_operations(task_id, started_at DESC);
    `);
  }

  listOperations(taskId: string, limit = 200): CodexOperationRecord[] {
    return this.#database
      .prepare("SELECT record_json FROM codex_operations WHERE task_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(taskId, Math.max(1, Math.min(limit, 500)))
      .map((row) => JSON.parse(String(row.record_json)) as CodexOperationRecord)
      .reverse();
  }

  saveOperation(record: CodexOperationRecord): void {
    this.#database.prepare(`
      INSERT INTO codex_operations (id, task_id, record_json, started_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        record_json = excluded.record_json,
        started_at = excluded.started_at
    `).run(record.id, record.taskId, JSON.stringify(record), record.startedAt);
    this.#database.prepare(`
      DELETE FROM codex_operations
      WHERE task_id = ? AND id NOT IN (
        SELECT id FROM codex_operations WHERE task_id = ? ORDER BY started_at DESC LIMIT 500
      )
    `).run(record.taskId, record.taskId);
  }

  clearOperations(taskId: string): void {
    this.#database.prepare("DELETE FROM codex_operations WHERE task_id = ?").run(taskId);
  }

  loadCollections(): CollectionItem[] {
    return this.#database
      .prepare("SELECT item_json FROM collections ORDER BY created_at DESC")
      .all()
      .map((row) => JSON.parse(String(row.item_json)) as CollectionItem);
  }

  saveCollections(items: CollectionItem[]): void {
    this.#saveLibrary(items);
  }

  loadCollectionFolders(): CollectionFolder[] | undefined {
    const row = this.#database.prepare("SELECT folders_json FROM collection_library WHERE id = 1").get();
    return row ? JSON.parse(String(row.folders_json)) : undefined;
  }

  saveCollectionLibrary(items: CollectionItem[], folders: CollectionFolder[]): void {
    this.#saveLibrary(items, folders);
  }

  #saveLibrary(items: CollectionItem[], folders?: CollectionFolder[]): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (folders) {
        this.#database.prepare("INSERT OR IGNORE INTO collection_migration_backup (id, items_json, created_at) VALUES (1, ?, ?)")
          .run(JSON.stringify(this.loadCollections()), new Date().toISOString());
        this.#database.prepare("INSERT INTO collection_library (id, folders_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET folders_json = excluded.folders_json")
          .run(JSON.stringify(folders));
      }
      const upsert = this.#database.prepare(`
        INSERT INTO collections (id, item_json, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          item_json = excluded.item_json,
          created_at = excluded.created_at
      `);
      const ids = new Set<string>();
      for (const item of items) {
        ids.add(item.id);
        upsert.run(item.id, JSON.stringify(item), item.createdAt);
      }
      for (const row of this.#database.prepare("SELECT id FROM collections").all()) {
        const id = String(row.id);
        if (!ids.has(id)) this.#database.prepare("DELETE FROM collections WHERE id = ?").run(id);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  load(): TaskSpaceRecord[] {
    return this.#database
      .prepare("SELECT record_json FROM task_spaces ORDER BY id")
      .all()
      .map((row) => JSON.parse(String(row.record_json)) as TaskSpaceRecord);
  }

  save(spaces: TaskSpaceRecord[]): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const upsert = this.#database.prepare(`
        INSERT INTO task_spaces (id, task_id, record_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          task_id = excluded.task_id,
          record_json = excluded.record_json,
          updated_at = excluded.updated_at
      `);
      const ids = new Set<number>();
      for (const space of spaces) {
        ids.add(space.id);
        upsert.run(space.id, space.taskId, JSON.stringify(space), space.updatedAt);
      }
      for (const row of this.#database.prepare("SELECT id FROM task_spaces").all()) {
        const id = Number(row.id);
        if (!ids.has(id)) this.#database.prepare("DELETE FROM task_spaces WHERE id = ?").run(id);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
}
