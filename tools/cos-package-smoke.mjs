import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const work = join(root, ".tmp/codex/cos-integration", `package-${randomUUID()}`);
const evidence = join(root, "docs/cos-workspace-pack/evidence");
const result = { checkedAt: new Date().toISOString(), passed: false };
const logs = [];
try {
  const child = spawn(process.execPath, [join(root, "tools/prepare-desktop-package.mjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, EGO_PACKAGE_STAGING_ROOT: work, SCANSCI_PACKAGE_SOURCE: "A:\\Project\\ScanSci PDF" },
  });
  child.stdout.on("data", chunk => logs.push(String(chunk)));
  child.stderr.on("data", chunk => logs.push(String(chunk)));
  const [code] = await once(child, "exit");
  assert.equal(code, 0, logs.join("").slice(-5000));
  const builder = join(work, "runtime/cos-builder");
  assert.equal((await readdir(builder)).includes("packs"), false);
  assert.equal((await readdir(builder)).includes("node_modules"), false);
  assert.ok((await stat(join(builder, "tools/acquire-cos-pack.mjs"))).isFile());
  const acquire = await import(pathToFileURL(join(work, "app/workspace-packs/cos-acquire.mjs")).href);
  assert.equal(typeof acquire.acquireCosPreset, "function");
  const metadata = JSON.parse(await readFile(join(work, "app/package.json"), "utf8"));
  assert.equal(metadata.build.extraResources.some(row => row.to === "runtime"), true);
  result.packagedAcquisitionHelperLoads = true;
  result.builderIncludedWithoutCoSBusinessPackage = true;
  result.preparedDesktopPackage = true;
  result.passed = true;
} catch (error) {
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  await writeFile(join(evidence, "cos-package-prepare.txt"), logs.join(""));
  await rm(work, { recursive: true, force: true });
  result.testDirectoryRemoved = true;
  await writeFile(join(evidence, "cos-package-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
