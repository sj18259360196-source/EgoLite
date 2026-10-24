const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const work = process.env.EGO_COS_COMPUTER_TEST;
if (!work) throw Error('Isolated test directory required');
app.setPath('userData', path.join(work, 'profile'));
app.setPath('temp', work);
let window;
let native;
const result = { checkedAt: new Date().toISOString(), passed: false };
app.whenReady().then(async () => {
  try {
    native = require(path.join(work, 'computer.cjs'));
    const api = native.createWindowsComputerApi();
    window = new BrowserWindow({ width: 650, height: 400, title: 'CoS native input test', show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL('data:text/html,<title>CoS native input test</title><input id="test" aria-label="Test input" style="margin:50px;font-size:24px" autofocus>');
    window.show();
    window.focus();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await window.webContents.executeJavaScript("document.querySelector('input').focus()");
    const handle = window.getNativeWindowHandle();
    const id = handle.length >= 8 ? Number(handle.readBigUInt64LE()) : handle.readUInt32LE();
    result.fixture = { id, visible: window.isVisible(), bounds: window.getBounds() };
    const target = await api.get_window({ id });
    assert.equal(target.id, id);
    result.exactOwnedWindowResolved = true;
    const state = await api.get_window_state({ window: target, include_screenshot: true, include_text: true });
    assert.ok(state.screenshots.length > 0);
    result.nativeWindowScreenshot = true;
    result.accessibilityAvailable = Boolean(state.accessibility);
    await api.type_text({ window: target, text: 'cos-native-input' });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('input').value"), 'cos-native-input');
    result.nativeTypingReturnedToFixture = true;
    await api.press_key({ window: target, key: 'Control_L+a' });
    await api.type_text({ window: target, text: 'cos-keyboard-ok' });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('input').value"), 'cos-keyboard-ok');
    result.nativeKeyChord = true;
    result.passed = true;
  } catch (error) { result.error = error.stack; }
  finally {
    await native?.stopComputerHelper();
    window?.destroy();
    fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(result));
    app.exit(result.passed ? 0 : 1);
  }
});
