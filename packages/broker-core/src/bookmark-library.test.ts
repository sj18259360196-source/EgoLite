import assert from "node:assert/strict";
import test from "node:test";
import type { CollectionFolder, CollectionItem } from "@ego-compat/protocol";
import { CollectionService } from "./collection-service.ts";

class Store {
  items: CollectionItem[] = [];
  folders: CollectionFolder[] | undefined;
  fail = false;
  loadCollections() { return structuredClone(this.items); }
  loadCollectionFolders() { return structuredClone(this.folders); }
  saveCollections(items: CollectionItem[]) { this.items = structuredClone(items); }
  saveCollectionLibrary(items: CollectionItem[], folders: CollectionFolder[]) {
    if (this.fail) throw new Error("disk full");
    this.items = structuredClone(items);
    this.folders = structuredClone(folders);
  }
}

test("migration preserves IDs, excerpts, literal slash groups and empty folders on restart", () => {
  const store = new Store();
  store.items = [{ id: "old", text: "Excerpt", sourceUrl: "https://a.test/", group: "A / B", tags: ["tag"], createdAt: "2020-01-01" }];
  const service = new CollectionService(store);
  const migrated = service.list()[0]!;
  assert.equal(migrated.id, "old");
  assert.equal(migrated.kind, undefined);
  assert.equal(migrated.text, "Excerpt");
  assert.deepEqual(migrated.tags, ["tag"]);
  assert.equal(service.snapshot().folders.find(folder => folder.id === migrated.folderId)?.name, "A / B");
  const empty = service.folderSave("Empty", "bar");
  assert.deepEqual(new CollectionService(store).snapshot(), service.snapshot());
  assert.ok(new CollectionService(store).snapshot().folders.some(folder => folder.id === empty.id));
});

test("bookmark save is idempotent and does not consume same-page excerpts", () => {
  const service = new CollectionService();
  service.save("Excerpt A", { sourceUrl: "https://a.test/" });
  service.save("Excerpt B", { sourceUrl: "https://a.test/" });
  const first = service.bookmark({ title: "Page", url: "https://a.test", folderId: "bar" });
  const second = service.bookmark({ title: "Changed", url: "https://a.test/" });
  assert.equal(first.id, second.id);
  assert.equal(second.folderId, "bar");
  assert.equal(service.list().length, 3);
  const copy = service.bookmark({ title: "Copy", url: "https://a.test/", copy: true });
  assert.notEqual(copy.id, first.id);
  assert.equal(service.list().length, 4);
  assert.throws(() => service.bookmark({ title: "Bad", url: "javascript:alert(1)" }));
});

test("moving and renaming folders retains descendants and rejects cycles without partial changes", () => {
  const service = new CollectionService();
  const parent = service.folderSave("Parent");
  const child = service.folderSave("Child", parent.id);
  const item = service.bookmark({ title: "Page", url: "https://a.test/", folderId: child.id });
  service.folderSave("Renamed", parent.id, child.id);
  assert.equal(service.list()[0]?.group, "Renamed");
  service.libraryMove([parent.id], "bar");
  const snapshot = service.snapshot();
  assert.throws(() => service.libraryMove([item.id, parent.id], child.id));
  assert.deepEqual(service.snapshot(), snapshot);
  assert.throws(() => service.folderSave("Bad", child.id, parent.id));
  assert.throws(() => service.libraryMove(["bar"], "other"));
});

test("manual mixed ordering survives restart", () => {
  const store = new Store();
  const service = new CollectionService(store);
  const a = service.bookmark({ title: "A", url: "https://a.test", folderId: "bar" });
  const folder = service.folderSave("Folder", "bar");
  const b = service.bookmark({ title: "B", url: "https://b.test", folderId: "bar" });
  service.libraryMove([b.id, folder.id], "bar", a.id);
  const restored = new CollectionService(store).snapshot();
  const order = [...restored.items, ...restored.folders.filter(entry => entry.parentId === "bar")].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  assert.deepEqual(order.map(entry => entry.id), [b.id, folder.id, a.id]);
});

test("folder trash restores its batch but not previously deleted children", () => {
  const store = new Store();
  const service = new CollectionService(store);
  const parent = service.folderSave("Parent");
  const child = service.folderSave("Child", parent.id);
  const a = service.bookmark({ title: "A", url: "https://a.test", folderId: child.id });
  const b = service.bookmark({ title: "B", url: "https://b.test", folderId: child.id });
  service.trash([a.id]);
  service.trash([parent.id]);
  assert.equal(service.list().length, 0);
  const restored = new CollectionService(store);
  restored.restore([parent.id]);
  assert.deepEqual(restored.list().map(item => item.id), [b.id]);
  assert.ok(restored.snapshot().items.find(item => item.id === a.id)?.deletedAt);
  assert.throws(() => restored.trash(["bar", b.id]));
  assert.equal(restored.list().length, 1);
});

test("restoring an individual bookmark whose parent is deleted uses other folder", () => {
  const service = new CollectionService();
  const folder = service.folderSave("Folder");
  const item = service.bookmark({ title: "A", url: "https://a.test", folderId: folder.id });
  service.trash([folder.id]);
  service.restore([item.id]);
  assert.equal(service.list()[0]?.folderId, "other");
  assert.ok(service.snapshot().folders.find(entry => entry.id === folder.id)?.deletedAt);
});

test("failed persistence rolls back items and directories", () => {
  const store = new Store();
  const service = new CollectionService(store);
  service.bookmark({ title: "A", url: "https://a.test" });
  const snapshot = service.snapshot();
  store.fail = true;
  assert.throws(() => service.folderSave("Folder"), /disk full/);
  assert.deepEqual(service.snapshot(), snapshot);
  assert.throws(() => service.bookmark({ title: "B", url: "https://b.test" }), /disk full/);
  assert.deepEqual(service.snapshot(), snapshot);
  assert.throws(() => service.trash([snapshot.items[0]!.id]), /disk full/);
  assert.deepEqual(service.snapshot(), snapshot);
});

test("library import keeps empty nested directories and rejects malformed trees atomically", () => {
  const source = new CollectionService();
  const folder = source.folderSave("Empty", "bar");
  source.folderSave("Nested", folder.id);
  source.bookmark({ title: "A", url: "https://a.test", folderId: folder.id });
  const target = new CollectionService();
  const data = source.snapshot();
  assert.equal(target.importLibrary(data.items, data.folders).added, 1);
  assert.equal(target.snapshot().folders.length, 4);
  assert.equal(target.list()[0]?.kind, "bookmark");
  const snapshot = target.snapshot();
  assert.throws(() => target.importLibrary([], [{ id: "cycle", name: "Cycle", parentId: "cycle", order: 0 }]));
  assert.deepEqual(target.snapshot(), snapshot);
  assert.deepEqual(target.importLibrary(data.items, data.folders), { added: 0, skipped: 1 });
});
