import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installTargetedExtensionClient } from "./extension-targeted-client.mjs";

const ADAPTER_VERSION = 5;
const TARGETED_ADAPTER_VERSION = 1;

const VIOLENTMONKEY_EXTENSION_ID = "eeagobfjdenkkddmbclomhiblgggliao";
const VIOLENTMONKEY_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0HnVQ3f6j/JTjpacyTySZP2xrYDhJvxkvenUEBDPTgY4TlGWpQYoVRXR9fRryaM2Z36CaYvRVZv4LYQZAoSg7TNIrmJtjJ5OgRlTOH+bPKnDbAnLjrQnQklsbuzp9xxRle6AKjUP9XYI6Kl0nTDg1UllBjEDQNd8K+xaEA9nazbqLhQ45BSNgmcpe9eSVQeYpsWDrBO12zS50kVMLMsU47npJSCECwDoKDVFMhBrqazNXZKRdAxp79qMfvRYfAaqViRyl13ZWedZhRTjc4dte3jznEdzx7Fh9VhdaIrXj7nsNwa/fmoaySahMII+RZQMLsE+pNeOXwJa8881G3PHVQIDAQAB";
const IMMERSIVE_TRANSLATE_EXTENSION_ID = "amkbmndfnliijdhojkpoglbnaaahippg";
const IMMERSIVE_TRANSLATE_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArtwT/I0iOW23jkiXNSf932R1TR5hHUxHA/7xc6GPmeoaS9Rtfazp3jNFp/fm4ptczZARfdNcM/zwNUbBOkgZzloHN24RK1aU7VXtNtfHkRJLhilHOEVKQOZt3NlBxSmKpELaH5Ij/yl5PIeeze/kxaZ2q3l62XhrHeCW5KA3WqksbolI1wIshbioVMLL7bkwqNf8FRHBvVjw0TwEkBAc/2g8/uPS/Eoe/4ukNYrVjCbNEPMGMHu8qcQSxkIdiLNIM/Kf+ugUBAjhlJNuxu8ckZ9MzEzyrssyEA3ye/HEGoxkuPYE2WCcin27sLl69ZZmZG0ueqTFQni3Abn5XvK1mwIDAQAB";

const ELECTRON_SUPPORTED_PERMISSIONS = new Set([
  "activeTab",
  "management",
  "scripting",
  "storage",
  "tabs",
  "unlimitedStorage",
  "webRequest",
  "webRequestBlocking",
]);

const UNSUPPORTED_MANIFEST_PERMISSIONS = new Set([
  "declarativeNetRequest",
  "declarativeNetRequestFeedback",
  "declarativeNetRequestWithHostAccess",
  "offscreen",
  "sidePanel",
  "identity",
  "nativeMessaging",
  "debugger",
]);

const RUNTIME_CAPABILITIES = Object.freeze({
  action: "native",
  alarms: "polyfill",
  browserAction: "native",
  contextMenus: "diagnostic-only",
  cookies: "native-or-unsupported",
  scripting: "native-or-tabs-fallback",
  storage: "native",
  storageSession: "isolated-memory",
  tabs: "partial-native",
  webNavigation: "partial-native",
  webRequest: "native",
  windows: "partial-native",
  userScripts: "native-or-virtual",
  offscreen: "unsupported",
  sidePanel: "unsupported",
  declarativeNetRequest: "unsupported",
  identity: "unsupported",
});

export function extensionCapabilityReport(manifest = {}) {
  const permissions = [...new Set([
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
  ].filter((value) => typeof value === "string" && !isHostPermission(value)))];
  const missingCapabilities = permissions
    .filter((permission) => UNSUPPORTED_MANIFEST_PERMISSIONS.has(permission))
    .map((permission) => ({
      capability: permission,
      status: "unsupported",
      detail: `${permission} 在当前扩展运行时没有真实实现`,
    }));
  if (manifest.declarative_net_request) {
    missingCapabilities.push({
      capability: "declarativeNetRequest",
      status: "unsupported",
      detail: "声明式网络规则尚未接入 EgoLite 网络规则服务",
    });
  }
  return {
    capabilities: { ...RUNTIME_CAPABILITIES },
    requiredCapabilities: permissions,
    missingCapabilities,
  };
}

export function analyzeExtensionCompatibility(manifest = {}) {
  const permissions = [...new Set([
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
  ].filter((value) => typeof value === "string" && !isHostPermission(value)))];
  const unsupportedPermissions = permissions.filter((permission) => !ELECTRON_SUPPORTED_PERMISSIONS.has(permission));
  const name = [manifest.name, manifest.short_name, manifest.description].filter(Boolean).join(" ");
  const extensionId = extensionIdFromManifest(manifest);
  const violentmonkey = /violentmonkey|暴力猴/i.test(name)
    || extensionId === VIOLENTMONKEY_EXTENSION_ID
    || manifest.key === VIOLENTMONKEY_PUBLIC_KEY;
  const immersiveTranslate = /immersive\s*translate|沉浸式翻译/i.test(name)
    || extensionId === IMMERSIVE_TRANSLATE_EXTENSION_ID
    || manifest.key === IMMERSIVE_TRANSLATE_PUBLIC_KEY;
  const hasMv3Worker = Number(manifest.manifest_version) === 3 && typeof manifest.background?.service_worker === "string";
  const hasActiveTab = Array.isArray(manifest.permissions) && manifest.permissions.includes("activeTab");
  const capabilityReport = extensionCapabilityReport(manifest);

  if (violentmonkey && hasMv3Worker) {
    return {
      level: "adapted",
      adapter: "violentmonkey-mv3",
      label: "Electron 兼容模式",
      detail: "使用独立运行副本和持久后台页，优先保障用户脚本存储、注册、注入与扩展弹窗。",
      unsupportedPermissions,
      ...capabilityReport,
    };
  }
  if (immersiveTranslate && hasMv3Worker) {
    return {
      level: "adapted",
      adapter: "immersive-translate-mv3",
      label: "Electron 兼容模式",
      detail: "使用独立运行副本和持久后台页，保留页面翻译、扩展弹窗与 MV2 webRequest 降级路径。",
      unsupportedPermissions,
      ...capabilityReport,
    };
  }
  if (hasMv3Worker || hasActiveTab) {
    return {
      level: "adapted",
      adapter: "general-mv3",
      label: "Electron 兼容模式",
      detail: "使用独立运行副本和持久后台页，自动适配后台服务与页面宿主权限。",
      unsupportedPermissions,
      ...capabilityReport,
    };
  }
  if (unsupportedPermissions.length || capabilityReport.missingCapabilities.length) {
    return {
      level: "limited",
      adapter: "",
      label: "部分兼容",
      detail: `当前运行时未完整实现：${[...new Set([
        ...unsupportedPermissions,
        ...capabilityReport.missingCapabilities.map((item) => item.capability),
      ])].join("、")}`,
      unsupportedPermissions,
      ...capabilityReport,
    };
  }
  return {
    level: "native",
    adapter: "",
    label: "原生兼容",
    detail: "扩展只使用 Electron 已实现的 Chromium 扩展能力。",
    unsupportedPermissions: [],
    ...capabilityReport,
  };
}

