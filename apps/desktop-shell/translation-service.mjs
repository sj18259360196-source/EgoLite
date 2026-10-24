import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { translationScript } from "./page-translation.mjs";

export const TRANSLATION_LANGUAGES = Object.freeze({
  "zh-Hans": "简体中文", "zh-Hant": "繁體中文", en: "English", ja: "日本語",
  ko: "한국어", fr: "Français", de: "Deutsch", es: "Español", ru: "Русский", pt: "Português",
});
export const TRANSLATION_WORLD = 1007;

export class TranslationSettings {
  constructor(path, storage) { this.path = path; this.storage = storage; }
  read() {
    if (!existsSync(this.path)) return {};
    const value = JSON.parse(readFileSync(this.path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("翻译配置损坏");
    return value;
  }
  public(profile) {
    const value = this.read()[profile] || {};
    let keyStatus = value.key ? "ready" : "missing";
    if (value.key) {
      try { this.credentials(profile); } catch { keyStatus = "unreadable"; }
    }
    return { configured: keyStatus === "ready", keyStatus, cloudConsent: value.cloudConsent === true, region: value.region || "", target: value.target || "zh-Hans" };
  }
  write(data) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
  save(profile, payload) {
    if (!Object.hasOwn(TRANSLATION_LANGUAGES, payload.target)) throw new Error("目标语言无效");
    const region = String(payload.region || "").trim();
    if (region && !/^[a-z0-9-]{1,64}$/.test(region)) throw new Error("Azure 区域格式无效");
    const data = this.read();
    const value = { ...data[profile], region, target: payload.target };
    if (typeof payload.cloudConsent === "boolean") value.cloudConsent = payload.cloudConsent;
    if (payload.clearKey) delete value.key;
    else if (typeof payload.key === "string" && payload.key.trim()) {
      if (!this.storage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法保存密钥");
      const key = payload.key.trim();
      if (!/^[\x21-\x7e]{1,512}$/.test(key)) throw new Error("密钥格式无效");
      value.key = this.storage.encryptString(key).toString("base64");
    }
    Object.defineProperty(data, profile, { value, enumerable: true, configurable: true, writable: true });
    this.write(data);
    return this.public(profile);
  }
  credentials(profile) {
    const value = this.read()[profile];
    if (!value?.key) throw new Error("请先配置 Azure Translator 密钥");
    if (!this.storage.isEncryptionAvailable()) throw new Error("系统安全存储不可用");
    let key;
    try { key = this.storage.decryptString(Buffer.from(value.key, "base64")); }
    catch { throw new Error("无法解密翻译密钥，请重新配置"); }
    return { key, region: value.region };
  }
  remove(profile) {
    const data = this.read();
    delete data[profile];
    this.write(data);
  }
}

export async function translateAzure(blocks, { key, region, source, target, signal }, fetcher = fetch) {
  if (!Object.hasOwn(TRANSLATION_LANGUAGES, target)
    || (source && !Object.hasOwn(TRANSLATION_LANGUAGES, source))) throw new Error("翻译语言无效");
  if (!blocks.length || blocks.length > 30 || blocks.reduce((n, b) => n + b.html.length, 0) > 45000) {
    throw new Error("翻译批次过大");
  }
  const url = new URL("https://api.cognitive.microsofttranslator.com/translate");
  url.search = new URLSearchParams({ "api-version": "3.0", to: target, textType: "html", ...(source ? { from: source } : {}) }).toString();
  const headers = { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": key };
  if (region) headers["Ocp-Apim-Subscription-Region"] = region;
  let response;
  try {
    response = await fetcher(url, {
      method: "POST", redirect: "error", credentials: "omit", headers,
      body: JSON.stringify(blocks.map(b => ({ Text: b.html }))),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
  } catch {
    if (signal.aborted) throw new Error("翻译已取消");
    throw new Error("翻译服务连接失败或超时");
  }
  if (!response.ok) {
    const errors = { 401: "翻译密钥无效", 403: "翻译服务未授权或额度已用完", 429: "翻译服务请求过多，请稍后重试" };
    throw new Error(errors[response.status] || `翻译服务请求失败（${response.status}）`);
  }
  let result;
  try { result = await response.json(); }
  catch { throw new Error("翻译服务返回了无效数据"); }
  if (!Array.isArray(result) || result.length !== blocks.length) throw new Error("翻译服务响应不完整");
  return result.map((row, index) => {
    const text = row.translations?.find(item => item.to === target)?.text;
    if (typeof text !== "string" || text.length > 100000) throw new Error("翻译服务响应格式异常");
    return { ...blocks[index], html: text };
  });
}

export class TranslationService {
  constructor({ settings, authorize, changed = () => {}, fetcher = fetch, interval = 1000 }) {
    this.settings = settings;
    this.authorize = authorize;
    this.changed = changed;
    this.fetcher = fetcher;
    this.interval = interval;
    this.jobs = new Map();
  }
  status(id) {
    const job = this.jobs.get(id);
    return job ? { phase: job.phase, count: job.count, target: job.targetLanguage, error: job.error || "" } : { phase: "original", count: 0 };
  }
  async evaluate(job, command, extra = {}) {
    if (job.target.isDestroyed()) throw new Error("页面已关闭");
    const result = await job.target.executeJavaScriptInIsolatedWorld(TRANSLATION_WORLD, [{
      code: translationScript(command, { token: job.token, ...extra }),
    }]);
    if (result?.translationError) throw new Error(result.translationError);
    return result;
  }
  check(job) {
    if (this.jobs.get(job.id) !== job || job.abort.signal.aborted || job.target.isDestroyed()) throw new Error("翻译已取消");
  }
  cancel(id, forget = false, reason = "") {
    const job = this.jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    job.abort.abort();
    job.phase = reason ? "error" : "stopped";
    job.error = reason;
    // Disconnect the observer without changing page text.
    if (!job.target.isDestroyed()) void this.evaluate(job, "stop").catch(() => {});
    if (forget) this.jobs.delete(id);
  }
  async restore(id) {
    const job = this.jobs.get(id);
    if (!job) return this.status(id);
    await this.authorize(job.context);
    this.cancel(id);
    const result = await this.evaluate(job, "restore");
    if (!result.stale && result.restored) this.changed(job.context);
    if (this.jobs.get(id) === job) this.jobs.delete(id);
    return this.status(id);
  }
  async resume(id, context) {
    const previous = this.jobs.get(id);
    if (!previous) throw new Error("页面已更新，请重新翻译");
    if (!["error", "stopped"].includes(previous.phase)) return this.status(id);
    const credentials = this.settings.credentials(previous.profile);
    await this.authorize(context);
    if (this.jobs.get(id) !== previous) throw new Error("页面已更新，请重新翻译");
    const job = { ...previous, context, abort: new AbortController(), phase: "translating", error: "", timer: undefined };
    this.jobs.set(id, job);
    try {
      await this.evaluate(job, "resume");
      this.check(job);
    } catch (error) {
      this.cancel(id, false, error.message);
      throw error;
    }
    void this.tick(job, credentials);
    return this.status(id);
  }
  async start({ id, target, profile, source = "", targetLanguage = "zh-Hans", context }) {
    if (this.jobs.has(id)) throw new Error("请先显示原文，再重新翻译");
    if (!Object.hasOwn(TRANSLATION_LANGUAGES, targetLanguage) || (source && !Object.hasOwn(TRANSLATION_LANGUAGES, source))) {
      throw new Error("翻译语言无效");
    }
    const credentials = this.settings.credentials(profile);
    await this.authorize(context);
    if (this.jobs.has(id)) throw new Error("翻译正在启动");
    const job = { id, target, profile, context, targetLanguage, source, token: randomUUID(), abort: new AbortController(), phase: "translating", count: 0, chars: 0 };
    this.jobs.set(id, job);
    try {
      await this.evaluate(job, "init");
      this.check(job);
    } catch (error) {
      if (this.jobs.get(id) === job) this.jobs.delete(id);
      throw error;
    }
    // Keep credentials out of status and diagnostic output.
    void this.tick(job, credentials);
    return this.status(id);
  }
  async tick(job, credentials) {
    try {
      this.check(job);
      await this.authorize(job.context);
      this.check(job);
      const batch = await this.evaluate(job, "collect");
      this.check(job);
      if (batch.stale || batch.stopped) throw new Error("页面已更新，请重新翻译");
      if (batch.blocks.length) {
        job.phase = "translating";
        job.chars += batch.blocks.reduce((n, block) => n + block.html.length, 0);
        if (job.chars > 150000) throw new Error("本次翻译已达到字符上限，已暂停新增内容");
        const blocks = await translateAzure(batch.blocks, {
          ...credentials, source: job.source, target: job.targetLanguage, signal: job.abort.signal,
        }, this.fetcher);
        this.check(job);
        await this.authorize(job.context);
        this.check(job);
        const result = await this.evaluate(job, "apply", { blocks });
        this.check(job);
        if (result.stale || result.stopped) throw new Error("页面已更新，请重新翻译");
        job.count += result.applied;
        if (result.applied) this.changed(job.context);
      }
      job.phase = batch.pending ? "translating" : "translated";
      job.timer = setTimeout(() => void this.tick(job, credentials), batch.pending ? 0 : this.interval);
    } catch (error) {
      if (!job.abort.signal.aborted && this.jobs.get(job.id) === job) this.cancel(job.id, false, error.message);
    }
  }
}
