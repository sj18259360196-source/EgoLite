import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const sevenZip = process.env.EGO_SEVEN_ZIP || join(root, `node_modules/electron-winstaller/vendor/7z-${process.arch}.exe`);
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
  await run(sevenZip, ["x", join(work, "app-64.7z"), "resources/runtime/scansci/*", `-o${work}`, "-y"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const manifest = async directory => {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort();
    const hashes = [];
    for (const file of files) hashes.push([file.replaceAll("\\", "/"), await hash(join(directory, file))]);
    return hashes;
  };
  const scanSciFiles = await manifest(join(work, "resources/runtime/scansci"));
  assert.ok(scanSciFiles.length > 100, "Installer ScanSci runtime is missing");
  assert.deepEqual(scanSciFiles, await manifest(join(dirname(expectedArchive), "runtime/scansci")), "Installer must contain the complete tested ScanSci runtime");
  const scanSci = { files: scanSciFiles.length, sha256: createHash("sha256").update(JSON.stringify(scanSciFiles)).digest("hex"), bundle: JSON.parse(await readFile(join(work, "resources/runtime/scansci/bundle-info.json"), "utf8")) };
  const result = { passed: true, checkedAt: new Date().toISOString(), installer,
    installerSha256: await hash(installer), testedArchive: expectedArchive, appAsarSha256: actual,
    dependencyAudit: true, componentFiles, scanSci, installed: false };
  if (evidence) await writeFile(evidence, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { await rm(work, { recursive: true, force: true }); }
