import assert from "node:assert/strict";
import test from "node:test";

import type { CollectionItem } from "@ego-compat/protocol";

import { CollectionService, type CollectionStore } from "./collection-service.ts";

class MemoryStore implements CollectionStore {
  items: CollectionItem[] = [];
  loadCollections() { return structuredClone(this.items); }
  saveCollections(items: CollectionItem[]) { this.items = structuredClone(items); }
}

test("collections persist and search text, title, and source", () => {
  const store = new MemoryStore();
  const service = new CollectionService(store);
  assert.equal(service.save("  useful selected text  ", {
    sourceUrl: "https://example.test/research",
    pageTitle: "Research Notes",
  }), true);
  assert.equal(service.save("   "), false);

  const restored = new CollectionService(store);
  assert.equal(restored.list().length, 1);
  assert.equal(restored.list()[0]?.text, "useful selected text");
  assert.equal(restored.list("notes").length, 1);
  assert.equal(restored.list("example.test").length, 1);
  assert.equal(restored.list("missing").length, 0);
});

test("collection import deduplicates browser entries and persists once", () => {
  const store = new MemoryStore();
  const service = new CollectionService(store);
  const first = service.import([
    { text: "OpenAI", sourceUrl: "https://openai.com", pageTitle: "Chrome · Bookmarks" },
    { text: "OpenAI", sourceUrl: "https://openai.com", pageTitle: "Chrome · Bookmarks" },
  ]);
  const second = service.import([
    { text: "OpenAI", sourceUrl: "https://openai.com", pageTitle: "Edge · Bookmarks" },
  ]);

  assert.deepEqual(first, { added: 1, skipped: 1 });
  assert.deepEqual(second, { added: 0, skipped: 1 });
  assert.equal(service.list().length, 1);
});

test("collections can be grouped, searched by group, and deleted", () => {
  const store = new MemoryStore();
  const service = new CollectionService(store);
  service.save("Windows browser notes", { sourceUrl: "https://example.test/ego" });
  const item = service.list()[0];
  assert.ok(item);
  assert.equal(service.update(item.id, { group: "Research" }) && service.list()[0]?.group, "Research");
  assert.equal(service.list("research").length, 1);
  assert.equal(service.delete(item.id), true);
  assert.equal(service.delete(item.id), false);
  assert.equal(new CollectionService(store).list().length, 0);
});

test("collections support single-persist batch move and removal", () => {
  const store = new MemoryStore();
  let saves = 0;
  const originalSave = store.saveCollections.bind(store);
  store.saveCollections = (items) => { saves += 1; originalSave(items); };
  const service = new CollectionService(store);
  service.save("One");
  service.save("Two");
  const [two, one] = service.list();
  assert.ok(one && two);
  const beforeMove = saves;
  assert.deepEqual(service.move([one.id, two.id, "missing"], "Reading"), {
    updated: service.list().map((item) => ({ ...item, group: "Reading" })),
    missing: ["missing"],
  });
  assert.equal(saves, beforeMove + 1);
  const beforeRemove = saves;
  assert.deepEqual(service.remove([one.id, "missing"]), { removed: [one.id], missing: ["missing"] });
  assert.equal(saves, beforeRemove + 1);
  assert.equal(service.list().length, 1);
});

test("collection title and body can be edited without losing source metadata", () => {
  const service = new CollectionService();
  service.save("Original body", { sourceUrl: "https://example.test", pageTitle: "Original title", group: "Research" });
  const item = service.list()[0];
  assert.ok(item);
  const updated = service.update(item.id, { text: "Edited body", pageTitle: "Edited title" });
  assert.ok(updated);
  assert.equal(updated.text, "Edited body");
  assert.equal(updated.pageTitle, "Edited title");
  assert.equal(updated.sourceUrl, "https://example.test");
  assert.equal(updated.group, "Research");
  assert.equal(service.update(item.id, { text: "   " }), false);
});

test("collection tags persist, update, and participate in search", () => {
  const store = new MemoryStore();
  const service = new CollectionService(store);
  service.save("Tagged body", { sourceUrl: "https://example.test/tags", tags: ["Windows", "研究"] });
  const item = service.list()[0];
  assert.ok(item);
  assert.equal(service.list("研究").length, 1);
  const updated = service.update(item.id, { tags: ["AI", "AI", "浏览器"] });
  assert.ok(updated);
  assert.deepEqual(updated.tags, ["AI", "浏览器"]);
  assert.deepEqual(new CollectionService(store).list()[0]?.tags, ["AI", "浏览器"]);
});

test("merge combines duplicate metadata and removes redundant records in one persist", () => {
  const store = new MemoryStore();
  const service = new CollectionService(store);
  service.save("First excerpt", { sourceUrl: "https://example.test/page", pageTitle: "Example", tags: ["A"] });
  service.save("Second excerpt", { sourceUrl: "https://example.test/page", group: "Research", tags: ["B"] });
  const [second, first] = service.list();
  assert.ok(first && second);
  let saves = 0;
  const originalSave = store.saveCollections.bind(store);
  store.saveCollections = (items) => { saves += 1; originalSave(items); };

  const result = service.merge([first.id, second.id], first.id);

  assert.equal(saves, 1);
  assert.deepEqual(result.removed, [second.id]);
  assert.equal(service.list().length, 1);
  assert.equal(result.merged && result.merged.group, "Research");
  assert.deepEqual(result.merged && result.merged.tags, ["A", "B"]);
  assert.match(result.merged && result.merged.text || "", /First excerpt[\s\S]*Second excerpt/);
});
