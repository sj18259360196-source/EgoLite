import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { webContents } from 'electron';

export async function runInteractionSmoke({ window, getTabs, getVisibleId, createTab, extensionHost, output, exit }) {
  const checks = {};
  const evaluate = code => window.webContents.executeJavaScript(code);
  const until = async (fn, label) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); }
    throw Error(label);
  };
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>${req.url}</title><input id="typing"><a id="same" href="/next">same page</a><a id="popup" target="_blank" href="/child">new page</a><button id="open" onclick="window.open('/script-child')">open</button><p>${req.url}</p>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await until(() => evaluate('document.querySelector("#connection")?.textContent === "本地运行中"'), 'UI not ready');
    await evaluate(`(async()=>{const task = await window.egoDesktop.invoke('task.create',{name:'Interaction regression'}); await window.egoDesktop.invoke('tab.open',{taskId:task.taskId,url:${JSON.stringify(url + '/home')},visual:true});})()`);
    const visible = () => getTabs().find(tab => tab.webContentsId === getVisibleId());
    const initial = visible();
    assert.ok(initial);
    const assertVisible = async tab => {
      await until(async () => getVisibleId() === tab.webContentsId && await evaluate(`(()=>{const id=${JSON.stringify(tab.targetId)};const view=[...document.querySelectorAll('webview[data-target-id]')].find(v=>v.dataset.targetId===id);return view && !view.hidden && document.querySelector('.browser-tab.active')?.dataset.targetId === id && document.querySelector('#current-address').value === view.getURL()})()`), 'Visible page, address and active tab disagree');
      await until(() => webContents.fromId(tab.webContentsId).getURL().startsWith(url), 'Page not loaded');
    };
    await assertVisible(initial);
    const home = webContents.fromId(initial.webContentsId);
    await until(() => home.executeJavaScript('!!document.querySelector("#popup")'), 'Fixture not ready');
    await home.executeJavaScript('document.querySelector("#popup").click()');
    await until(() => getTabs().some(tab => tab.url === url + '/child'), 'Link did not open');
    const child = getTabs().find(tab => tab.url === url + '/child');
    await assertVisible(child);
    checks.linkOpensVisibleTab = true;
    await until(() => evaluate('document.activeElement?.tagName === "WEBVIEW"'), 'New page lacks focus');
    checks.newPageFocus = true;
    const childContents = webContents.fromId(child.webContentsId);
    await until(() => !childContents.isLoading(), 'Child still loading');
    await until(() => childContents.executeJavaScript('!!document.querySelector("#same")'), 'Child not ready');
    await childContents.executeJavaScript('document.querySelector("#same").click()', true);
    await until(() => childContents.getURL() === url + '/next', 'Same-tab navigation failed');
    await until(() => evaluate('!document.querySelector("#browser-back").disabled'), 'Back button not enabled');
    await evaluate('document.querySelector("#browser-back").click()');
    await until(() => childContents.getURL() === url + '/child', 'Back failed');
    await until(() => evaluate('!document.querySelector("#browser-forward").disabled'), 'Forward button not enabled');
    await evaluate('document.querySelector("#browser-forward").click()');
    await until(() => childContents.getURL() === url + '/next', 'Forward failed');
    checks.historyNavigation = true;
    await until(() => !childContents.isLoading(), 'Forward still loading');
    const beforeMiddle = getTabs().length;
    const point = await childContents.executeJavaScript(`(()=>{const r=document.querySelector('#popup').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    childContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'middle', clickCount: 1 });
    childContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'middle', clickCount: 1 });
    await until(() => getTabs().length > beforeMiddle, 'Middle click did not open tab');
    await assertVisible(child);
    checks.middleClickStaysInBackground = true;
    const beforeCtrl = getTabs().length;
    childContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1, modifiers: ['control'] });
    childContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1, modifiers: ['control'] });
    await until(() => getTabs().length > beforeCtrl, 'Ctrl click did not open tab');
    await assertVisible(child);
    checks.ctrlClickStaysInBackground = true;
    await home.executeJavaScript('document.querySelector("#open").click()');
    await until(() => getTabs().some(tab => tab.url === url + '/script-child'), 'Background popup absent');
    await assertVisible(child);
    checks.backgroundPageDoesNotStealFocus = true;
    const background = await createTab(initial.taskId, url + '/agent');
    await assertVisible(child);
    checks.agentOpenDoesNotChangeVisiblePage = true;
    const ext = { extension: { id: 'interaction-test', url: 'chrome-extension://interaction-test/' }, manifest: {} };
    const extBackground = await extensionHost.invoke(ext, 'tabs.create', [{ url: url + '/extension-background', active: false }]);
    await assertVisible(child);
    checks.extensionBackgroundRespected = true;
    const extFront = await extensionHost.invoke(ext, 'tabs.create', [{ url: url + '/extension-front', active: true }]);
    const front = getTabs().find(tab => tab.webContentsId === extFront.id);
    await assertVisible(front);
    await extensionHost.invoke(ext, 'tabs.update', [extBackground.id, { active: true }]);
    const selected = getTabs().find(tab => tab.webContentsId === extBackground.id);
    await assertVisible(selected);
    checks.extensionActivationVisible = true;
    await evaluate(`${JSON.stringify([child.targetId, front.targetId, selected.targetId])}.forEach(id=>[...document.querySelectorAll('.browser-tab')].find(el=>el.dataset.targetId===id).click())`);
    await assertVisible(selected);
    checks.rapidSelectionKeepsLatest = true;
    await extensionHost.invoke(ext, 'tabs.remove', [extFront.id]);
    await assertVisible(selected);
    checks.closeBackgroundKeepsVisible = true;
    await extensionHost.invoke(ext, 'tabs.remove', [extBackground.id]);
    await until(() => evaluate('!!document.querySelector(".browser-tab.active") && [...document.querySelectorAll("webview[data-target-id]")].some(v=>!v.hidden)'), 'Closing current tab left blank view');
    assert.notEqual(getVisibleId(), extBackground.id);
    checks.closeCurrentShowsReplacement = true;
    writeFileSync(output, JSON.stringify({ passed: true, checks }, null, 2));
    exit(0);
  } catch (error) {
    const debug = await evaluate(`(async()=>{const views=[...document.querySelectorAll('webview[data-target-id]')];return {address:document.querySelector('#current-address').value,active:document.querySelector('.browser-tab.active')?.dataset.targetId,views:await Promise.all(views.map(async v=>({id:v.dataset.targetId,url:v.getURL(),hidden:v.hidden,canBack:await v.canGoBack?.(),method:typeof v.canGoBack})))}})()`).catch(() => null);
    writeFileSync(output, JSON.stringify({ passed: false, checks, error: error.stack, debug }, null, 2));
    exit(1);
  } finally { server.close(); }
}
