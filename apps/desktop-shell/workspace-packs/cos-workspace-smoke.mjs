import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { webContents, nativeImage } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runCosWorkspaceSmoke({ window, workspace, exit }) {
  const resultPath = process.env.EGO_COS_SMOKE_RESULT;
  const result = { checkedAt: new Date().toISOString(), passed: false };
  const errors = [];
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const evaluate = script => window.webContents.executeJavaScript(script);
  async function browserCall(method, args) {
    result.browserStage = method;
    console.error(`[CoS smoke] ${method}`);
    let timer;
    try {
      return await Promise.race([
        workspace.browser.call(method, args),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Browser fixture timed out at ${method}`)), 15_000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async function capture(contents, name) {
    window.show();
    window.focus();
    await contents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const image = await contents.capturePage(undefined, { stayAwake: true });
        assert.equal(image.isEmpty(), false);
        await writeFile(join(dirname(resultPath), name), image.toPNG());
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await delay(300);
      }
    }
  }
  async function waitFor(script, label, timeout = 30_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(script)) return;
      await delay(100);
    }
    throw new Error(`Timed out: ${label}`);
  }
  try {
    await waitFor("Boolean(window.egoDesktop && document.querySelector('[data-cos-enabled]'))", "Ego renderer ready");
    const initial = await evaluate("window.egoDesktop.invoke('cos.status')");
    assert.equal(initial.builtin, true);
    assert.equal(initial.installed, true);
    assert.equal(initial.enabled, false);
    result.builtinAvailableWithoutInstallation = true;
    await waitFor("document.querySelector('[data-cos-install]').hidden && document.querySelector('[data-cos-load]').hidden", "built-in component controls");
    assert.equal(await evaluate("Boolean(document.querySelector('[data-cos-check]') && document.querySelector('[data-cos-update]'))"), true);
    const enabled = await evaluate("window.egoDesktop.invoke('cos.enable', {profileId:'default'})");
    assert.equal(enabled.enabled, true);
    assert.ok(enabled.workspace.taskId);
    const endpoint = JSON.parse(await readFile(workspace.statusService.discoveryPath, "utf8"));
    const statusResponse = await fetch(`${endpoint.url}/v1/packages/cos/instances/default/status`, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
    });
    assert.equal(statusResponse.status, 200);
    const packageStatus = await statusResponse.json();
    assert.equal(packageStatus.package.state, "ready");
    assert.equal(packageStatus.taskState, "observed", JSON.stringify(packageStatus));
    assert.ok(Array.isArray(packageStatus.sessions.sessions));
    assert.equal(packageStatus.package.directory, undefined);
    const hostAgents = await workspace.runtime.invoke("ego:agent-status", { sourceScope: "ego" });
    assert.equal(hostAgents.available, true, JSON.stringify(hostAgents));
    assert.ok(Array.isArray(hostAgents.agents));
    const externalAgents = await workspace.runtime.invoke("ego:agent-status", { sourceScope: "codex-desktop" });
    assert.equal(externalAgents.available, false);
    result.statusInterface = { automaticDiscovery: true, realRuntimeSummary: true, hostedAgentRequest: true, externalProviderExplicitlyUnavailable: true };
    const mcp = await promisify(execFile)(process.env.EGO_COS_SMOKE_NODE, ["tools/cos-status-mcp-smoke.mjs"], {
      windowsHide: true, timeout: 30_000,
    });
    result.statusInterface.mcp = JSON.parse(mcp.stdout);
    const companion = await workspace.companion.message({ type: "status" });
    assert.equal(companion.connected, true, JSON.stringify(companion));
    assert.equal(companion.paired, true, JSON.stringify(companion));
    assert.equal(companion.compatible, true, JSON.stringify(companion));
    result.originalCompanionConnectedOverIpc = true;
    const page = await browserCall("tabs.create", [{ url: process.env.EGO_COS_SMOKE_PAGE, active: false }]);
    const ownTabs = await browserCall("tabs.query");
    assert.ok(ownTabs.some(tab => tab.id === page.id));
    assert.ok(ownTabs.every(tab => tab.windowId === enabled.workspace.id));
    const groupId = await browserCall('tabs.group', [{ tabIds: [page.id], createProperties: { windowId: enabled.workspace.id } }]);
    await browserCall('tabGroups.update', [groupId, { title: 'Chat On Steroids', color: 'grey', collapsed: true }]);
    assert.equal((await browserCall('tabs.get', [page.id])).groupId, groupId);
    assert.equal((await browserCall('tabGroups.query', [{ title: 'Chat On Steroids' }]))[0].collapsed, true);
    await browserCall('tabGroups.update', [groupId, { collapsed: false }]);
    assert.equal((await browserCall('windows.getAll'))[0].id, enabled.workspace.id);
    assert.equal((await browserCall('windows.create', [{ tabId: page.id, focused: false }])).tabs[0].id, page.id);
    result.nativeTabGroupsAndWindowQueries = true;
    await browserCall("debugger.attach", [{ tabId: page.id }, "1.3"]);
    let document;
    for (let attempt = 0; attempt < 50; attempt++) {
      document = await browserCall("debugger.sendCommand", [
        { tabId: page.id }, "Runtime.evaluate", { expression: "document.title", returnByValue: true },
      ]);
      if (document.result.value === "CoS native browser fixture") break;
      await delay(100);
    }
    assert.equal(document.result.value, "CoS native browser fixture");
    const input = await browserCall("scripting.executeScript", [{
      target: { tabId: page.id }, world: "MAIN",
      functionSource: "() => { document.querySelector('#message').value = 'CoS through Ego'; document.querySelector('#send').click(); return document.querySelector('output').textContent; }",
    }]);
    assert.equal(input[0].result, "CoS through Ego");
    const screenshot = await browserCall("debugger.sendCommand", [{ tabId: page.id }, "Page.captureScreenshot", { format: "png" }]);
    result.screenshotDiagnostics = {
      visible: window.isVisible(), minimized: window.isMinimized(), bounds: window.getBounds(),
      page: await webContents.fromId(page.id).executeJavaScript("({width:innerWidth,height:innerHeight,visibility:document.visibilityState})"),
      shell: await evaluate(`Array.from(document.querySelectorAll('#start-view, #webview-stack, webview')).map(e => ({tag:e.tagName,id:e.id,hidden:e.hidden,background:e.dataset.background,display:getComputedStyle(e).display,opacity:getComputedStyle(e).opacity,rect:e.getBoundingClientRect().toJSON()}))`),
    };
    assert.equal(Buffer.from(screenshot.data, "base64").subarray(1, 4).toString(), "PNG");
    const screenshotImage = nativeImage.createFromBuffer(Buffer.from(screenshot.data, "base64"));
    const pixels = screenshotImage.toBitmap();
    const colors = new Set();
    for (let index = 0; index < pixels.length; index += 16) colors.add(pixels.readUInt32LE(index));
    assert.ok(colors.size > 8, "Browser screenshot must contain rendered content");
    result.browserScreenshotPixelColors = colors.size;
    await assert.rejects(browserCall("tabs.get", [-123]), /outside/);
    await browserCall("debugger.detach", [{ tabId: page.id }]);
    await browserCall("tabs.remove", [page.id]);
    assert.equal((await browserCall("tabs.query")).length, 0);
    result.nativeBrowserFixture = { createsScopedTab: true, readsPage: true, inputsAndClicks: true, screenshot: true, rejectsForeignTab: true, closesTab: true };
    const hosted = await browserCall("tabs.create", [{ active: false }]);
    const hostedContents = webContents.fromId(hosted.id);
    const profileSession = hostedContents.session;
    profileSession.protocol.handle("https", () => new Response(
      "<!doctype html><script>window.cosEarly=Boolean(window.__cosUsageObserver)</script><title>CoS hosted ChatGPT fixture</title><main><input id='draft'></main>",
      { headers: { "content-type": "text/html" } }));
    try {
      await browserCall("tabs.update", [hosted.id, { url: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111" }]);
      const early = await browserCall("scripting.executeScript", [{ target: { tabId: hosted.id }, world: "MAIN", functionSource: "()=>window.cosEarly" }]);
      assert.equal(early[0].result, true);
      const registration = await browserCall("scripting.executeScript", [{
        target: { tabId: hosted.id },
        functionSource: "()=>chrome.runtime.sendMessage({type:'register_document',navigationEpoch:0})",
      }]);
      assert.equal(registration[0].result.ok, true, JSON.stringify(registration));
      assert.ok(registration[0].result.documentId);
      const ping = await browserCall("tabs.sendMessage", [hosted.id, { type: "clf-recorder-ping" }]);
      assert.equal(ping.ok, true, JSON.stringify(ping));
      const connected = await browserCall("scripting.executeScript", [{
        target: { tabId: hosted.id }, functionSource: "()=>chrome.runtime.sendMessage({type:'status'})",
      }]);
      assert.equal(connected[0].result.connected, true);
      assert.equal(connected[0].result.paired, true);
      await browserCall("scripting.executeScript", [{
        target: { tabId: hosted.id }, world: "MAIN",
        functionSource: "()=>{setTimeout(()=>window.open('https://chatgpt.com/c/33333333-3333-4333-8333-333333333333','_blank'),0);return true;}",
      }]);
      let popup;
      for (let attempt = 0; attempt < 50; attempt++) {
        popup = (await browserCall("tabs.query")).find(tab => tab.url.includes("33333333-3333"));
        if (popup) break;
        await delay(100);
      }
      assert.ok(popup, "CoS popup must appear in its source workspace");
      assert.equal(popup.windowId, hosted.windowId);
      const popupEarly = await browserCall("scripting.executeScript", [{ target: { tabId: popup.id }, world: "MAIN", functionSource: "()=>window.cosEarly" }]);
      assert.equal(popupEarly[0].result, true);
      await browserCall("tabs.remove", [popup.id]);
      console.error("[CoS smoke] companion.restart");
      assert.equal(await workspace.companion.restart(), true);
      const afterRestart = await browserCall("scripting.executeScript", [{
        target: { tabId: hosted.id }, functionSource: "()=>chrome.runtime.sendMessage({type:'status'})",
      }]);
      assert.equal(afterRestart[0].result.connected, true);
      const reRegistered = await browserCall("scripting.executeScript", [{
        target: { tabId: hosted.id }, functionSource: "()=>chrome.runtime.sendMessage({type:'register_document',navigationEpoch:0})",
      }]);
      assert.equal(reRegistered[0].result.ok, true);
      assert.equal(reRegistered[0].result.documentId, registration[0].result.documentId);
      const firstDocument = registration[0].result.documentId;
      await browserCall("tabs.update", [hosted.id, { url: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" }]);
      await assert.rejects(browserCall("tabs.sendMessage", [hosted.id, { type: "clf-recorder-ping" }, { documentId: firstDocument }]), /stale/);
      await hostedContents.executeJavaScript("document.querySelector('#draft').value='retained-chat-draft'");
      await evaluate("window.egoDesktop.invoke('cos.disable')");
      await evaluate("window.egoDesktop.invoke('cos.enable')");
      const resumedPing = await browserCall("tabs.sendMessage", [hosted.id, { type: "clf-recorder-ping" }]);
      assert.equal(resumedPing.ok, true, "Retained page must reconnect without an explicit injection or navigation");
      assert.equal(await hostedContents.executeJavaScript("document.querySelector('#draft').value"), "retained-chat-draft");
      result.originalPageAgentFixture = {
        documentStart: true, originalBackgroundRegistersDocument: true,
        originalContentResponds: true, originalBackendConnected: true, staleDocumentRejected: true,
        fixtureOnly: true,
        popupStaysScopedAndInjectsBeforeNavigation: true,
        companionRestartPreservesPageConnection: true,
        retainedPageReconnectsAfterEnable: true,
      };
    } finally {
      await browserCall("tabs.remove", [hosted.id]);
      profileSession.protocol.unhandle("https");
    }
    result.workspace = enabled.workspace;
    await waitFor("Boolean(document.querySelector('.task-row.cos-workspace'))", "CoS workspace in sidebar");
    await evaluate("document.querySelector('.task-row.cos-workspace').click()");
    await waitFor("Boolean(document.querySelector('.cos-home-tab.active'))", "fixed CoS tab active");
    assert.ok(workspace.view && !workspace.view.webContents.isDestroyed());
    const contents = workspace.view.webContents;
    contents.on("console-message", (_event, level, message) => {
      if (level >= 3) errors.push(`CoS: ${message}`);
    });
    const ui = await contents.executeJavaScript(`(async () => ({
      title: document.title,
      text: document.body.innerText,
      api: Object.keys(window.api || {}),
      state: await window.api.getState(),
    }))()`);
    assert.ok(ui.text.trim().length > 80, "Original CoS UI must contain rendered content");
    assert.ok(ui.state.ok, JSON.stringify(ui.state));
    result.originalUi = { title: ui.title, text: ui.text.slice(0, 2500), api: ui.api };
    result.stateReadThroughOriginalPreload = true;
    if (workspace.runtime.channels.includes('sessions:search')) {
      const features = await contents.executeJavaScript(`(async () => {
        const search = await window.api.searchSessions('ego-fixture-no-match');
        const skills = await window.api.listManagedSkills();
        const refresh = await window.api.refreshUpdate();
        document.querySelector('#searchChatsButton').click();
        const searchOpened = document.querySelector('#searchDialog').open;
        document.querySelector('#searchDialog').close();
        return { searchOk: search.ok, skillsOk: skills.ok, refreshOk: refresh.ok, searchOpened,
          egoSetup: Boolean(document.querySelector('#egoBrowserSetup button')),
          externalSetupHidden: getComputedStyle(document.querySelector('#browserExtensionStage')).display === 'none' };
      })()`);
      assert.ok(Object.values(features).every(Boolean), JSON.stringify(features));
      result.upstreamFeatures = features;
    }
    const hostedUi = await contents.executeJavaScript(`(() => {
      const visible = selector => {
        const node = document.querySelector(selector);
        return node && getComputedStyle(node).display !== 'none';
      };
      return {
        host: window.egoHost,
        adapterLoaded: Boolean(document.querySelector('#ego-hosted-ui')),
        standaloneControlsHidden: ['#bridgeFolder', '#bridgeDownload', '#bridgeUnpair',
          '#extensionPath', '#startAtLoginRow', 'label:has(#minimizeToTray)',
          'label:has(#chatBrowser)', 'label:has(#browserBridgePort)',
          '#updateGet', '#updateInstall', '#installUpdate'].every(s => !visible(s)),
        browserLabel: document.querySelector('#bridgeState')?.textContent,
        background: document.querySelector('#backgroundRunningCopy')?.textContent,
      };
    })()`);
    assert.equal(hostedUi.host?.name, "EgoLite");
    assert.equal(hostedUi.adapterLoaded, true);
    assert.equal(hostedUi.standaloneControlsHidden, true);
    assert.match(hostedUi.browserLabel, /Ego/);
    assert.ok(['Managed by Ego', '由 Ego 管理'].includes(hostedUi.background));
    result.hostedUi = hostedUi;
    // The broker lease lasts 15 seconds; UI links must still work after idle time.
    await new Promise(resolve => setTimeout(resolve, 16_000));
    const opened = await contents.executeJavaScript(`window.api.openLink(${JSON.stringify(process.env.EGO_COS_SMOKE_PAGE)})`);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const linkedTabs = await browserCall("tabs.query");
    const linkedTab = linkedTabs.find(tab => tab.url === process.env.EGO_COS_SMOKE_PAGE);
    assert.ok(linkedTab, "CoS UI links must open in the CoS workspace");
    assert.equal(linkedTab.active, true);
    assert.equal(linkedTab.windowId, enabled.workspace.id);
    await waitFor("!document.querySelector('.cos-home-tab.active')", "user link replaces the CoS home view");
    const linkedContents = webContents.fromId(linkedTab.id);
    for (let attempt = 0; attempt < 30 && await linkedContents.executeJavaScript("document.visibilityState") !== "visible"; attempt++) await delay(100);
    assert.equal(await linkedContents.executeJavaScript("document.visibilityState"), "visible");
    const observed = await browserCall("scripting.executeScript", [{
      target: { tabId: linkedTab.id }, world: "ISOLATED", functionSource: "()=>document.title",
    }]);
    assert.ok(observed[0].documentId);
    const pinned = await browserCall("scripting.executeScript", [{
      target: { tabId: linkedTab.id, documentIds: [observed[0].documentId] },
      world: "ISOLATED", functionSource: "()=>document.title",
    }]);
    assert.equal(pinned[0].documentId, observed[0].documentId);
    await linkedContents.loadURL(`${process.env.EGO_COS_SMOKE_PAGE}?next-document`);
    await assert.rejects(browserCall("scripting.executeScript", [{
      target: { tabId: linkedTab.id, documentIds: [observed[0].documentId] },
      world: "ISOLATED", functionSource: "()=>document.title",
    }]), /stale/);
    result.browserDocumentProofAndStaleRejection = true;
    await linkedContents.loadURL(`${process.env.EGO_COS_SMOKE_PAGE}frames`);
    const frames = await browserCall("scripting.executeScript", [{ target: { tabId: linkedTab.id, allFrames: true },
      functionSource: "()=>({title:document.title, marker:typeof window.mainMarker})" }]);
    assert.equal(frames.length, 3);
    assert.equal(frames[0].frameId, 0);
    for (const frame of frames.slice(1)) {
      assert.equal(frame.result.title, "Child");
      assert.equal(frame.result.marker, "undefined");
      const main = await browserCall("scripting.executeScript", [{ target: { tabId: linkedTab.id, frameIds: [frame.frameId] },
        world: "MAIN", functionSource: "()=>window.mainMarker" }]);
      assert.equal(main[0].result, "main-only");
      await browserCall("scripting.executeScript", [{ target: { tabId: linkedTab.id, documentIds: [frame.documentId] },
        functionSource: "()=>document.querySelector('input').value='frame-ok'" }]);
    }
    await browserCall("scripting.insertCSS", [{ target: { tabId: linkedTab.id, allFrames: true }, css: "input{color:rgb(12, 34, 56)}" }]);
    const styles = await browserCall("scripting.executeScript", [{ target: { tabId: linkedTab.id, frameIds: frames.slice(1).map(frame=>frame.frameId) },
      functionSource: "()=>({value:document.querySelector('input').value,color:getComputedStyle(document.querySelector('input')).color})" }]);
    assert.ok(styles.every(item => item.result.value === "frame-ok" && item.result.color === "rgb(12, 34, 56)"));
    await linkedContents.loadURL(process.env.EGO_COS_SMOKE_PAGE);
    await assert.rejects(browserCall("scripting.executeScript", [{ target: { tabId: linkedTab.id, documentIds: [frames[1].documentId] }, functionSource: "()=>true" }]), /stale/);
    result.browserSubframes = { count: frames.length, isolatedAndMain: true, css: true, staleRejected: true };
    const multiple = await browserCall("windows.create", [{ url: [process.env.EGO_COS_SMOKE_PAGE, `${process.env.EGO_COS_SMOKE_PAGE}?second`], focused: false }]);
    assert.equal(multiple.tabs.length, 2);
    assert.ok(multiple.tabs.every(tab=>tab.windowId===linkedTab.windowId));
    await browserCall("tabs.remove", [multiple.tabs.map(tab=>tab.id)]);
    result.browserMultipleUrls = true;
    await browserCall("tabs.remove", [linkedTab.id]);
    await evaluate("document.querySelector('.cos-home-tab').click()");
    result.userLinksOpenInOwnForegroundTab = true;
    result.userLinksAfterLeaseIdle = true;
    const attachment = await contents.executeJavaScript(`window.api.dropFiles([
      new File([new Uint8Array([0,127,128,255])], 'ego-ui-binary.bin', {type:'application/octet-stream'})
    ])`);
    assert.equal(attachment.ok, true, attachment.error);
    assert.equal(attachment.data[0].size, 4);
    result.binaryAttachmentThroughOriginalPreload = true;
    const theme = await contents.executeJavaScript(`(async () => {
      const response = await window.api.getState();
      const config = response.data.config;
      const fields = ['capabilities','readOnly','commandAllowlist','tunnel','ui','sessions','compaction','multiAgent','goal','mcp','controlApi'];
      const base = Object.fromEntries(fields.filter(key => config[key] !== undefined).map(key => [key, config[key]]));
      const theme = config.ui.theme === 'dark' ? 'light' : 'dark';
      const saved = await window.api.saveSettings({...base, ui:{...base.ui, theme}}, base);
      if (!saved.ok || saved.data.config.ui.theme !== theme) throw new Error('UI settings save failed');
      return theme;
    })()`);
    result.settingsSavedThroughOriginalPreload = true;
    await delay(1200);
    await mkdir(dirname(resultPath), { recursive: true });
    result.captureState = {
      viewVisible: workspace.view.getVisible(), bounds: workspace.view.getBounds(),
      windowVisible: window.isVisible(), windowMinimized: window.isMinimized(),
      shell: await evaluate(`({
        stackHidden: document.querySelector('#webview-stack').hidden,
        stackBounds: document.querySelector('#webview-stack').getBoundingClientRect().toJSON(),
        stackDisplay: getComputedStyle(document.querySelector('#webview-stack')).display,
        startClasses: document.querySelector('#start-view').className,
        homeClasses: document.querySelector('.cos-home-tab')?.className,
        address: document.querySelector('#current-address').value
      })`),
    };
    await capture(contents, "cos-original-ui.png");
    await capture(window.webContents, "cos-ego-shell.png");
    const bounds = workspace.view.getBounds();
    assert.ok(bounds.width > 300 && bounds.height > 200, JSON.stringify(bounds));
    const toolbarBottom = await evaluate("document.querySelector('.browser-toolbar').getBoundingClientRect().bottom");
    assert.ok(bounds.y >= Math.floor(toolbarBottom * window.webContents.getZoomFactor()), "CoS must not cover Ego toolbar");
    assert.equal(workspace.view.getVisible(), true);
    result.visibleBounds = bounds;
    await evaluate("document.querySelector('[data-open-view=\"settings\"]').click()");
    await delay(200);
    assert.equal(workspace.view.getVisible(), false, "Ego settings must hide CoS native view");
    assert.equal(workspace.runtime.state, "ready", "Switching view must retain backend");
    const installControls = await evaluate(`(() => {
      const root = document.querySelector('#cos-pack-settings');
      return [...root.querySelectorAll('[data-cos-install], [data-cos-load]')].map(button => ({
        hidden: button.hidden, disabled: button.disabled, width: button.getBoundingClientRect().width,
        right: button.getBoundingClientRect().right, parentRight: root.getBoundingClientRect().right
      }));
    })()`);
    assert.equal(installControls.length, 2);
    assert.ok(installControls.every(button => button.hidden && button.width === 0));
    const updateControls = await evaluate(`['check','update','rollback'].map(name=>{
      const button=document.querySelector('[data-cos-'+name+']');
      const bounds=button.getBoundingClientRect();
      return {width:bounds.width,right:bounds.right,parentRight:document.querySelector('#cos-pack-settings').getBoundingClientRect().right};
    })`);
    assert.ok(updateControls.every(button=>button.width>0 && button.right<=button.parentRight));
    await capture(window.webContents, "cos-pack-settings.png");
    assert.notDeepEqual(await readFile(join(dirname(resultPath), "cos-pack-settings.png")),
      await readFile(join(dirname(resultPath), "cos-ego-shell.png")), "Settings capture must not reuse the previous shell frame");
    result.builtinControlsVisibleAndInstallationHidden = true;
    await evaluate("document.querySelector('[data-cos-open]').click()");
    await delay(300);
    assert.equal(workspace.view.getVisible(), true);
    result.settingsNavigationPreservesRuntime = true;
    const other = await evaluate("window.egoDesktop.invoke('task.create', {name:'Ordinary browsing', profileId:'default'})");
    const otherSelector = JSON.stringify(`.task-row[data-task-id="${other.taskId}"]`);
    await waitFor(`Boolean(document.querySelector(${otherSelector}))`, "ordinary workspace added");
    await evaluate(`document.querySelector(${otherSelector}).click()`);
    await waitFor(`document.querySelector(${otherSelector}).classList.contains('active')`, "ordinary workspace selected");
    await delay(300);
    assert.equal(workspace.view.getVisible(), false);
    assert.equal(workspace.runtime.state, "ready");
    await evaluate("document.querySelector('.task-row.cos-workspace').click()");
    await waitFor("Boolean(document.querySelector('.cos-home-tab.active'))", "return to CoS");
    assert.equal(workspace.view.getVisible(), true);
    result.workspaceSwitchPreservesRuntime = true;
    const retained = await browserCall("tabs.create", [{ url: `${process.env.EGO_COS_SMOKE_PAGE}?retained`, active: false }]);
    await browserCall("scripting.executeScript", [{
      target: { tabId: retained.id }, world: "MAIN",
      functionSource: "()=>{document.querySelector('input').value='keep-this-draft';return true;}",
    }]);
    const disabled = await evaluate("window.egoDesktop.invoke('cos.disable')");
    assert.equal(disabled.enabled, false);
    assert.equal(workspace.runtime.pid, undefined);
    assert.equal(workspace.view, undefined);
    result.disabledStopsRuntime = true;
    await assert.rejects(readFile(workspace.statusService.discoveryPath), { code: "ENOENT" });
    result.statusInterface.discoveryRemovedOnDisable = true;
    const restored = await evaluate("window.egoDesktop.invoke('cos.enable')");
    const nextEndpoint = JSON.parse(await readFile(workspace.statusService.discoveryPath, "utf8"));
    assert.notEqual(nextEndpoint.token, endpoint.token);
    assert.equal((await fetch(`${nextEndpoint.url}/v1/health`, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
    })).status, 401);
    result.statusInterface.oldTokenRevoked = true;
    assert.equal(restored.workspace.taskId, enabled.workspace.taskId);
    result.reusesWorkspace = true;
    const restoredState = await workspace.runtime.invoke("state:get");
    assert.equal(restoredState.data.config.ui.theme, theme);
    result.uiSettingsPersistedAcrossRestart = true;
    const retainedTabs = await browserCall("tabs.query");
    const reopened = retainedTabs.find(tab => tab.url.includes("?retained"));
    assert.ok(reopened, "Disabling CoS must retain its business tab");
    const draft = await browserCall("scripting.executeScript", [{
      target: { tabId: reopened.id }, world: "MAIN", functionSource: "()=>document.querySelector('input').value",
    }]);
    assert.equal(draft[0].result, "keep-this-draft");
    result.businessTabAndDraftSurviveDisable = true;
    await browserCall("tabs.remove", [reopened.id]);
    const stopStatus = workspace.statusService.stop.bind(workspace.statusService);
    workspace.statusService.stop = async () => { await stopStatus(); throw new Error("Injected discovery cleanup failure"); };
    try {
      await assert.rejects(workspace.disable(), /shutdown cleanup failed/);
      assert.equal(workspace.enabled, false);
      assert.equal(workspace.runtime.pid, undefined);
      assert.equal(workspace.companion, undefined);
      assert.equal(workspace.browser, undefined);
      result.statusCleanupFailureStillStopsExecution = true;
    } finally { workspace.statusService.stop = stopStatus; }
    await evaluate("window.egoDesktop.invoke('cos.disable')");
    result.passed = true;
  } catch (error) {
    result.error = error.stack || String(error);
  } finally {
    try { await workspace.shutdown(); }
    catch (error) { result.shutdownError = error.message; result.passed = false; }
    result.rendererErrors = errors;
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
    exit(result.passed ? 0 : 1);
  }
}
