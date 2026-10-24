import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CosPageAgent } from "../apps/desktop-shell/workspace-packs/cos-page-agent.mjs";

const root = resolve(import.meta.dirname, "..");
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(join(root, "node_modules/electron/dist/electron.exe"), [import.meta.filename], {
    cwd: root, env, windowsHide: true, stdio: "inherit",
  });
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} else {
  const { app, BrowserWindow, session } = await import("electron");
  app.on("window-all-closed", () => {});
  const work = join(root, ".tmp/codex/cos-integration", `page-${randomUUID()}`);
  await mkdir(work, { recursive: true });
  app.setPath("userData", work);
  void app.whenReady().then(async () => {
  const partition = session.fromPartition(`cos-page-smoke-${randomUUID()}`);
  partition.protocol.handle("https", () => new Response(`<!doctype html>
    <script>window.usageBeforePageScript=Boolean(window.__cosUsageObserver)</script>
    <title>Local CoS protocol fixture</title><main></main>`, { headers: { "content-type": "text/html" } }));
  const window = new BrowserWindow({ show: false, webPreferences: { session: partition, contextIsolation: true, nodeIntegration: false } });
  const contents = window.webContents;
  const messages = [];
  const diagnostics = [];
  const result = { checkedAt: new Date().toISOString(), passed: false, fixtureOnly: true };
  const watchdog = setTimeout(() => {
    console.error(`CoS page smoke timed out at ${result.stage}`);
    app.exit(1);
  }, 45000);
  const phase = name => { result.stage = name; console.log(`CoS page smoke: ${name}`); };
  const tab = { webContentsId: contents.id };
  const agent = new CosPageAgent({
    directory: join(root, "packs/cos/versions/2.1.20-ego.1"),
    contents: () => contents,
    checkTab: id => {
      assert.equal(id, contents.id);
      return { id, url: contents.getURL(), status: "complete" };
    },
    sendCommand: (_contents, method, params) => contents.debugger.sendCommand(method, params),
    runMutation: operation => operation(),
    preferences: async () => ({ renderStreamEnabled: false }),
    message: async (message, sender) => {
      messages.push({ type: message.type, documentId: sender.documentId, frameId: sender.frameId });
      return message.type === "ego-test" ? { echoed: message.value, documentId: sender.documentId } : { ok: false, error: "fixture_only" };
    },
    diagnostic: message => diagnostics.push(message),
  });
  try {
    phase("blank");
    await window.loadURL("about:blank");
    phase("attach");
    await agent.attach(tab);
    phase("navigate");
    await window.loadURL("https://chatgpt.com/c/fixture");
    phase("document-start");
    assert.equal(await contents.executeJavaScript("window.usageBeforePageScript"), true);
    result.documentStartBeforeInlineScript = true;
    phase("round-trip");
    const first = await agent.evaluate(tab, "chrome.runtime.sendMessage({type:'ego-test',value:42})");
    assert.equal(first.echoed, 42);
    assert.ok(first.documentId);
    assert.equal(await contents.executeJavaScript("typeof globalThis.__egoCosPage"), "undefined");
    result.isolatedRoundTrip = true;
    result.websiteCannotSeeHostShim = true;
    assert.equal(await agent.evaluate(tab, "Boolean(globalThis.__CLF_CONTENT_RECORDER__)"), true);
    result.originalContentScriptLoaded = true;
    await agent.evaluate(tab, "chrome.runtime.onMessage.addListener((m,s,reply)=>{if(m.type==='ego-test'){reply({answer:m.value+1});return true;}})");
    assert.deepEqual(await agent.send(contents.id, { type: "ego-test", value: 8 }, { documentId: first.documentId }), { answer: 9 });
    result.backgroundToPage = true;
    await agent.evaluate(tab, "chrome.storage.onChanged.addListener(changes=>globalThis.lastPreference=changes.renderStreamEnabled?.newValue)");
    await agent.preferencesChanged({ renderStreamEnabled: { oldValue: false, newValue: true } });
    assert.equal(await agent.evaluate(tab, "globalThis.lastPreference"), true);
    result.preferenceEvents = true;
    await contents.executeJavaScript("history.pushState({},'', '/c/same-document')");
    const same = await agent.evaluate(tab, "chrome.runtime.sendMessage({type:'ego-test',value:44})");
    assert.equal(same.documentId, first.documentId);
    result.sameDocumentIdentityPreserved = true;
    await window.loadURL("https://chatgpt.com/c/next-document");
    const second = await agent.evaluate(tab, "chrome.runtime.sendMessage({type:'ego-test',value:43})");
    assert.notEqual(first.documentId, second.documentId);
    await assert.rejects(agent.send(contents.id, { type: "ego-test" }, { documentId: first.documentId }), /stale/);
    result.navigationRotatesDocument = true;
    await window.loadURL("https://example.com/");
    assert.equal(await agent.evaluate(tab, "typeof globalThis.__egoCosPage"), "undefined");
    result.unrelatedOriginsHaveNoShim = true;
    await window.loadURL("https://chatgpt.com/c/stop-check");
    assert.equal(await agent.evaluate(tab, "__CLF_CONTENT_RECORDER__.healthy()"), true);
    await agent.stop();
    const tree = await contents.debugger.sendCommand("Page.getFrameTree");
    const world = await contents.debugger.sendCommand("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "EgoCoSPage" });
    const stopped = await contents.debugger.sendCommand("Runtime.evaluate", {
      contextId: world.executionContextId, returnByValue: true,
      expression: "({runtime:typeof chrome.runtime.id,healthy:__CLF_CONTENT_RECORDER__.healthy()})",
    });
    assert.deepEqual(stopped.result.value, { runtime: "undefined", healthy: false });
    assert.equal(await contents.executeJavaScript("window.__cosUsageObserver.current()"), false);
    await window.loadURL("https://chatgpt.com/c/after-stop");
    assert.equal(await contents.executeJavaScript("window.usageBeforePageScript"), false);
    result.stopRetiresOriginalScriptsAndFutureInjection = true;
    await assert.rejects(agent.evaluate(tab, "1"), /stopped/);
    result.stopRejectsNewWork = true;
    result.passed = true;
  } catch (error) {
    result.error = error.stack;
    process.exitCode = 1;
  } finally {
    await agent.stop();
    window.destroy();
    result.messages = messages;
    result.diagnostics = diagnostics;
    const evidence = join(root, "docs/cos-workspace-pack/evidence");
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "cos-page-smoke.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
    clearTimeout(watchdog);
    app.exit(process.exitCode || 0);
  }
  }).catch(error => { console.error(error); app.exit(1); });
}
