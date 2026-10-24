import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { analyzeExtensionCompatibility, prepareExtensionRuntime } from "./extension-runtime.mjs";

test('targeted adapter preserves its extension path and refreshes changed source without a version bump', () => {
  const parent = join(import.meta.dirname, '..', '..', '.tmp', 'codex', 'installed-extension-adaptation');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'identity-'));
  try {
    const source = join(root, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ name: 'OpenJobAutofill', version: '1.4.1', manifest_version: 3, background: { service_worker: 'worker.js' }, permissions: ['storage', 'activeTab'] }));
    writeFileSync(join(source, 'worker.js'), 'globalThis.revision = 1');
    const first = prepareExtensionRuntime(source, join(root, 'runtime'));
    writeFileSync(join(source, 'worker.js'), 'globalThis.revision = 2');
    const next = prepareExtensionRuntime(source, join(root, 'runtime'));
    assert.equal(next.path, first.path);
    assert.equal(readFileSync(join(next.path, 'worker.js'), 'utf8'), 'globalThis.revision = 2');
    assert.equal(next.compatibility.targeted, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("marks content-script extensions as native compatible", () => {
  const result = analyzeExtensionCompatibility({ manifest_version: 3, name: "Simple", permissions: ["storage", "scripting"] });
  assert.equal(result.level, "native");
  assert.deepEqual(result.unsupportedPermissions, []);
});

test("reports unsupported Electron 43 permissions accurately", () => {
  const permissions = analyzeExtensionCompatibility({
    manifest_version: 3,
    name: "Cookie helper",
    permissions: ["storage", "cookies", "alarms", "contextMenus"],
  });
  assert.equal(permissions.level, "limited");
  assert.equal(permissions.label, "部分兼容");
  assert.deepEqual(permissions.unsupportedPermissions, ["cookies", "alarms", "contextMenus"]);
});

test("adapts generic MV3 worker and activeTab extensions", () => {
  const worker = analyzeExtensionCompatibility({
    manifest_version: 3,
    name: "Unknown worker extension",
    background: { service_worker: "background.js" },
    permissions: ["storage"],
  });
  assert.equal(worker.level, "adapted");
  assert.equal(worker.adapter, "general-mv3");
  assert.equal(worker.label, "Electron 兼容模式");

  const activeTabExt = analyzeExtensionCompatibility({
    manifest_version: 3,
    name: "OpenJobAutofill",
    background: { service_worker: "src/background.js" },
    permissions: ["activeTab", "scripting", "storage"],
    host_permissions: ["https://api.github.com/*"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
  });
  assert.equal(activeTabExt.level, "adapted");
  assert.equal(activeTabExt.adapter, "general-mv3");
});

test("recognizes Immersive Translate by name, id, or public key", () => {
  const key = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArtwT/I0iOW23jkiXNSf932R1TR5hHUxHA/7xc6GPmeoaS9Rtfazp3jNFp/fm4ptczZARfdNcM/zwNUbBOkgZzloHN24RK1aU7VXtNtfHkRJLhilHOEVKQOZt3NlBxSmKpELaH5Ij/yl5PIeeze/kxaZ2q3l62XhrHeCW5KA3WqksbolI1wIshbioVMLL7bkwqNf8FRHBvVjw0TwEkBAc/2g8/uPS/Eoe/4ukNYrVjCbNEPMGMHu8qcQSxkIdiLNIM/Kf+ugUBAjhlJNuxu8ckZ9MzEzyrssyEA3ye/HEGoxkuPYE2WCcin27sLl69ZZmZG0ueqTFQni3Abn5XvK1mwIDAQAB";
  for (const identity of [
    { name: "Immersive Translate" },
    { name: "Localized extension", id: "amkbmndfnliijdhojkpoglbnaaahippg" },
    { name: "__MSG_brandName__", key },
  ]) {
    const result = analyzeExtensionCompatibility({
      manifest_version: 3,
      background: { service_worker: "background.js" },
      permissions: ["storage", "offscreen", "sidePanel"],
      ...identity,
    });
    assert.equal(result.level, "adapted");
    assert.equal(result.adapter, "immersive-translate-mv3");
  }
});

test("creates an isolated MV2 runtime copy for Immersive Translate", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-immersive-runtime-"));
  const source = join(root, "source");
  const runtime = join(root, "runtime");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "background.js"), "globalThis.immersiveBackgroundStarted = true;", "utf8");
  writeFileSync(join(source, "popup.html"), "<!doctype html><title>Immersive popup</title>", "utf8");
  writeFileSync(join(source, "content_guard.js"), "globalThis.immersiveContentStarted = true;", "utf8");
  const sourceManifest = {
    manifest_version: 3,
    name: "Immersive Translate",
    version: "1.32.7",
    background: { service_worker: "background.js" },
    action: { default_popup: "popup.html" },
    commands: { _execute_action: {}, toggleTranslatePage: { description: "Translate" } },
    content_scripts: [{ matches: ["<all_urls>"], js: ["content_guard.js"] }],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    host_permissions: ["<all_urls>"],
    optional_host_permissions: ["https://optional.example/*"],
    permissions: [
      "storage",
      "activeTab",
      "contextMenus",
      "webRequest",
      "declarativeNetRequest",
      "declarativeNetRequestWithHostAccess",
      "offscreen",
      "sidePanel",
    ],
    declarative_net_request: { rule_resources: [{ id: "rules", enabled: true, path: "rules.json" }] },
    side_panel: { default_path: "side-panel.html" },
    web_accessible_resources: [{ resources: ["styles/inject.css", "content_main.js"], matches: ["<all_urls>"] }],
  };
  writeFileSync(join(source, "manifest.json"), JSON.stringify(sourceManifest), "utf8");
  try {
    const prepared = prepareExtensionRuntime(source, runtime);
    assert.equal(prepared.compatibility.level, "adapted");
    assert.equal(prepared.compatibility.adapter, "immersive-translate-mv3");
    assert.notEqual(prepared.path, source);
    assert.equal(existsSync(join(prepared.path, "electron-compat.js")), false);
    assert.match(readFileSync(join(prepared.path, "electron-background.html"), "utf8"), /<script src="\/background\.js"><\/script>/);

    const manifest = JSON.parse(readFileSync(join(prepared.path, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 2);
    assert.deepEqual(manifest.background, { page: "electron-background.html", persistent: true });
    assert.equal(manifest.browser_action.default_popup, "popup.html");
    assert.equal(manifest.action, undefined);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.optional_host_permissions, undefined);
    assert.equal(manifest.declarative_net_request, undefined);
    assert.equal(manifest.side_panel, undefined);
    assert.equal(manifest.permissions.includes("<all_urls>"), true);
    assert.equal(manifest.permissions.includes("webRequestBlocking"), true);
    assert.equal(manifest.permissions.includes("declarativeNetRequest"), false);
    assert.equal(manifest.permissions.includes("offscreen"), false);
    assert.equal(manifest.permissions.includes("sidePanel"), false);
    assert.equal(manifest.optional_permissions.includes("https://optional.example/*"), true);
    assert.deepEqual(manifest.web_accessible_resources, ["styles/inject.css", "content_main.js"]);
    assert.equal(manifest.content_security_policy, "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
    assert.deepEqual(manifest.commands._execute_browser_action, {});
    assert.equal(manifest.commands._execute_action, undefined);
    assert.equal(JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")).manifest_version, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates an isolated MV2 runtime copy for Violentmonkey", async () => {
  const root = mkdtempSync(join(tmpdir(), "ego-extension-runtime-"));
  const source = join(root, "source");
  const runtime = join(root, "runtime");
  mkdirSync(join(source, "public", "lib"), { recursive: true });
  writeFileSync(join(source, "public", "lib", "tld.js"), "globalThis.tld = {};", "utf8");
  writeFileSync(join(source, "sw.js"), "globalThis.started = true;", "utf8");
  mkdirSync(join(source, "popup"), { recursive: true });
  writeFileSync(join(source, "popup", "index.html"), "<script src=/get-data.js?popup></script>", "utf8");
  writeFileSync(join(source, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name: "Violentmonkey",
    version: "2.48.0",
    background: { service_worker: "sw.js" },
    action: { default_popup: "popup.html" },
    host_permissions: ["<all_urls>"],
    permissions: ["storage", "userScripts", "offscreen"],
  }), "utf8");
  try {
    const prepared = prepareExtensionRuntime(source, runtime);
    assert.equal(prepared.compatibility.level, "adapted");
    assert.notEqual(prepared.path, source);
    assert.equal(existsSync(join(prepared.path, "electron-compat.js")), true);
    assert.match(readFileSync(join(prepared.path, "popup", "index.html"), "utf8"), /popup\/electron-page\.js/);
    assert.match(readFileSync(join(prepared.path, "popup", "electron-page.js"), "utf8"), /violentmonkey\.initialData/);
    const manifest = JSON.parse(readFileSync(join(prepared.path, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 2);
    assert.equal(manifest.background.page, "electron-background.html");
    assert.equal(manifest.browser_action.default_popup, "popup.html");
    assert.equal(manifest.permissions.includes("<all_urls>"), true);
    assert.equal(JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")).manifest_version, 3);

    const client = readFileSync(join(prepared.path, 'electron-compat.js'), 'utf8');
    assert.doesNotMatch(client, /EgoCompatStoreUserScript|__egoCompatUserScripts/);
    assert.equal(manifest.content_scripts.some(script => script.js.includes('electron-content.js')), false);
    assert.equal(prepared.compatibility.targeted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates an isolated runtime copy with host permissions and polyfills for generic MV3 extensions", async () => {
  const root = mkdtempSync(join(tmpdir(), "ego-general-runtime-"));
  const source = join(root, "source");
  const runtime = join(root, "runtime");
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "src", "background.js"), "chrome.runtime.onMessage.addListener(() => {});", "utf8");
  writeFileSync(join(source, "src", "popup.html"), "<!doctype html><html><head><title>Popup</title></head><body><script src=\"popup.js\"></script></body></html>", "utf8");
  writeFileSync(join(source, "src", "popup.js"), "console.log('popup');", "utf8");
  const sourceManifest = {
    manifest_version: 3,
    name: "Generic MV3 fixture",
    version: "1.3.0",
    permissions: ["activeTab", "alarms", "scripting", "storage"],
    host_permissions: ["https://api.github.com/*"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    background: { service_worker: "src/background.js", type: "module" },
    action: { default_title: "OpenJobAutofill", default_popup: "src/popup.html" },
  };
  writeFileSync(join(source, "manifest.json"), JSON.stringify(sourceManifest), "utf8");
  try {
    const prepared = prepareExtensionRuntime(source, runtime);
    assert.equal(prepared.compatibility.level, "adapted");
    assert.equal(prepared.compatibility.adapter, "general-mv3");
    assert.notEqual(prepared.path, source);
    assert.equal(existsSync(join(prepared.path, "electron-compat.js")), true);
    assert.equal(existsSync(join(prepared.path, "electron-background.html")), true);

    const bgHtml = readFileSync(join(prepared.path, "electron-background.html"), "utf8");
    assert.match(bgHtml, /<script src="\/electron-compat\.js"><\/script>/);
    assert.match(bgHtml, /<script type="module" src="\/src\/background\.js"><\/script>/);

    const popupHtml = readFileSync(join(prepared.path, "src", "popup.html"), "utf8");
    assert.match(popupHtml, /<script src="\/electron-compat\.js"><\/script>/);

    const manifest = JSON.parse(readFileSync(join(prepared.path, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 2);
    assert.equal(manifest.background.page, "electron-background.html");
    assert.equal(manifest.browser_action.default_popup, "src/popup.html");
    assert.equal(manifest.action, undefined);
    assert.equal(manifest.permissions.includes("<all_urls>"), false);
    assert.equal(manifest.permissions.includes("https://api.github.com/*"), true);
    assert.equal(manifest.permissions.includes("activeTab"), true);
    assert.equal(manifest.permissions.includes("scripting"), true);
    assert.equal(manifest.permissions.includes("storage"), true);

    // Verify electron-compat.js execution and polyfills
    const executedTabs = [];
    const queriedTabs = [];
    const chrome = {
      browserAction: { setBadgeText() {} },
      runtime: {
        getManifest: () => manifest,
        onMessage: { addListener() {} },
      },
      tabs: {
        query(queryInfo, callback) {
          queriedTabs.push(queryInfo);
          if (queryInfo.currentWindow) callback([]); // Simulate empty currentWindow
          else callback([{ id: 42, url: "https://example.com" }]);
        },
        executeScript(tabId, details, callback) {
          executedTabs.push({ tabId, details });
          callback([{ ok: true }]);
        },
      },
    };
    runInNewContext(readFileSync(join(prepared.path, "electron-compat.js"), "utf8"), {
      chrome,
      console,
      navigator: { userAgent: "Mozilla/5.0 Chrome/142.0.0.0 Electron/43.1.0" },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });

    // 1. chrome.action aliased to chrome.browserAction
    assert.equal(chrome.action, chrome.browserAction);

    // 2. tabs.query fallback
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].id, 42);

    // 3. scripting.executeScript fallback to tabs.executeScript
    const result = await chrome.scripting.executeScript({
      target: { tabId: 42 },
      files: ["src/content.js"],
    });
    assert.equal(result[0].result.ok, true);
    assert.equal(executedTabs.length, 1);
    assert.equal(executedTabs[0].tabId, 42);
    assert.equal(executedTabs[0].details.file, "src/content.js");

    // 4. alarms polyfill
    assert.equal(typeof chrome.alarms.create, "function");
    chrome.alarms.create("test-alarm", { delayInMinutes: 1 });
    const alarm = await chrome.alarms.get("test-alarm");
    assert.equal(alarm.name, "test-alarm");
    await chrome.alarms.clear("test-alarm");
    assert.equal(await chrome.alarms.get("test-alarm"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps storage.session isolated from storage.local", async () => {
  const root = mkdtempSync(join(tmpdir(), "ego-session-storage-"));
  const source = join(root, "source");
  const runtime = join(root, "runtime");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "background.js"), "true;", "utf8");
  writeFileSync(join(source, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name: "Session Storage",
    version: "1.0.0",
    background: { service_worker: "background.js" },
  }), "utf8");
  try {
    const prepared = prepareExtensionRuntime(source, runtime);
    const local = new Map();
    const chrome = {
      storage: {
        local: {
          async get() { return Object.fromEntries(local); },
          async set(values) { for (const [key, value] of Object.entries(values)) local.set(key, value); },
        },
      },
      runtime: { getManifest: () => ({}) },
    };
    runInNewContext(readFileSync(join(prepared.path, "electron-compat.js"), "utf8"), {
      chrome,
      console,
      navigator: { userAgent: "Chrome/142.0.0.0 Electron/43.1.0" },
    });
    await chrome.storage.local.set({ persisted: "yes" });
    await chrome.storage.session.set({ ephemeral: "yes" });
    assert.equal((await chrome.storage.local.get(null)).persisted, "yes");
    assert.equal((await chrome.storage.session.get(null)).ephemeral, "yes");
    assert.equal((await chrome.storage.local.get(null)).ephemeral, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports unsupported manifest capabilities instead of hiding them", () => {
  const result = analyzeExtensionCompatibility({
    manifest_version: 3,
    name: "Rules extension",
    permissions: ["storage", "declarativeNetRequest", "offscreen"],
    declarative_net_request: { rule_resources: [] },
  });
  assert.equal(result.level, "limited");
  assert.deepEqual(result.missingCapabilities.map((item) => item.capability), [
    "declarativeNetRequest",
    "offscreen",
    "declarativeNetRequest",
  ]);
  assert.equal(result.capabilities.storage, "native");
  assert.equal(result.capabilities.declarativeNetRequest, "unsupported");
});
