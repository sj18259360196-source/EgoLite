import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const BROWSER_PROFILE_STATE_VERSION = 1;
export const DEFAULT_BROWSER_PROFILE_ID = "default";
export const DEFAULT_BROWSER_PROFILE_PARTITION = "persist:ego-desktop";
export const BROWSER_PROFILE_COLORS = Object.freeze([
  "#5b7c86",
  "#668b72",
  "#a07856",
  "#8a6f91",
  "#b06d6d",
  "#777f8c",
]);

const PROFILE_ID_PATTERN = /^profile-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROFILE_PARTITION_PREFIX = "persist:ego-profile-";
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/;
const SHORT_HEX_COLOR_PATTERN = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/;

export class BrowserProfileRegistry {
  #path;
  #profiles;
  #clock;
  #uuidFactory;

  constructor(path, options = {}) {
    this.#path = resolve(String(path || ""));
    this.#clock = typeof options.clock === "function" ? options.clock : () => new Date();
    this.#uuidFactory = typeof options.uuidFactory === "function" ? options.uuidFactory : randomUUID;
    const loaded = loadBrowserProfileState(this.#path, {
      clock: this.#clock,
      uuidFactory: this.#uuidFactory,
    });
    this.#profiles = loaded.profiles;
    if (loaded.migrated) this.#persist();
  }

  list() {
    return this.#profiles.map(copyProfile);
  }

  get(id) {
    const normalizedId = normalizeBrowserProfileId(id);
    const profile = normalizedId ? this.#profiles.find((item) => item.id === normalizedId) : undefined;
    return profile ? copyProfile(profile) : undefined;
  }

  require(id) {
    const profile = this.get(id);
    if (!profile) throw new Error(`找不到浏览器 Profile：${String(id || "")}`);
    return profile;
  }

  has(id) {
    return Boolean(this.get(id));
  }

  defaultProfile() {
    return this.require(DEFAULT_BROWSER_PROFILE_ID);
  }

  create(input = {}) {
    const id = createBrowserProfileId(this.#uuidFactory);
    if (this.#profiles.some((profile) => profile.id === id)) throw new Error(`浏览器 Profile ID 重复：${id}`);
    const now = clockIso(this.#clock);
    const profile = {
      id,
      name: normalizeBrowserProfileName(input.name, `Profile ${this.#profiles.length + 1}`),
      color: normalizeBrowserProfileColor(input.color, BROWSER_PROFILE_COLORS[this.#profiles.length % BROWSER_PROFILE_COLORS.length]),
      partition: browserProfilePartition(id),
      createdAt: now,
      updatedAt: now,
    };
    this.#profiles.push(profile);
    this.#assertUniquePartitions();
    this.#persist();
    return copyProfile(profile);
  }

  update(id, changes = {}) {
    const normalizedId = requiredBrowserProfileId(id);
    const profile = this.#profiles.find((item) => item.id === normalizedId);
    if (!profile) throw new Error(`找不到浏览器 Profile：${normalizedId}`);
    if (Object.prototype.hasOwnProperty.call(changes, "name")) {
      profile.name = normalizeBrowserProfileName(changes.name, profile.name);
    }
    if (Object.prototype.hasOwnProperty.call(changes, "color")) {
      profile.color = normalizeBrowserProfileColor(changes.color, profile.color);
    }
    profile.updatedAt = clockIso(this.#clock);
    this.#persist();
    return copyProfile(profile);
  }

  remove(id, usedProfileIds = []) {
    const normalizedId = requiredBrowserProfileId(id);
    if (normalizedId === DEFAULT_BROWSER_PROFILE_ID) throw new Error("默认浏览器 Profile 不能删除");
    const used = normalizeUsedProfileIds(usedProfileIds);
    if (used.has(normalizedId)) throw new Error("浏览器 Profile 仍被工作空间使用，不能删除");
    const index = this.#profiles.findIndex((profile) => profile.id === normalizedId);
    if (index < 0) throw new Error(`找不到浏览器 Profile：${normalizedId}`);
    const [removed] = this.#profiles.splice(index, 1);
    this.#persist();
    return copyProfile(removed);
  }

  toJSON() {
    return browserProfileState(this.#profiles);
  }

  #assertUniquePartitions() {
    assertUniquePartitions(this.#profiles);
  }

  #persist() {
    this.#assertUniquePartitions();
    persistBrowserProfileState(this.#path, this.#profiles);
  }
}

export function loadBrowserProfileState(path, options = {}) {
  const statePath = resolve(String(path || ""));
  const clock = typeof options.clock === "function" ? options.clock : () => new Date();
  const uuidFactory = typeof options.uuidFactory === "function" ? options.uuidFactory : randomUUID;
  if (!existsSync(statePath)) {
    return { profiles: [defaultBrowserProfile(clockIso(clock))], migrated: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取浏览器 Profile 注册表：${error instanceof Error ? error.message : String(error)}`);
  }

  const rawProfiles = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.profiles) ? parsed.profiles : [];
  assertUniqueRawPartitions(rawProfiles);
  const now = clockIso(clock);
  const profiles = [];
  const ids = new Set();
  for (let index = 0; index < rawProfiles.length; index += 1) {
    const raw = rawProfiles[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const id = migratedBrowserProfileId(raw, uuidFactory);
    if (ids.has(id)) throw new Error(`浏览器 Profile ID 重复：${id}`);
    ids.add(id);
    profiles.push(normalizeBrowserProfile(raw, {
      id,
      fallbackColor: BROWSER_PROFILE_COLORS[index % BROWSER_PROFILE_COLORS.length],
      now,
    }));
  }

  if (!ids.has(DEFAULT_BROWSER_PROFILE_ID)) profiles.unshift(defaultBrowserProfile(now));
  else profiles.sort((left, right) => Number(right.id === DEFAULT_BROWSER_PROFILE_ID) - Number(left.id === DEFAULT_BROWSER_PROFILE_ID));
  assertUniquePartitions(profiles);
  const canonical = browserProfileState(profiles);
  return {
    profiles,
    migrated: JSON.stringify(parsed) !== JSON.stringify(canonical),
  };
}

export function persistBrowserProfileState(path, profiles) {
  const statePath = resolve(String(path || ""));
  const normalizedProfiles = Array.isArray(profiles) ? profiles.map(copyProfile) : [];
  assertUniquePartitions(normalizedProfiles);
  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(browserProfileState(normalizedProfiles), null, 2), "utf8");
    renameSync(temporaryPath, statePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function createBrowserProfileId(uuidFactory = randomUUID) {
  const uuid = String(uuidFactory()).trim().toLowerCase();
  const id = `profile-${uuid}`;
  if (!PROFILE_ID_PATTERN.test(id)) throw new Error("无法生成有效的浏览器 Profile ID");
  return id;
}

export function normalizeBrowserProfileId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (id === DEFAULT_BROWSER_PROFILE_ID || PROFILE_ID_PATTERN.test(id)) return id;
  return "";
}

export function isBrowserProfileId(value) {
  return Boolean(normalizeBrowserProfileId(value));
}

export function browserProfilePartition(id) {
  const normalizedId = requiredBrowserProfileId(id);
  return normalizedId === DEFAULT_BROWSER_PROFILE_ID
    ? DEFAULT_BROWSER_PROFILE_PARTITION
    : `${PROFILE_PARTITION_PREFIX}${normalizedId}`;
}

export function normalizeBrowserProfileColor(value, fallback = BROWSER_PROFILE_COLORS[0]) {
  const color = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (HEX_COLOR_PATTERN.test(color)) return color;
  const short = color.match(SHORT_HEX_COLOR_PATTERN);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const normalizedFallback = typeof fallback === "string" ? fallback.trim().toLowerCase() : "";
  return HEX_COLOR_PATTERN.test(normalizedFallback) ? normalizedFallback : BROWSER_PROFILE_COLORS[0];
}

export function normalizeBrowserProfileName(value, fallback = "浏览器 Profile") {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (name) return name.slice(0, 80);
  const cleanFallback = typeof fallback === "string" ? fallback.trim().replace(/\s+/g, " ") : "";
  return (cleanFallback || "浏览器 Profile").slice(0, 80);
}

function normalizeBrowserProfile(raw, options) {
  const createdAt = normalizedIso(raw.createdAt, options.now);
  return {
    id: options.id,
    name: normalizeBrowserProfileName(raw.name, options.id === DEFAULT_BROWSER_PROFILE_ID ? "默认 Profile" : "浏览器 Profile"),
    color: normalizeBrowserProfileColor(raw.color, options.fallbackColor),
    partition: browserProfilePartition(options.id),
    createdAt,
    updatedAt: normalizedIso(raw.updatedAt, createdAt),
  };
}

function migratedBrowserProfileId(raw, uuidFactory) {
  const normalized = normalizeBrowserProfileId(raw.id);
  if (normalized) return normalized;
  const partition = typeof raw.partition === "string" ? raw.partition.trim().toLowerCase() : "";
  if (partition === DEFAULT_BROWSER_PROFILE_PARTITION) return DEFAULT_BROWSER_PROFILE_ID;
  if (partition.startsWith(PROFILE_PARTITION_PREFIX)) {
    const fromPartition = normalizeBrowserProfileId(partition.slice(PROFILE_PARTITION_PREFIX.length));
    if (fromPartition && fromPartition !== DEFAULT_BROWSER_PROFILE_ID) return fromPartition;
  }
  return createBrowserProfileId(uuidFactory);
}

function defaultBrowserProfile(now) {
  return {
    id: DEFAULT_BROWSER_PROFILE_ID,
    name: "默认 Profile",
    color: BROWSER_PROFILE_COLORS[0],
    partition: DEFAULT_BROWSER_PROFILE_PARTITION,
    createdAt: now,
    updatedAt: now,
  };
}

function browserProfileState(profiles) {
  return {
    version: BROWSER_PROFILE_STATE_VERSION,
    defaultProfileId: DEFAULT_BROWSER_PROFILE_ID,
    profiles: profiles.map(copyProfile),
  };
}

function copyProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    partition: profile.partition,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function requiredBrowserProfileId(value) {
  const id = normalizeBrowserProfileId(value);
  if (!id) throw new Error(`浏览器 Profile ID 无效：${String(value || "")}`);
  return id;
}

function normalizedIso(value, fallback) {
  if (typeof value === "string" && value.trim()) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return fallback;
}

function clockIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("浏览器 Profile 时钟返回了无效时间");
  return date.toISOString();
}

function normalizeUsedProfileIds(values) {
  const iterable = values instanceof Set || Array.isArray(values) ? values : [];
  return new Set([...iterable].map(normalizeBrowserProfileId).filter(Boolean));
}

function assertUniqueRawPartitions(profiles) {
  const partitions = new Set();
  for (const profile of profiles) {
    const partition = profile && typeof profile === "object" && typeof profile.partition === "string"
      ? profile.partition.trim().toLowerCase()
      : "";
    if (!partition) continue;
    if (partitions.has(partition)) throw new Error(`浏览器 Profile partition 重复：${partition}`);
    partitions.add(partition);
  }
}

function assertUniquePartitions(profiles) {
  const partitions = new Set();
  for (const profile of profiles) {
    const partition = String(profile?.partition || "").trim().toLowerCase();
    if (!partition) throw new Error("浏览器 Profile 缺少 partition");
    if (partitions.has(partition)) throw new Error(`浏览器 Profile partition 重复：${partition}`);
    partitions.add(partition);
  }
}
