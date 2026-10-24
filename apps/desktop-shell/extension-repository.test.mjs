import assert from "node:assert/strict";
import test from "node:test";

import { bundledExtensionRepository, normalizeExtensionRepository } from "./extension-repository.mjs";

test("normalizes bundled and remote extension repository entries", () => {
  const bundled = bundledExtensionRepository();
  assert.equal(bundled[0]?.id, "ego-companion");
  const items = normalizeExtensionRepository([
    { id: "remote-one", name: "Remote One", version: "1.0.0", url: "https://example.com/one.zip", permissions: ["storage"] },
    { id: "invalid", name: "Missing source" },
  ], new Set(["remote-one"]));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.installed, true);
  assert.equal(items[0]?.source, "url");
});
