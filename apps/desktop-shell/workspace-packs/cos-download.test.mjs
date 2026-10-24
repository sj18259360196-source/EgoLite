import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { downloadCosFile, extractCosSource, publishCosDirectory } from "./cos-download.mjs";
import { CosWorkspace } from "./cos-workspace.mjs";

async function folder(t) {
  const base = resolve(".tmp/codex/cos-integration/unit");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const url = "https://example.test/preset.zip";
const fetchBytes = (text, headers) => async () => new Response(text, { headers });

test("CoS download verifies bytes and checksum without replacing an existing file", async t => {
  const root = await folder(t), path = join(root, "archive");
  const sha256 = createHash("sha256").update("fixture").digest("hex");
  const progress = [];
  assert.deepEqual(await downloadCosFile(url, path, {
    sha256, fetchImpl: fetchBytes("fixture"), onProgress: value => progress.push(value),
  }), { sha256, bytes: 7 });
  assert.equal(await readFile(path, "utf8"), "fixture");
  assert.equal(progress.at(-1).received, 7);
  await assert.rejects(downloadCosFile(url, path, { fetchImpl: fetchBytes("other") }), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), "fixture");
});

test("CoS download rejects insecure URLs, broken checksums and oversized responses", async t => {
  const path = join(await folder(t), "archive");
  await assert.rejects(downloadCosFile("http://example.test", path), /HTTPS/);
  for (const options of [{ sha256: "wrong" }, { maxBytes: 1 }]) {
    await assert.rejects(downloadCosFile(url, path, { fetchImpl: fetchBytes("fixture"), ...options }), /checksum|size/);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
  await assert.rejects(downloadCosFile(url, path, {
    maxBytes: 1, fetchImpl: fetchBytes("fixture", { "content-length": "7" }),
  }), /size/);
});

test("CoS download cancellation removes only its partial file", async t => {
  const path = join(await folder(t), "archive");
  const controller = new AbortController();
  await assert.rejects(downloadCosFile(url, path, {
    signal: controller.signal, fetchImpl: fetchBytes("fixture"),
    onProgress: () => controller.abort(),
  }), { name: "AbortError" });
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

async function zip(root, entries) {
  const archive = join(root, "source.zip"), output = new yazl.ZipFile();
  for (const [name, mode] of entries) output.addBuffer(Buffer.from("fixture"), name, { mode });
  const done = pipeline(output.outputStream, createWriteStream(archive));
  output.end();
  await done;
  return archive;
}

test("CoS source extraction accepts one expected root and rejects links or collisions", async t => {
  for (const [entries, error] of [
    [[["cos/source.js"]], null], [[["other/source.js"]], /archive root/],
    [[["cos/link", 0o120777]], /link/], [[["cos/A.js"], ["cos/a.js"]], /Duplicate/],
  ]) {
    const root = await folder(t), directory = join(root, "out");
    const archive = await zip(root, entries);
    if (error) await assert.rejects(extractCosSource(archive, directory, "cos"), error);
    else {
      assert.equal((await extractCosSource(archive, directory, "cos")).files, 1);
      assert.equal(await readFile(join(directory, "source.js"), "utf8"), "fixture");
    }
  }
});

test("CoS preset cancellation and shutdown retain previous registration and data", async t => {
  const root = await folder(t), registryPath = join(root, "registry.json"), dataDirectory = join(root, "data");
  await mkdir(dataDirectory);
  await writeFile(join(dataDirectory, "session.json"), '{"keep":true}');
  const previous = JSON.stringify({ enabled: false, directory: "previous", workspace: { taskId: "keep" } });
  await writeFile(registryPath, previous);
  let cancelled = false;
  const workspace = new CosWorkspace({
    registryPath, dataDirectory, installRoot: join(root, "packs"),
    acquirePreset: async ({ signal, onProgress }) => {
      onProgress({ phase: "build" });
      await new Promise((_, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }));
    },
  });
  const pending = workspace.installPreset();
  const rejected = assert.rejects(pending, /安装已取消/);
  assert.equal(workspace.acquiring, true);
  assert.equal(workspace.describe().acquisition.phase, "build");
  await assert.rejects(workspace.enable(), /安装完成/);
  await assert.rejects(workspace.installPreset(), /正在下载/);
  await workspace.shutdown();
  await rejected;
  assert.equal(cancelled, true);
  assert.equal(workspace.acquiring, false);
  assert.equal(workspace.describe().installing, false);
  assert.equal(await readFile(registryPath, "utf8"), previous);
  assert.equal(await readFile(join(dataDirectory, "session.json"), "utf8"), '{"keep":true}');
});

test("CoS publication stages a cross-volume copy before making the version visible", async t => {
  const root = await folder(t), source = join(root, "source"), destination = join(root, "published");
  await mkdir(source);
  await writeFile(join(source, "entry"), "fixture");
  let calls = 0;
  await publishCosDirectory(source, destination, {
    move: async (from, to) => {
      if (++calls === 1) throw Object.assign(new Error("cross volume"), { code: "EXDEV" });
      assert.equal(await readFile(join(from, "entry"), "utf8"), "fixture");
      await rename(from, to);
    },
  });
  assert.equal(calls, 2);
  assert.equal(await readFile(join(destination, "entry"), "utf8"), "fixture");
  assert.deepEqual((await readdir(root)).sort(), ["published", "source"]);
});
