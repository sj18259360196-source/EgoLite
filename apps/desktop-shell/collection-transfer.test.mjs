import assert from "node:assert/strict";
import test from "node:test";
import { parseLibraryJson, libraryToBookmarksHtml } from "./collection-transfer.mjs";

test("JSON transfer preserves typed records and folders but accepts legacy arrays", () => {
  const folders = [{ id: "bar", name: "Bookmarks bar", parentId: null, order: 0 }];
  const item = { id: "a", text: "Title", sourceUrl: "https://a.test/", kind: "bookmark", folderId: "bar", order: 3, tags: ["a"] };
  const parsed = parseLibraryJson(JSON.stringify({ version: 2, folders, collections: [item] }));
  assert.deepEqual(parsed.folders, folders);
  assert.equal(parsed.entries[0].folderId, "bar");
  assert.equal(parsed.entries[0].kind, "bookmark");
  assert.equal(parsed.entries[0].order, 3);
  assert.equal(parseLibraryJson(JSON.stringify([{ text: "legacy", group: "A / B" }])).entries[0].group, "A / B");
  assert.throws(() => parseLibraryJson("{}"), /collections/);
});

test("HTML export retains empty nested folders, stable mixed order, and escapes untrusted text", () => {
  const folders = [
    { id: "bar", name: "Bar", parentId: null, order: 0 },
    { id: "child", name: 'A < B & "C"', parentId: "bar", order: 0 },
    { id: "nested", name: "Empty", parentId: "child", order: 0 },
  ];
  const html = libraryToBookmarksHtml([{ id: "a", text: "<script>", sourceUrl: "https://a.test/?x=1&y=2", folderId: "bar", order: 1, createdAt: "2020-01-01" }], folders);
  assert.match(html, /PERSONAL_TOOLBAR_FOLDER="true"/);
  assert.match(html, /A &lt; B &amp; &quot;C&quot;/);
  assert.match(html, /<H3>Empty<\/H3>/);
  assert.ok(html.indexOf("Empty") < html.indexOf("&lt;script&gt;"));
  assert.match(html, /x=1&amp;y=2/);
});
