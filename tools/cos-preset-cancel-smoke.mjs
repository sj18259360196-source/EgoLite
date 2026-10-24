import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareCosBuilder } from "./prepare-cos-builder.mjs";
import { acquireCosPreset } from "../apps/desktop-shell/workspace-packs/cos-acquire.mjs";

const root = resolve(import.meta.dirname, "..");
const base = join(root, ".tmp/codex/cos-integration"), installRoot = join(root, "packs/cos");
const work = join(base, `preset-cancel-${randomUUID()}`), builder = join(work, "builder");
await mkdir(work, { recursive: true });
const before = new Set(await readdir(base));
const beforeVersions = new Set(await readdir(join(installRoot, "versions")));
const controller = new AbortController(), logs = [];
let timer;
const result = { checkedAt: new Date().toISOString(), passed: false, phases: [] };
try {
  await prepareCosBuilder(root, builder);
  const path = join(builder, "integrations/cos/upstream.json");
  const upstream = JSON.parse(await readFile(path, "utf8"));
  upstream.adapterVersion += `-cancel-${randomUUID().slice(0, 8)}`;
  await writeFile(path, JSON.stringify(upstream));
  await assert.rejects(acquireCosPreset({
    builderRoot: builder, installRoot, workRoot: base, signal: controller.signal, onLog: text => logs.push(text),
    onProgress: progress => {
      if (!result.phases.includes(progress.phase)) { result.phases.push(progress.phase); console.log(progress.phase); }
      if (progress.phase === "build") timer = setTimeout(() => controller.abort(new Error("Preset build cancellation fixture")), 250);
    },
  }), /Preset build cancellation fixture/);
  assert.ok(result.phases.includes("build"), "Cancellation must reach the real build process");
  assert.deepEqual(new Set(await readdir(join(installRoot, "versions"))), beforeVersions);
  assert.deepEqual(new Set(await readdir(base)), before);
  result.noVersionPublished = true;
  result.ownedStagingRemoved = true;
  result.passed = true;
} catch (error) {
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  const evidence = join(root, "docs/cos-workspace-pack/evidence");
  await writeFile(join(evidence, "cos-preset-cancel-build.txt"), logs.join(""));
  await rm(work, { recursive: true, force: true });
  result.testDirectoryRemoved = true;
  await writeFile(join(evidence, "cos-preset-cancel-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
