import { parentPort, workerData } from "node:worker_threads";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const pending = new Map();
const events = new Map();
const alarms = new Map();
let stopped = false;
let local = {};
let session = workerData.session || {};
let saving = Promise.resolve();
try { local = JSON.parse(await readFile(workerData.storagePath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }

function event(name) {
  if (!events.has(name)) events.set(name, new Set());
  const listeners = events.get(name);
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    hasListener: listener => listeners.has(listener),
  };
}
function emit(name, ...args) {
  for (const listener of events.get(name) || []) listener(...args);
}
function host(method, ...args) {
  if (stopped) return Promise.reject(new Error("CoS browser companion stopped"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CoS browser operation timed out; outcome unknown: ${method}`));
    }, 200_000);
    pending.set(id, { resolve, reject, timer });
    parentPort.postMessage({ type: "call", id, method, args });
  });
}
function storage(area) {
  const current = () => area === "local" ? local : session;
  const persist = async changes => {
    if (area === "local") {
      const snapshot = JSON.stringify(local);
      saving = saving.then(async () => {
        await mkdir(dirname(workerData.storagePath), { recursive: true });
        await writeFile(workerData.storagePath + ".tmp", snapshot);
        await rename(workerData.storagePath + ".tmp", workerData.storagePath);
      });
      await saving;
    }
    emit("storage.onChanged", changes, area);
    if (area === "local") {
      const preferences = Object.fromEntries(Object.entries(changes).filter(([key]) => ["renderStreamEnabled", "showStreamTimes"].includes(key)));
      if (Object.keys(preferences).length) parentPort.postMessage({ type: "preferences", changes: preferences });
    }
  };
  return {
    async get(keys) {
      const source = current();
      if (keys == null) return structuredClone(source);
      const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(names.filter(key => key in source || typeof keys === "object" && !Array.isArray(keys))
        .map(key => [key, structuredClone(key in source ? source[key] : keys[key])]));
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: current()[key], newValue: structuredClone(value) };
        current()[key] = structuredClone(value);
      }
      await persist(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const key of typeof keys === "string" ? [keys] : keys) {
        changes[key] = { oldValue: current()[key] };
        delete current()[key];
      }
      await persist(changes);
    },
    async clear() {
      const keys = Object.keys(current());
      await this.remove(keys);
    },
  };
}
const tabs = Object.fromEntries(["query", "get", "create", "update", "remove", "reload", "move", "group", "ungroup", "sendMessage"]
  .map(name => [name, (...args) => host(`tabs.${name}`, ...args)]));
tabs.onUpdated = event("tabs.onUpdated");
tabs.onRemoved = event("tabs.onRemoved");
globalThis.chrome = {
  tabs,
  windows: Object.fromEntries(["create", "get", "getAll", "getLastFocused", "update"].map(name => [name, (...args) => host(`windows.${name}`, ...args)])),
  tabGroups: Object.fromEntries(["get", "query", "update"].map(name => [name, (...args) => host(`tabGroups.${name}`, ...args)])),
  runtime: {
    getURL: path => pathToFileURL(join(workerData.extensionDirectory, path)).href,
    getManifest: () => workerData.manifest,
    onInstalled: event("runtime.onInstalled"),
    onStartup: event("runtime.onStartup"),
    onMessage: event("runtime.onMessage"),
    reload: () => { parentPort.postMessage({ type: "restart-requested" }); },
  },
  storage: { local: storage("local"), session: storage("session"), onChanged: event("storage.onChanged") },
  scripting: {
    executeScript: details => {
      const { func, ...rest } = details;
      return host("scripting.executeScript", { ...rest, ...(func ? { functionSource: func.toString() } : {}) });
    },
    insertCSS: details => host("scripting.insertCSS", details),
  },
  alarms: {
    onAlarm: event("alarms.onAlarm"),
    async create(name, details) {
      clearTimeout(alarms.get(name));
      const wait = details.when ? Math.max(0, details.when - Date.now()) : (details.delayInMinutes || 0.5) * 60_000;
      alarms.set(name, setTimeout(() => {
        alarms.delete(name);
        emit("alarms.onAlarm", { name, scheduledTime: Date.now() });
      }, wait));
    },
    async clear(name) { clearTimeout(alarms.get(name)); return alarms.delete(name); },
  },
  permissions: { contains: details => host("permissions.contains", details) },
};
if (workerData.debuggerEnabled) {
  chrome.debugger = {
    ...Object.fromEntries(["attach", "detach", "getTargets", "sendCommand"].map(name => [name, (...args) => host(`debugger.${name}`, ...args)])),
    onEvent: event("debugger.onEvent"), onDetach: event("debugger.onDetach"),
  };
}

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url || String(input));
  if (url.hostname === "127.0.0.1" && [8765, 8766, 8767, 8768, 8769].includes(Number(url.port))) {
    if (init?.signal?.aborted) throw init.signal.reason;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const result = await host("bridge.request", { path: url.pathname + url.search, method: init?.method || "GET", headers, body: init?.body });
    return new Response(result.body, { status: result.status, headers: result.headers });
  }
  if (url.protocol === "file:") {
    const root = pathToFileURL(workerData.extensionDirectory + "/").href;
    if (!url.href.startsWith(root)) throw new Error("CoS asset is outside its package");
    return new Response(await readFile(fileURLToPath(url)));
  }
  return nativeFetch(input, init);
};
// Wake notifications use the private parent channel; no browser WebSocket is opened.
globalThis.WebSocket = undefined;
let companion;
parentPort.on("message", async message => {
  if (message.type === "reply") {
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(message.error));
    else call.resolve(message.value);
  } else if (message.type === "event") {
    emit(message.name, ...message.args);
  } else if (message.type === "wake") {
    try { await companion?.egoWake(); }
    catch (error) { parentPort.postMessage({ type: "diagnostic", error: error.message }); }
  } else if (message.type === "page-message") {
    let replied = false;
    const reply = value => {
      if (replied) return;
      replied = true;
      parentPort.postMessage({ type: "page-reply", id: message.id, value });
    };
    for (const listener of events.get("runtime.onMessage") || []) listener(message.message, message.sender, reply);
    if (!events.get("runtime.onMessage")?.size) reply({ ok: false, error: "CoS observer is not ready" });
  } else if (message.type === "page-preferences") {
    const allowed = ["renderStreamEnabled", "showStreamTimes"];
    const requested = message.message;
    const keys = requested == null ? allowed : typeof requested === "string" ? [requested]
      : Array.isArray(requested) ? requested : Object.keys(requested);
    const value = Object.fromEntries(keys.filter(key => allowed.includes(key)).filter(key => key in local)
      .map(key => [key, local[key]]));
    parentPort.postMessage({ type: "page-reply", id: message.id, value });
  } else if (message.type === "stop") {
    stopped = true;
    for (const timer of alarms.values()) clearTimeout(timer);
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("CoS companion stopped")); }
    pending.clear();
    try { await saving; }
    finally { parentPort.postMessage({ type: "stopped", session }); }
  }
});
companion = await import(pathToFileURL(workerData.entry).href);
parentPort.postMessage({ type: "ready" });
