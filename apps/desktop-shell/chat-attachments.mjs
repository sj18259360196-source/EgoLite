import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { nativeImage } from "electron";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_EDGE = 2048;

const IMAGE_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
]);

const TEXT_MIME = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".cjs", "text/javascript"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".jsx", "text/javascript"],
  [".css", "text/css"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".py", "text/x-python"],
  [".java", "text/x-java-source"],
  [".cs", "text/x-csharp"],
  [".cpp", "text/x-c++src"],
  [".c", "text/x-csrc"],
  [".h", "text/x-chdr"],
  [".sql", "application/sql"],
  [".log", "text/plain"],
]);

export class ChatAttachmentStore {
  constructor(rootPath) {
    this.rootPath = rootPath;
  }

  ingestPaths(taskId, paths) {
    if (!Array.isArray(paths) || paths.length > MAX_ATTACHMENTS) throw new Error(`一次最多添加 ${MAX_ATTACHMENTS} 个附件`);
    return paths.map((path) => this.#ingestPath(taskId, path));
  }

  saveNativeImage(taskId, image, name, source) {
    if (!image || image.isEmpty()) throw new Error("没有可用的图片");
    const size = image.getSize();
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(size.width, size.height));
    const normalized = scale < 1
      ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "good" })
      : image;
    const mimeType = "image/png";
    const buffer = normalized.toPNG();
    if (buffer.length > MAX_FILE_BYTES) throw new Error("图片转码后仍超过 8 MB");
    const thumbnail = normalized.resize({ width: 96, height: 96, quality: "good" }).toPNG();
    return this.#save({
      taskId,
      kind: "image",
      name,
      mimeType,
      size: buffer.length,
      source,
      dataBase64: buffer.toString("base64"),
      previewDataUrl: `data:image/png;base64,${thumbnail.toString("base64")}`,
    });
  }

  resolve(taskId, attachments) {
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) throw new Error(`一次最多发送 ${MAX_ATTACHMENTS} 个附件`);
    let totalBytes = 0;
    return attachments.map((attachment) => {
      const id = typeof attachment === "string" ? attachment : attachment?.id;
      if (typeof id !== "string" || !id) throw new Error("附件 ID 无效");
      const record = this.#load(id);
      if (record.taskId !== taskId) throw new Error("附件不属于当前 Task Space");
      totalBytes += record.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("附件总大小不能超过 20 MB");
      return record.kind === "image"
        ? { kind: "image", id, name: record.name, mimeType: record.mimeType, size: record.size, source: record.source, dataBase64: record.dataBase64 }
        : { kind: "text", id, name: record.name, mimeType: record.mimeType, size: record.size, source: record.source, text: record.text };
    });
  }

  #ingestPath(taskId, path) {
    const extension = extname(path).toLowerCase();
    const buffer = readFileSync(path);
    if (buffer.length > MAX_FILE_BYTES) throw new Error(`${basename(path)} 超过 8 MB`);
    if (IMAGE_MIME.has(extension)) {
      const image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) throw new Error(`${basename(path)} 不是有效图片`);
      return this.saveNativeImage(taskId, image, basename(path), "file");
    }
    const mimeType = TEXT_MIME.get(extension);
    if (!mimeType) throw new Error(`暂不支持 ${extension || "该类型"} 文件`);
    if (buffer.length > MAX_TEXT_BYTES) throw new Error(`${basename(path)} 超过 2 MB 文本限制`);
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    const nullBytes = sample.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
    if (sample.length && nullBytes / sample.length > 0.01) throw new Error(`${basename(path)} 看起来是二进制文件`);
    const text = buffer.toString("utf8");
    return this.#save({ taskId, kind: "text", name: basename(path), mimeType, size: buffer.length, source: "file", text });
  }

  #save(record) {
    mkdirSync(this.rootPath, { recursive: true });
    const id = `attachment-${randomUUID()}`;
    const saved = { version: 1, id, createdAt: new Date().toISOString(), ...record };
    const path = join(this.rootPath, `${id}.json`);
    const temporaryPath = `${path}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(saved), "utf8");
    renameSync(temporaryPath, path);
    return publicAttachment(saved);
  }

  #load(id) {
    const path = join(this.rootPath, `${id}.json`);
    if (!existsSync(path)) throw new Error(`附件已不存在：${id}`);
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (record?.id !== id || !["image", "text"].includes(record.kind)) throw new Error(`附件缓存损坏：${id}`);
    return record;
  }
}

function publicAttachment(record) {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    source: record.source,
    ...(record.previewDataUrl ? { previewDataUrl: record.previewDataUrl } : {}),
  };
}
