import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const renderer = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
function extract(source, name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}
function harness(extra = {}) {
  const context = vm.createContext({
    structuredClone, existsSync, readFileSync,
    CONTROL_CONSENT_POLICY_VERSION: 3,
    desktopPreferencesNeedsMigration: false,
    browserExtensionPartition: "persist:ego-desktop",
    DEFAULT_BROWSER_PROFILE: { id: "default", name: "默认 Profile", partition: "persist:ego-desktop" },
    desktopPreferences: { profiles: [] },
    browserProfileSessions: new Map(),
    configureWebviewSession() {},
    session: { fromPartition() { throw new Error("Unexpected session creation"); } },
    persistDesktopPreferences() {},
    required(value) { if (!value) throw new Error("Required"); return value; },
    rpc: undefined,
    clientId: "desktop-test",
    ...extra,
  });
  for (const name of [
    "normalizeBrowserProfileId", "normalizeBrowserProfileColor", "browserProfilePartition",
    "normalizeBrowserProfiles", "findBrowserProfile", "listBrowserProfiles",
    "ensureBrowserProfileSession", "createBrowserProfile", "removeBrowserProfile",
    "normalizeControlMode", "normalizeControlConsentLevel", "loadDesktopPreferences",
  ]) vm.runInContext(extract(main, name), context);
  return context;
}

test("desktop preferences retain more than 24 profiles and workspace bindings across two reloads", () => {
  const parent = fileURLToPath(new URL("../../.tmp/codex", import.meta.url));
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "profile-recovery-"));
  try {
    const path = join(dir, "desktop-preferences.json");
    const profiles = Array.from({ length: 40 }, (_, index) => ({
      id: `work-${index}`, name: `Work ${index}`, partition: `persist:ego-profile-work-${index}`,
    }));
    const binding = { taskId: "restored-work", profileId: "work-39" };
    writeFileSync(join(dir, "workspace.json"), JSON.stringify(binding), "utf8");
    writeFileSync(path, JSON.stringify({ profiles, controlConsentPolicyVersion: 3 }), "utf8");
    for (let restart = 0; restart < 2; restart += 1) {
      const host = harness({ preferencesStatePath: path });
      const preferences = host.loadDesktopPreferences();
      assert.equal(preferences.profiles.length, 41);
      const restored = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
      const profile = preferences.profiles.find((item) => item.id === restored.profileId);
      assert.equal(profile.partition, profiles[39].partition);
      writeFileSync(path, JSON.stringify(preferences), "utf8");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("desktop rejects duplicate IDs, invalid IDs and missing profiles without a default session", () => {
  const host = harness();
  host.desktopPreferences.profiles = host.normalizeBrowserProfiles([]);
  assert.throws(() => host.normalizeBrowserProfiles([{ id: "work" }, { id: "WORK" }]), /标识重复/);
  assert.throws(() => host.normalizeBrowserProfileId("../invalid"), /标识无效/);
  assert.throws(() => host.createBrowserProfile({ name: "Duplicate", id: "default" }), /已存在/);
  assert.throws(() => host.ensureBrowserProfileSession("missing"), /找不到浏览器 Profile/);
  assert.equal(host.desktopPreferences.profiles.length, 1);
});

test("desktop profile deletion rejects unavailable or failed reference checks and referenced profiles", async () => {
  const host = harness();
  host.desktopPreferences.profiles = host.normalizeBrowserProfiles([{ id: "work" }]);
  await assert.rejects(() => host.removeBrowserProfile({ id: "work" }), /等待 Broker/);
  host.rpc = { request: async () => { throw new Error("Disconnected"); } };
  await assert.rejects(() => host.removeBrowserProfile({ id: "work" }), /Disconnected/);
  host.rpc = { request: async () => ({ taskSpaces: [{ profileId: "work" }] }) };
  await assert.rejects(() => host.removeBrowserProfile({ id: "work" }), /正在使用/);
  assert.ok(host.findBrowserProfile("work"));
});

test("missing snapshot profile fails before creating a workspace", async () => {
  let calls = 0;
  const context = vm.createContext({
    state: { profiles: [{ id: "default" }] },
    invoke: async () => { calls++; },
    showToast() {},
    localizedError: String,
  });
  const restore = vm.runInContext(`(${extract(renderer, "restoreWorkspaceSnapshot")})`, context);
  const button = { disabled: false };
  await restore({ profileId: "missing", name: "Saved work", tabs: [] }, button);
  assert.equal(calls, 0);
  assert.equal(button.disabled, false);
});

test("renderer marks a missing profile without selecting a different account", () => {
  const context = vm.createContext({ browserProfiles: () => [{ id: "default", partition: "persist:ego-desktop" }] });
  const resolve = vm.runInContext(`(${extract(renderer, "browserProfileForTask")})`, context);
  assert.equal(resolve({ profileId: "missing" }).missing, true);
  assert.equal(resolve({ profileId: "missing" }).partition, undefined);
  assert.equal(resolve({}).id, "default");
});
