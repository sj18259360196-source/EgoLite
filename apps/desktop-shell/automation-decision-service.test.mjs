import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  AutomationSettings, AutomationDecisionService, evaluateJev, JEV_DEFAULTS, JEV_ENDPOINT,
  validateDecisionResponse,
} from "./automation-decision-service.mjs";

const tempRoot = resolve(".tmp/codex/jev-automation/unit");
const request = { state: { text: "Search" }, questions: { action: { type: "choice", instructions: "Choose", criteria: { search: "Search", none: "Neither" } } } };
const response = () => ({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 },
  answers: { action: { type: "choice", choice: "search", confidence: 0.9, probabilities: { search: 0.95, none: 0.05 } } } });
function fixture(t, available = true) {
  mkdirSync(tempRoot, { recursive: true });
  const directory = mkdtempSync(join(tempRoot, "settings-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = {
    isEncryptionAvailable: () => available,
    encryptString: text => Buffer.from([...text].reverse().join("")),
    decryptString: data => [...data.toString()].reverse().join(""),
  };
  return new AutomationSettings(join(directory, "settings.json"), storage);
}

test("automation settings keep keys out of public state and require secure storage", t => {
  const settings = fixture(t);
  const saved = settings.save("default", { key: "test-private-secret", cloudConsent: true, allowedOrigins: ["https://example.com/path"] });
  assert.equal(saved.configured, true);
  assert.equal(saved.cloudConsent, true);
  assert.deepEqual(saved.allowedOrigins, ["https://example.com"]);
  assert.doesNotMatch(JSON.stringify(saved), /private-secret/);
  assert.doesNotMatch(readFileSync(settings.path, "utf8"), /private-secret/);
  assert.equal(settings.key("default"), "test-private-secret");
  assert.equal(new AutomationSettings(settings.path, settings.storage).key("default"), "test-private-secret");
  settings.save("default", { clearKey: true });
  assert.throws(() => settings.key("default"), /尚未配置/);
});

test("automation settings support memory-only secrets without insecure fallback", t => {
  const settings = fixture(t, false);
  assert.throws(() => settings.save("default", { key: "private-secret" }), /系统加密不可用/);
  settings.save("default", { key: "private-secret", memoryOnly: true });
  assert.equal(settings.key("default"), "private-secret");
  assert.equal(settings.public("default").memoryOnly, true);
  assert.doesNotMatch(readFileSync(settings.path, "utf8"), /private-secret/);
  assert.equal(new AutomationSettings(settings.path, settings.storage).public("default").configured, false);
  assert.throws(() => settings.save("__proto__", {}), /Invalid Profile/);
  assert.throws(() => settings.save("default", { model: "jev-latest" }), /固定版本/);
  assert.throws(() => settings.save("default", { maxActions: 1000 }), /maxActions/);
});

test("changing memory-only mode migrates the existing key without re-entry", t => {
  const settings = fixture(t);
  settings.save("default", { key: "private-secret" });
  settings.save("default", { memoryOnly: true });
  assert.equal(settings.public("default").memoryOnly, true);
  assert.equal(new AutomationSettings(settings.path, settings.storage).public("default").configured, false);
  settings.save("default", { memoryOnly: false });
  assert.equal(settings.public("default").memoryOnly, false);
  assert.equal(new AutomationSettings(settings.path, settings.storage).key("default"), "private-secret");
});

test("Jev client uses native endpoint and validates finite closed-set responses", async () => {
  const output = await evaluateJev(request, { key: "test-key", fetcher: async (url, init) => {
    assert.equal(url, JEV_ENDPOINT);
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    assert.equal(JSON.parse(init.body).model, JEV_DEFAULTS.model);
    return Response.json(response());
  } });
  assert.equal(output.answers.action.choice, "search");
  assert.equal(output.usage.input_tokens, 100);
  assert.equal(output.attempts, 1);
  const invalid = response();
  invalid.answers.action.choice = "execute_arbitrary_javascript";
  assert.throws(() => validateDecisionResponse(invalid, request.questions), /unknown candidate/);
  invalid.answers.action.choice = "search";
  invalid.answers.action.probabilities.search = NaN;
  assert.throws(() => validateDecisionResponse(invalid, request.questions), /distribution/);
});

test("Jev client does not leak errors or retry rejected credentials", async () => {
  let calls = 0;
  await assert.rejects(evaluateJev(request, { key: "private-secret", fetcher: async () => {
    calls++;
    return new Response("secret body private-secret", { status: 401 });
  } }), error => error.code === "AUTOMATION_PROVIDER" && !error.message.includes("private-secret"));
  assert.equal(calls, 1);
});

test("Jev retries transient failures within a shared deadline", async () => {
  let calls = 0;
  const result = await evaluateJev(request, { key: "test-key", fetcher: async () =>
    ++calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : Response.json(response()) });
  assert.equal(result.attempts, 2);
  await assert.rejects(evaluateJev(request, { key: "test-key", fetcher: async () =>
    new Response("", { status: 529, headers: { "retry-after": "30" } }) }), /预算/);
});

test("Jev cancellation prevents accepting late model results", async () => {
  const abort = new AbortController();
  await assert.rejects(evaluateJev(request, { key: "test-key", signal: abort.signal, fetcher: async () => {
    abort.abort();
    return Response.json(response());
  } }), /停止|超时/);
});

test("automation jobs enforce consent, scope, budgets, cancellation and lease revalidation", async t => {
  const settings = fixture(t);
  settings.save("default", { key: "private-secret", maxDecisions: 1 });
  const context = { clientId: "codex-test", taskId: "task", taskSpaceId: 1, leaseEpoch: 2, profileId: "default" };
  let authorized = true;
  const service = new AutomationDecisionService({ settings, authorize: async () => { if (!authorized) throw new Error("revoked"); }, fetcher: async () => Response.json(response()) });
  t.after(() => { for (const job of service.jobs.values()) service.end(job.context, job.id); });
  const job = await service.begin(context, { targetId: "tab" });
  const input = { runId: job.runId, targetId: "tab", url: "https://example.com", input: request };
  await assert.rejects(service.decide(context, input), /未允许/);
  settings.save("default", { cloudConsent: true, allowedOrigins: ["https://example.com"] });
  await assert.rejects(service.decide(context, { ...input, url: "https://other.test" }), /未启用/);
  await assert.rejects(service.check({ ...context, clientId: "other" }, job.runId, "tab"), /scope/);
  assert.equal((await service.decide(context, input)).answers.action.choice, "search");
  await assert.rejects(service.decide(context, input), /预算/);
  authorized = false;
  await assert.rejects(service.check(context, job.runId, "tab"), /revoked/);
  authorized = true;
  service.cancel(job.runId);
  await assert.rejects(service.check(context, job.runId, "tab"), /停止/);
});

test("automation rechecks permission after provider response", async t => {
  const settings = fixture(t);
  settings.save("default", { key: "private-secret", cloudConsent: true });
  const context = { clientId: "a", taskId: "task", taskSpaceId: 1, leaseEpoch: 2, profileId: "default" };
  let allowed = true;
  const service = new AutomationDecisionService({ settings, authorize: async () => { if (!allowed) throw new Error("revoked"); },
    fetcher: async () => { allowed = false; return Response.json(response()); } });
  const job = await service.begin(context, { targetId: "tab" });
  t.after(() => service.end(context, job.runId));
  await assert.rejects(service.decide(context, { runId: job.runId, targetId: "tab", url: "https://example.com", input: request }), /revoked/);
});

test("revoking cloud consent while a response is pending discards it", async t => {
  const settings = fixture(t);
  settings.save("default", { key: "private-secret", cloudConsent: true });
  const context = { clientId: "a", taskId: "task", taskSpaceId: 1, leaseEpoch: 2, profileId: "default" };
  const service = new AutomationDecisionService({ settings, authorize: async () => {},
    fetcher: async () => { settings.save("default", { cloudConsent: false }); return Response.json(response()); } });
  const job = await service.begin(context, { targetId: "tab" });
  t.after(() => service.end(context, job.runId));
  await assert.rejects(service.decide(context, { runId: job.runId, targetId: "tab", url: "https://example.com", input: request }), /权限已变化/);
});

test("a high confidence cannot authorize a lower-ranked candidate", () => {
  const invalid = response();
  invalid.answers.action.choice = "none";
  assert.throws(() => validateDecisionResponse(invalid, request.questions), /confidence/);
});
