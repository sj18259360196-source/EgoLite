import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

test("hosted UI reports actual bridge states without claiming update checks or requiring an extension", async t => {
  const before = { window: globalThis.window, document: globalThis.document };
  t.after(() => {
    for (const key of ["window", "document"]) {
      if (before[key] === undefined) delete globalThis[key]; else globalThis[key] = before[key];
    }
  });
  const compiled = await build({
    entryPoints: ["integrations/cos/hosted-renderer.ts"], write: false, bundle: true, format: "esm",
    plugins: [{
      name: "i18n-test-binding",
      setup(builder) {
        builder.onResolve({ filter: /i18n\.js$/ }, () => ({ path: "i18n", namespace: "test" }));
        builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents: "export const currentLanguage=()=>window.language; export const ui=(n,p,v)=>(n[p]=v(),n);",
        }));
      },
    }],
  });
  globalThis.window = { egoHost: { name: "EgoLite", protocol: 1 }, language: "en" };
  const nodes = new Map();
  globalThis.document = { getElementById: id => {
    if (!nodes.has(id)) nodes.set(id, { classList: { toggle(_name, value) { this.warning = value; } } });
    return nodes.get(id);
  } };
  const uri = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`;
  const hosted = await import(uri);
  const state = { bridge: { present: false, running: false }, update: { current: "2.1.20", latest: "9.0.0" } };
  hosted.paintEgoHostedUi(state);
  assert.deepEqual(hosted.egoBrowserSetup(state), { ready: false, choosingLocation: true });
  assert.equal(nodes.get("bridgeState").textContent, "Ego browser connection stopped");
  assert.equal(nodes.get("bridgeState").classList.warning, true);
  state.bridge.running = true;
  hosted.paintEgoHostedUi(state);
  assert.equal(nodes.get("bridgeState").textContent, "Waiting for the Ego browser connection");
  assert.equal(hosted.egoUpdateSummary(state).notice, true);
  state.bridge.present = true;
  assert.deepEqual(hosted.egoBrowserSetup(state), { ready: true, choosingLocation: true });
  hosted.paintEgoHostedUi(state);
  assert.equal(nodes.get("bridgeState").textContent, "Ego browser connected");
  assert.equal(nodes.get("bridgeState").classList.warning, false);
  assert.deepEqual(hosted.egoUpdateSummary(state), {
    text: "Ego · CoS 2.1.20", tone: "work", notice: false, extensionAction: null,
  });
  window.language = "zh-CN";
  hosted.paintEgoHostedUi(state);
  assert.equal(nodes.get("bridgeState").textContent, "Ego 浏览器已连接");
  assert.equal(nodes.get("backgroundRunningCopy").textContent, "由 Ego 管理");
  window.egoHost = undefined;
  const standalone = await import(`${uri}#standalone`);
  nodes.clear();
  standalone.paintEgoHostedUi(state);
  assert.equal(nodes.size, 0);
});
