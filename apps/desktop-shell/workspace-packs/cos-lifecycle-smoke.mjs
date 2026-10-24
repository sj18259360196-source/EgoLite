import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function runCosLifecycleSmoke({ window, workspace, brokerPid, listSpaces, quit }) {
  const output = process.env.EGO_COS_LIFECYCLE_RESULT;
  const phase = process.env.EGO_COS_LIFECYCLE_PHASE;
  const seedPath = join(dirname(output), "fixture-state.json");
  const result = { checkedAt: new Date().toISOString(), phase, passed: false, hostPid: process.pid, brokerPid: brokerPid() };
  window.webContents.setBackgroundThrottling(false);
  const evaluate = script => window.webContents.executeJavaScript(script);
  const call = async (channel, payload) => {
    const response = await workspace.runtime.invoke(channel, payload);
    assert.equal(response.ok, true, response.error);
    return response.data;
  };
  try {
    for (let n = 0; n < 100; n++) {
      if (await evaluate("Boolean(window.egoDesktop && document.querySelector('[data-cos-enabled]'))")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (phase === "seed") {
      assert.equal(workspace.enabled, false);
      const enabled = await evaluate("window.egoDesktop.invoke('cos.enable')");
      const page = await workspace.browser.call("tabs.create", [{ url: process.env.EGO_COS_LIFECYCLE_PAGE, active: false }]);
      await call("roots:addPath", { path: dirname(output) });
      const queued = await call("sessions:send", {
        id: randomUUID(), sessionId: null, text: "CoS host restart fixture", mode: "auto",
        dueAt: workspace.runtime.manifest.features?.executionGate ? 0 : Date.now() + 86400000,
        model: null, reasoningEffort: null, automation: "off",
      });
      const ordinary = await evaluate("window.egoDesktop.invoke('task.create', {name:'Ordinary restart fixture',profileId:'default'})");
      await evaluate(`window.egoDesktop.invoke('tab.open', ${JSON.stringify({ taskId: ordinary.taskId, url: `${process.env.EGO_COS_LIFECYCLE_PAGE}?ordinary` })})`);
      await writeFile(seedPath, JSON.stringify({ workspace: enabled.workspace, ordinary, queued, url: page.url }));
      result.queuedInputId = queued.id;
      result.enabledBeforeQuit = true;
    } else {
      const seed = JSON.parse(await readFile(seedPath, "utf8"));
      if (phase === "disabled") {
        assert.equal(workspace.enabled, false);
        assert.equal(workspace.runtime?.pid, undefined);
        await assert.rejects(readFile(workspace.statusService.discoveryPath), { code: "ENOENT" });
        result.disabledRemainsDisabled = true;
        await evaluate("window.egoDesktop.invoke('cos.enable')");
      } else {
        assert.equal(workspace.enabled, true, workspace.describe().error);
        assert.equal(workspace.runtime?.state, "ready", workspace.describe().error);
        result.enabledRestoredAutomatically = true;
      }
      result.runtimePid = workspace.runtime.pid;
      assert.equal(workspace.taskId, seed.workspace.taskId);
      assert.equal(workspace.describe().workspace.id, seed.workspace.id);
      assert.equal((await listSpaces()).filter(space => space.name === "CoS").length, 1);
      const tabs = await workspace.browser.call("tabs.query");
      assert.equal(tabs.filter(tab => tab.url === seed.url).length, 1, JSON.stringify(tabs));
      assert.ok(tabs.every(tab => tab.windowId === seed.workspace.id));
      const rows = await call("sessions:outbox");
      const row = rows.find(item => item.id === seed.queued.id);
      assert.equal(row?.text, seed.queued.text);
      assert.equal(row?.state, "queued");
      assert.equal(row?.dueAt, seed.queued.dueAt);
      assert.equal(rows.filter(item => item.id === seed.queued.id).length, 1);
      result.sameWorkspaceAndQueuedInput = true;
      result.businessTabRestored = true;
      if (workspace.runtime.manifest.features?.executionGate === 1) {
        assert.equal(workspace.describe().execution?.requiresResume, true);
        assert.equal((await call("state:get")).bridge.running, false);
        await evaluate("document.querySelector('[data-open-view=\"settings\"]').click()");
        for (let n = 0; n < 50; n++) {
          if (await evaluate("!document.querySelector('[data-cos-resume]').hidden")) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(await evaluate("!document.querySelector('[data-cos-resume]').hidden"), true);
        if (phase === "restored") {
          window.show();
          window.focus();
          window.unmaximize();
          window.setSize(1000, 760);
          await new Promise(resolve => setTimeout(resolve, 500));
          assert.equal(await evaluate(`(() => {
            const button = document.querySelector('[data-cos-resume]');
            const bounds = button.getBoundingClientRect();
            return bounds.width > 0 && bounds.right <= document.querySelector('#cos-pack-settings').getBoundingClientRect().right;
          })()`), true);
          await writeFile(resolve(import.meta.dirname, "../../../docs/cos-workspace-pack/evidence/cos-recovery-settings.png"),
            (await window.webContents.capturePage()).toPNG());
        }
        await evaluate("document.querySelector('[data-cos-resume]').click()");
        for (let n = 0; n < 100 && workspace.describe().execution?.mode !== "running"; n++) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(workspace.describe().execution?.mode, "running");
        assert.equal((await call("state:get")).bridge.running, true);
        result.dueInputPausedAndResumedFromSettings = true;
      }
      const persisted = JSON.parse(await readFile(process.env.EGO_DESKTOP_STATE, "utf8"));
      assert.ok(persisted.tabs.some(tab => tab.taskId === seed.ordinary.taskId && tab.url.endsWith("?ordinary")));
      result.ordinaryTabsRetained = true;
      await evaluate("window.egoDesktop.invoke('cos.disable')");
      result.disabledBeforeQuit = true;
    }
    result.runtimePid ??= workspace.runtime?.pid;
    result.passed = true;
  } catch (error) {
    result.error = error.stack || String(error);
    result.runtimePid ??= workspace.runtime?.pid;
  } finally {
    await writeFile(output, JSON.stringify(result, null, 2));
    quit();
  }
}