export function prepareExtensionRuntime(sourcePath, runtimeRoot) {
  const manifest = JSON.parse(readFileSync(join(sourcePath, "manifest.json"), "utf8"));
  const compatibility = analyzeExtensionCompatibility(manifest);
  if (!compatibility.adapter) return { path: sourcePath, compatibility };

  const violentmonkey = compatibility.adapter === "violentmonkey-mv3";
  const general = compatibility.adapter === "general-mv3";
  const targeted = process.env.EGO_TARGETED_EXTENSIONS !== '0' && (
    (violentmonkey && manifest.version === '2.48.0')
    || (general && manifest.name === 'OpenJobAutofill' && manifest.version === '1.4.1')
  );
  compatibility.targeted = targeted;
  if (targeted) {
    compatibility.capabilities = { ...compatibility.capabilities, action: 'host-backed', alarms: 'host-backed', contextMenus: 'host-backed', storageSession: 'shared-session', permissions: 'host-backed', tabs: 'host-backed-subset', ...(violentmonkey ? { offscreen: 'violentmonkey-adapter', declarativeNetRequest: 'background-exact-url-headers' } : {}) };
    compatibility.detail = violentmonkey
      ? '暴力猴 2.48.0 定向适配，支持脚本管理、注入、GM 存储和普通网络请求；云同步授权与通用网络规则暂不支持。'
      : 'OpenJobAutofill 1.4.1 定向适配，支持设置页、当前页面注入、共享会话存储与网站授权。';
  }
  const compatibilitySource = targeted ? `(${installTargetedExtensionClient.toString()})();\n` : violentmonkey
    ? violentmonkeyCompatibilitySource()
    : general
    ? generalCompatibilitySource()
    : "";
  const initialDataSource = violentmonkey ? violentmonkeyInitialDataSource() : "";
  const backgroundPage = violentmonkey
    ? violentmonkeyBackgroundPage()
    : persistentBackgroundPage(manifest.background?.service_worker, manifest.background?.type, general);
  const contentProbe = violentmonkey && !targeted ? `document.documentElement.setAttribute("data-ego-extension-runtime", "ready");
chrome.runtime.sendMessage({ cmd: "EgoCompatRunUserScripts", url: location.href }).then(
  value => document.documentElement.setAttribute("data-ego-extension-response", JSON.stringify(value)),
  error => document.documentElement.setAttribute("data-ego-extension-response", JSON.stringify({ error: error?.message || String(error) })),
);\n` : "";
  const runtimeManifest = violentmonkey
    ? adaptViolentmonkeyManifest(manifest)
    : general
    ? adaptGeneralManifest(manifest)
    : adaptImmersiveTranslateManifest(manifest);
  if (targeted) {
    // Native MV2 injection needs declared origins; the host enforces grants before injection.
    runtimeManifest.permissions = [...new Set([...runtimeManifest.permissions, ...(manifest.optional_host_permissions || [])])];
    runtimeManifest.permissions = runtimeManifest.permissions.filter(permission => permission !== 'scripting');
    if (violentmonkey) {
      runtimeManifest.content_scripts = runtimeManifest.content_scripts.map(script => ({ ...script, js: script.js.filter(file => file !== 'electron-content.js') }));
    }
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ adapter: compatibility.adapter, adapterVersion: targeted ? `targeted-${TARGETED_ADAPTER_VERSION}` : ADAPTER_VERSION, manifest }))
    .update(JSON.stringify(runtimeManifest))
    .update(compatibilitySource)
    .update(initialDataSource)
    .update(backgroundPage)
    .update(contentProbe)
    .update(targeted ? extensionSourceFingerprint(sourcePath) : '')
    .update(targeted ? readFileSync(fileURLToPath(import.meta.url)) : '')
    .digest("hex")
    .slice(0, 16);
  const prefix = `${safeName(basename(sourcePath))}-${compatibility.adapter}-`;
  // Preserve the path-derived ID of previously installed keyless extensions.
  const previous = targeted && existsSync(runtimeRoot) ? readdirSync(runtimeRoot, { withFileTypes: true }).find(entry => {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix) || entry.name.includes('.backup-') || entry.name.endsWith('.staging')) return false;
    try { return JSON.parse(readFileSync(join(runtimeRoot, entry.name, '.ego-runtime.json'), 'utf8')).sourcePath === sourcePath; } catch { return false; }
  }) : null;
  const runtimePath = join(runtimeRoot, previous?.name || `${prefix}${fingerprint}`);
  let existingFingerprint;
  try { existingFingerprint = JSON.parse(readFileSync(join(runtimePath, '.ego-runtime.json'), 'utf8')).fingerprint; } catch {}
  if (!existsSync(join(runtimePath, ".ego-runtime.json")) || (targeted && existingFingerprint !== fingerprint)) {
    mkdirSync(runtimeRoot, { recursive: true });
    for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
      if (!targeted && entry.isDirectory() && entry.name.startsWith(prefix) && entry.name !== basename(runtimePath)) {
        rmSync(join(runtimeRoot, entry.name), { recursive: true, force: true });
      }
    }
    let backup;
    try {
    if (targeted && existsSync(runtimePath)) {
      backup = `${runtimePath}.backup-${Date.now()}`;
      renameSync(runtimePath, backup);
    } else rmSync(runtimePath, { recursive: true, force: true });
    cpSync(sourcePath, runtimePath, { recursive: true, filter: path => !targeted || !['.git', 'node_modules', '.tmp', 'output', 'release'].includes(basename(path)) });
    if (manifest.background?.service_worker || manifest.background?.scripts || violentmonkey) {
      writeFileSync(join(runtimePath, "electron-background.html"), backgroundPage, "utf8");
    }
    writeFileSync(join(runtimePath, "manifest.json"), JSON.stringify(runtimeManifest, null, 2), "utf8");
    if (compatibilitySource) {
      writeFileSync(join(runtimePath, "electron-compat.js"), compatibilitySource, "utf8");
    }
    if (violentmonkey) {
      writeFileSync(join(runtimePath, "electron-get-data.js"), initialDataSource, "utf8");
      writeFileSync(join(runtimePath, "electron-content.js"), contentProbe, "utf8");
      for (const page of ["popup/index.html", "options/index.html", "confirm/index.html"]) {
        const pagePath = join(runtimePath, page);
        if (!existsSync(pagePath)) continue;
        let html = readFileSync(pagePath, "utf8");
        if (targeted) {
          const scripts = [];
          // These three upstream entrypoints contain only external classic scripts.
          html = html.replace(/<script\s+src=(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*><\/script>/gi, (_tag, double, single, bare) => { scripts.push(double || single || bare); return ''; });
          const kind = page.split('/')[0];
          writeFileSync(join(runtimePath, kind, 'electron-page.js'), `(${async function(kind, scripts) {
            const response = await egoExtensionHost.call('violentmonkey.initialData', [kind]);
            if (response.error) throw new Error(response.error);
            globalThis.BGDATA = response.value;
            for (const src of scripts.filter(src => !src.startsWith('/get-data.js?'))) {
              await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = reject; document.head.append(script); });
            }
          }.toString()})(${JSON.stringify(kind)}, ${JSON.stringify(scripts)}).catch(console.error);`, 'utf8');
          html += `<script src="/electron-compat.js"></script><script src="/${kind}/electron-page.js"></script>`;
        } else html = html.replace("/get-data.js?", "/electron-get-data.js?");
        writeFileSync(pagePath, html, "utf8");
      }
      if (targeted && existsSync(join(runtimePath, 'offscreen/index.html'))) {
        const page = join(runtimePath, 'offscreen/index.html');
        writeFileSync(page, '<script src="/electron-compat.js"></script>' + readFileSync(page, 'utf8'), 'utf8');
      }
      if (targeted && existsSync(join(runtimePath, 'injected.js'))) {
        const injectedPath = join(runtimePath, 'injected.js');
        writeFileSync(injectedPath, readFileSync(injectedPath, 'utf8').replace('.catch(!1)', '.catch(error=>console.error("[EgoLite userscript injection]",error))'), 'utf8');
      }
    }
    if (general) {
      injectCompatIntoHtmlPages(runtimePath);
    }
    writeFileSync(join(runtimePath, ".ego-runtime.json"), JSON.stringify({
      adapter: compatibility.adapter,
      adapterVersion: targeted ? `targeted-${TARGETED_ADAPTER_VERSION}` : ADAPTER_VERSION,
      sourcePath,
      sourceVersion: manifest.version || "",
      fingerprint,
    }, null, 2), "utf8");
    } catch (error) {
      if (backup) {
        rmSync(runtimePath, { recursive: true, force: true });
        renameSync(backup, runtimePath);
      }
      throw error;
    }
  }
  return { path: runtimePath, compatibility };
}

