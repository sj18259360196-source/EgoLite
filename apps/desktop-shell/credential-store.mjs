import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const CREDENTIAL_STORE_VERSION = 1;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_ORIGIN_LENGTH = 2_000;
const MAX_USERNAME_LENGTH = 1_000;
const MAX_PASSWORD_LENGTH = 20_000;
const MAX_REALM_LENGTH = 500;
const MAX_SIGNATURE_LENGTH = 2_000;

export function createCredentialCipher(platformStorage) {
  return {
    encrypt(value) {
      const text = String(value ?? "");
      try {
        if (platformStorage?.isEncryptionAvailable?.()) {
          return `safe:${platformStorage.encryptString(text).toString("base64")}`;
        }
      } catch {}
      return `plain:${Buffer.from(text, "utf8").toString("base64")}`;
    },
    decrypt(value) {
      const encoded = String(value || "");
      if (encoded.startsWith("safe:")) {
        try { return platformStorage?.decryptString?.(Buffer.from(encoded.slice(5), "base64")) || ""; } catch { return ""; }
      }
      if (encoded.startsWith("plain:")) {
        try { return Buffer.from(encoded.slice(6), "base64").toString("utf8"); } catch { return ""; }
      }
      try { return Buffer.from(encoded, "base64").toString("utf8"); } catch { return ""; }
    },
  };
}

export class CredentialStore {
  #path;
  #records;
  #clock;
  #uuidFactory;
  #encrypt;
  #decrypt;

  constructor(path, options = {}) {
    this.#path = resolve(String(path || ""));
    this.#clock = typeof options.clock === "function" ? options.clock : () => new Date();
    this.#uuidFactory = typeof options.uuidFactory === "function" ? options.uuidFactory : randomUUID;
    this.#encrypt = typeof options.encrypt === "function" ? options.encrypt : (value) => Buffer.from(value, "utf8").toString("base64");
    this.#decrypt = typeof options.decrypt === "function" ? options.decrypt : (value) => Buffer.from(value, "base64").toString("utf8");
    this.#records = loadCredentialRecords(this.#path);
  }

  list(profileId) {
    const normalizedProfileId = profileId === undefined || profileId === null || profileId === ""
      ? ""
      : normalizeCredentialProfileId(profileId);
    return this.#records
      .filter((record) => !normalizedProfileId || record.profileId === normalizedProfileId)
      .sort(compareCredentials)
      .map(copyPublicCredential);
  }

  find(profileId, origin, realm = "") {
    const normalizedProfileId = normalizeCredentialProfileId(profileId);
    const normalizedOrigin = normalizeCredentialOrigin(origin);
    if (!normalizedOrigin) return [];
    const normalizedRealm = normalizeCredentialRealm(realm);
    return this.#records
      .filter((record) => record.profileId === normalizedProfileId
        && record.origin === normalizedOrigin
        && (!normalizedRealm || record.realm === normalizedRealm))
      .sort(compareCredentials)
      .map(copyPublicCredential);
  }

