import assert from "node:assert/strict";
import { BrowserWindow, webContents } from "electron";
import { writeFileSync } from "node:fs";

export async function runExtensionStartupSmoke({ window, host, loaded, backgrounds, records, session, exit }) {
  const checks = {};
  const consoleErrors = [];
  const observer = (_event, contents) => contents.on("console-message", (_event, details) => {
    if (details?.level === "error") consoleErrors.push(String(details.message).slice(0, 500));
  });
  for (const contents of webContents.getAllWebContents()) observer(null, contents);
  let popup;
  const until = async (check, label) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(label);
  };
  const invoke = (method, payload) => window.webContents.executeJavaScript(`window.egoDesktop.invoke(${JSON.stringify(method)},${JSON.stringify(payload)})`);
  try {
    await until(() => window.webContents.executeJavaScript('document.querySelector("#connection")?.textContent === "本地运行中"'), "Shell not ready");
    const task = await invoke("task.create", { name: "Extension cold startup" });
    const tab = await invoke("tab.open", { taskId: task.taskId, url: process.env.EGO_EXTENSION_FIXTURE, visual: true });
    await until(() => webContents.getAllWebContents().some(w => w.getURL() === process.env.EGO_EXTENSION_FIXTURE), "Fixture not available");
    const target = webContents.getAllWebContents().find(w => w.getURL() === process.env.EGO_EXTENSION_FIXTURE);
    for (const record of records) {
      const extension = loaded.get(record.id);
      assert.ok(extension, `${record.name}: ${record.error || "not loaded"}`);
      const background = backgrounds.get(record.id);
      assert.ok(background, `${record.name}: background missing`);
      const path = extension.manifest.browser_action?.default_popup || extension.manifest.action?.default_popup;
      host.grantActiveTab(extension.id);
      popup = new BrowserWindow({ show: false, webPreferences: { session, sandbox: true } });
      await popup.loadURL(new URL(path, extension.url).href);
      await until(() => popup.webContents.executeJavaScript('typeof chrome?.runtime?.sendMessage === "function" && document.body.innerText.length > 0'), "Popup not ready");
      const health = await background.webContents.executeJavaScript('({errors:globalThis.__egoExtensionErrors || [],listeners:chrome.runtime.onMessage.hasListeners(),targeted:!!globalThis.__egoTargetedExtension,chromeSendHeaders:typeof chrome.webRequest?.onSendHeaders,browserSendHeaders:typeof globalThis.browser?.webRequest?.onSendHeaders,chromeEvents:Object.keys(chrome.webRequest||{})})');
      checks[record.name] = { health };
      checks[record.name].sameSession = target.session === session;
      if (extension.id === "eeagobfjdenkkddmbclomhiblgggliao") {
        await until(() => popup.webContents.executeJavaScript('typeof browser !== "undefined"'), "Violentmonkey popup not ready");
        const data = await host.invoke(host.extensions.get(extension.id), "violentmonkey.initialData", ["options"]);
        assert.ok(data.options, "Violentmonkey options unavailable");
        if (process.env.EGO_EXTENSION_BOOT === "1") {
          const code = '// ==UserScript==\n// @name Ego cold boot regression\n// @namespace ego-cold-start-test\n// @version 1.0\n// @match *://*/*\n// @run-at document-end\n// @grant GM_setValue\n// @grant GM_getValue\n// ==/UserScript==\nGM_setValue("coldCounter", GM_getValue("coldCounter",0)+1); document.documentElement.dataset.egoColdBoot="ready";';
          const parsed = await popup.webContents.executeJavaScript(`browser.runtime.sendMessage({cmd:"ParseScript",data:{code:${JSON.stringify(code)}}})`);
          assert.ok(parsed.where?.id, "Script installation failed");
          await popup.webContents.executeJavaScript(`browser.runtime.sendMessage({cmd:"UpdateScriptInfo",data:{id:${parsed.where.id},config:{enabled:1}}})`);
          await target.loadURL(process.env.EGO_EXTENSION_FIXTURE);
        }
        await until(() => target.executeJavaScript('document.documentElement.dataset.egoColdBoot === "ready"'), "Cold-start userscript did not execute without reload");
        checks[record.name].injectionWithoutExtensionReload = true;
      } else if (record.name === "OpenJobAutofill") {
        if (process.env.EGO_EXTENSION_BOOT === "1") {
          await popup.webContents.executeJavaScript(`chrome.storage.local.set({profileV2:{schemaVersion:2,sections:{basic:{key:"basic",title:"基本信息",kind:"simple",values:{姓名:"Cold Boot Tester",邮箱:"cold@example.test"},custom:[]}}},apiConfig:{enabled:false}})`);
        }
        const response = await popup.webContents.executeJavaScript('chrome.runtime.sendMessage({type:"OJAF_GET_SETTINGS"})');
        assert.equal(response?.ok, true, "Autofill background did not respond");
        checks[record.name].messageWithoutExtensionReload = true;
        await until(() => popup.webContents.executeJavaScript('!!document.querySelector("#startAutofillBtn")'), "Autofill action not ready");
        await popup.webContents.executeJavaScript('document.querySelector("#startAutofillBtn").click()');
        await until(() => target.executeJavaScript('document.querySelector("input[name=email]").value === "cold@example.test"'), "Cold-start autofill did not execute");
        checks[record.name].autofillWithoutExtensionReload = true;
      }
      popup.destroy();
      popup = null;
    }
    await session.flushStorageData();
    writeFileSync(process.env.EGO_EXTENSION_STARTUP_SMOKE_RESULT, JSON.stringify({ passed: true, boot: process.env.EGO_EXTENSION_BOOT, checks }, null, 2));
    exit(0);
  } catch (error) {
    popup?.destroy();
    writeFileSync(process.env.EGO_EXTENSION_STARTUP_SMOKE_RESULT, JSON.stringify({ passed: false, error: error.stack, checks, consoleErrors }, null, 2));
    exit(1);
  }
}
