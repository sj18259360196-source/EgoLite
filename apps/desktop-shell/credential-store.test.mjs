import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCredentialCipher, CredentialStore, normalizeCredentialOrigin } from "./credential-store.mjs";

const NOW = "2026-09-01T12:00:00.000Z";
const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

function createStore(root, options = {}) {
  return new CredentialStore(join(root, "credentials.json"), {
    clock: () => new Date(NOW),
    encrypt: (value) => `test:${Buffer.from(value, "utf8").toString("base64")}`,
    decrypt: (value) => Buffer.from(String(value).replace(/^test:/, ""), "base64").toString("utf8"),
    ...options,
  });
}

test("normalizes credential origins to the web origin", () => {
  assert.equal(normalizeCredentialOrigin(" HTTPS://Example.com:443/login "), "https://example.com");
  assert.equal(normalizeCredentialOrigin("http://localhost:4312/login"), "http://localhost:4312");
  assert.equal(normalizeCredentialOrigin("file:///tmp/login.html"), "");
});

test("uses platform encryption when available and keeps a development fallback", () => {
  const platformStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^protected:/, ""),
  };
  const protectedCipher = createCredentialCipher(platformStorage);
  const encrypted = protectedCipher.encrypt("secret");
  assert.match(encrypted, /^safe:/);
  assert.equal(protectedCipher.decrypt(encrypted), "secret");

  const fallbackCipher = createCredentialCipher({ isEncryptionAvailable: () => false });
  const fallback = fallbackCipher.encrypt("test-password");
  assert.match(fallback, /^plain:/);
  assert.equal(fallbackCipher.decrypt(fallback), "test-password");
});

test("saves, lists, finds, reveals, and reloads credentials without exposing passwords in public records", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-credential-store-test-"));
  try {
    const store = createStore(root, { uuidFactory: () => FIRST_ID });
    const saved = store.save({
      profileId: "Work",
      origin: "https://Example.com/login",
      username: "  alice@example.com ",
      password: "s3cret",
      formSignature: "form:0",
    });
    assert.equal(saved.id, `credential-${FIRST_ID}`);
    assert.equal(saved.profileId, "work");
    assert.equal(saved.origin, "https://example.com");
    assert.equal("password" in saved, false);
    assert.equal(store.find("work", "https://example.com/path").length, 1);
    assert.deepEqual(store.reveal("work", saved.id)?.password, "s3cret");

    const raw = readFileSync(join(root, "credentials.json"), "utf8");
    assert.equal(raw.includes("s3cret"), false);
    assert.equal(existsSync(join(root, "credentials.json.tmp")), false);

    const restored = createStore(root);
    assert.equal(restored.list("work").length, 1);
    assert.equal(restored.reveal("work", saved.id)?.username, "alice@example.com");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updates the same site and username, supports multiple accounts, and removes records by profile", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-credential-store-update-"));
  try {
    let nextId = FIRST_ID;
    const store = createStore(root, { uuidFactory: () => nextId });
    const first = store.save({ profileId: "default", origin: "https://example.com", username: "alice", password: "one" });
    const updated = store.save({ profileId: "default", origin: "https://example.com/login", username: "alice", password: "two" });
    assert.equal(updated.id, first.id);
    assert.equal(store.reveal("default", first.id)?.password, "two");

    nextId = SECOND_ID;
    const second = store.save({ profileId: "default", origin: "https://example.com", username: "bob", password: "three" });
    assert.equal(store.find("default", "https://example.com").length, 2);
    const edited = store.save({ id: second.id, profileId: "default", origin: "https://example.org", username: "robert", password: "four" });
    assert.equal(edited.id, second.id);
    assert.equal(store.find("default", "https://example.com").length, 1);
    assert.equal(store.reveal("default", second.id)?.origin, "https://example.org");
    assert.equal(store.remove("default", first.id), true);
    assert.equal(store.remove("default", first.id), false);
    assert.equal(store.clear("default"), 1);
    assert.equal(store.list("default").length, 0);
    assert.equal(store.list("other").length, 0);
    assert.equal(second.profileId, "default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
