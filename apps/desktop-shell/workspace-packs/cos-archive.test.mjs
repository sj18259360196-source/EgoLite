import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import electron from "electron";
import { archivePath, installCosArchive } from "./cos-archive.mjs";
import { CosWorkspace } from "./cos-workspace.mjs";

async function fixture(t, extra = [], manifestPatch = {}) {
  const base = resolve(".tmp/codex/cos-integration/unit");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = {
    schemaVersion: 1, id: "cos", hostApiVersion: 1, ipcEncoding: "cos-json-v1",
    packVersion: "2.1.20-test", upstreamVersion: "2.1.20",
    entries: { main: "source/main.js", renderer: "source/index.html", preload: "source/preload.js", companion: "source/worker.mjs", electron: "source/electron.exe" },
    ...manifestPatch,
  };
  const files = [
    ["manifest.json", JSON.stringify(manifest)],
    ["source/package.json", JSON.stringify({ name: "chat-on-steroids", version: "2.1.20" })],
    ...Object.values(manifest.entries).filter(entry => !entry.startsWith("missing")).map(entry => [entry, "fixture"]),
    ...extra,
  ];
  const archive = join(root, "test.egopack");
  const zip = new yazl.ZipFile();
  for (const [name, value, options] of files) zip.addBuffer(Buffer.from(value), name, { compress: false, ...options });
  const done = pipeline(zip.outputStream, createWriteStream(archive));
  zip.end();
  await done;
  return { root, archive, manifest, installRoot: join(root, "packs") };
}

test("CoS archive installs in a version directory and reuses identical imports", async t => {
  const { archive, installRoot } = await fixture(t);
  const first = await installCosArchive(archive, installRoot);
  assert.ok(first.directory.startsWith(join(installRoot, "versions")));
  assert.equal(await readFile(join(first.directory, "source/main.js"), "utf8"), "fixture");
  const again = await installCosArchive(archive, installRoot);
  assert.equal(again.directory, first.directory);
  assert.equal(again.reused, true);
  assert.deepEqual(await readdir(installRoot), ["versions"]);
});

test("Electron installs nested ASAR files as opaque bytes", async t => {
  const name = "source/node_modules/electron/dist/resources/default_app.asar";
  const { root, archive, installRoot } = await fixture(t, [[name, "opaque archive bytes"]]);
  const script = join(root, "electron-install.mjs");
  const moduleUrl = new URL("./cos-archive.mjs", import.meta.url).href;
  await writeFile(script, `import { app } from 'electron';
import { installCosArchive } from ${JSON.stringify(moduleUrl)};
try { await installCosArchive(${JSON.stringify(archive)}, ${JSON.stringify(installRoot)}); app.exit(0); }
catch (error) { console.error(error.stack); app.exit(1); }`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await promisify(execFile)(electron, [script, `--user-data-dir=${join(root, "profile")}`], {
    env, windowsHide: true, timeout: 60000,
  });
  const [version] = await readdir(join(installRoot, "versions"));
  assert.equal(await readFile(join(installRoot, "versions", version, name), "utf8"), "opaque archive bytes");
  assert.deepEqual(await readdir(installRoot), ["versions"]);
});

test("CoS archive refuses path traversal and Windows aliases", () => {
  for (const name of ["../other", "/other", "C:/other", "a\\b", "a/../b", "a/./b", "a//b", "a.", "a ", "a:stream", "CON.txt"]) {
    assert.throws(() => archivePath(resolve("packs"), name), /路径/);
  }
});

test("CoS archive retries transient promotion locks without extracting again", async t => {
  const { archive, installRoot } = await fixture(t);
  let attempts = 0;
  const paths = [];
  const installed = await installCosArchive(archive, installRoot, {
    renameDirectory: async (from, to) => {
      paths.push([from, to]);
      if (++attempts < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
      await rename(from, to);
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(paths[0], paths[2]);
  assert.equal(await readFile(join(installed.directory, "source/main.js"), "utf8"), "fixture");
  assert.deepEqual(await readdir(installRoot), ["versions"]);
});

test("CoS archive promotion stops retrying permanent locks and unrelated errors", async t => {
  for (const [code, expectedAttempts] of [["EPERM", 4], ["ENOENT", 1]]) {
    const { archive, installRoot } = await fixture(t);
    let attempts = 0;
    await assert.rejects(installCosArchive(archive, installRoot, {
      renameDirectory: async () => { attempts++; throw Object.assign(new Error(code), { code }); },
    }), { code });
    assert.equal(attempts, expectedAttempts);
    assert.deepEqual(await readdir(installRoot), ["versions"]);
    assert.deepEqual(await readdir(join(installRoot, "versions")), []);
  }
});

test("CoS archive rejects case-insensitive collisions and symbolic links", async t => {
  for (const extra of [[["MANIFEST.JSON", "{}"]], [["source/link", "other", { mode: 0o120777 }]]]) {
    const { archive, installRoot } = await fixture(t, extra);
    await assert.rejects(installCosArchive(archive, installRoot), /重复路径|链接/);
    assert.deepEqual(await readdir(installRoot), []);
  }
});

test("CoS archive checks actual CRC, size limits and required entries", async t => {
  const crc = await fixture(t);
  const bytes = await readFile(crc.archive);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE((bytes.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
  await writeFile(crc.archive, bytes);
  await assert.rejects(installCosArchive(crc.archive, crc.installRoot), /校验失败/);
  const sized = await fixture(t);
  await assert.rejects(installCosArchive(sized.archive, sized.installRoot, { maxBytes: 10 }), /容量/);
  const missing = await fixture(t, [], { entries: { electron: "missing.exe" } });
  await assert.rejects(installCosArchive(missing.archive, missing.installRoot), /运行入口/);
});

test("CoS failed install retains registry and data while successful install stays disabled", async t => {
  const { root, archive, installRoot } = await fixture(t);
  const registryPath = join(root, "registry.json");
  await writeFile(registryPath, JSON.stringify({ enabled: false, directory: "previous-version", workspace: { taskId: "keep" } }));
  const dataDirectory = join(root, "data");
  await mkdir(dataDirectory);
  await writeFile(join(dataDirectory, "session.json"), '{"keep":true}');
  const workspace = new CosWorkspace({ registryPath, dataDirectory, installRoot });
  const before = await readFile(registryPath, "utf8");
  await assert.rejects(workspace.install(join(root, "absent.zip")), /ENOENT/);
  assert.equal(await readFile(registryPath, "utf8"), before);
  assert.equal(workspace.describe().installing, false);
  const installed = await workspace.install(archive);
  assert.equal(installed.enabled, false);
  assert.equal(installed.installing, false);
  assert.equal(installed.workspace.taskId, "keep");
  assert.equal(JSON.parse(await readFile(registryPath, "utf8")).previousDirectory, "previous-version");
  assert.equal(await readFile(join(dataDirectory, "session.json"), "utf8"), '{"keep":true}');
});

test("CoS archive installer bundles for the dependency-free desktop shell", async t => {
  const { root, archive, installRoot } = await fixture(t);
  const output = join(root, "bundled-installer.mjs");
  await build({
    entryPoints: [resolve("apps/desktop-shell/workspace-packs/cos-archive.mjs")], outfile: output,
    bundle: true, platform: "node", target: "node24", format: "esm",
    banner: { js: 'import { createRequire as __egoCreateRequire } from "node:module"; const require = __egoCreateRequire(import.meta.url);' },
  });
  const bundled = await import(pathToFileURL(output).href);
  const installed = await bundled.installCosArchive(archive, installRoot);
  assert.equal(installed.manifest.packVersion, "2.1.20-test");
});