  reveal(profileId, id) {
    const record = this.#findRecord(profileId, id);
    if (!record) return undefined;
    return {
      ...copyPublicCredential(record),
      password: String(this.#decrypt(record.encryptedPassword)),
    };
  }

  save(input = {}) {
    const profileId = normalizeCredentialProfileId(input.profileId);
    const origin = normalizeCredentialOrigin(input.origin);
    const username = normalizeCredentialUsername(input.username);
    const password = normalizeCredentialPassword(input.password);
    const realm = normalizeCredentialRealm(input.realm);
    const formSignature = normalizeCredentialSignature(input.formSignature);
    if (!origin) throw new Error("凭据需要有效的网站地址");
    if (password === "") throw new Error("密码不能为空");

    const now = clockIso(this.#clock);
    const requestedId = typeof input.id === "string" ? input.id.trim() : "";
    const existing = (requestedId ? this.#findRecord(profileId, requestedId) : undefined)
      || this.#records.find((record) => record.profileId === profileId
        && record.origin === origin
        && record.username === username
        && record.realm === realm);
    if (existing) {
      existing.origin = origin;
      existing.username = username;
      existing.realm = realm;
      existing.encryptedPassword = String(this.#encrypt(password));
      existing.formSignature = formSignature || existing.formSignature;
      existing.updatedAt = now;
      existing.lastUsedAt = now;
      this.#persist();
      return copyPublicCredential(existing);
    }

    const id = `credential-${String(this.#uuidFactory()).trim().toLowerCase()}`;
    if (this.#records.some((record) => record.id === id)) throw new Error(`凭据 ID 重复：${id}`);
    const record = {
      id,
      profileId,
      origin,
      username,
      realm,
      formSignature,
      encryptedPassword: String(this.#encrypt(password)),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    };
    this.#records.push(record);
    this.#persist();
    return copyPublicCredential(record);
  }

  touch(profileId, id) {
    const record = this.#findRecord(profileId, id);
    if (!record) return undefined;
    record.lastUsedAt = clockIso(this.#clock);
    this.#persist();
    return copyPublicCredential(record);
  }

  remove(profileId, id) {
    const normalizedProfileId = normalizeCredentialProfileId(profileId);
    const index = this.#records.findIndex((record) => record.profileId === normalizedProfileId && record.id === String(id || ""));
    if (index < 0) return false;
    this.#records.splice(index, 1);
    this.#persist();
    return true;
  }

  clear(profileId) {
    const normalizedProfileId = normalizeCredentialProfileId(profileId);
    const before = this.#records.length;
    this.#records = this.#records.filter((record) => record.profileId !== normalizedProfileId);
    if (this.#records.length !== before) this.#persist();
    return before - this.#records.length;
  }

  removeProfile(profileId) {
    return this.clear(profileId);
  }

  toJSON() {
    return credentialStoreState(this.#records);
  }

  #findRecord(profileId, id) {
    const normalizedProfileId = normalizeCredentialProfileId(profileId);
    return this.#records.find((record) => record.profileId === normalizedProfileId && record.id === String(id || ""));
  }

  #persist() {
    persistCredentialRecords(this.#path, this.#records);
  }
}

export function loadCredentialRecords(path) {
  const statePath = resolve(String(path || ""));
  if (!existsSync(statePath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取凭据库：${error instanceof Error ? error.message : String(error)}`);
  }
  const rawRecords = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.credentials) ? parsed.credentials : [];
  return rawRecords.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const profileId = normalizeCredentialProfileId(raw.profileId);
    const origin = normalizeCredentialOrigin(raw.origin);
    const encryptedPassword = typeof raw.encryptedPassword === "string" ? raw.encryptedPassword : "";
    if (!id || !origin || !encryptedPassword) return [];
    const createdAt = normalizedIso(raw.createdAt, new Date(0).toISOString());
    const updatedAt = normalizedIso(raw.updatedAt, createdAt);
    return [{
      id,
      profileId,
      origin,
      username: normalizeCredentialUsername(raw.username),
      realm: normalizeCredentialRealm(raw.realm),
      formSignature: normalizeCredentialSignature(raw.formSignature),
      encryptedPassword,
      createdAt,
      updatedAt,
      lastUsedAt: normalizedIso(raw.lastUsedAt, updatedAt),
    }];
  });
}

export function persistCredentialRecords(path, records) {
  const statePath = resolve(String(path || ""));
  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(credentialStoreState(records), null, 2), "utf8");
    renameSync(temporaryPath, statePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function normalizeCredentialProfileId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return PROFILE_ID_PATTERN.test(id) ? id : "default";
}

export function normalizeCredentialOrigin(value) {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input || input.length > MAX_ORIGIN_LENGTH) return "";
  try {
    const url = new URL(input);
    if (!/^https?:$/i.test(url.protocol) || !url.hostname) return "";
    return url.origin.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeCredentialUsername(value) {
  return String(value ?? "").trim().slice(0, MAX_USERNAME_LENGTH);
}

function normalizeCredentialPassword(value) {
  return typeof value === "string" ? value.slice(0, MAX_PASSWORD_LENGTH) : "";
}

function normalizeCredentialRealm(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_REALM_LENGTH);
}

function normalizeCredentialSignature(value) {
  return String(value ?? "").trim().slice(0, MAX_SIGNATURE_LENGTH);
}

function copyPublicCredential(record) {
  return {
    id: record.id,
    profileId: record.profileId,
    origin: record.origin,
    username: record.username,
    realm: record.realm,
    formSignature: record.formSignature,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function compareCredentials(left, right) {
  const leftTime = Date.parse(left.lastUsedAt || left.updatedAt || "") || 0;
  const rightTime = Date.parse(right.lastUsedAt || right.updatedAt || "") || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return left.origin.localeCompare(right.origin) || left.username.localeCompare(right.username);
}

function credentialStoreState(records) {
  return {
    version: CREDENTIAL_STORE_VERSION,
    credentials: records.map((record) => ({
      id: record.id,
      profileId: record.profileId,
      origin: record.origin,
      username: record.username,
      realm: record.realm,
      formSignature: record.formSignature,
      encryptedPassword: record.encryptedPassword,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastUsedAt: record.lastUsedAt,
    })),
  };
}

function normalizedIso(value, fallback) {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function clockIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("凭据库时钟返回了无效时间");
  return date.toISOString();
}