function extensionSourceFingerprint(directory) {
  const hash = createHash('sha256');
  const visit = (path, relative = '') => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', 'node_modules', '.tmp', 'output', 'release'].includes(entry.name)) continue;
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(join(path, entry.name), name);
      else if (entry.isFile()) hash.update(name).update(readFileSync(join(path, entry.name)));
    }
  };
  visit(directory);
  return hash.digest('hex');
}

function adaptViolentmonkeyManifest(input) {
  const manifest = structuredClone(input);
  manifest.manifest_version = 2;
  manifest.background = { page: "electron-background.html", persistent: true };
  manifest.browser_action = manifest.action;
  delete manifest.action;
  delete manifest.minimum_chrome_version;
  const permissions = [...new Set([
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
  ])];
  manifest.permissions = permissions.filter((permission) => isHostPermission(permission) || [
    "tabs", "storage", "unlimitedStorage", "clipboardWrite", "webRequest", "webRequestBlocking",
  ].includes(permission));
  manifest.optional_permissions = [];
  if (manifest.commands?._execute_action) delete manifest.commands._execute_action;
  manifest.content_scripts = [
    ...(Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []),
    {
      matches: ["<all_urls>"],
      js: ["electron-content.js", "injected-web.js", "injected.js"],
      all_frames: true,
      match_about_blank: true,
      run_at: "document_start",
    },
  ];
  delete manifest.host_permissions;
  if (Array.isArray(manifest.web_accessible_resources)) {
    manifest.web_accessible_resources = [...new Set(manifest.web_accessible_resources.flatMap((entry) => (
      typeof entry === "string" ? [entry] : Array.isArray(entry?.resources) ? entry.resources : []
    )))];
  }
  return manifest;
}

