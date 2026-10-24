import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";

// Electron must treat bundled .asar files as opaque bytes during installation.
const rawFs = createRequire(import.meta.url)(process.versions.electron ? "original-fs" : "node:fs");
const { createReadStream, createWriteStream } = rawFs;
const { mkdir, readFile, realpath, rename, rm, stat } = rawFs.promises;

export async function readCosPack(directory) {
  const root = await realpath(directory);
  const manifestPath = join(root, "manifest.json");
  let manifestInfo;
  try { manifestInfo = await stat(manifestPath); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("包内缺少 manifest.json，请载入已适配的 CoS 包");
    throw error;
  }
  if (!manifestInfo.isFile() || manifestInfo.size > 1024 * 1024) throw new Error("CoS 功能包清单无效");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.id !== "cos" || manifest.schemaVersion !== 1 || manifest.hostApiVersion !== 1
    || manifest.ipcEncoding !== "cos-json-v1") throw new Error("不支持的 CoS 功能包，请使用已适配版本");
  if (typeof manifest.packVersion !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(manifest.packVersion)) {
    throw new Error("CoS 功能包版本无效");
  }
  if (manifest.platform && manifest.platform !== process.platform
    || manifest.arch && manifest.arch !== process.arch) throw new Error("CoS 功能包不适用于当前系统");
  for (const key of ["main", "renderer", "preload", "companion", "electron"]) {
    const entry = manifest.entries?.[key];
    if (typeof entry !== "string" || !entry || isAbsolute(entry)) throw new Error(`CoS 缺少运行入口 ${key}`);
    const candidate = resolve(root, entry);
    const inside = relative(root, candidate);
    if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("CoS 运行入口越出包目录");
    const actual = await realpath(candidate);
    const realInside = relative(root, actual);
    if (realInside.startsWith("..") || isAbsolute(realInside) || !(await stat(actual)).isFile()) {
      throw new Error("CoS 运行入口无效");
    }
  }
  const source = JSON.parse(await readFile(join(root, "source/package.json"), "utf8"));
  if (source.name !== "chat-on-steroids" || source.version !== manifest.upstreamVersion) {
    throw new Error("CoS 源码版本与功能包不一致");
  }
  return manifest;
}

export function archivePath(root, name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.startsWith("/")) throw new Error("功能包路径无效");
  const parts = name.replace(/\/$/, "").split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error("功能包包含不安全路径");
  }
  const target = resolve(root, ...parts);
  const inside = relative(root, target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("功能包路径越界");
  return target;
}

export async function installCosArchive(archive, installRoot, {
  maxBytes = 16 * 1024 ** 3, maxEntries = 250000, renameDirectory = rename,
} = {}) {
  const root = resolve(installRoot);
  await mkdir(root, { recursive: true });
  const staging = join(root, `.install-${randomUUID()}`);
  await mkdir(staging);
  let zip;
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const digest = hash.digest("hex");
    zip = await yauzl.openPromise(archive, { strictFileNames: true, validateEntrySizes: true });
    let total = 0;
    let count = 0;
    const names = new Set();
    for await (const entry of zip.eachEntry()) {
      if (++count > maxEntries || !Number.isSafeInteger(entry.uncompressedSize)
        || (total += entry.uncompressedSize) > maxBytes) throw new Error("CoS 功能包超过解包容量限制");
      const target = archivePath(staging, entry.fileName);
      const key = relative(staging, target).toLowerCase();
      if (names.has(key)) throw new Error("CoS 功能包包含重复路径");
      names.add(key);
      const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (fileType && fileType !== 0x8000 && fileType !== 0x4000) throw new Error("CoS 功能包不接受链接或特殊文件");
      if (entry.fileName.endsWith("/")) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      let checksum = 0;
      const verify = new Transform({
        transform(chunk, _encoding, callback) { checksum = crc32(chunk, checksum); callback(null, chunk); },
      });
      const stream = await zip.openReadStreamPromise(entry);
      await pipeline(stream, verify, createWriteStream(target, { flags: "wx" }));
      if (checksum !== entry.crc32) throw new Error("CoS 功能包文件校验失败");
    }
    const manifest = await readCosPack(staging);
    const destination = join(root, "versions", `${manifest.packVersion}-${digest.slice(0, 16)}`);
    await mkdir(dirname(destination), { recursive: true });
    let exists = false;
    try { await stat(destination); exists = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (exists) {
      await readCosPack(destination);
    } else {
      // Windows may briefly hold newly extracted files after stream close.
      const delays = [25, 100, 250];
      for (let attempt = 0; ; attempt++) {
        try { await renameDirectory(staging, destination); break; }
        catch (error) {
          if (!["EACCES", "EBUSY", "EPERM"].includes(error.code) || attempt >= delays.length) throw error;
          await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        }
      }
    }
    return { directory: destination, manifest, sha256: digest, reused: exists };
  } finally {
    zip?.close();
    // Only the random staging directory created by this invocation is removed.
    if (dirname(staging) !== root || !staging.startsWith(join(root, ".install-"))) throw new Error("Invalid CoS staging directory");
    await rm(staging, { recursive: true, force: true });
  }
}
