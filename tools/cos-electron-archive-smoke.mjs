import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, readFile, rm, rmdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import electron from "electron";

const root = resolve(import.meta.dirname, "..");
const [modulePath, archivePath] = process.argv.slice(2);
assert.ok(modulePath && archivePath, "Expected installer module and egopack paths");
const base = join(root, ".tmp/codex/cos-asar-fix-smoke");
await mkdir(base, { recursive: true });
const work = await mkdtemp(join(base, "run-"));
const result = { checkedAt: new Date().toISOString(), passed: false };
try {
  const script = join(work, "install.mjs");
  await writeFile(script, `import { app } from 'electron';
import { createRequire } from 'node:module';
import { installCosArchive } from ${JSON.stringify(pathToFileURL(resolve(modulePath)).href)};
const fs = createRequire(import.meta.url)('original-fs');
try {
  const result = await installCosArchive(${JSON.stringify(resolve(archivePath))}, ${JSON.stringify(join(work, "packs"))});
  const file = result.directory + '/source/node_modules/electron/dist/resources/default_app.asar';
  if (!fs.statSync(file).isFile() || fs.readFileSync(file).length === 0) throw Error('ASAR missing');
  fs.writeFileSync(${JSON.stringify(join(work, "result.json"))}, JSON.stringify({ sha256: result.sha256, version: result.manifest.packVersion, electron: process.versions.electron }));
  app.exit(0);
} catch (error) { console.error(error.stack); app.exit(1); }
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await promisify(execFile)(electron, [script, `--user-data-dir=${join(work, "profile")}`], {
    cwd: work, env, windowsHide: true, timeout: 240000, maxBuffer: 1024 * 1024,
  });
  Object.assign(result, JSON.parse(await readFile(join(work, "result.json"), "utf8")), { passed: true });
} catch (error) {
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rmdir(base).catch(error => { if (error.code !== "ENOTEMPTY") throw error; });
  await writeFile(join(root, "docs/cos-workspace-pack/evidence/cos-electron-archive-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