function adaptImmersiveTranslateManifest(input) {
  const manifest = structuredClone(input);
  const declaredPermissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const optionalPermissions = Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : [];
  const hostPermissions = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  const optionalHostPermissions = Array.isArray(manifest.optional_host_permissions) ? manifest.optional_host_permissions : [];
  const dnrPermissions = new Set([
    "declarativeNetRequest",
    "declarativeNetRequestFeedback",
    "declarativeNetRequestWithHostAccess",
  ]);
  const mv3OnlyPermissions = new Set([...dnrPermissions, "offscreen", "sidePanel"]);
  const usesDeclarativeRules = Boolean(manifest.declarative_net_request)
    || declaredPermissions.some((permission) => dnrPermissions.has(permission));

  manifest.manifest_version = 2;
  manifest.background = { page: "electron-background.html", persistent: true };
  if (manifest.action && typeof manifest.action === "object") manifest.browser_action = manifest.action;
  delete manifest.action;
  delete manifest.minimum_chrome_version;

  manifest.permissions = [...new Set([
    ...declaredPermissions.filter((permission) => !mv3OnlyPermissions.has(permission)),
    ...hostPermissions,
    ...(usesDeclarativeRules ? ["webRequest", "webRequestBlocking"] : []),
  ])];
  manifest.optional_permissions = [...new Set([
    ...optionalPermissions.filter((permission) => !mv3OnlyPermissions.has(permission)),
    ...optionalHostPermissions,
  ])];
  delete manifest.host_permissions;
  delete manifest.optional_host_permissions;
  delete manifest.declarative_net_request;
  delete manifest.side_panel;

  if (manifest.commands?._execute_action) {
    manifest.commands._execute_browser_action ||= manifest.commands._execute_action;
    delete manifest.commands._execute_action;
  }
  if (manifest.content_security_policy && typeof manifest.content_security_policy === "object") {
    const extensionPages = manifest.content_security_policy.extension_pages;
    if (typeof extensionPages === "string" && extensionPages.trim()) manifest.content_security_policy = extensionPages;
    else delete manifest.content_security_policy;
  }
  manifest.web_accessible_resources = flattenWebAccessibleResources(manifest.web_accessible_resources);
  return manifest;
}

function flattenWebAccessibleResources(resources) {
  if (!Array.isArray(resources)) return resources;
  return [...new Set(resources.flatMap((entry) => (
    typeof entry === "string" ? [entry] : Array.isArray(entry?.resources) ? entry.resources : []
  )))];
}

function adaptGeneralManifest(input) {
  const manifest = structuredClone(input);
  const declaredPermissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const optionalPermissions = Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : [];
  const hostPermissions = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  const optionalHostPermissions = Array.isArray(manifest.optional_host_permissions) ? manifest.optional_host_permissions : [];

  const dnrPermissions = new Set([
    "declarativeNetRequest",
    "declarativeNetRequestFeedback",
    "declarativeNetRequestWithHostAccess",
  ]);
  const mv3OnlyPermissions = new Set([...dnrPermissions, "offscreen", "sidePanel"]);

  manifest.manifest_version = 2;
  if (manifest.background?.service_worker || manifest.background?.scripts) {
    manifest.background = { page: "electron-background.html", persistent: true };
  }
  if (manifest.action && typeof manifest.action === "object") {
    manifest.browser_action = manifest.action;
  }
  delete manifest.action;
  delete manifest.minimum_chrome_version;

  const filteredPermissions = declaredPermissions.filter((permission) => !mv3OnlyPermissions.has(permission));
  const mergedPermissions = new Set([
    ...filteredPermissions,
    ...hostPermissions,
  ]);

  manifest.permissions = [...mergedPermissions];

  manifest.optional_permissions = [
    ...new Set(optionalPermissions.filter((permission) => !mv3OnlyPermissions.has(permission))),
  ];

  delete manifest.host_permissions;
  delete manifest.optional_host_permissions;
  delete manifest.declarative_net_request;
  delete manifest.side_panel;

  if (manifest.commands?._execute_action) {
    manifest.commands._execute_browser_action ||= manifest.commands._execute_action;
    delete manifest.commands._execute_action;
  }

  if (manifest.content_security_policy && typeof manifest.content_security_policy === "object") {
    const extensionPages = manifest.content_security_policy.extension_pages;
    if (typeof extensionPages === "string" && extensionPages.trim()) manifest.content_security_policy = extensionPages;
    else delete manifest.content_security_policy;
  }

  manifest.web_accessible_resources = flattenWebAccessibleResources(manifest.web_accessible_resources);
  return manifest;
}

function injectCompatIntoHtmlPages(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      injectCompatIntoHtmlPages(fullPath);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html") && entry.name !== "electron-background.html") {
      try {
        let content = readFileSync(fullPath, "utf8");
        if (!content.includes("electron-compat.js")) {
          if (/<head[^>]*>/i.test(content)) {
            content = content.replace(/(<head[^>]*>)/i, '$1\n  <script src="/electron-compat.js"></script>');
          } else {
            content = `<script src="/electron-compat.js"></script>\n${content}`;
          }
          writeFileSync(fullPath, content, "utf8");
        }
      } catch (err) {
        console.warn(`[EgoLite] Failed to inject electron-compat.js into ${fullPath}:`, err);
      }
    }
  }
}

