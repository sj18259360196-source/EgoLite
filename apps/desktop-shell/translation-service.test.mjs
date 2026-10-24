import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { TranslationSettings, TranslationService, translateAzure } from "./translation-service.mjs";

const scratch = resolve(import.meta.dirname, "../../.tmp/codex/page-translation");
const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from([...text].reverse().join("")),
  decryptString: buffer => [...buffer.toString()].reverse().join(""),
};
function temporary(t) {
  mkdirSync(scratch, { recursive: true });
  const path = mkdtempSync(join(scratch, "unit-"));
  t.after(() => {
    const rel = relative(scratch, path);
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}
test("settings keep encrypted keys out of renderer responses and isolate Profiles", t => {
  const path = join(temporary(t), "settings.json");
  const settings = new TranslationSettings(path, cipher);
  const result = settings.save("default", { key: "private-fixture-key", region: "eastasia", target: "zh-Hans", cloudConsent: true });
  assert.equal(result.configured, true);
  assert.equal(JSON.stringify(result).includes("private-fixture-key"), false);
  assert.equal(readFileSync(path, "utf8").includes("private-fixture-key"), false);
  assert.equal(settings.credentials("default").key, "private-fixture-key");
  assert.equal(settings.public("other").configured, false);
  assert.equal(settings.public("other").cloudConsent, false);
  assert.equal(new TranslationSettings(path, cipher).public("default").cloudConsent, true);
  settings.save("default", { key: "", region: "eastasia", target: "ja" });
  assert.equal(settings.credentials("default").key, "private-fixture-key");
  settings.save("default", { clearKey: true, target: "en" });
  assert.throws(() => settings.credentials("default"), /Azure/);
});
test("settings refuse plaintext fallback and invalid language/region", t => {
  const settings = new TranslationSettings(join(temporary(t), "settings.json"), { isEncryptionAvailable: () => false });
  assert.throws(() => settings.save("p", { key: "secret", target: "en" }), /安全存储/);
  assert.throws(() => settings.save("p", { target: "__proto__" }), /语言/);
  assert.throws(() => settings.save("p", { target: "en", region: "a\r\nb" }), /区域/);
});
test("public settings distinguish saved but unreadable credentials", t => {
  const path = join(temporary(t), "settings.json");
  new TranslationSettings(path, cipher).save("default", { key: "fixture", target: "zh-Hans" });
  const settings = new TranslationSettings(path, { ...cipher, decryptString() { throw new Error("wrong encryption profile"); } });
  assert.equal(settings.public("default").configured, false);
  assert.equal(settings.public("default").keyStatus, "unreadable");
  assert.equal(settings.public("other").keyStatus, "missing");
});
const blocks = [{ ids: [1], html: '<div><span id="ego-t-1">Hello</span></div>' }];
const options = () => ({ key: "test-key", target: "zh-Hans", region: "eastasia", signal: new AbortController().signal });
test("Azure uses fixed HTTPS endpoint, HTML batches, no redirects, and correct mapping", async () => {
  const result = await translateAzure(blocks, options(), async (url, init) => {
    assert.equal(url.origin, "https://api.cognitive.microsofttranslator.com");
    assert.equal(url.searchParams.get("textType"), "html");
    assert.equal(url.searchParams.has("from"), false);
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(init.headers["Ocp-Apim-Subscription-Region"], "eastasia");
    assert.deepEqual(JSON.parse(init.body), [{ Text: blocks[0].html }]);
    return { ok: true, json: async () => [{ translations: [{ to: "zh-Hans", text: '<div><span id="ego-t-1">你好</span></div>' }] }] };
  });
  assert.deepEqual(result[0].ids, [1]);
  assert.match(result[0].html, /你好/);
});
test("provider errors never surface server bodies, keys, or page text", async () => {
  await assert.rejects(translateAzure(blocks, options(), async () => ({ ok: false, status: 401 })), /密钥无效/);
  await assert.rejects(translateAzure(blocks, options(), async () => { throw new Error("secret page text"); }), error => !error.message.includes("secret"));
  await assert.rejects(translateAzure(blocks, options(), async () => ({ ok: true, json: async () => [] })), /不完整/);
  await assert.rejects(translateAzure(blocks, options(), async () => ({ ok: true, json: async () => { throw new Error("private response"); } })), /无效数据/);
  await assert.rejects(translateAzure(blocks, { ...options(), target: "bad" }), /语言无效/);
});
function mockService(fetcher, authorize = async () => {}) {
  const service = new TranslationService({
    settings: { credentials: () => ({ key: "fake" }) }, authorize, fetcher, interval: 10,
  });
  const calls = [];
  service.evaluate = async (_job, command) => {
    calls.push(command);
    if (command === "collect") return { blocks, pending: false };
    return command === "apply" ? { applied: 1 } : {};
  };
  const input = { id: "tab", profile: "default", target: { isDestroyed: () => false }, context: {} };
  return { service, calls, input };
}
const until = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Test timeout");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
test("cancelled in-flight translation cannot apply a stale response", async () => {
  let complete;
  const { service, calls, input } = mockService(() => new Promise(resolve => { complete = resolve; }));
  await service.start(input);
  await until(() => complete);
  service.cancel("tab", true);
  complete({ ok: true, json: async () => [{ translations: [{ to: "zh-Hans", text: blocks[0].html }] }] });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls.includes("apply"), false);
  assert.equal(service.status("tab").phase, "original");
});
test("authorization is checked again before applying translated text", async () => {
  let authorized = true;
  const { service, calls, input } = mockService(async () => {
    authorized = false;
    return { ok: true, json: async () => [{ translations: [{ to: "zh-Hans", text: blocks[0].html }] }] };
  }, async () => { if (!authorized) throw new Error("control changed"); });
  await service.start(input);
  await until(() => service.status("tab").phase === "error");
  assert.equal(calls.includes("apply"), false);
  assert.match(service.status("tab").error, /control changed/);
  service.cancel("tab", true);
});
test("concurrent starts only initialize one document and restore clears state", async () => {
  let calls = 0;
  const { service, input } = mockService(async () => ({ ok: false, status: 429 }), async () => { calls++; });
  const results = await Promise.allSettled([service.start(input), service.start(input)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  await until(() => service.status("tab").phase === "error");
  await service.restore("tab");
  assert.equal(service.status("tab").phase, "original");
  assert.ok(calls >= 3);
});
test("resume retains progress and rejects old in-flight responses", async () => {
  const completions = [];
  const { service, input, calls } = mockService(() => new Promise(resolve => completions.push(resolve)));
  await service.start(input);
  await until(() => completions.length === 1);
  service.jobs.get("tab").count = 4;
  service.cancel("tab");
  await service.resume("tab", {});
  await until(() => completions.length === 2);
  completions[0]({ ok: true, json: async () => [{ translations: [{ to: "zh-Hans", text: blocks[0].html }] }] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.filter(c => c === "apply").length, 0);
  assert.equal(service.status("tab").count, 4);
  completions[1]({ ok: true, json: async () => [{ translations: [{ to: "zh-Hans", text: blocks[0].html }] }] });
  await until(() => service.status("tab").count === 5);
  assert.equal(calls.includes("restore"), false);
  service.cancel("tab", true);
});
