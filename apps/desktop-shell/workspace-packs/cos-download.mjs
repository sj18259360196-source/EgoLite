import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import { archivePath } from "./cos-archive.mjs";

export async function downloadCosFile(url, path, {
  sha256, signal, onProgress = () => {}, maxBytes = 2 * 1024 ** 3, fetchImpl = fetch,
} = {}) {
  if (new URL(url).protocol !== "https:") throw new Error("CoS downloads require HTTPS");
  const response = await fetchImpl(url, { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(600000)]) });
  if (!response.ok || !response.body) throw new Error(`CoS download failed (${response.status})`);
  if (response.url && new URL(response.url).protocol !== "https:") throw new Error("CoS download redirected outside HTTPS");
  const total = Number(response.headers.get("content-length")) || undefined;
  if (total > maxBytes) { await response.body.cancel(); throw new Error("CoS download exceeds size limit"); }
  await mkdir(dirname(path), { recursive: true });
  let received = 0, lastProgress = 0;
  const hash = createHash("sha256");
  const output = createWriteStream(path, { flags: "wx" });
  let created = false;
  output.once("open", () => { created = true; });
  try {
    await pipeline(response.body, new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) { callback(new Error("CoS download exceeds size limit")); return; }
        hash.update(chunk);
        if (Date.now() - lastProgress >= 250) { lastProgress = Date.now(); onProgress({ received, total }); }
        callback(null, chunk);
      },
    }), output, { signal });
    const digest = hash.digest("hex");
    if (sha256 && digest !== sha256.toLowerCase()) throw new Error("CoS download checksum mismatch");
    onProgress({ received, total });
    return { sha256: digest, bytes: received };
  } catch (error) {
    if (created) await rm(path, { force: true });
    throw error;
  }
}

export async function extractCosSource(archive, directory, prefix, {
  signal, maxBytes = 4 * 1024 ** 3, maxEntries = 150000,
} = {}) {
  if (!prefix || prefix.includes("/") || prefix.includes("\\")) throw new Error("Invalid CoS archive prefix");
  const zip = await yauzl.openPromise(archive, { strictFileNames: true, validateEntrySizes: true });
  let bytes = 0, count = 0;
  const names = new Set();
  try {
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      if (++count > maxEntries || !Number.isSafeInteger(entry.uncompressedSize)
        || (bytes += entry.uncompressedSize) > maxBytes) throw new Error("CoS source archive exceeds size limit");
      if (entry.fileName === `${prefix}/`) continue;
      if (!entry.fileName.startsWith(`${prefix}/`)) throw new Error("Unexpected CoS archive root");
      const name = entry.fileName.slice(prefix.length + 1);
      const target = archivePath(directory, name);
      const key = name.replace(/\/$/, "").toLowerCase();
      if (names.has(key)) throw new Error("Duplicate CoS source archive path");
      names.add(key);
      const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (fileType && ![0x8000, 0x4000].includes(fileType)) throw new Error("CoS source archive contains a link");
      if (name.endsWith("/")) { await mkdir(target, { recursive: true }); continue; }
      await mkdir(dirname(target), { recursive: true });
      let checksum = 0;
      const verify = new Transform({
        transform(chunk, _encoding, callback) { checksum = crc32(chunk, checksum); callback(null, chunk); },
      });
      await pipeline(await zip.openReadStreamPromise(entry), verify, createWriteStream(target, { flags: "wx" }), { signal });
      if (checksum !== entry.crc32) throw new Error("CoS source file checksum mismatch");
    }
  } finally { zip.close(); }
  if (!count || !names.size) throw new Error("CoS source archive is empty");
  return { files: names.size, bytes };
}

export async function publishCosDirectory(source, destination, { signal, move = rename } = {}) {
  const attempt = async (from, to) => {
    const delays = [25, 100, 250];
    for (let index = 0; ; index++) {
      signal?.throwIfAborted();
      try { await move(from, to); return; }
      catch (error) {
        if (!["EACCES", "EBUSY", "EPERM"].includes(error.code) || index >= delays.length) throw error;
        await new Promise(resolve => setTimeout(resolve, delays[index]));
      }
    }
  };
  try { await attempt(source, destination); return; }
  catch (error) { if (error.code !== "EXDEV") throw error; }
  // Publish from a staging directory on the destination volume; callers own source cleanup.
  const parent = dirname(resolve(destination));
  const staging = join(parent, `.cos-publish-${randomUUID()}`);
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
    signal?.throwIfAborted();
    await attempt(staging, destination);
  } finally {
    if (dirname(resolve(staging)) !== parent) throw new Error("Invalid CoS publication staging directory");
    await rm(staging, { recursive: true, force: true });
  }
}
