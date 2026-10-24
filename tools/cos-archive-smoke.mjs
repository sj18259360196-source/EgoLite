import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { installCosArchive } from "../apps/desktop-shell/workspace-packs/cos-archive.mjs";
import { CosRuntime } from "../apps/desktop-shell/workspace-packs/cos-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const base = join(root, ".tmp/codex/cos-integration");
const work = join(base, `archive-smoke-${randomUUID()}`);
await mkdir(work, { recursive: true });
const archive = resolve(process.argv[2] || join(root, "packs/cos/exports/CoS-2.1.20-ego.1-win32-x64.egopack"));
const result = { checkedAt: new Date().toISOString(), passed: false, archive };
let runtime;
try {
  const installed = await installCosArchive(archive, join(work, "packs"));
  result.sha256 = installed.sha256;
  result.packVersion = installed.manifest.packVersion;
  result.installedDirectory = installed.directory;
  runtime = new CosRuntime({ directory: installed.directory, dataDirectory: join(work, "state") });
  await runtime.start();
  const state = await runtime.invoke("state:get");
  assert.equal(state.ok, true, state.error);
  assert.ok(state.data.config.ui);
  result.installedBackendStarted = true;
  result.channels = runtime.channels.length;
  const version = (await readFile(join(installed.directory, "source/resources/tunnel/VERSION"), "utf8")).trim();
  assert.equal(version, "v0.0.15");
  result.bundledTunnelVersion = version;
  result.passed = true;
} catch (error) {
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  await runtime?.stop();
  result.runtimeStopped = !runtime || runtime.state === "stopped";
  if (dirname(work) !== base) throw new Error("Invalid test cleanup directory");
  await rm(work, { recursive: true, force: true });
  result.testDirectoryRemoved = true;
  await writeFile(join(root, "docs/cos-workspace-pack/evidence/cos-archive-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
