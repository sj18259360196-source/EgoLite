import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createBrowserExtensionRecord,
  hashBrowserExtensionArchive,
  normalizeBrowserExtensionPath,
  publicBrowserExtension,
  readBrowserExtensionManifest,
} from "./browser-extensions.mjs";

test("reads and normalizes a local Chromium extension manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-extension-test-"));
  try {
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      manifest_version: 3,
      name: "Fixture Extension",
      version: "1.2.3",
      description: "A local test extension",
    }));
    const manifest = readBrowserExtensionManifest(root);
    assert.equal(manifest.name, "Fixture Extension");
    assert.equal(manifest.manifestVersion, 3);
    assert.equal(normalizeBrowserExtensionPath(root), manifest.path);
    const record = createBrowserExtensionRecord(root);
    assert.match(record.id, /^local-/);
    assert.equal(record.sourceType, "directory");
    assert.equal(publicBrowserExtension(record, { loaded: true, extensionId: "fixture-id" }).loaded, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hashes extension archives deterministically", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-extension-archive-test-"));
  const first = join(root, "first.zip");
  const second = join(root, "second.zip");
  try {
    writeFileSync(first, "same archive bytes");
    writeFileSync(second, "same archive bytes");
    assert.equal(hashBrowserExtensionArchive(first), hashBrowserExtensionArchive(second));
    writeFileSync(second, "different archive bytes");
    assert.notEqual(hashBrowserExtensionArchive(first), hashBrowserExtensionArchive(second));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsupported extension manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-extension-invalid-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ manifest_version: 1, name: "Old" }));
    assert.throws(() => readBrowserExtensionManifest(root), /Manifest V2 或 V3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
