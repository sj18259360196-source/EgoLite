import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "..");
const parent = join(root, ".tmp/codex/scansci-guided-setup/ui");
const evidence = join(root, "docs/scansci-integration/evidence");
await mkdir(parent, { recursive: true });
await mkdir(evidence, { recursive: true });
const work = await mkdtemp(join(parent, "run-"));
const executable = resolve(process.argv[2] || join(root, "release/win-unpacked/EgoLite.exe"));
const id = randomUUID();
const probe = createServer();
await new Promise(done => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise(done => probe.close(done));
await writeFile(join(work, "desktop-preferences.json"), JSON.stringify({ onboardingCompleted: true, controlMode: "agent" }));
const env = {
  ...process.env, LOCALAPPDATA: join(work, "local"), APPDATA: join(work, "roaming"),
  EGO_DESKTOP_USER_DATA: join(work, "user"), EGO_DESKTOP_STATE: join(work, "state.json"),
  EGO_DESKTOP_PIPE: `\\\\.\\pipe\\setup-${id}`, EGO_COMPAT_PIPE: `\\\\.\\pipe\\setup-${id}`,
  EGO_DESKTOP_AUTOMATION_PIPE: `\\\\.\\pipe\\setup-ui-${id}`,
  EGO_DESKTOP_CONTROL_TOKEN: randomUUID() + randomUUID(),
  EGO_AGENT_INTEGRATION_DISABLED: "1", SCANSCI_PORT: String(port), TEMP: work, TMP: work,
};
for (const name of ["ELECTRON_RUN_AS_NODE", "PYTHONHOME", "PYTHONPATH", "SCANSCI_PROJECT_DIR", "SCANSCI_PYTHON", "EGO_DESKTOP_CAPTURE", "EGO_DESKTOP_CAPTURE_SCANSCI_SETTINGS"]) delete env[name];
let app;
async function stop() {
  if (app) await promisify(execFile)("taskkill.exe", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  app = null;
  await new Promise(done => setTimeout(done, 1000));
}
async function launch() {
  app = spawn(executable, [], { cwd: work, env, windowsHide: true, stdio: "ignore" });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(2000) })).ok);
}
async function until(operation) {
  const deadline = Date.now() + 60000;
  let last;
  while (Date.now() < deadline) {
    try { const result = await operation(); if (result) return result; } catch (error) { last = error; }
    await new Promise(done => setTimeout(done, 250));
  }
  throw last || new Error("Setup UI readiness timed out");
}
async function browserScript(source) {
  const child = spawn(executable, [join(executable, "..", "resources/runtime/ego-browser.mjs"), "nodejs"], {
    cwd: work, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => stdout += data);
  child.stderr.on("data", data => stderr += data);
  const timer = setTimeout(() => child.kill(), 150000);
  child.stdin.end(`try {\n${source}\n} catch (error) {\nconsole.error('SETUP_DIAGNOSTIC', JSON.stringify(await page.evaluate(() => ({guide:document.querySelector('#guideResult')?.textContent, toast:document.querySelector('#toast')?.textContent, invalid:[...document.querySelectorAll('input:invalid')].map(n=>n.id), viewport:[innerWidth,innerHeight,scrollX,scrollY], visibility:document.visibilityState, title:document.querySelector('#pageTitle')?.textContent, button:document.querySelector('#basicForm button')?.getBoundingClientRect().toJSON()}))));\nawait page.screenshot({path:${JSON.stringify(join(evidence, "guided-failed.png"))}});\nthrow error;\n}`);
  const code = await new Promise(done => child.once("exit", done));
  clearTimeout(timer);
  if (code !== 0) throw new Error(`Setup browser script failed (${code}): ${stderr.slice(-2500)} ${stdout.slice(-1000)}`);
  return stdout;
}
const prelude = `
const task = await taskSpaces.useOrCreate('ScanSci guided settings verification');
await browser.openOrReuseTab(${JSON.stringify(`http://127.0.0.1:${port}/settings`)}, {wait:true});
await page.goto(${JSON.stringify(`http://127.0.0.1:${port}/settings`)}, {waitUntil:'load'});
const {connect} = await import('node:net');
const visual = (method, values) => new Promise((resolve,reject) => {
  const socket = connect(process.env.EGO_DESKTOP_AUTOMATION_PIPE);
  let buffer = '';
  const timer = setTimeout(() => {socket.destroy(); reject(Error('Visual selection timed out'));},15000);
  socket.on('connect', () => socket.write(JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...values,__egoBridgeToken:process.env.EGO_DESKTOP_CONTROL_TOKEN}})+'\\n'));
  socket.on('data', chunk => { buffer += chunk; const end = buffer.indexOf('\\n'); if(end < 0) return; const response = JSON.parse(buffer.slice(0,end)); clearTimeout(timer);socket.destroy(); if(response.error) reject(Error(response.error.message)); else resolve(response.result); });
  socket.on('error', error => {clearTimeout(timer);reject(error);});
});
await visual('space.select', {taskId:task.taskId,visualSync:true});
const tab = (await browser.listTabs()).find(t => t.url === ${JSON.stringify(`http://127.0.0.1:${port}/settings`)});
if (!tab) throw Error('Settings tab not found');
await visual('tabs.activate', {targetId:tab.targetId,visual:true});
if (!(await page.waitForFunction(() => innerHeight > 400))) throw Error('Settings viewport too short');
if (!(await page.waitForFunction(() => document.querySelector('#checkedAt')?.textContent.includes('最后刷新'), undefined, {timeout:30000}))) throw Error('Dashboard not loaded');
await page.locator('[data-view="guide"]').first().click();
const requireValue = async (selector, value) => { if (await page.locator(selector).inputValue() !== value) throw Error('Unexpected value in '+selector); };
const saved = async () => { if (!(await page.waitForFunction(() => !document.querySelector('form[data-saving]') && document.querySelector('#guideResult').textContent.includes('保存'), {timeout:30000}))) throw Error('Setup save did not complete'); };
`;
let output;
try {
  await launch();
  const schoolShot = join(work, "guided-school.png");
  const sessionShot = join(work, "guided-session.png");
  await browserScript(prelude + `
