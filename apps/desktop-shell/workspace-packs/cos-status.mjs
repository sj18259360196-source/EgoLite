import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
export class CosStatus {
  #options;
  #server;
  #token = "";
  #epoch = randomUUID();
  #revision = 0;
  #events = [];
  #changed = new EventEmitter();
  constructor(options) { this.#options = options; this.#changed.setMaxListeners(100); }
  get cursor() { return `${this.#epoch}:${this.#revision}`; }
  get discoveryPath() { return this.#options.discoveryPath; }
  #stamp() {
    const now = Date.now();
    return { sourceScope: "cos", instanceId: "default", observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 5000).toISOString(), cursor: this.cursor };
  }
  #instance(id) { if (id && id !== "default") throw new Error("Unknown CoS instance"); }
  publish(kind) {
    this.#events.push({ cursor: `${this.#epoch}:${++this.#revision}`, kind, observedAt: new Date().toISOString() });
    if (this.#events.length > 256) this.#events.shift();
    this.#changed.emit("changed");
  }
  async #invoke(channel, payload) {
    const response = await this.#options.runtime()?.invoke(channel, payload, 10000);
    if (!response?.ok) throw new Error(response?.error || "CoS runtime is unavailable");
    return response.data;
  }
  async sessions({ instanceId, cursor } = {}) {
    this.#instance(instanceId);
    const data = await this.#invoke("sessions:list", { limit: 20, ...(cursor ? { cursor } : {}) });
    return { ...this.#stamp(), total: data.total, nextCursor: data.nextCursor, sessions: data.sessions.map(session =>
      pick(session, ["id", "title", "conversationId", "startedAt", "updatedAt", "endedAt", "activeTurnId", "lastTurnEndAt", "lastToolCallAt", "activityExpiresAt"])) };
  }
  async status({ packageId = "cos", instanceId } = {}) {
    if (packageId !== "cos") throw new Error("Unknown workspace package");
    this.#instance(instanceId);
    const summary = pick(this.#options.describe(), ["id", "name", "installed", "enabled", "state", "error", "version", "installing", "updating"]);
    const base = { ...this.#stamp(), package: summary, execution: this.#options.describe().execution, taskState: "unavailable", tasks: [] };
    if (this.#options.runtime()?.state !== "ready") return base;
    try {
      const rows = await this.#invoke("sessions:outbox");
      return { ...base, taskState: "observed", totalTasks: rows.length, truncated: rows.length > 100,
        tasks: rows.slice(0, 100).map(row => pick(row, ["id", "sessionId", "state", "createdAt", "error"])),
        sessions: await this.sessions() };
    } catch (error) { return { ...base, taskError: error.message }; }
  }
  async agents({ clientId, sourceScope = "ego" } = {}) {
    if (sourceScope !== "ego") return { ...this.#stamp(), sourceScope, available: false, reason: "No external Codex Desktop status provider is connected", agents: [] };
    try {
      const data = await this.#options.agents();
      return { ...this.#stamp(), sourceScope: "ego", available: true,
        agents: (data.agents || []).filter(agent => !clientId || agent.clientId === clientId).map(agent =>
          pick(agent, ["clientId", "clientKind", "displayName", "status", "connectedAt", "lastSeenAt", "currentTaskId", "activityStartedAt"])),
        externalCodexDesktop: { available: false } };
    } catch { return { ...this.#stamp(), sourceScope: "ego", available: false, reason: "Ego broker is unavailable", agents: [] }; }
  }
  events(after) {
    const [epoch, raw, extra] = String(after || "").split(":");
    const revision = Number(raw);
    const resetRequired = Boolean(after) && (epoch !== this.#epoch || extra !== undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(revision)
      || revision > this.#revision || revision < this.#revision - this.#events.length);
    return { ...this.#stamp(), resetRequired,
      events: this.#events.filter(event => !after || resetRequired || Number(event.cursor.split(":")[1]) > revision) };
  }
  async wait({ instanceId, afterCursor, timeoutMs = 0 } = {}) {
    this.#instance(instanceId);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 25000) throw new Error("Invalid status wait timeout");
    const ready = this.events(afterCursor);
    if (ready.events.length || ready.resetRequired || !afterCursor || !timeoutMs) return ready;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.#changed.off("changed", finish); resolve(); };
      const timer = setTimeout(finish, timeoutMs);
      this.#changed.once("changed", finish);
    });
    return this.events(afterCursor);
  }
  async start() {
    if (this.#server) return;
    this.#epoch = randomUUID();
    this.#revision = 0;
    this.#events = [];
    this.#token = randomBytes(32).toString("hex");
    const server = createServer((request, response) => { void this.#handle(request, response); });
    const temporaryPath = `${this.discoveryPath}.${randomUUID()}.tmp`;
    this.#server = server;
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const discovery = { schemaVersion: 1, pid: process.pid, instanceId: "default",
        url: `http://127.0.0.1:${server.address().port}`, token: this.#token };
      await mkdir(dirname(this.discoveryPath), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(discovery), { mode: 0o600 });
      await rename(temporaryPath, this.discoveryPath);
      this.publish("package.started");
    } catch (error) { await this.stop(); throw error; }
    finally { await rm(temporaryPath, { force: true }); }
  }
  async #handle(request, response) {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const reply = (code, value) => { response.writeHead(code); response.end(JSON.stringify(value)); };
    const token = Buffer.from(/^Bearer (.+)$/.exec(request.headers.authorization || "")?.[1] || "");
    const expected = Buffer.from(this.#token);
    if (!expected.length || token.length !== expected.length || !timingSafeEqual(token, expected)) return reply(401, { error: "Unauthorized" });
    if (request.headers.origin || request.headers["sec-fetch-site"]
      || request.headers.host !== `127.0.0.1:${this.#server?.address()?.port}`) return reply(403, { error: "Browser requests are not supported" });
    if (request.method !== "GET") return reply(405, { error: "Read-only status API" });
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const query = Object.fromEntries(url.searchParams);
      if (url.pathname === "/v1/health") return reply(200, { ...this.#stamp(), ready: true });
      if (url.pathname === "/v1/agents") return reply(200, await this.agents(query));
      if (url.pathname === "/v1/events") return reply(200, await this.wait({ afterCursor: query.after, timeoutMs: Number(query.timeoutMs || 0) }));
      const match = /^\/v1\/packages\/cos\/instances\/([^/]+)\/(status|sessions)$/.exec(url.pathname);
      if (!match) return reply(404, { error: "Unknown status route" });
      const args = { instanceId: match[1], ...(query.cursor ? { cursor: JSON.parse(query.cursor) } : {}) };
      return reply(200, await this[match[2]](args));
    } catch (error) { return reply(400, { error: error.message }); }
  }
  async stop() {
    const token = this.#token;
    this.#token = "";
    this.publish("package.stopped");
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    try {
      const stored = JSON.parse(await readFile(this.discoveryPath, "utf8"));
      if (stored.token === token) await rm(this.discoveryPath, { force: true });
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  }
}
