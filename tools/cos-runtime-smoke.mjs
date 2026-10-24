import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { CosRuntime } from "../apps/desktop-shell/workspace-packs/cos-runtime.mjs";

const directory = resolve(process.argv[2] || "packs/cos/versions/2.1.20-ego.1");
const temporary = resolve(".tmp/codex/cos-integration/runtime-smoke");
const evidenceDirectory = resolve("docs/cos-workspace-pack/evidence");
const runtime = new CosRuntime({ directory, dataDirectory: temporary, startTimeoutMs: 25_000 });
const logs = [];
runtime.on("log", text => { logs.push(text); process.stderr.write(text); });
runtime.on("runtime-error", error => process.stderr.write(error.message + "\n"));
const evidence = { checkedAt: new Date().toISOString(), directory, dataDirectory: temporary, passed: false };
function unwrap(result) {
  assert.equal(result?.ok, true, result?.error);
  return result.data;
}
try {
  await runtime.start();
  evidence.registeredChannels = runtime.channels.length;
  const browserRequest = payload => runtime.invoke("ego:browser-request", payload);
  const hello = await browserRequest({ path: "/hello" });
  assert.equal(hello.status, 200);
  const helloBody = JSON.parse(hello.body);
  assert.equal(helloBody.app, "chat-on-steroids");
  const headers = { "x-extension-protocol": String(helloBody.bridge), "x-extension-version": runtime.manifest.upstreamVersion };
  const denied = await browserRequest({ path: "/settings", headers });
  assert.equal(denied.status, 401);
  const webDenied = await browserRequest({ path: "/hello", headers: { ...headers, origin: "https://example.com" } });
  assert.equal(webDenied.status, 403);
  const paired = await browserRequest({ path: "/pair", method: "POST", headers, body: JSON.stringify({ reuse: true }) });
  assert.equal(paired.status, 200, paired.body);
  const credential = JSON.parse(paired.body).token;
  const settings = await browserRequest({ path: "/settings", headers: { ...headers, authorization: `Bearer ${credential}` } });
  assert.equal(settings.status, 200, settings.body);
  evidence.privateBrowserTransport = { hello: true, authenticatedSettings: true, rejectsMissingCredential: true, rejectsWebOrigin: true };
  const initial = unwrap(await runtime.invoke("state:get"));
  const config = initial.config;
  assert.ok(config?.ui);
  const fields = ["capabilities", "readOnly", "commandAllowlist", "tunnel", "ui", "sessions", "compaction", "multiAgent", "goal", "mcp", "controlApi"];
  const base = Object.fromEntries(fields.filter(key => config[key] !== undefined).map(key => [key, config[key]]));
  const theme = config.ui.theme === "dark" ? "light" : "dark";
  const changed = unwrap(await runtime.invoke("settings:save", { base, patch: { ...base, ui: { ...base.ui, theme } } }));
  assert.equal(changed.config.ui.theme, theme);
  const sessions = unwrap(await runtime.invoke("sessions:list", {}));
  assert.ok(Array.isArray(sessions.sessions));
  evidence.sessionsRead = true;
  await runtime.stop();
  assert.equal(runtime.state, "stopped");
  await runtime.start();
  const restored = unwrap(await runtime.invoke("state:get"));
  assert.equal(restored.config.ui.theme, theme);
  evidence.settingsPersistedAcrossRestart = true;
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  try { await runtime.stop(); evidence.stopped = runtime.state === "stopped" || runtime.state === "failed"; }
  catch (error) { evidence.stopError = error.message; evidence.passed = false; process.exitCode = 1; }
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(evidenceDirectory, "cos-runtime-smoke.json"), JSON.stringify(evidence, null, 2) + "\n");
  await writeFile(join(temporary, "runtime-output.log"), logs.join("")).catch(() => {});
  console.log(JSON.stringify(evidence, null, 2));
}
