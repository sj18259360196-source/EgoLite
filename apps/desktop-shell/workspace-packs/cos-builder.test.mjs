import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareCosBuilder } from "../../../tools/prepare-cos-builder.mjs";

test("CoS packaged builder contains adapters and bundled helpers, not CoS or a global toolchain", async t => {
  const base = resolve(".tmp/codex/cos-integration/unit");
  await mkdir(base, { recursive: true });
  const destination = await mkdtemp(join(base, "builder-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  await prepareCosBuilder(resolve("."), destination);
  const names = await readdir(destination);
  assert.deepEqual(names.sort(), ["apps", "integrations", "licenses", "tools"]);
  for (const file of [
    "tools/acquire-cos-pack.mjs", "tools/prepare-cos-pack.mjs", "integrations/cos/upstream.json",
    "apps/desktop-shell/workspace-packs/cos-runtime.mjs", "integrations/cos/hosted-execution.ts",
    "integrations/cos/hosted-renderer.ts",
  ]) assert.ok((await stat(join(destination, file))).isFile());
  const archive = await import(pathToFileURL(join(destination, "apps/desktop-shell/workspace-packs/cos-archive.mjs")).href);
  const downloads = await import(pathToFileURL(join(destination, "apps/desktop-shell/workspace-packs/cos-download.mjs")).href);
  assert.equal(typeof archive.installCosArchive, "function");
  assert.equal(typeof downloads.downloadCosFile, "function");
  const packageTool = await readFile("tools/prepare-desktop-package.mjs", "utf8");
  assert.ok(packageTool.includes('prepareCosBuilder(root, join(runtimeDirectory, "cos-builder"))'));
  assert.ok(packageTool.includes("workspace-packs/cos-acquire.mjs"));
});
