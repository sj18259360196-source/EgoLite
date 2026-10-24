import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000;

export function discoverBrowserProfiles(localAppData = process.env.LOCALAPPDATA || "") {
  const browsers = [
    { id: "edge", name: "Microsoft Edge", root: join(localAppData, "Microsoft", "Edge", "User Data") },
    { id: "chrome", name: "Google Chrome", root: join(localAppData, "Google", "Chrome", "User Data") },
    { id: "brave", name: "Brave", root: join(localAppData, "BraveSoftware", "Brave-Browser", "User Data") },
  ];
  const profiles = [];
  for (const browser of browsers) {
    if (!existsSync(browser.root)) continue;
    const localState = readJson(join(browser.root, "Local State"));
    const infoCache = localState?.profile?.info_cache || {};
    const directories = new Set(Object.keys(infoCache));
    for (const entry of safeDirectories(browser.root)) {
      if (entry === "Default" || /^Profile \d+$/.test(entry)) directories.add(entry);
    }
    for (const directory of directories) {
      const path = join(browser.root, directory);
      const bookmarks = existsSync(join(path, "Bookmarks"));
      const history = existsSync(join(path, "History"));
      const extensions = existsSync(join(path, "Extensions"));
      if (!bookmarks && !history && !extensions) continue;
      const cached = infoCache[directory] || {};
      profiles.push({
        id: `${browser.id}:${directory}`,
        browserId: browser.id,
        browserName: browser.name,
        profileId: directory,
        profileName: String(cached.name || (directory === "Default" ? "Default" : directory)),
        path,
        bookmarks,
        history,
        extensions,
      });
    }
  }
  return profiles;
}

export function discoverBrowserExtensions(profile) {
  const root = String(profile?.path || "");
  const extensionsRoot = join(root, "Extensions");
  if (!existsSync(extensionsRoot)) return [];
  const result = [];
  for (const extensionEntry of safeDirectories(extensionsRoot)) {
    const extensionRoot = join(extensionsRoot, extensionEntry);
    for (const version of safeDirectories(extensionRoot).sort().reverse()) {
      const path = join(extensionRoot, version);
      const manifest = readJson(join(path, "manifest.json"));
      if (!manifest || ![2, 3].includes(Number(manifest.manifest_version))) continue;
      result.push({
        id: `${profile.id}:${extensionEntry}`,
        extensionId: extensionEntry,
        browserId: profile.browserId,
        browserName: profile.browserName,
        profileId: profile.profileId,
        profileName: profile.profileName,
        path,
        name: String(manifest.name || extensionEntry).slice(0, 200),
        version: String(manifest.version || version).slice(0, 80),
        description: typeof manifest.description === "string" ? manifest.description.slice(0, 500) : "",
        manifestVersion: Number(manifest.manifest_version),
        permissions: [...new Set([...(Array.isArray(manifest.permissions) ? manifest.permissions : []), ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [])])].slice(0, 40),
      });
      break;
    }
  }
  return result;
}

export function importBrowserProfile(profile, options = {}) {
  const entries = [];
  const historyEntries = [];
  const errors = [];
  if (options.bookmarks !== false && profile.bookmarks) {
    try {
      entries.push(...readBookmarks(profile, options.bookmarkLimit ?? 5_000));
    } catch (error) {
      errors.push(`书签：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (options.history !== false && profile.history) {
    try {
      historyEntries.push(...readHistory(profile, options.historyLimit ?? 500));
    } catch (error) {
      errors.push(`历史：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const uniqueBookmarks = new Map();
  for (const entry of entries) uniqueBookmarks.set(String(entry.sourceUrl || "").toLocaleLowerCase(), entry);
  const uniqueHistory = new Map();
  for (const entry of historyEntries) uniqueHistory.set(String(entry.url || "").toLocaleLowerCase(), entry);
  return { entries: [...uniqueBookmarks.values()], historyEntries: [...uniqueHistory.values()], errors };
}

function readBookmarks(profile, limit) {
  const value = readJson(join(profile.path, "Bookmarks"));
  if (!value?.roots) return [];
  const entries = [];
  const visit = (node, folders) => {
    if (entries.length >= limit || !node) return;
    if (node.type === "url" && isWebUrl(node.url)) {
      const title = String(node.name || node.url).slice(0, 20_000);
      const folder = folders.join(" / ").slice(0, 120);
      entries.push({
        text: title,
        sourceUrl: String(node.url).slice(0, 20_000),
        pageTitle: title.slice(0, 2_000),
        ...(folder ? { group: folder } : {}),
        ...(chromiumTime(node.date_added) ? { createdAt: chromiumTime(node.date_added) } : {}),
      });
      return;
    }
    const nextFolders = node.name && !["Bookmarks bar", "Other bookmarks", "Mobile bookmarks"].includes(node.name)
      ? [...folders, String(node.name)]
      : folders;
    for (const child of node.children || []) visit(child, nextFolders);
  };
  for (const [rootName, rootNode] of Object.entries(value.roots)) {
    if (rootName === "meta_info") continue;
    visit(rootNode, [rootLabel(rootName)]);
  }
  return entries;
}

function readHistory(profile, limit) {
  const directory = mkdtempSync(join(tmpdir(), "ego-browser-history-"));
  const copied = join(directory, "History");
  let database;
  try {
    copyFileSync(join(profile.path, "History"), copied);
    database = new DatabaseSync(copied, { readOnly: true });
    const statement = database.prepare(`
      SELECT url, title, visit_count, last_visit_time
      FROM urls
      WHERE url LIKE 'http://%' OR url LIKE 'https://%'
      ORDER BY last_visit_time DESC
      LIMIT ?
    `);
    statement.setReadBigInts(true);
    const rows = statement.all(BigInt(Math.max(0, Math.min(Number(limit) || 500, 2_000))));
    return rows.flatMap((row) => {
      const url = String(row.url || "");
      if (!isWebUrl(url)) return [];
      return [{
        url: url.slice(0, 20_000),
        title: String(row.title || url).slice(0, 20_000),
        visitCount: Number(row.visit_count) || 1,
        ...(chromiumTime(row.last_visit_time) ? { visitedAt: chromiumTime(row.last_visit_time) } : {}),
      }];
    });
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function chromiumTime(value) {
  const microseconds = Number(value);
  if (!Number.isFinite(microseconds) || microseconds <= 0) return undefined;
  const milliseconds = microseconds / 1_000 - CHROMIUM_EPOCH_OFFSET_MS;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
  return new Date(milliseconds).toISOString();
}

function rootLabel(value) {
  if (value === "bookmark_bar") return "Bookmarks bar";
  if (value === "other") return "Other bookmarks";
  if (value === "synced") return "Mobile bookmarks";
  return value;
}

function isWebUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function safeDirectories(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => basename(entry.name));
  } catch {
    return [];
  }
}
