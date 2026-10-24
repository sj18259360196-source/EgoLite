import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function runCosPresetUiSmoke({ window, workspace, brokerPid, quit }) {
  const output = process.env.EGO_COS_PRESET_UI_RESULT;
  const result = { checkedAt: new Date().toISOString(), passed: false, brokerPid: brokerPid() };
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = async predicate => {
    for (let n = 0; n < 600; n++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`CoS preset UI did not settle: ${workspace.describe().error}`);
  };
  window.webContents.setBackgroundThrottling(false);
  try {
    await wait(() => evaluate("Boolean(window.egoDesktop && document.querySelector('[data-cos-download]'))"));
    assert.equal(workspace.describe().installed, false);
    await evaluate("document.querySelector('[data-open-view=\"settings\"]').click()");
    await wait(() => evaluate("!document.querySelector('[data-cos-download]').hidden"));
    await evaluate("document.querySelector('[data-cos-download]').click()");
    await wait(() => workspace.acquiring);
    result.downloadStartedFromSettings = true;
    await wait(() => evaluate("!document.querySelector('[data-cos-cancel-install]').hidden"));
    await evaluate("document.querySelector('[data-cos-cancel-install]').click()");
    await wait(() => !workspace.acquiring);
    assert.equal(workspace.describe().installed, false);
    assert.equal(workspace.enabled, false);
    result.cancelledDownloadKeepsUninstalledState = true;
    await wait(() => evaluate("!document.querySelector('[data-cos-download]').hidden && !document.querySelector('[data-cos-download]').disabled"));
    await evaluate("document.querySelector('[data-cos-download]').click()");
    await wait(() => workspace.acquiring);
    await wait(() => !workspace.acquiring);
    assert.equal(workspace.describe().installed, true, workspace.describe().error);
    assert.equal(workspace.enabled, false);
    await wait(() => evaluate("document.querySelector('[data-cos-download]').hidden && !document.querySelector('[data-cos-enabled]').disabled"));
    result.installationKeepsToggleOff = true;
    await evaluate("document.querySelector('[data-cos-enabled]').click()");
    await wait(() => workspace.enabled && workspace.runtime?.state === "ready");
    result.runtimePid = workspace.runtime.pid;
    await workspace.openHome();
    assert.equal(await workspace.view.webContents.executeJavaScript("typeof window.api"), "object");
    const state = await workspace.runtime.invoke("state:get");
    assert.equal(state.ok, true);
    result.originalUiAndBackendOpened = true;
    result.version = workspace.describe().version;
    await evaluate("document.querySelector('[data-open-view=\"settings\"]').click()");
    window.show();
    window.focus();
    window.unmaximize();
    window.setSize(1000, 760);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await evaluate(`(() => {
      const root = document.querySelector('#cos-pack-settings');
      return [...root.querySelectorAll('button')].filter(item => !item.hidden).every(item => {
        const b = item.getBoundingClientRect();
        return b.width > 0 && b.right <= root.getBoundingClientRect().right + 1;
      });
    })()`), true);
    await writeFile(resolve(import.meta.dirname, "../../../docs/cos-workspace-pack/evidence/cos-preset-settings.png"),
      (await window.webContents.capturePage()).toPNG());
    await workspace.disable();
    assert.equal(workspace.runtime.pid, undefined);
    result.disabledWithoutRestart = true;
    result.passed = true;
  } catch (error) {
    result.error = error.stack;
    result.runtimePid ??= workspace.runtime?.pid;
  } finally {
    await writeFile(output, JSON.stringify(result, null, 2));
    quit();
  }
}
