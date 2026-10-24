import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { validateDesktopArchive } from "./validate-desktop-package.mjs";

const root = resolve(import.meta.dirname, "..");
const installer = resolve(process.argv[2]);
const expectedArchive = resolve(process.argv[3]);
const evidence = process.argv[4] && resolve(process.argv[4]);
const parent = join(root, ".tmp/codex/desktop-installer-verification");
await mkdir(parent, { recursive: true });
const work = await mkdtemp(join(parent, "run-"));
const run = promisify(execFile);
const sevenZip = join(root, "node_modules/electron-winstaller/vendor/7z.exe");
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
try {
  await run(sevenZip, ["e", installer, "$PLUGINSDIR\\app-64.7z", `-o${work}`, "-y"], { windowsHide: true });
  await run(sevenZip, ["e", join(work, "app-64.7z"), "resources\\app.asar", `-o${work}`, "-y"], { windowsHide: true });
  const archive = join(work, "app.asar");
  const actual = await hash(archive);
  assert.equal(actual, await hash(expectedArchive), "Installer must contain the tested desktop archive");
  await validateDesktopArchive(archive, work);
  const componentFiles = {};
  for (const file of ["components/cos/manifest.json", "components/cos/source/out/main/index.js"]) {
    await run(sevenZip, ["e", join(work, "app-64.7z"), `resources/${file}`, `-o${work}`, "-y"], { windowsHide: true });
    const digest = await hash(join(work, basename(file)));
    assert.equal(digest, await hash(join(dirname(expectedArchive), file)), `Installer component differs: ${file}`);
    componentFiles[file] = digest;
  }
  const result = { passed: true, checkedAt: new Date().toISOString(), installer,
    installerSha256: await hash(installer), testedArchive: expectedArchive, appAsarSha256: actual,
    dependencyAudit: true, componentFiles, installed: false };
  if (evidence) await writeFile(evidence, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { await rm(work, { recursive: true, force: true }); }
