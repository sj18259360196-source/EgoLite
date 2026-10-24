import { app, BrowserWindow, session } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { prepareExtensionRuntime } from '../apps/desktop-shell/extension-runtime.mjs';
import { TargetedExtensionHost } from '../apps/desktop-shell/extension-targeted-host.mjs';

const root = resolve(import.meta.dirname, '..');
const work = join(root, '.tmp', 'codex', 'installed-extension-adaptation');
mkdirSync(work, { recursive: true });
app.setPath('userData', join(work, 'probe-user-data'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
const ses = session.fromPartition('persist:extension-probe');
const installCode = '// ==UserScript==\n// @name Click install regression\n// @namespace ego-tests-ui\n// @version 1.0\n// @match *://*/*\n// ==/UserScript==\ndocument.documentElement.dataset.clickInstalled="yes";';
const server = createServer((req, res) => {
  if (req.url === '/click.user.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(installCode); return; }
  if (req.url === '/data') { res.end('extension-network-ok'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>Extension fixture</title><form><label>姓名<input name="fullName" autocomplete="name"></label><label>邮箱<input name="email" type="email"></label></form>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
const parent = new BrowserWindow({ show: false, webPreferences: { session: ses } });
const page = new BrowserWindow({ show: false, webPreferences: { session: ses } });
page.webContents.on('console-message', event => { if (event.level === 'error') console.log('PAGE', event.message); });
const tab = () => ({ id: page.webContents.id, url: page.webContents.getURL(), title: 'Extension fixture', windowId: parent.id, active: true });
const extraTabs = [];
const describe = win => ({ id: win.webContents.id, url: win.webContents.getURL(), windowId: parent.id, active: false });
const host = new TargetedExtensionHost({ session: ses, statePath: join(work, 'host.json'), getTabs: () => [tab(), ...extraTabs.filter(win => !win.isDestroyed()).map(describe)], getActiveTab: tab, getWindow: () => parent,
  createTab: async details => { const win = new BrowserWindow({ show: false, webPreferences: { session: ses } }); extraTabs.push(win); await win.loadURL(details.url); return describe(win); },
  updateTab: async (target, details) => { const win = [page, ...extraTabs].find(win => !win.isDestroyed() && win.webContents.id === target.id); if (details.url) await win.loadURL(details.url); return describe(win); },
  removeTab: target => { const win = extraTabs.find(win => !win.isDestroyed() && win.webContents.id === target.id); win?.destroy(); },
});
await page.loadURL(fixtureUrl);
assert.equal(await (await ses.fetch(fixtureUrl + 'data')).text(), 'extension-network-ok');
const prefs = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, 'EgoCompat', 'desktop-preferences.json'), 'utf8'));
const output = [];
let exitCode = 0;
try {
  for (const record of prefs.browserExtensions) {
    const prepared = prepareExtensionRuntime(record.path, join(work, 'runtime'));
    const extension = await ses.extensions.loadExtension(prepared.path);
    host.register(extension, JSON.parse(readFileSync(join(record.path, 'manifest.json'), 'utf8')));
    const logs = [];
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, backgroundThrottling: false } });
    win.webContents.on('console-message', event => logs.push({ level: event.level, message: event.message }));
    win.webContents.on('console-message', event => { if (event.level === 'error') console.log('BACKGROUND', event.message); });
    await win.loadURL(`${extension.url}electron-background.html`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const health = await win.webContents.executeJavaScript(`({ chrome: Object.keys(chrome), browser: typeof browser, errors: globalThis.__egoExtensionErrors, listeners: chrome.runtime.onMessage.hasListeners(), url: location.href })`);
    assert.deepEqual(health.errors, []);
    assert.equal(health.listeners, true);
    host.grantActiveTab(extension.id);
    const popup = new BrowserWindow({ show: false, webPreferences: { session: ses } });
    popup.webContents.on('console-message', event => logs.push({ level: event.level, message: event.message }));
    await popup.loadURL(extension.url + (extension.manifest.browser_action?.default_popup || extension.manifest.action?.default_popup));
    const checks = {};
    let data;
    if (extension.id === 'eeagobfjdenkkddmbclomhiblgggliao') {
      data = await host.invoke(host.extensions.get(extension.id), 'violentmonkey.initialData', ['options']);
      assert.ok(data.options);
      await waitFor(() => popup.webContents.executeJavaScript('typeof browser !== "undefined" && document.body.innerText.length > 0'));
      const script = `// ==UserScript==\n// @name Ego adapter smoke\n// @namespace ego-tests\n// @version 1.0\n// @match http://127.0.0.1/*\n// @inject-into content\n// @grant GM_setValue\n// @grant GM_getValue\n// @run-at document-end\n// ==/UserScript==\nGM_setValue('counter', GM_getValue('counter', 0) + 1); document.documentElement.dataset.egoScript = String(GM_getValue('counter'));`;
      const parsed = await popup.webContents.executeJavaScript(`browser.runtime.sendMessage({cmd:'ParseScript',data:{code:${JSON.stringify(script.replace('http://127.0.0.1/*', '*://*/*').replace('// @inject-into content\n', ''))}}})`);
      checks.installed = parsed.errors == null;
      await popup.webContents.executeJavaScript(`browser.runtime.sendMessage({cmd:'UpdateScriptInfo',data:{id:${parsed.where.id},config:{enabled:1}}})`);
      await page.loadURL(fixtureUrl);
      await waitFor(() => page.webContents.executeJavaScript('Boolean(document.documentElement.dataset.egoScript)'));
      checks.injected = await page.webContents.executeJavaScript('document.documentElement.dataset.egoScript');
      await page.loadURL(fixtureUrl);
      await waitFor(() => page.webContents.executeJavaScript(`Number(document.documentElement.dataset.egoScript) === ${Number(checks.injected) + 1}`));
      checks.gmStorageAndNoDuplicate = true;
      data = await host.invoke(host.extensions.get(extension.id), 'violentmonkey.initialData', ['options']);
      checks.scriptCount = data.options.scripts.length;
      const id = data.options.scripts.find(script => script.meta.name === 'Ego adapter smoke').props.id;
      await popup.webContents.executeJavaScript(`browser.runtime.sendMessage({cmd:'UpdateScriptInfo',data:{id:${id},config:{enabled:0}}})`);
      await page.loadURL(fixtureUrl);
      assert.equal(await page.webContents.executeJavaScript('document.documentElement.dataset.egoScript || null'), null);
      checks.disable = true;
      await popup.webContents.executeJavaScript(`browser.runtime.sendMessage({cmd:'UpdateScriptInfo',data:{id:${id},config:{enabled:1}}})`);
      const networkScript = script.replace('http://127.0.0.1/*', '*://*/*').replace('// @inject-into content\n', '').replace('// @grant GM_setValue', '// @grant GM_xmlhttpRequest\n// @connect 127.0.0.1\n// @grant GM_setValue') + `\nGM_xmlhttpRequest({url:${JSON.stringify(fixtureUrl + 'data')},onload:r=>document.documentElement.dataset.egoNetwork=r.responseText,onerror:r=>document.documentElement.dataset.egoNetwork=String(r)+' '+r.message+' '+r.stack});`;
      await popup.webContents.executeJavaScript(`browser.runtime.sendMessage({cmd:'ParseScript',data:{code:${JSON.stringify(networkScript)}}})`);
      await page.loadURL(fixtureUrl);
      try { await waitFor(() => page.webContents.executeJavaScript(`Boolean(document.documentElement.dataset.egoNetwork)`)); assert.equal(await page.webContents.executeJavaScript('document.documentElement.dataset.egoNetwork'), 'extension-network-ok'); }
      catch(error) {
        console.log('NETWORK DEBUG', await page.webContents.executeJavaScript('JSON.stringify(document.documentElement.dataset)'), await win.webContents.executeJavaScript('JSON.stringify({errors:globalThis.__egoExtensionErrors,frames:[...document.querySelectorAll("iframe")].map(f=>({src:f.src,ready:f.contentDocument.readyState,bridge:!!f.contentWindow.egoExtensionHost}))})'));
        throw error;
      }
      checks.network = true;
      await popup.webContents.executeJavaScript(`browser.runtime.sendMessage({cmd:'MarkRemoved',data:{id:${id},removed:1}})`);
      await popup.webContents.executeJavaScript(`browser.runtime.sendMessage({cmd:'RemoveScripts',data:[${id}]})`);
      checks.delete = true;
      data = await host.invoke(host.extensions.get(extension.id), 'violentmonkey.initialData', ['options']);
      assert.equal(data.options.scripts.some(script => script.meta.name === 'Ego adapter smoke'), false);
    } else {
      await popup.webContents.executeJavaScript(`chrome.storage.local.set({profileV2:{schemaVersion:2,sections:{basic:{key:'basic',title:'基本信息',kind:'simple',values:{姓名:'Adapter Tester',邮箱:'adapter@example.test'},custom:[]}}},apiConfig:{enabled:false}})`);
      const settings = await popup.webContents.executeJavaScript(`chrome.runtime.sendMessage({type:'OJAF_GET_SETTINGS'})`);
      assert.equal(settings.ok, true);
      checks.settings = true;
      await popup.webContents.executeJavaScript(`chrome.storage.session.set({smokeShared:'visible'})`);
      assert.equal(await win.webContents.executeJavaScript(`chrome.storage.session.get('smokeShared').then(v=>v.smokeShared)`), 'visible');
      checks.sharedSession = true;
      checks.permissionCallback = await popup.webContents.executeJavaScript(`new Promise(resolve=>chrome.permissions.contains({origins:['https://ungranted.invalid/*']}, resolve))`);
      assert.equal(checks.permissionCallback, false);
      await popup.webContents.executeJavaScript(`document.querySelector('#startAutofillBtn').click()`);
      await waitFor(() => page.webContents.executeJavaScript(`document.querySelector('input[name="email"]').value === 'adapter@example.test'`));
      checks.filled = await page.webContents.executeJavaScript(`Array.from(document.querySelectorAll('form input')).map(input=>input.value)`);
      assert.deepEqual(checks.filled, ['Adapter Tester', 'adapter@example.test']);
      await popup.webContents.executeJavaScript(`document.querySelector('#startAutofillBtn').click()`);
      await waitFor(() => popup.webContents.executeJavaScript(`!document.querySelector('#startAutofillBtn').disabled`));
      assert.deepEqual(await page.webContents.executeJavaScript(`Array.from(document.querySelectorAll('form input')).map(input=>input.value)`), checks.filled);
      checks.repeatFill = true;
    }
    await popup.webContents.executeJavaScript('chrome.runtime.openOptionsPage()');
    const optionsWindow = host.extensions.get(extension.id).options;
    await waitFor(() => optionsWindow.webContents.executeJavaScript('document.body.innerText.length > 20'));
    checks.optionsPage = true;
    if (extension.id === 'eeagobfjdenkkddmbclomhiblgggliao') {
      assert.equal(await optionsWindow.webContents.executeJavaScript('document.body.innerText.includes("Custom Script Template")'), true);
      const initialAutoReload = (await host.invoke(host.extensions.get(extension.id), 'violentmonkey.initialData', ['options'])).opts.autoReload;
      await optionsWindow.webContents.executeJavaScript(`const label = [...document.querySelectorAll('label')].find(el => el.innerText.includes('Reload current tab')); if (!label) throw Error('Missing auto reload control'); label.click();`);
      await waitFor(async () => (await host.invoke(host.extensions.get(extension.id), 'violentmonkey.initialData', ['options'])).opts.autoReload !== initialAutoReload);
      optionsWindow.reload();
      await waitFor(() => optionsWindow.webContents.executeJavaScript('document.body.innerText.includes("Custom Script Template")'));
      checks.settingsSaved = true;
      await page.loadURL(fixtureUrl + 'click.user.js').catch(() => {});
      await waitFor(() => [page, ...extraTabs].some(win => !win.isDestroyed() && win.webContents.getURL().includes('/confirm/index.html')));
      const confirm = [page, ...extraTabs].find(win => !win.isDestroyed() && win.webContents.getURL().includes('/confirm/index.html'));
      await waitFor(() => confirm.webContents.executeJavaScript('document.body.innerText.includes("Click install regression")'));
      await confirm.webContents.executeJavaScript(`const button = [...document.querySelectorAll('button')].find(el => /^(Install|Reinstall)$/.test(el.textContent.trim())); if (!button || button.disabled) throw Error('Install button unavailable'); button.click();`);
      await waitFor(async () => (await host.invoke(host.extensions.get(extension.id), 'violentmonkey.initialData', ['options'])).options.scripts.some(script => script.meta.name === 'Click install regression'));
      await page.loadURL(fixtureUrl);
      await waitFor(() => page.webContents.executeJavaScript('document.documentElement.dataset.clickInstalled === "yes"'));
      checks.installConfirmation = true;
      assert.equal(logs.some(log => log.level === 'error'), false, JSON.stringify(logs));
    }
    const rejected = await host.handler({ sender: page.webContents, senderFrame: { url: fixtureUrl } }, 'storage.session.get', [null]);
    assert.match(rejected.error, /denied/);
    checks.webPageCannotAccessHost = true;
    output.push({ name: record.name, version: extension.version, health, checks, logs });
    popup.destroy();
    win.destroy();
    host.unregister(extension.id);
    ses.extensions.removeExtension(extension.id);
  }
  writeFileSync(join(work, 'baseline.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally { for (const win of BrowserWindow.getAllWindows()) win.destroy(); host.dispose(); server.close(); app.exit(exitCode); }
});

async function waitFor(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Extension operation timed out');
}
