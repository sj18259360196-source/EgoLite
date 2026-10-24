import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function runCosUpdateSmoke({ window, workspace, brokerPid, quit }) {
  const output = process.env.EGO_COS_UPDATE_RESULT;
  const root = resolve(import.meta.dirname, "../../..");
  const packRoot = join(dirname(output), "workspace-packs/cos");
  const data = join(packRoot, "state");
  const endpoint = join(packRoot, "maintenance-endpoint.json");
  const result = { checkedAt: new Date().toISOString(), passed: false, brokerPid: brokerPid(), runtimePids: [] };
  window.webContents.setBackgroundThrottling(false);
  const paint = async () => {
    let timer;
    try {
      await Promise.race([
        window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Settings paint timed out")), 10000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const remember = () => { if (workspace.runtime?.pid) result.runtimePids.push(workspace.runtime.pid); };
  const cli = (args, discovery = endpoint) => new Promise((resolveRun, reject) => {
    const child = spawn(process.env.EGO_NODE_PATH, [join(root, "tools/update-cos-pack.mjs"), "--endpoint", discovery, ...args], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolveRun(JSON.parse(stdout)) : reject(new Error(stderr || `Update exited ${code}`)));
  });
  try {
    await workspace.enable();
    remember();
    const original = workspace.describe();
    await writeFile(join(data, "update-smoke.txt"), "before-update");
    const discovery = JSON.parse(await readFile(endpoint, "utf8"));
    const invalid = join(dirname(output), "invalid-endpoint.json");
    await writeFile(invalid, JSON.stringify({ ...discovery, token: "invalid" }));
    await assert.rejects(cli(["--pack", process.env.EGO_COS_UPDATE_CANDIDATE], invalid), /authentication failed/);
    assert.equal(workspace.runtime.pid, result.runtimePids[0]);
    result.invalidTokenRejectedWithoutStopping = true;

    const updated = await cli(["--pack", process.env.EGO_COS_UPDATE_CANDIDATE]);
    remember();
    assert.equal(updated.enabled, true);
    assert.equal(updated.state, "ready");
    assert.equal(workspace.taskId, original.workspace.taskId);
    assert.notEqual(updated.version, original.version);
    assert.equal(await readFile(join(data, "update-smoke.txt"), "utf8"), "before-update");
    await workspace.openHome();
    assert.equal(await workspace.view.webContents.executeJavaScript("typeof window.api"), "object");
    await writeFile(join(data, "update-smoke.txt"), "after-update");
    await writeFile(join(data, "new-session-marker.txt"), "retain-me");
    result.updatedOriginalUiAndSameWorkspace = true;
    result.candidateVersion = updated.version;

    const rolled = await cli(["--rollback"]);
    remember();
    assert.equal(rolled.directory, original.directory);
    assert.equal(rolled.enabled, true);
    assert.equal(await workspace.view.webContents.executeJavaScript("typeof window.api"), "object");
    assert.equal(workspace.taskId, original.workspace.taskId);
    assert.equal(await readFile(join(data, "update-smoke.txt"), "utf8"), "before-update");
    const journal = JSON.parse(await readFile(join(rolled.backupDirectory, "transaction.json"), "utf8"));
    assert.equal(await readFile(join(journal.preservedData[0], "new-session-marker.txt"), "utf8"), "retain-me");
    result.programAndDataRollbackWithNewDataPreserved = true;

    await assert.rejects(cli(["--pack", process.env.EGO_COS_UPDATE_BROKEN]), /previous program and data restored/);
    remember();
    assert.equal(workspace.describe().directory, original.directory);
    assert.equal(workspace.runtime.state, "ready");
    assert.equal(await readFile(join(data, "update-smoke.txt"), "utf8"), "before-update");
    result.failedChildMigrationRolledBack = true;
    await window.webContents.executeJavaScript("document.querySelector('[data-open-view=\"settings\"]').click()");
    await new Promise(resolve => setTimeout(resolve, 400));
    const controls = await window.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('#cos-pack-settings');
      return ['update', 'rollback'].map(name => {
        const button = root.querySelector('[data-cos-' + name + ']');
        const bounds = button.getBoundingClientRect();
        return { name, disabled: button.disabled, width: bounds.width, right: bounds.right, parentRight: root.getBoundingClientRect().right };
      });
    })()`);
    assert.equal(controls[0].disabled, false);
    assert.equal(controls[1].disabled, true);
    assert.ok(controls.every(button => button.width > 0 && button.right <= button.parentRight));
    window.show();
    window.focus();
    await paint();
    await writeFile(join(root, "docs/cos-workspace-pack/evidence/cos-update-settings.png"), (await window.webContents.capturePage()).toPNG());
    window.unmaximize();
    await new Promise(resolve => setTimeout(resolve, 250));
    window.setSize(1000, 760);
    await new Promise(resolve => setTimeout(resolve, 250));
    result.compactWindowSize = window.getSize();
    assert.ok(Math.abs(result.compactWindowSize[0] - 1000) <= 3
      && Math.abs(result.compactWindowSize[1] - 760) <= 3, "Compact window size must account only for DPI rounding");
    const fits = await window.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('#cos-pack-settings');
      return [...root.querySelectorAll('button, [data-cos-status]')].every(item => {
        if (item.hidden) return true;
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.right <= root.getBoundingClientRect().right + 1
          && item.scrollWidth <= item.clientWidth + 1;
      });
    })()`);
    assert.equal(fits, true, "CoS settings controls must fit the compact desktop window");
    window.focus();
    await paint();
    await writeFile(join(root, "docs/cos-workspace-pack/evidence/cos-update-settings-compact.png"), (await window.webContents.capturePage()).toPNG());
    result.compactSettingsFit = true;
    result.settingsControlsVisible = true;

    await workspace.disable();
    const disabledUpdate = await cli(["--pack", process.env.EGO_COS_UPDATE_CANDIDATE]);
    assert.equal(disabledUpdate.enabled, false);
    assert.equal(workspace.runtime?.pid, undefined);
    const disabledRollback = await cli(["--rollback"]);
    assert.equal(disabledRollback.enabled, false);
    assert.equal(disabledRollback.version, original.version);
    assert.equal(workspace.runtime?.pid, undefined);
    result.disabledUpdateAndRollbackRemainDisabled = true;
    result.passed = true;
  } catch (error) {
    result.error = error.stack;
  } finally {
    remember();
    await writeFile(output, JSON.stringify(result, null, 2));
    quit();
  }
}
