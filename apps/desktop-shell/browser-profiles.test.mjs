import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BROWSER_PROFILE_STATE_VERSION,
  BrowserProfileRegistry,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_PROFILE_PARTITION,
  browserProfilePartition,
  createBrowserProfileId,
  isBrowserProfileId,
  loadBrowserProfileState,
  normalizeBrowserProfileColor,
  normalizeBrowserProfileId,
} from "./browser-profiles.mjs";

const FIRST_UUID = "11111111-1111-4111-8111-111111111111";
const SECOND_UUID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-27T12:00:00.000Z";

test("creates and persists the fixed default browser profile", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-browser-profiles-default-"));
  const path = join(root, "browser-profiles.json");
  try {
    const registry = new BrowserProfileRegistry(path, { clock: () => new Date(NOW) });
    assert.deepEqual(registry.list(), [{
      id: DEFAULT_BROWSER_PROFILE_ID,
      name: "默认 Profile",
      color: "#5b7c86",
      partition: DEFAULT_BROWSER_PROFILE_PARTITION,
      createdAt: NOW,
      updatedAt: NOW,
    }]);
    assert.equal(registry.defaultProfile().partition, "persist:ego-desktop");
    assert.equal(existsSync(`${path}.tmp`), false);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.version, BROWSER_PROFILE_STATE_VERSION);
    assert.equal(saved.defaultProfileId, "default");
    assert.equal(saved.profiles[0].partition, "persist:ego-desktop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates stable profile ids and partitions across reloads", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-browser-profiles-create-"));
  const path = join(root, "browser-profiles.json");
  try {
    const registry = new BrowserProfileRegistry(path, {
      clock: () => new Date(NOW),
      uuidFactory: () => FIRST_UUID,
    });
    const created = registry.create({ name: "  工作   Profile  ", color: "#abc" });
    assert.equal(created.id, `profile-${FIRST_UUID}`);
    assert.equal(created.partition, `persist:ego-profile-profile-${FIRST_UUID}`);
    assert.equal(created.name, "工作 Profile");
    assert.equal(created.color, "#aabbcc");

    const updated = registry.update(created.id, { name: "研究", color: "#123456" });
    assert.equal(updated.id, created.id);
    assert.equal(updated.partition, created.partition);
    assert.equal(updated.name, "研究");

    const restored = new BrowserProfileRegistry(path);
    assert.deepEqual(restored.require(created.id), updated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrates legacy arrays and repairs malformed profile fields", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-browser-profiles-migrate-"));
  const path = join(root, "browser-profiles.json");
  try {
    writeFileSync(path, JSON.stringify([
      {
        id: "DEFAULT",
        name: "",
        color: "invalid",
        partition: "persist:wrong-default",
        createdAt: "invalid",
      },
      {
        name: "Legacy Work",
        color: "#ABCDEF",
        partition: `persist:ego-profile-profile-${FIRST_UUID}`,
        createdAt: "2025-01-02T03:04:05Z",
      },
      null,
    ]), "utf8");

    const state = loadBrowserProfileState(path, {
      clock: () => new Date(NOW),
      uuidFactory: () => SECOND_UUID,
    });
    assert.equal(state.migrated, true);
    assert.equal(state.profiles.length, 2);
    assert.equal(state.profiles[0].id, "default");
    assert.equal(state.profiles[0].partition, "persist:ego-desktop");
    assert.equal(state.profiles[0].createdAt, NOW);
    assert.equal(state.profiles[1].id, `profile-${FIRST_UUID}`);
    assert.equal(state.profiles[1].partition, `persist:ego-profile-profile-${FIRST_UUID}`);
    assert.equal(state.profiles[1].color, "#abcdef");

    const registry = new BrowserProfileRegistry(path, {
      clock: () => new Date(NOW),
      uuidFactory: () => SECOND_UUID,
    });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).profiles.length, 2);
    assert.equal(registry.require(`profile-${FIRST_UUID}`).name, "Legacy Work");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects duplicate persisted partitions without overwriting the registry", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-browser-profiles-duplicate-"));
  const path = join(root, "browser-profiles.json");
  const duplicate = "persist:ego-profile-shared";
  const source = JSON.stringify({
    version: 1,
    profiles: [
      { id: `profile-${FIRST_UUID}`, name: "One", partition: duplicate },
      { id: `profile-${SECOND_UUID}`, name: "Two", partition: duplicate },
    ],
  });
  try {
    writeFileSync(path, source, "utf8");
    assert.throws(() => new BrowserProfileRegistry(path), /partition 重复/);
    assert.equal(readFileSync(path, "utf8"), source);
    assert.equal(existsSync(`${path}.tmp`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protects the default and referenced profiles during deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-browser-profiles-remove-"));
  const path = join(root, "browser-profiles.json");
  try {
    let nextUuid = FIRST_UUID;
    const registry = new BrowserProfileRegistry(path, { uuidFactory: () => nextUuid });
    const first = registry.create({ name: "Work" });
    nextUuid = SECOND_UUID;
    const second = registry.create({ name: "Personal" });

    assert.throws(() => registry.remove("default"), /默认.*不能删除/);
    assert.throws(() => registry.remove(first.id, new Set([first.id])), /工作空间使用/);
    assert.equal(registry.has(first.id), true);
    assert.equal(registry.remove(second.id, [first.id]).id, second.id);
    assert.equal(registry.has(second.id), false);

    const restored = new BrowserProfileRegistry(path);
    assert.deepEqual(restored.list().map((profile) => profile.id), ["default", first.id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects corrupt JSON instead of replacing browser profile metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-browser-profiles-corrupt-"));
  const path = join(root, "browser-profiles.json");
  try {
    writeFileSync(path, "{not-json", "utf8");
    assert.throws(() => new BrowserProfileRegistry(path), /无法读取浏览器 Profile 注册表/);
    assert.equal(readFileSync(path, "utf8"), "{not-json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes profile ids, colors, and fixed partitions", () => {
  assert.equal(createBrowserProfileId(() => FIRST_UUID), `profile-${FIRST_UUID}`);
  assert.equal(normalizeBrowserProfileId(` PROFILE-${FIRST_UUID.toUpperCase()} `), `profile-${FIRST_UUID}`);
  assert.equal(normalizeBrowserProfileId("work"), "");
  assert.equal(isBrowserProfileId("default"), true);
  assert.equal(isBrowserProfileId(`profile-${FIRST_UUID}`), true);
  assert.equal(isBrowserProfileId("profile-invalid"), false);
  assert.equal(browserProfilePartition("default"), "persist:ego-desktop");
  assert.equal(browserProfilePartition(`profile-${FIRST_UUID}`), `persist:ego-profile-profile-${FIRST_UUID}`);
  assert.equal(normalizeBrowserProfileColor(" #ABC "), "#aabbcc");
  assert.equal(normalizeBrowserProfileColor("invalid", "#123456"), "#123456");
  assert.throws(() => browserProfilePartition("work"), /ID 无效/);
});
