import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareCosBuilder } from "./prepare-cos-builder.mjs";
import { acquireCosPreset } from "../apps/desktop-shell/workspace-packs/cos-acquire.mjs";
import { CosRuntime } from "../apps/desktop-shell/workspace-packs/cos-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const base = join(root, ".tmp/codex/cos-integration");
const work = join(base, `preset-smoke-${randomUUID()}`);
const builder = join(work, "builder"), installRoot = join(root, "packs/cos");
const evidence = join(root, "docs/cos-workspace-pack/evidence");
const beforePath = process.env.PATH, beforeNodePath = process.env.NODE_PATH;
const result = { checkedAt: new Date().toISOString(), passed: false, phases: [] };
const logs = [];
let runtime;
await mkdir(work, { recursive: true });
try {
  await prepareCosBuilder(root, builder);
  assert.equal((await readdir(builder)).includes("node_modules"), false);
  assert.equal((await readdir(builder)).includes("packs"), false);
  process.env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
  delete process.env.NODE_PATH;
  const candidate = await acquireCosPreset({
    builderRoot: builder, installRoot, workRoot: base, onLog: text => logs.push(text),
    onProgress: progress => {
      if (!result.phases.includes(progress.phase)) { result.phases.push(progress.phase); console.log(progress.phase); }
    },
  });
  result.candidate = candidate;
  assert.ok(result.phases.includes("source"));
  result.independentBuilderWithoutGlobalGitNodeOrNpm = true;
  runtime = new CosRuntime({ directory: candidate.directory, dataDirectory: join(work, "state"), probeOnly: true });
  await runtime.start();
  const state = await runtime.invoke("state:get");
  assert.equal(state.ok, true, state.error);
  assert.equal(state.data.bridge.running, false);
  assert.equal((await runtime.invoke("ego:execution-status")).mode, "probe");
  const receipt = JSON.parse(await readFile(join(candidate.directory, "source-download.json"), "utf8"));
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  result.sourceDownload = receipt;
  result.realPackageStartsInProbeMode = true;
  result.passed = true;
} catch (error) {
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  process.env.PATH = beforePath;
  if (beforeNodePath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = beforeNodePath;
  await runtime?.stop();
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, "cos-preset-build.txt"), logs.join(""));
  await rm(work, { recursive: true, force: true });
  result.testDirectoryRemoved = true;
  await writeFile(join(evidence, "cos-preset-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
