import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export function normalizeBrowserExtensionPath(inputPath) {
  const path = resolve(String(inputPath || ""));
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error("扩展目录不存在或不是文件夹");
  const manifestPath = join(path, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("扩展目录中没有 manifest.json");
  return realpathSync(path);
}

export function hashBrowserExtensionArchive(inputPath) {
  const path = resolve(String(inputPath || ""));
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error("ZIP 扩展包不存在");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readBrowserExtensionManifest(inputPath) {
  const path = normalizeBrowserExtensionPath(inputPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
  } catch (error) {
    throw new Error(`无法读取扩展清单：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("扩展清单格式无效");
  const manifestVersion = Number(manifest.manifest_version);
  if (![2, 3].includes(manifestVersion)) throw new Error("仅支持 Manifest V2 或 V3 扩展");
  const name = typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : basename(path);
  const version = typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : "未知版本";
  return {
    path,
    name: name.slice(0, 200),
    version: version.slice(0, 80),
    description: typeof manifest.description === "string" ? manifest.description.slice(0, 500) : "",
    manifestVersion,
    manifest,
  };
}

export function createBrowserExtensionRecord(inputPath, previous = {}) {
  const manifest = readBrowserExtensionManifest(inputPath);
  const id = typeof previous.id === "string" && previous.id
    ? previous.id
    : `local-${createHash("sha256").update(manifest.path).digest("hex").slice(0, 24)}`;
  return {
    id,
    path: manifest.path,
    sourceType: previous.sourceType === "zip" ? "zip" : "directory",
    sourceHash: typeof previous.sourceHash === "string" ? previous.sourceHash : "",
    sourcePath: typeof previous.sourcePath === "string" ? previous.sourcePath : manifest.path,
    managedPath: typeof previous.managedPath === "string" ? previous.managedPath : "",
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    manifestVersion: manifest.manifestVersion,
    enabled: previous.enabled !== false,
    pinned: previous.pinned !== false,
    error: "",
  };
}

export function publicBrowserExtension(record, runtime = {}) {
  return {
    id: record.id,
    name: record.name,
    version: record.version,
    description: record.description || "",
    manifestVersion: record.manifestVersion,
    sourceType: ["zip", "browser-profile", "repository"].includes(record.sourceType) ? record.sourceType : "directory",
    path: record.path,
    enabled: record.enabled === true,
    pinned: record.pinned === true,
    loaded: runtime.loaded === true,
    ready: runtime.ready === true,
    extensionId: runtime.extensionId || "",
    compatibilityLevel: runtime.compatibilityLevel || "native",
    compatibilityLabel: runtime.compatibilityLabel || "",
    compatibilityDetail: runtime.compatibilityDetail || "",
    unsupportedPermissions: Array.isArray(runtime.unsupportedPermissions) ? runtime.unsupportedPermissions : [],
    requiredCapabilities: Array.isArray(runtime.requiredCapabilities) ? runtime.requiredCapabilities : [],
    missingCapabilities: Array.isArray(runtime.missingCapabilities) ? runtime.missingCapabilities : [],
    runtimeCapabilities: runtime.runtimeCapabilities && typeof runtime.runtimeCapabilities === "object"
      ? runtime.runtimeCapabilities
      : {},
    diagnostics: Array.isArray(runtime.diagnostics) ? runtime.diagnostics : [],
    runtimeAdapted: runtime.runtimeAdapted === true,
    actionAvailable: runtime.actionAvailable === true,
    optionsAvailable: runtime.optionsAvailable === true,
    iconDataUrl: runtime.iconDataUrl || "",
    error: record.error || "",
  };
}