await page.locator('#guideEmail').fill('setup@example.test');
await page.locator('#guideOutput').fill(${JSON.stringify(join(work, "papers"))});
await page.locator('#basicForm [type="submit"]').click(); await saved();
await page.locator('#guideEmail').fill('unsaved@example.test');
await page.locator('#refreshBtn').click();
if (!(await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled))) throw Error('Refresh failed');
await requireValue('#guideEmail', 'unsaved@example.test');
await page.locator('[data-guide="school"][role="tab"]').click();
if (!(await page.waitForFunction(() => document.querySelector('#schoolChoices').options.length > 1))) throw Error('No schools loaded');
const choices = await page.locator('#schoolChoices option').evaluateAll(nodes => nodes.map(n => ({value:n.value,text:n.textContent})));
const school = choices.find(item => item.value);
await page.locator('#schoolChoices').selectOption(school.value);
if (!(await page.locator('#guideWebvpn').inputValue()).startsWith('https://')) throw Error('School URL not filled');
await page.locator('#schoolForm [type="submit"]').click(); await saved();
await requireValue('#guideSchool', school.value);
await page.screenshot({path:${JSON.stringify(schoolShot)}});
await page.locator('#schoolQuery').fill('no-school-fixture-unique');
await page.locator('#schoolSearchForm [type="submit"]').click();
if (!(await page.waitForFunction(() => document.querySelector('#schoolSearchNote').textContent.includes('没有匹配')))) throw Error('Manual fallback missing');
await page.locator('#guideSchool').fill('Fixture University');
await page.locator('#guideWebvpn').fill('https://vpn.example.test');
await page.locator('#schoolForm [type="submit"]').click(); await saved();
await page.locator('[data-guide="optional"][role="tab"]').click();
await page.locator('#elsevierGuide summary').click();
await page.locator('#guideApiKey').fill('fixtureKey0123456789');
await page.locator('#elsevierForm [type="submit"]').click(); await saved();
await requireValue('#guideApiKey', '');
if (!(await page.locator('#apiKeyState').innerText()).includes('已保存')) throw Error('Key status not shown');
await page.locator('[data-guide="session"][role="tab"]').click();
await page.locator('#guideRelogin').setChecked(false);
await page.locator('#sessionForm [type="submit"]').click(); await saved();
await page.screenshot({path:${JSON.stringify(sessionShot)}});
console.log('GUIDED_SETUP_SAVED');
`);
  const configPath = join(work, "scansci/config.json");
  let cfg = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(cfg.email, "setup@example.test");
  assert.equal(cfg.vpnsci_school, "Fixture University");
  assert.equal(cfg.elsevier_api_key, "fixtureKey0123456789");
  assert.equal(cfg.auto_relogin, false);
  assert.ok(await readFile(configPath + ".bak"));
  const cache = cfg.cache_dir;
  assert.ok(resolve(cache).startsWith(resolve(work) + "\\"), "Test cookie path must stay in isolated data");
  await mkdir(cache, { recursive: true });
  const cookiePath = join(cache, "instsci-cookies.json");
  const cookieBytes = '[{"name":"session","value":"fixture-session","domain":"vpn.example.test"}]';
  await writeFile(cookiePath, cookieBytes);
  await stop();
  await launch();
  await browserScript(prelude + `
await requireValue('#guideEmail', 'setup@example.test');
await page.locator('[data-guide="school"][role="tab"]').click();
await requireValue('#guideSchool', 'Fixture University');
await requireValue('#guideWebvpn', 'https://vpn.example.test');
await page.locator('[data-guide="optional"][role="tab"]').click();
await page.locator('#elsevierGuide summary').click();
await requireValue('#guideApiKey', '');
if (!(await page.locator('#apiKeyState').innerText()).includes('已保存')) throw Error('Saved key lost');
await page.locator('[data-guide="session"][role="tab"]').click();
if (await page.locator('#guideRelogin').isChecked()) throw Error('Restore setting lost');
const sessionText = await page.locator('#sessionList').innerText();
if (!sessionText.includes('会话已保存') || sessionText.includes('登录有效')) throw Error('Saved cookie falsely displayed as validated');
await page.screenshot({path:${JSON.stringify(sessionShot)}});
console.log('GUIDED_SETUP_RESTART_OK');
`);
  cfg = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(cfg.email, "setup@example.test");
  assert.equal(await readFile(cookiePath, "utf8"), cookieBytes);
  for (const name of ["guided-school.png", "guided-session.png"]) await copyFile(join(work, name), join(evidence, name));
  output = { passed: true, checkedAt: new Date().toISOString(), version: "0.2.14", checks: {
    realEgoFormInteraction: true, schoolCatalogAutofill: true, manualSchoolFallback: true,
    unsavedDraftSurvivesRefresh: true, batchConfigurationPersisted: true, secretNotEchoed: true,
    previousConfigBackup: true, browserRestartRetainsConfig: true, savedCookiesRetained: true,
    savedCookiesNotAssumedValid: true,
  }, limits: ["No real institutional SSO or external API credentials used"] };
} catch (error) {
  output = { passed: false, checkedAt: new Date().toISOString(), error: error.stack };
  process.exitCode = 1;
} finally {
  await stop();
  assert.ok(resolve(work).startsWith(resolve(parent) + "\\"));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
await writeFile(join(evidence, "guided-setup.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
