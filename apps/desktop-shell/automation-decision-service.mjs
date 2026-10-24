import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULTS = Object.freeze({
  mode: "auto", model: "jev-1.13.0", requestTimeoutMs: 4000, runTimeoutMs: 45000,
  maxActions: 24, maxDecisions: 18, maxRequestAttempts: 2, candidateLimit: 80,
  readConcurrency: 3, maxNoProgress: 3,
});

const ranges = {
  requestTimeoutMs: [500, 15000], runTimeoutMs: [1000, 120000], maxActions: [1, 100],
  maxDecisions: [1, 60], maxRequestAttempts: [1, 2], candidateLimit: [10, 200],
  readConcurrency: [1, 4], maxNoProgress: [1, 5],
};
const fail = (code, message) => Object.assign(new Error(message), { code });
const profileName = value => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw fail("AUTOMATION_INVALID", "Invalid Profile");
  return value;
};
const originOf = value => {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw fail("AUTOMATION_INVALID", "Only HTTP page origins are supported");
  return url.origin;
};

export class AutomationSettings {
  #memoryKeys = new Map();
  constructor(path, storage) { this.path = path; this.storage = storage; }
  read() {
    if (!existsSync(this.path)) return {};
    const data = JSON.parse(readFileSync(this.path, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw fail("AUTOMATION_CONFIG", "自动化配置损坏");
    return data;
  }
  public(profile) {
    profileName(profile);
    const value = this.read()[profile] || {};
    return {
      ...JEV_DEFAULTS, ...Object.fromEntries(Object.keys(ranges).filter(key => Number.isInteger(value[key])).map(key => [key, value[key]])),
      mode: value.mode === "off" ? "off" : "auto",
      model: value.model || JEV_DEFAULTS.model,
      configured: Boolean(value.key || this.#memoryKeys.has(profile)),
      cloudConsent: value.cloudConsent === true,
      allowedOrigins: Array.isArray(value.allowedOrigins) ? value.allowedOrigins : [],
      memoryOnly: this.#memoryKeys.has(profile),
    };
  }
  save(profile, payload) {
    profileName(profile);
    const data = this.read();
    const value = { ...data[profile] };
    if (payload.mode !== undefined) {
      if (!["off", "auto"].includes(payload.mode)) throw fail("AUTOMATION_INVALID", "Invalid automation mode");
      value.mode = payload.mode;
    }
    if (payload.model !== undefined) {
      if (!/^jev-\d+\.\d+\.\d+$/.test(payload.model)) throw fail("AUTOMATION_INVALID", "请使用固定版本的 Jev 模型");
      value.model = payload.model;
    }
    for (const [key, [min, max]] of Object.entries(ranges)) {
      if (payload[key] === undefined) continue;
      if (!Number.isInteger(payload[key]) || payload[key] < min || payload[key] > max) throw fail("AUTOMATION_INVALID", `Invalid ${key}`);
      value[key] = payload[key];
    }
    if (payload.cloudConsent !== undefined) {
      if (typeof payload.cloudConsent !== "boolean") throw fail("AUTOMATION_INVALID", "Invalid cloud consent");
      value.cloudConsent = payload.cloudConsent;
    }
    if (payload.allowedOrigins !== undefined) {
      if (!Array.isArray(payload.allowedOrigins) || payload.allowedOrigins.length > 100) throw fail("AUTOMATION_INVALID", "Invalid origin list");
      value.allowedOrigins = [...new Set(payload.allowedOrigins.map(originOf))];
    }
    let memoryKey;
    const suppliedKey = typeof payload.key === "string" ? payload.key.trim() : "";
    const migrateKey = (payload.memoryOnly === true && Boolean(value.key))
      || (payload.memoryOnly === false && this.#memoryKeys.has(profile));
    let keyChanged = false;
    if (payload.clearKey) delete value.key;
    else if (suppliedKey || migrateKey) {
      const key = suppliedKey || this.key(profile);
      keyChanged = true;
      if (!/^[\x21-\x7e]{8,1024}$/.test(key)) throw fail("AUTOMATION_INVALID", "密钥格式无效");
      if (payload.memoryOnly === true) { memoryKey = key; delete value.key; }
      else {
        if (!this.storage.isEncryptionAvailable()) throw fail("AUTOMATION_CONFIG", "系统加密不可用，请选择仅本次使用");
        value.key = this.storage.encryptString(key).toString("base64");
      }
    }
    Object.defineProperty(data, profile, { value, enumerable: true, configurable: true, writable: true });
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    if (payload.clearKey || keyChanged) this.#memoryKeys.delete(profile);
    if (memoryKey) this.#memoryKeys.set(profile, memoryKey);
    return this.public(profile);
  }
  key(profile) {
    profileName(profile);
    if (this.#memoryKeys.has(profile)) return this.#memoryKeys.get(profile);
    const value = this.read()[profile];
    if (!value?.key) throw fail("AUTOMATION_UNCONFIGURED", "尚未配置 TypeSafe 密钥");
    if (!this.storage.isEncryptionAvailable()) throw fail("AUTOMATION_CONFIG", "系统加密不可用");
    try { return this.storage.decryptString(Buffer.from(value.key, "base64")); }
    catch { throw fail("AUTOMATION_CONFIG", "密钥无法解密，请重新配置"); }
  }
}

export function validateEvaluation(input) {
  if (!input || typeof input !== "object" || !input.state || typeof input.state !== "object") throw fail("AUTOMATION_INVALID", "Invalid decision state");
  if (Buffer.byteLength(JSON.stringify(input)) > 160000) throw fail("AUTOMATION_INVALID", "Decision input is too large");
  const questions = Object.entries(input.questions || {});
  if (!questions.length || questions.length > 40) throw fail("AUTOMATION_INVALID", "Invalid decision questions");
  for (const [id, question] of questions) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(id) || !question || typeof question.instructions !== "string" || question.instructions.length > 6000) throw fail("AUTOMATION_INVALID", "Invalid decision question");
    if (question.type === "choice") {
      const options = Object.entries(question.criteria || {});
      if (!options.length || options.length > 255 || options.some(([key, value]) => key.length > 256 || (value !== null && typeof value !== "string"))) throw fail("AUTOMATION_INVALID", "Invalid choice options");
    } else if (question.type !== "noul") throw fail("AUTOMATION_INVALID", "Unsupported decision question type");
  }
  return { state: input.state, questions: input.questions };
}

export function validateDecisionResponse(value, questions) {
  if (!value || typeof value.model !== "string" || !value.answers || !Number.isInteger(value.usage?.input_tokens) || value.usage.input_tokens < 0) throw fail("AUTOMATION_RESPONSE", "Invalid Jev response");
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = value.answers[id];
    const probability = number => typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1;
    if (answer?.type !== question.type) throw fail("AUTOMATION_RESPONSE", "Mismatched Jev answer type");
    if (question.type === "noul") {
      if (!probability(answer.noul)) throw fail("AUTOMATION_RESPONSE", "Invalid Jev probability");
      answers[id] = { type: "noul", noul: answer.noul };
      continue;
    }
    if (!Object.hasOwn(question.criteria, answer.choice) || !probability(answer.confidence)) throw fail("AUTOMATION_RESPONSE", "Jev selected an unknown candidate");
    const options = Object.keys(question.criteria);
    if (!answer.probabilities || Object.keys(answer.probabilities).length !== options.length
      || options.some(key => !probability(answer.probabilities[key]))
      || Math.abs(options.reduce((sum, key) => sum + answer.probabilities[key], 0) - 1) > 0.02) throw fail("AUTOMATION_RESPONSE", "Invalid Jev distribution");
    if (answer.probabilities[answer.choice] + 0.0001 < Math.max(...Object.values(answer.probabilities))) {
      throw fail("AUTOMATION_RESPONSE", "Inconsistent Jev confidence");
    }
    answers[id] = { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities: Object.fromEntries(options.map(key => [key, answer.probabilities[key]])) };
  }
  return { model: value.model, answers, usage: { input_tokens: value.usage.input_tokens, output_tokens: Number.isInteger(value.usage.output_tokens) ? value.usage.output_tokens : 0 } };
}

export async function evaluateJev(input, { key, settings = JEV_DEFAULTS, signal, fetcher = fetch }) {
  const body = validateEvaluation(input);
  const started = performance.now();
  const timeout = AbortSignal.timeout(settings.requestTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let attempts = 0;
  let unknownUsageAttempts = 0;
  for (;;) {
    combined.throwIfAborted();
    attempts++;
    let response;
    try {
      response = await fetcher(JEV_ENDPOINT, {
        method: "POST", redirect: "error", credentials: "omit",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, model: settings.model }), signal: combined,
      });
    } catch {
      if (signal?.aborted) throw fail("AUTOMATION_CANCELLED", "自动化已停止");
      if (timeout.aborted) throw fail("AUTOMATION_TIMEOUT", "Jev 请求超时，未执行对应动作");
      unknownUsageAttempts++;
      if (attempts >= settings.maxRequestAttempts) throw fail("AUTOMATION_NETWORK", "Jev 连接失败，服务端用量未知");
      await delay(150, undefined, { signal: combined });
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if ([429, 529, 502, 503, 504].includes(response.status) && attempts < settings.maxRequestAttempts) {
        const retry = response.headers.get("retry-after");
        const waitMs = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 250;
        if (!Number.isFinite(waitMs) || waitMs + performance.now() - started >= settings.requestTimeoutMs) throw fail("AUTOMATION_RATE_LIMIT", "Jev 暂不可用，退避时间超过任务预算");
        await delay(waitMs, undefined, { signal: combined });
        continue;
      }
      const message = response.status === 401 ? "TypeSafe 密钥无效" : response.status === 422 ? "Jev 请求参数无效" : `Jev 服务返回 HTTP ${response.status}`;
      throw fail("AUTOMATION_PROVIDER", message);
    }
    // Bound the response before parsing; never surface provider bodies in errors.
    const reader = response.body?.getReader();
    let text = "";
    if (!reader) throw fail("AUTOMATION_RESPONSE", "Empty Jev response");
    const decoder = new TextDecoder();
    try {
      for (;;) {
        combined.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
        if (text.length > 2000000) throw fail("AUTOMATION_RESPONSE", "Jev response exceeds the size limit");
      }
      text += decoder.decode();
      const result = validateDecisionResponse(JSON.parse(text), body.questions);
      return { ...result, elapsedMs: Math.round(performance.now() - started), attempts, unknownUsageAttempts };
    } catch (error) {
      if (typeof error?.code === "string" && error.code.startsWith("AUTOMATION_")) throw error;
      throw fail(combined.aborted ? "AUTOMATION_CANCELLED" : "AUTOMATION_RESPONSE", combined.aborted ? "Jev 请求已停止或超时" : "Jev 响应格式无效");
    } finally { await reader.cancel().catch(() => {}); }
  }
}

export class AutomationDecisionService {
  constructor({ settings, authorize, changed = () => {}, fetcher = fetch }) {
    this.settings = settings; this.authorize = authorize; this.changed = changed; this.fetcher = fetcher;
    this.jobs = new Map();
  }
  list() {
    return [...this.jobs.values()].map(job => ({ runId: job.id, taskId: job.context.taskId, profileId: job.profile,
      startedAt: job.startedAt, cancelled: job.abort.signal.aborted, decisions: job.decisions, inputTokens: job.inputTokens }));
  }
  async begin(context, { runId = randomUUID(), targetId, timeoutMs } = {}) {
    await this.authorize(context, targetId);
    for (const [id, job] of this.jobs) if (job.abort.signal.aborted) { clearTimeout(job.timer); this.jobs.delete(id); }
    if (this.jobs.size >= 32) throw fail("AUTOMATION_BUSY", "Too many active automation jobs");
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(runId) || this.jobs.has(runId)) throw fail("AUTOMATION_INVALID", "Invalid or duplicate run ID");
    if ([...this.jobs.values()].some(job => job.context.taskId === context.taskId && !job.abort.signal.aborted)) throw fail("AUTOMATION_BUSY", "当前工作空间已有自动化任务");
    const config = this.settings.public(context.profileId);
    if (config.mode === "off") throw fail("AUTOMATION_DISABLED", "自动化加速已关闭");
    const lifetime = Math.min(config.runTimeoutMs, Number.isInteger(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : config.runTimeoutMs);
    const job = { id: runId, targetId, context: { ...context }, profile: context.profileId, abort: new AbortController(),
      startedAt: new Date().toISOString(), decisions: 0, inputTokens: 0, busy: false, config };
    job.timer = setTimeout(() => { job.abort.abort(); this.changed(this.list()); }, lifetime);
    job.timer.unref?.();
    this.jobs.set(runId, job);
    this.changed(this.list());
    return { runId, config, timeoutMs: lifetime };
  }
  async check(context, runId, targetId) {
    const job = this.jobs.get(runId);
    if (!job || job.context.clientId !== context.clientId || job.context.taskId !== context.taskId
      || job.context.leaseEpoch !== context.leaseEpoch || job.targetId !== targetId) throw fail("AUTOMATION_SCOPE", "Automation scope changed");
    if (job.abort.signal.aborted) throw fail("AUTOMATION_CANCELLED", "自动化已停止");
    if (this.settings.public(job.profile).mode === "off") { this.cancel(runId); throw fail("AUTOMATION_DISABLED", "自动化加速已关闭"); }
    await this.authorize(context, targetId);
    if (job.abort.signal.aborted) throw fail("AUTOMATION_CANCELLED", "自动化已停止");
    return job;
  }
  async decide(context, { runId, targetId, url, input }) {
    const job = await this.check(context, runId, targetId);
    const config = this.settings.public(job.profile);
    if (!config.cloudConsent) throw fail("AUTOMATION_CONSENT", "未允许向 TypeSafe 发送页面文本");
    const origin = originOf(url);
    if (config.allowedOrigins.length && !config.allowedOrigins.includes(origin)) throw fail("AUTOMATION_CONSENT", "当前站点未启用云端判断");
    if (job.busy) throw fail("AUTOMATION_BUSY", "A decision is already in flight");
    if (job.decisions >= job.config.maxDecisions) throw fail("AUTOMATION_BUDGET", "Jev 决策预算已用完");
    job.busy = true;
    job.decisions++;
    try {
      const result = await evaluateJev(input, { key: this.settings.key(job.profile), settings: config, signal: job.abort.signal, fetcher: this.fetcher });
      job.inputTokens += result.usage.input_tokens;
      await this.check(context, runId, targetId);
      const current = this.settings.public(job.profile);
      if (!current.cloudConsent || (current.allowedOrigins.length && !current.allowedOrigins.includes(origin))) {
        throw fail("AUTOMATION_CONSENT", "云端判断权限已变化，已丢弃返回结果");
      }
      return result;
    } finally { job.busy = false; this.changed(this.list()); }
  }
  cancel(runId) {
    const job = this.jobs.get(runId);
    if (!job) return false;
    job.abort.abort(); clearTimeout(job.timer); this.changed(this.list()); return true;
  }
  end(context, runId) {
    const job = this.jobs.get(runId);
    if (!job || job.context.clientId !== context.clientId || job.context.taskId !== context.taskId) return false;
    this.cancel(runId); this.jobs.delete(runId); this.changed(this.list()); return true;
  }
  invalidate(taskId, epoch) {
    for (const job of this.jobs.values()) if (job.context.taskId === taskId && job.context.leaseEpoch !== epoch) this.cancel(job.id);
  }
  async test(profile) {
    const config = this.settings.public(profile);
    const results = [];
    for (const state of [{ label: "Search" }, { label: "搜索" }]) {
      const value = await evaluateJev({ state, questions: { action: { type: "choice", instructions: "Select the meaning of the label.", criteria: { search: "Search", delete: "Delete", none: "Neither" } } } },
        { key: this.settings.key(profile), settings: config, fetcher: this.fetcher });
      results.push({ model: value.model, correct: value.answers.action.choice === "search", elapsedMs: value.elapsedMs, usage: value.usage });
    }
    return { passed: results.every(result => result.correct), results };
  }
}
