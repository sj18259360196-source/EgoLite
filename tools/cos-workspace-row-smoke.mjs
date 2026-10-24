import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const evidence = join(root, "docs/cos-workspace-pack/evidence");
if (!process.versions.electron) {
  const parent = join(root, ".tmp/codex/cos-workspace-row");
  await mkdir(parent, { recursive: true });
  const work = await mkdtemp(join(parent, "run-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(join(root, "node_modules/electron/dist/electron.exe"), [import.meta.filename, work, ...(process.argv[2] ? [resolve(process.argv[2])] : [])],
    { cwd: root, env, windowsHide: true, stdio: "inherit" });
  const timer = setTimeout(() => {
    spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  }, 45000);
  try {
    const [code] = await once(child, "exit");
    process.exitCode = code ?? 1;
  } finally {
    clearTimeout(timer);
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
} else {
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", join(process.argv[2], "profile"));
  app.whenReady().then(async () => {
    try {
      const resources = process.argv[3];
      const publicRoot = resources ? join(resources, "app.asar/public") : join(root, "apps/desktop-shell/public");
      const css = await readFile(join(publicRoot, "styles.css"), "utf8");
      const source = await readFile(join(publicRoot, "app.js"), "utf8");
      const render = source.slice(source.indexOf("function renderTasks() {"), source.indexOf("function bindTaskDrag("));
      assert.ok(render.includes("cos-workspace"));
      const builtin = JSON.parse(await readFile(join(root, "integrations/cos/builtin.json"), "utf8"));
      const component = resources ? join(resources, "components/cos") : join(root, builtin.directory);
      const logo = `data:image/png;base64,${(await readFile(join(component, "source/extension/icons/icon48.png"))).toString("base64")}`;
      const icons = await readFile(resources ? join(publicRoot, "vendor/lucide.js") : join(root, "node_modules/lucide/dist/umd/lucide.js"), "utf8");
      const window = new BrowserWindow({ width: 560, height: 400, show: false });
      await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent('<!doctype html><html data-theme="light"><meta charset="utf-8"><title>CoS workspace row regression</title><div id="task-list" class="task-list" style="margin:16px"></div></html>'));
      await window.webContents.insertCSS(css);
      await window.webContents.executeJavaScript(icons);
      await window.webContents.executeJavaScript(`
        const $ = (s) => document.querySelector(s);
        const state = { spaces: [{id:1,taskId:'ordinary',name:'Regular workspace'}, {id:2,taskId:'cos',name:'CoS'}], cos: {logo:${JSON.stringify(logo)}} };
        let activeTaskId = 'cos';
        let workspaceSidebarQuickMode = false;
        const cosWorkspace = { owns: t => t.taskId === 'cos' };
        const tabsForTask = () => [{}];
        const browserProfileForTask = () => ({ color:'#438a62', name:'默认 Profile' });
        const ownershipName = () => 'Agent 自主';
        const agentSummaryHtml = () => '';
        const escapeHtml = s => s;
        const escapeAttribute = s => s;
        const bindTaskDrag = () => {};
        const activateTaskById = async id => { window.selectedTask = id; };
        const closeTask = async task => { window.closedTask = task.id; };
        ${render}
        renderTasks();
      `);
      await window.webContents.executeJavaScript("Promise.all([...document.images].map(i => i.decode()))");
      await mkdir(evidence, { recursive: true });
      const checks = [];
      for (const zoom of [1, 1.5]) {
        window.webContents.setZoomFactor(zoom);
        for (const width of [190, 220, 320]) {
          const measured = await window.webContents.executeJavaScript(`
            document.querySelector('#task-list').style.width = '${width}px';
            (() => {
              const row = document.querySelector('.cos-workspace');
              const img = row.querySelector('img');
              const copy = row.querySelector('.task-copy');
              const actions = row.querySelector('.task-row-actions');
              const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width}; };
              return { image:rect(img), copy:rect(copy), actions:rect(actions), row:rect(row),
                loaded:img.naturalWidth > 0, grid:getComputedStyle(row).gridTemplateColumns,
                tooltip:row.querySelector('.task-meta').title,
                meta:row.querySelector('.task-meta').textContent,
                renameHidden:getComputedStyle(row.querySelector('.rename-task')).display === 'none' };
            })()
          `);
          assert.ok(Math.abs(measured.image.width - 22) < 0.01);
          assert.ok(measured.copy.left - measured.image.right >= 7.9, JSON.stringify(measured));
          assert.ok(measured.copy.right <= measured.actions.left);
          assert.ok(measured.actions.right <= measured.row.right);
          assert.ok(measured.loaded && measured.renameHidden);
          assert.equal(measured.tooltip, measured.meta);
          checks.push({ width, zoom, ...measured });
          await writeFile(join(evidence, `cos-row-${width}-${zoom}.png`), (await window.webContents.capturePage()).toPNG());
        }
      }
      await window.webContents.executeJavaScript("document.querySelector('.cos-workspace').click()");
      assert.equal(await window.webContents.executeJavaScript("window.selectedTask"), 2);
      await window.webContents.executeJavaScript("window.selectedTask=null; document.querySelector('.cos-workspace .delete-task').click()");
      assert.deepEqual(await window.webContents.executeJavaScript("[window.selectedTask,window.closedTask]"), [null, 2]);
      await writeFile(join(evidence, "cos-workspace-row.json"), JSON.stringify({ checkedAt:new Date().toISOString(), resources:resources || null, passed:true, checks, selectAndStop:true }, null, 2));
      console.log("CoS row: six width/zoom combinations, logo, spacing, tooltips and select/stop passed");
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