function persistentBackgroundPage(worker, type, includeCompat = false) {
  const source = extensionResourceUrl(worker || "background.js");
  const scriptType = type === "module" ? ' type="module"' : "";
  const compatScript = includeCompat ? '<script src="/electron-compat.js"></script>\n' : "";
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>EgoLite extension runtime</title></head>
<body>
${compatScript}<script${scriptType} src="${escapeHtmlAttribute(source)}"></script>
</body>
</html>
`;
}

function extensionResourceUrl(value) {
  const path = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!path || path.split("/").includes("..")) throw new Error("扩展后台脚本路径无效");
  return `/${path}`;
}

function escapeHtmlAttribute(value) {
  return String(value).replace(/[&"'<>]/g, (character) => ({
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
    "<": "&lt;",
    ">": "&gt;",
  })[character]);
}

function violentmonkeyCompatibilitySource() {
  return `"use strict";
(() => {
  const api = globalThis.chrome;
  if (!api) return;
  const getManifest = api.runtime.getManifest.bind(api.runtime);
  api.runtime.getManifest = () => {
    const manifest = getManifest();
    manifest.action ||= manifest.browser_action;
    return manifest;
  };
  api.runtime.getBrowserInfo ||= async () => {
    const userAgent = String(globalThis.navigator?.userAgent || "");
    const chromiumVersion = userAgent.match(/(?:Chrome|Chromium)\\/([\\d.]+)/i)?.[1] || "0";
    const electronVersion = userAgent.match(/Electron\\/([\\d.]+)/i)?.[1] || "";
    return {
      name: "EgoLite",
      vendor: "EgoLite",
      version: chromiumVersion,
      buildID: electronVersion ? \`Electron \${electronVersion}\` : "Electron",
    };
  };
  const event = () => {
    const listeners = new Set();
    return {
      addListener(listener) { if (typeof listener === "function") listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      hasListener(listener) { return listeners.has(listener); },
      hasListeners() { return listeners.size > 0; },
      dispatch(...args) { for (const listener of [...listeners]) listener(...args); },
    };
  };
  const call = async (target, method, ...args) => {
    if (typeof target?.[method] !== "function") throw new Error(\`chrome.\${method} is unavailable in Electron\`);
    try {
      const result = target[method](...args);
      if (result?.then) return await result;
      if (result !== undefined) return result;
    } catch (promiseError) {
      return await new Promise((resolve, reject) => {
        try {
          target[method](...args, value => {
            const error = api.runtime?.lastError;
            if (error) reject(new Error(error.message));
            else resolve(value);
          });
        } catch { reject(promiseError); }
      });
    }
    return await new Promise((resolve, reject) => {
      try {
        target[method](...args, value => {
          const error = api.runtime?.lastError;
          if (error) reject(new Error(error.message));
          else resolve(value);
        });
      } catch (error) { reject(error); }
    });
  };
  const compatScriptKey = "__egoCompatUserScripts";
  const readCompatScripts = async () => (await call(api.storage.local, "get", compatScriptKey))?.[compatScriptKey] || [];
  const writeCompatScripts = scripts => call(api.storage.local, "set", { [compatScriptKey]: scripts });
  const metaValues = (code, name) => [...String(code || "").matchAll(new RegExp("^\\\\s*//\\\\s*@" + name + "\\\\s+(.+)$", "gmi"))].map(match => match[1].trim());
  const scriptIdentity = code => [metaValues(code, "namespace")[0] || "", metaValues(code, "name")[0] || ""].join("\\n");
  const matchesPattern = (pattern, url) => {
    if (pattern === "<all_urls>") return /^(https?|file):/.test(url);
    const expression = String(pattern).replace(/[.+?^{}$()|[\\]\\\\]/g, "\\\\$&").replace(/\\\*/g, ".*");
    try { return new RegExp("^" + expression + "$").test(url); } catch { return false; }
  };
  const scriptMatches = (script, url) => {
    const matches = script.matches?.length ? script.matches : script.includes?.length ? script.includes : ["<all_urls>"];
    return matches.some(pattern => matchesPattern(pattern, url)) && !(script.excludes || []).some(pattern => matchesPattern(pattern, url));
  };
  const storeCompatScript = async code => {
    const scripts = await readCompatScripts();
    const record = {
      id: scriptIdentity(code),
      code,
      matches: metaValues(code, "match"),
      includes: metaValues(code, "include"),
      excludes: [...metaValues(code, "exclude"), ...metaValues(code, "exclude-match")],
      enabled: true,
    };
    const index = scripts.findIndex(script => script.id === record.id);
    if (index >= 0) scripts[index] = record;
    else scripts.push(record);
    await writeCompatScripts(scripts);
    return true;
  };

  api.extension ||= {};
  api.extension.inIncognitoContext ||= false;
  api.extension.isAllowedIncognitoAccess ||= async () => false;
  api.extension.isAllowedFileSchemeAccess ||= async () => false;
  api.permissions ||= {
    onAdded: event(),
    onRemoved: event(),
    contains: async () => false,
    getAll: async () => ({ permissions: [], origins: [] }),
    request: async () => false,
    remove: async () => false,
  };
  api.storage ||= {};
  if (!api.storage.session || api.storage.session === api.storage.local) {
    const sessionValues = new Map();
    api.storage.session = {
      async get(keys) {
        if (keys == null) return Object.fromEntries(sessionValues);
        const requested = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const result = {};
        for (const key of requested) {
          if (sessionValues.has(key)) result[key] = sessionValues.get(key);
          else if (keys && typeof keys === "object" && !Array.isArray(keys) && Object.prototype.hasOwnProperty.call(keys, key)) result[key] = keys[key];
        }
        return result;
      },
      async set(values = {}) { for (const [key, value] of Object.entries(values)) sessionValues.set(key, value); },
      async remove(keys) { for (const key of (Array.isArray(keys) ? keys : [keys])) sessionValues.delete(key); },
      async clear() { sessionValues.clear(); },
      async getBytesInUse() { return 0; },
    };
  }
  api.storage.session ||= {
    async get() { return {}; }, async set() {}, async remove() {}, async clear() {}, async getBytesInUse() { return 0; },
  };
  api.storage.session.QUOTA_BYTES ||= 10 * 1024 * 1024;

  const alarmEvent = event();
  const alarms = new Map();
  api.alarms ||= {};
  api.alarms.onAlarm ||= alarmEvent;
  api.alarms.get ||= async name => alarms.get(name);
  api.alarms.clear ||= async name => {
    const alarm = alarms.get(name);
    if (!alarm) return false;
    clearTimeout(alarm.timer); clearInterval(alarm.timer); alarms.delete(name); return true;
  };
  api.alarms.create ||= (name, info = {}) => {
    void api.alarms.clear(name);
    const delay = Math.max(1, Number(info.delayInMinutes || info.periodInMinutes || 1)) * 60_000;
    const record = { name, scheduledTime: Date.now() + delay };
    record.timer = info.periodInMinutes
      ? setInterval(() => alarmEvent.dispatch({ name, scheduledTime: Date.now() }), delay)
      : setTimeout(() => { alarms.delete(name); alarmEvent.dispatch({ name, scheduledTime: Date.now() }); }, delay);
    alarms.set(name, record);
  };

  api.contextMenus ||= {
    onClicked: event(),
    create() { throw new Error("chrome.contextMenus is not connected to the EgoLite browser menu service"); },
    update: async () => { throw new Error("chrome.contextMenus.update is not supported by the EgoLite runtime"); },
    remove: async () => { throw new Error("chrome.contextMenus.remove is not supported by the EgoLite runtime"); },
    removeAll: async () => { throw new Error("chrome.contextMenus.removeAll is not supported by the EgoLite runtime"); },
  };
  api.commands ||= { onCommand: event(), getAll: async () => [] };
  api.notifications ||= { onClicked: event(), onClosed: event(), create: async () => "", clear: async () => true };
  api.offscreen ||= {
    createDocument: async () => { throw new Error("chrome.offscreen is not supported by the EgoLite runtime"); },
    closeDocument: async () => { throw new Error("chrome.offscreen is not supported by the EgoLite runtime"); },
    hasDocument: async () => false,
  };
  api.identity ||= {
    getRedirectURL: path => \`https://egolite.invalid/\${path || ""}\`,
    launchWebAuthFlow: async () => { throw new Error("chrome.identity.launchWebAuthFlow is not supported by the EgoLite runtime"); },
  };
  api.declarativeNetRequest ||= {
    getDynamicRules: async () => [],
    updateDynamicRules: async () => { throw new Error("chrome.declarativeNetRequest is not supported by the EgoLite runtime"); },
    getSessionRules: async () => [],
    updateSessionRules: async () => { throw new Error("chrome.declarativeNetRequest is not supported by the EgoLite runtime"); },
  };
  api.cookies ||= {
    get: async () => { throw new Error("chrome.cookies is not available in this extension context"); },
    getAll: async () => { throw new Error("chrome.cookies is not available in this extension context"); },
    set: async () => { throw new Error("chrome.cookies is not available in this extension context"); },
    remove: async () => { throw new Error("chrome.cookies is not available in this extension context"); },
  };
  api.webRequest ||= {};
  for (const name of ["onBeforeRequest", "onBeforeSendHeaders", "onHeadersReceived", "onSendHeaders", "onCompleted", "onErrorOccurred"]) {
    api.webRequest[name] ||= event();
  }
  api.webRequest.OnBeforeSendHeadersOptions ||= { EXTRA_HEADERS: "extraHeaders", REQUEST_HEADERS: "requestHeaders" };
  api.webRequest.OnHeadersReceivedOptions ||= { BLOCKING: "blocking", EXTRA_HEADERS: "extraHeaders", RESPONSE_HEADERS: "responseHeaders" };
  api.webNavigation ||= {};
  api.webNavigation.onCommitted ||= event();
  api.windows ||= {
    WINDOW_ID_CURRENT: -2,
    onCreated: event(),
    getCurrent: async () => ({ id: -2, focused: true }),
    getAll: async () => [{ id: -2, focused: true }],
    create: async changes => ({ id: -2, focused: true, ...changes }),
    update: async (id, changes) => ({ id, ...changes }),
  };
  api.windows.onCreated ||= event();
  api.windows.getAll ||= async () => [await api.windows.getCurrent()];
  api.windows.create ||= async changes => ({ id: -2, focused: true, ...changes });
  api.tabs ||= {};
  for (const name of ["onActivated", "onRemoved", "onReplaced", "onUpdated"]) api.tabs[name] ||= event();
  api.tabs.get ||= async id => (await call(api.tabs, "query", {})).find(tab => tab.id === id);
  api.tabs.create ||= async changes => {
    const [active] = await call(api.tabs, "query", { active: true, currentWindow: true });
    return active ? call(api.tabs, "update", active.id, changes) : { id: -1, ...changes };
  };
  api.tabs.remove ||= async () => {};
  api.tabs.reload ||= async tabId => call(api.tabs, "update", tabId, { url: (await api.tabs.get(tabId))?.url });
  api.runtime.onInstalled ||= event();
  api.runtime.onMessage.addListener((message, sender) => {
    if (message?.cmd === "ParseScript" && typeof message.data?.code === "string") {
      void storeCompatScript(message.data.code).catch(error => console.error("[EgoLite] Failed to persist compatibility userscript", error));
      return undefined;
    }
    if (message?.cmd === "EgoCompatStoreUserScript" && typeof message.data?.code === "string") return storeCompatScript(message.data.code);
    if (message?.cmd === "EgoCompatRunUserScripts") {
      return (async () => {
        const scripts = (await readCompatScripts()).filter(script => script.enabled !== false && scriptMatches(script, String(message.url || sender?.url || "")));
        if (!sender?.tab?.id || typeof api.tabs.executeScript !== "function") return { executed: 0, unavailable: "tabs.executeScript" };
        let executed = 0;
        for (const script of scripts) {
          await call(api.tabs, "executeScript", sender.tab.id, {
            code: script.code,
            ...(Number.isInteger(sender.frameId) ? { frameId: sender.frameId } : {}),
            runAt: "document_start",
          });
          executed += 1;
        }
        return { executed };
      })();
    }
    return undefined;
  });

  api.userScripts ||= {};
  const virtualUserScripts = new Map([["1001", {
    id: "1001",
    runAt: "document_start",
    allFrames: true,
    matches: ["<all_urls>"],
    js: [{ file: "injected-web.js" }, { file: "injected.js" }],
  }]]);
  api.userScripts.configureWorld ||= async () => {};
  api.userScripts.getScripts ||= async filter => {
    if (!api.scripting?.getRegisteredContentScripts) {
      const ids = Array.isArray(filter?.ids) ? new Set(filter.ids) : null;
      return [...virtualUserScripts.values()].filter(script => !ids || ids.has(script.id));
    }
    const scripts = await call(api.scripting, "getRegisteredContentScripts", filter || {});
    return scripts.map(script => ({ ...script, js: (script.js || []).map(file => ({ file })) }));
  };
  api.userScripts.register ||= async scripts => {
    if (!api.scripting?.registerContentScripts) {
      for (const script of scripts) virtualUserScripts.set(script.id, script);
      return;
    }
    return call(api.scripting, "registerContentScripts", scripts.map(script => ({
      id: script.id,
      matches: script.matches,
      excludeMatches: script.excludeMatches,
      js: (script.js || []).map(item => item.file).filter(Boolean),
      allFrames: script.allFrames,
      runAt: script.runAt,
      persistAcrossSessions: true,
      world: "ISOLATED",
    })));
  };
  api.userScripts.update ||= async scripts => {
    if (!api.scripting?.updateContentScripts) {
      for (const script of scripts) {
        const current = virtualUserScripts.get(script.id) || { id: script.id };
        virtualUserScripts.set(script.id, { ...current, ...script });
      }
      return;
    }
    return call(api.scripting, "updateContentScripts", scripts.map(script => {
      const update = { id: script.id };
      if (Array.isArray(script.matches)) update.matches = script.matches;
      if (Array.isArray(script.excludeMatches)) update.excludeMatches = script.excludeMatches;
      if (Array.isArray(script.js)) update.js = script.js.map(item => item.file).filter(Boolean);
      if (typeof script.allFrames === "boolean") update.allFrames = script.allFrames;
      if (typeof script.runAt === "string") update.runAt = script.runAt;
      return update;
    }));
  };
  api.userScripts.unregister ||= async filter => {
    if (!api.scripting?.unregisterContentScripts) {
      if (filter?.ids) for (const id of filter.ids) virtualUserScripts.delete(id);
      else virtualUserScripts.clear();
      return;
    }
    return call(api.scripting, "unregisterContentScripts", filter?.ids ? { ids: filter.ids } : undefined);
  };
  api.userScripts.execute ||= async ({ target, js = [], injectImmediately }) => {
    const results = [];
    const frameIds = target?.frameIds?.length ? target.frameIds : [undefined];
    for (const frameId of frameIds) for (const item of js) {
      const details = { ...(item.file ? { file: item.file } : { code: item.code || "" }), ...(frameId == null ? {} : { frameId }), runAt: injectImmediately ? "document_start" : "document_idle" };
      const value = await call(api.tabs, "executeScript", target.tabId, details);
      results.push({ frameId: frameId || 0, result: Array.isArray(value) ? value[0] : value });
    }
    return results;
  };
  api.runtime.onUserScriptMessage ||= api.runtime.onMessage;
  globalThis.clients ||= { claim: async () => {} };
  globalThis.importScripts ||= (...urls) => {
    const unknown = urls.filter(url => !String(url).endsWith("/public/lib/tld.js"));
    if (unknown.length) console.warn("[EgoLite extension compatibility] ignored importScripts", unknown);
  };
  console.info("[EgoLite] Violentmonkey Electron compatibility runtime active");
})();
`;
}

function violentmonkeyInitialDataSource() {
  return `var BGDATA = {
  opts: {},
  popup: {
    scripts: [[], []],
    domain: "",
    injectionFailure: null,
    injectable: true
  },
  options: {
    scripts: [],
    sizes: {}
  },
  confirm: false
};
(() => {
  try {
    const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (...args) => {
      const message = typeof args[0] === "string" ? args[1] : args[0];
      if (message?.cmd === "ParseScript" && typeof message.data?.code === "string") {
        await sendMessage({ cmd: "EgoCompatStoreUserScript", data: { code: message.data.code } });
      }
      return sendMessage(...args);
    };
  } catch (error) { console.warn("[EgoLite] Unable to hook userscript installation", error); }
})();
`;
}

function violentmonkeyBackgroundPage() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>EgoLite extension runtime</title></head>
<body>
<script src="/public/lib/tld.js"></script>
<script src="/electron-compat.js"></script>
<script src="/sw.js"></script>
</body>
</html>
`;
}

function generalCompatibilitySource() {
  return `"use strict";
(() => {
  const api = globalThis.chrome;
  if (!api) return;

  if (!api.action && api.browserAction) {
    api.action = api.browserAction;
  }
  if (!api.browserAction && api.action) {
    api.browserAction = api.action;
  }

  try {
    globalThis.browser ||= api;
  } catch {}

  const createEvent = () => {
    const listeners = new Set();
    return {
      addListener(listener) { if (typeof listener === "function") listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      hasListener(listener) { return listeners.has(listener); },
      hasListeners() { return listeners.size > 0; },
      dispatch(...args) { for (const listener of [...listeners]) { try { listener(...args); } catch (e) { console.error(e); } } },
    };
  };

  const alarmEvent = createEvent();
  const alarms = new Map();
  api.alarms ||= {};
  api.alarms.onAlarm ||= alarmEvent;
  api.alarms.get ||= async name => alarms.get(name);
  api.alarms.getAll ||= async () => [...alarms.values()].map(({ timer, ...rest }) => rest);
  api.alarms.clear ||= async name => {
    const alarm = alarms.get(name);
    if (!alarm) return false;
    clearTimeout(alarm.timer); clearInterval(alarm.timer); alarms.delete(name); return true;
  };
  api.alarms.clearAll ||= async () => {
    for (const name of alarms.keys()) await api.alarms.clear(name);
    return true;
  };
  api.alarms.create ||= (name, info = {}) => {
    void api.alarms.clear(name);
    const delay = Math.max(0.1, Number(info.delayInMinutes || info.periodInMinutes || 1)) * 60_000;
    const record = { name, scheduledTime: Date.now() + delay, periodInMinutes: info.periodInMinutes };
    record.timer = info.periodInMinutes
      ? setInterval(() => alarmEvent.dispatch({ name, scheduledTime: Date.now() }), delay)
      : setTimeout(() => { alarms.delete(name); alarmEvent.dispatch({ name, scheduledTime: Date.now() }); }, delay);
    alarms.set(name, record);
  };

  api.storage ||= {};
  if (!api.storage.session || api.storage.session === api.storage.local) {
    const sessionValues = new Map();
    api.storage.session = {
      async get(keys) {
        if (keys == null) return Object.fromEntries(sessionValues);
        const requested = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const result = {};
        for (const key of requested) {
          if (sessionValues.has(key)) result[key] = sessionValues.get(key);
          else if (keys && typeof keys === "object" && !Array.isArray(keys) && Object.prototype.hasOwnProperty.call(keys, key)) result[key] = keys[key];
        }
        return result;
      },
      async set(values = {}) { for (const [key, value] of Object.entries(values)) sessionValues.set(key, value); },
      async remove(keys) { for (const key of (Array.isArray(keys) ? keys : [keys])) sessionValues.delete(key); },
      async clear() { sessionValues.clear(); },
      async getBytesInUse() { return 0; },
    };
  }

  api.permissions ||= {
    onAdded: createEvent(),
    onRemoved: createEvent(),
    contains: async () => false,
    getAll: async () => ({ permissions: api.runtime?.getManifest?.()?.permissions || [], origins: ["<all_urls>"] }),
    request: async () => false,
    remove: async () => false,
  };

  if (api.tabs?.query) {
    const originalQuery = api.tabs.query.bind(api.tabs);
    api.tabs.query = (queryInfo, callback) => {
      const run = async () => {
        let tabs = await new Promise((resolve) => {
          try { originalQuery(queryInfo, resolve); } catch { resolve([]); }
        });
        if ((!tabs || tabs.length === 0) && queryInfo?.currentWindow) {
          const fallbackQuery = { ...queryInfo };
          delete fallbackQuery.currentWindow;
          tabs = await new Promise((resolve) => {
            try { originalQuery(fallbackQuery, resolve); } catch { resolve([]); }
          });
        }
        return tabs || [];
      };
      if (typeof callback === "function") {
        run().then(res => callback(res)).catch(() => callback([]));
        return undefined;
      }
      return run();
    };
  }

  api.scripting ||= {};
  const nativeScriptingExecute = typeof api.scripting.executeScript === "function" ? api.scripting.executeScript.bind(api.scripting) : null;
  api.scripting.executeScript = (details, callback) => {
    const run = async () => {
      if (nativeScriptingExecute) {
        try {
          return await nativeScriptingExecute(details);
        } catch (nativeError) {
          if (!api.tabs?.executeScript) throw nativeError;
        }
      }
      const tabId = details?.target?.tabId;
      if (typeof tabId !== "number") throw new Error("scripting.executeScript requires target.tabId");
      const results = [];
      const frameId = details.target?.frameIds?.[0];
      const allFrames = Boolean(details.target?.allFrames);

      if (Array.isArray(details.files)) {
        for (const file of details.files) {
          const res = await new Promise((resolve, reject) => {
            api.tabs.executeScript(tabId, {
              file,
              ...(frameId != null ? { frameId } : {}),
              allFrames,
            }, (val) => {
              const err = api.runtime?.lastError;
              if (err) reject(new Error(err.message));
              else resolve(val);
            });
          });
          results.push({ frameId: frameId || 0, result: Array.isArray(res) ? res[0] : res });
        }
      } else if (typeof details.func === "function") {
        const argsJson = JSON.stringify(details.args || []);
        const code = "(" + details.func.toString() + ")(..." + argsJson + ")";
        const res = await new Promise((resolve, reject) => {
          api.tabs.executeScript(tabId, {
            code,
            ...(frameId != null ? { frameId } : {}),
            allFrames,
          }, (val) => {
            const err = api.runtime?.lastError;
            if (err) reject(new Error(err.message));
            else resolve(val);
          });
        });
        results.push({ frameId: frameId || 0, result: Array.isArray(res) ? res[0] : res });
      }
      return results;
    };

    if (typeof callback === "function") {
      run().then(
        (res) => {
          if (api.runtime) delete api.runtime.lastError;
          callback(res);
        },
        (err) => {
          if (api.runtime) api.runtime.lastError = err;
          callback(undefined);
        }
      );
      return undefined;
    }
    return run();
  };

  api.runtime.getBrowserInfo ||= async () => {
    const userAgent = String(globalThis.navigator?.userAgent || "");
    const chromiumVersion = userAgent.match(/(?:Chrome|Chromium)\\/([\\d.]+)/i)?.[1] || "0";
    const electronVersion = userAgent.match(/Electron\\/([\\d.]+)/i)?.[1] || "";
    return {
      name: "EgoLite",
      vendor: "EgoLite",
      version: chromiumVersion,
      buildID: electronVersion ? "Electron " + electronVersion : "Electron",
    };
  };

  console.info("[EgoLite] Universal extension runtime active");
})();
`;
}

function isHostPermission(value) {
  return value === "<all_urls>" || value.includes("://") || value.startsWith("*://");
}

function extensionIdFromManifest(manifest) {
  for (const value of [manifest.id, manifest.extension_id, manifest.__ego_extension_id]) {
    if (typeof value === "string" && /^[a-p]{32}$/.test(value)) return value;
  }
  if (typeof manifest.key !== "string" || !manifest.key) return "";
  try {
    const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
    return [...digest]
      .flatMap((byte) => [byte >> 4, byte & 15])
      .map((nibble) => String.fromCharCode(97 + nibble))
      .join("");
  } catch {
    return "";
  }
}

function safeName(value) {
  return String(value || "extension").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "extension";
}
