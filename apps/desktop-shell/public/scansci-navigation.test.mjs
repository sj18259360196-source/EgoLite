import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const start = source.indexOf("function restoreInitialBrowserTab()");
const end = source.indexOf("\nfunction ", start + 1);
const restore = source.slice(start, end) + "\nrestoreInitialBrowserTab();";

test("startup tab restoration does not leave an explicitly selected ScanSci settings view", () => {
  runInNewContext(restore, { $: () => ({ id: "scansci-settings-view" }) });
});

test("normal startup still restores the welcome view", () => {
  let restored = false;
  runInNewContext(restore, {
    $: () => ({ id: "start-view" }), state: { spaces: [] }, activeTaskId: "",
    cosWorkspace: { owns: () => false }, tabsForTask: () => [], automaticTabForTask: () => null,
    showWelcome: () => { restored = true; },
  });
  assert.equal(restored, true);
});
