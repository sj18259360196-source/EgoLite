import { spawn, spawnSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PipeRuntimeTransport } from "@ego-compat/runtime-adapter";

const root = fileURLToPath(new URL("..", import.meta.url));
const extensionId = "omdijpknicgkhnpadadcggpnbojohpdc";
const pipeName = process.env.EGO_COMPAT_PIPE || "\\\\.\\pipe\\ego-compat-codex";
const edgeUserData = join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data");
const nativeManifest = join(root, "apps", "native-host", "publish", "com.egocompat.bridge.json");

const checks = {
  extensionSource: await canAccess(join(root, "apps", "companion-extension", "manifest.json")),
  nativeExecutable: await canAccess(join(root, "apps", "native-host", "publish", "ego-native-host.exe")),
  nativeManifest: await validateNativeManifest(),
  edgeRegistry: registryValue("HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.egocompat.bridge"),
  chromeRegistry: registryValue("HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.egocompat.bridge"),
  edgeProfiles: await findEdgeProfiles(),
};

if (!(await canConnect())) startBroker();
const transport = await connectWithRetry(20_000);
let backend;
let taskSpaces = [];
let tabs = [];
try {
  backend = await transport.request("backend.status", { clientId: "companion-doctor" });
  taskSpaces = (await transport.request("space.list", { clientId: "companion-doctor" })).taskSpaces || [];
  const allTabs = await transport.request("tab.listAll", { clientId: "companion-doctor" }).catch(() => []);
  tabs = Array.isArray(allTabs) ? allTabs : allTabs.tabs || [];
} finally {
  await transport.close();
}

const report = { ok: Boolean(backend?.ready), pipeName, checks, backend, taskSpaceCount: taskSpaces.length, tabCount: tabs.length };
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error("\nCompanion is prepared but the extension is not connected. Load/enable it in Edge, then run this doctor again.");
  process.exitCode = 2;
}

async function validateNativeManifest() {
  try {
    const value = JSON.parse(await readFile(nativeManifest, "utf8"));
    return value.name === "com.egocompat.bridge" &&
      value.allowed_origins?.includes(`chrome-extension://${extensionId}/`) &&
      await canAccess(value.path);
  } catch {
    return false;
  }
}

async function findEdgeProfiles() {
  try {
    const entries = await readdir(edgeUserData, { withFileTypes: true });
    const profiles = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name !== "Default" && !entry.name.startsWith("Profile ")) continue;
      const preferences = join(edgeUserData, entry.name, "Preferences");
      const securePreferences = join(edgeUserData, entry.name, "Secure Preferences");
      const installed = await containsId(preferences) || await containsId(securePreferences);
      profiles.push({ name: entry.name, extensionInstalled: installed });
    }
    return profiles;
  } catch {
    return [];
  }
}

async function containsId(path) {
  try { return (await readFile(path, "utf8")).includes(extensionId); } catch { return false; }
}

function registryValue(key) {
  const result = spawnSync("reg.exe", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 && result.stdout.includes(nativeManifest);
}

function startBroker() {
  const child = spawn(process.execPath, [join(root, "apps", "broker", "src", "main.ts")], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, EGO_COMPAT_BACKEND: "companion", EGO_COMPAT_PIPE: pipeName },
  });
  child.unref();
}

async function connectWithRetry(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await PipeRuntimeTransport.connect(pipeName); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  throw lastError || new Error(`Timed out connecting to ${pipeName}`);
}

async function canConnect() {
  try { const transport = await PipeRuntimeTransport.connect(pipeName); await transport.close(); return true; }
  catch { return false; }
}

async function canAccess(path) {
  try { await access(path); return true; } catch { return false; }
}
