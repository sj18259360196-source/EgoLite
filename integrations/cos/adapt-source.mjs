import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export function replaceOnce(source, before, after, label) {
  const offset = source.indexOf(before);
  if (offset < 0 || source.indexOf(before, offset + before.length) >= 0) {
    throw new Error(`CoS upstream changed at ${label}; keep the current working pack`);
  }
  return source.slice(0, offset) + after + source.slice(offset + before.length);
}

export function adaptMain(source) {
  let result = `import { stopBridge as stopEgoBridge } from './bridge.js';\nimport { stopControlApi as stopEgoControlApi } from './control-api.js';\nimport { configureEgoExecution, summarizeEgoPending, egoIsProbe } from './ego-execution.js';\nimport { isEgoHosted, initializeEgoHostedEnvironment, createEgoHostedOwner, egoHostedReady } from './ego-hosted.js';\n${source}`;
  result = replaceOnce(result, "const hasSingleInstanceLock = app.requestSingleInstanceLock();",
    "initializeEgoHostedEnvironment();\nconst hasSingleInstanceLock = app.requestSingleInstanceLock();", "host identity");
  result = "import { egoHostRequest } from './ego-hosted.js';\n" + replaceOnce(result,
    "function showWindow(): void {",
    "function showWindow(): void {\n  if (isEgoHosted) { void egoHostRequest('ui.show', {}).catch(error => logWarn(String(error))); return; }", "notification opens Ego");
  result = replaceOnce(result, "try { applyLoginStartup(app, getConfig().ui.startAtLogin === true); }",
    "try { if (!isEgoHosted) applyLoginStartup(app, getConfig().ui.startAtLogin === true); }", "login startup");
  result = replaceOnce(result, "  registerIpc(\n    () => window,",
    "  if (isEgoHosted) window = createEgoHostedOwner();\n  registerIpc(\n    () => window,", "IPC owner");
  result = replaceOnce(result, "  await loadConfig();",
    `  await loadConfig();
  if (egoIsProbe()) {
    window = createEgoHostedOwner();
    registerIpc(() => window, () => app.quit());
    egoHostedReady();
    return;
  }
  const egoPending = isEgoHosted ? summarizeEgoPending({
    inputs: await readDurable('session-input'), commands: await readDurable('bridge-commands'),
    swarm: await readDurable('swarm'), goals: await readDurable('goal-switches'),
    replies: await readDurable('goal-replies'), continuations: await readDurable('continuations')
  }, getConfig().goal.enabled) : {};`, "probe and pending recovery");
  result = replaceOnce(result, "  windowActivation.enable();",
    `  if (isEgoHosted) {
    configureEgoExecution(egoPending, async () => {
      if (getConfig().controlApi.enabled) await startControlApi();
      if (await startBridge() === null) throw new Error('CoS browser startup failed');
      void pluginManager.resumeEgoConnections().catch(error => logWarn(String(error)));
      if (getConfig().ui.autoConnect) void connect().catch(error => logWarn(String(error)));
    }, async () => {
      await Promise.all([stopEgoBridge(), stopEgoControlApi()]);
    });
    egoHostedReady();
  } else {
  windowActivation.enable();`, "desktop presentation start");
  result = replaceOnce(result, "  onStatusChange(refreshTray);",
    "  onStatusChange(refreshTray);\n  }", "desktop presentation end");
  result = replaceOnce(result, "  startUpdateChecks();",
    "  if (!isEgoHosted) startUpdateChecks();", "standalone updater");
  result = replaceOnce(result, "if (browserExtensionRequired(getConfig())) {",
    "if (isEgoHosted || browserExtensionRequired(getConfig())) {", "hosted browser startup");
  return result;
}

export async function applyCosAdapter(sourceRoot) {
  const originals = join(sourceRoot, ".ego-upstream");
  await mkdir(originals, { recursive: true });
  const receipts = [];
  async function patch(relativePath, transform) {
    const path = join(sourceRoot, relativePath);
    const saved = join(originals, relativePath);
    let original;
    try { original = await readFile(saved, "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      original = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
      await mkdir(dirname(saved), { recursive: true });
      await writeFile(saved, original);
    }
    const patched = transform(original);
    await writeFile(path, patched);
    const hash = value => createHash("sha256").update(value).digest("hex");
    receipts.push({ path: relativePath, upstreamSha256: hash(original), adaptedSha256: hash(patched) });
  }
  await copyFile(join(here, "hosted-runtime.ts"), join(sourceRoot, "src/main/ego-hosted.ts"));
  await copyFile(join(here, "hosted-browser.ts"), join(sourceRoot, "src/main/ego-browser.ts"));
  await copyFile(join(here, "hosted-execution.ts"), join(sourceRoot, "src/main/ego-execution.ts"));
  await copyFile(join(here, "hosted-renderer.ts"), join(sourceRoot, "src/renderer/ego-hosted.ts"));
  for (const suffix of ["cjs", "d.cts"]) {
    await copyFile(join(here, "../../apps/desktop-shell/workspace-packs", `cos-wire.${suffix}`),
      join(sourceRoot, "src/main", `ego-wire.${suffix}`));
  }
  await patch("src/main/tunnel/locate.ts", source => replaceOnce(source,
    "function bundledDir(): string | null {",
    "function bundledDir(): string | null {\n  if (process.env.COS_EGO_HOSTED === '1' && process.env.COS_EGO_RESOURCES) {\n    const hosted = path.join(process.env.COS_EGO_RESOURCES, 'tunnel');\n    if (existsSync(hosted)) return hosted;\n  }",
    "hosted tunnel resources"));
  await patch("src/main/index.ts", adaptMain);
  await patch("src/main/bridge.ts", source => {
    let result = replaceOnce("import { egoExecutionAllowed } from './ego-execution.js';\n" + source,
      "async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {",
      "export async function handleEgoBrowserRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {",
      "browser route entry");
    result = replaceOnce(result, "    handle(req, res).catch((err: Error) => {",
      "    handleEgoBrowserRequest(req, res).catch((err: Error) => {", "standalone browser route");
    result = replaceOnce(result, "  const instance = createBridgeListener();",
      "  const instance = createBridgeListener();\n  if (process.env.COS_EGO_HOSTED === '1') return { instance, actual: 0 };",
      "private browser transport");
    result = replaceOnce(result, "export function startBridge(): Promise<number | null> {",
      "export function startBridge(): Promise<number | null> {\n  if (!egoExecutionAllowed()) return Promise.resolve(null);", "browser activation gate");
    return result;
  });
  await patch("src/main/connection.ts", source => {
    const signature = source.includes('export function connect(current?: () => boolean)')
      ? 'export function connect(current?: () => boolean): Promise<void> {' : 'export function connect(): Promise<void> {';
    return replaceOnce("import { egoExecutionAllowed } from './ego-execution.js';\n" + source, signature,
      signature + "\n  if (!egoExecutionAllowed()) return Promise.resolve();", "connection activation gate");
  });
  await patch("src/main/control-api.ts", source => replaceOnce(
    "import { egoExecutionAllowed } from './ego-execution.js';\n" + source,
    "export function startControlApi(): Promise<void> {",
    "export function startControlApi(): Promise<void> {\n  if (!egoExecutionAllowed()) return Promise.resolve();", "control API activation gate"));
  await patch("src/main/plugins/manager.ts", source => {
    let result = "import { isEgoHosted, egoHostRequest } from '../ego-hosted.js';\nimport { egoExecutionAllowed } from '../ego-execution.js';\n" + source;
    result = replaceOnce(result, "    const { shell } = await import('electron'); await shell.openExternal(url.href);",
      "    if (isEgoHosted) { await egoHostRequest('browser.open', { url: url.href, active: true }); return; }\n    const { shell } = await import('electron'); await shell.openExternal(url.href);",
      "hosted plugin authorization browser");
    result = replaceOnce(result,
      "    void Promise.all(this.records.filter(row => row.enabled).map(row => this.connect(row))).catch(() => undefined);",
      "    if (egoExecutionAllowed()) void this.resumeEgoConnections().catch(() => undefined);", "plugin startup gate");
    result = replaceOnce(result, "  private connect(row: RecordEntry): Promise<void> {",
      "  private connect(row: RecordEntry): Promise<void> {\n    if (!egoExecutionAllowed()) return Promise.resolve();", "plugin connection gate");
    return replaceOnce(result, "  private exposure() {",
      "  async resumeEgoConnections(): Promise<void> {\n    await Promise.all(this.records.filter(row => row.enabled).map(row => this.connect(row)));\n  }\n  private exposure() {", "plugin explicit activation");
  });
  await patch("src/main/session/start-input.ts", source => replaceOnce(source,
    "if (!await startBridge()) throw new Error('The browser bridge could not start.');",
    "if (await startBridge() === null) throw new Error('The browser bridge could not start.');", "private bridge readiness"));
  await patch("src/main/ipc.ts", source => {
    const anchor = "if (!await startBridge()) throw new Error('The browser bridge could not start');";
    if (source.split(anchor).length !== 3) throw new Error("CoS upstream changed at IPC browser readiness");
    let result = "import { isEgoHosted, egoHostRequest } from './ego-hosted.js';\n"
      + source.replaceAll(anchor, "if (await startBridge() === null) throw new Error('The browser bridge could not start');");
    if (source.includes("handle('cosBrowser:show'")) result = replaceOnce(result,
      "  handle('cosBrowser:show', async () => {",
      "  handle('cosBrowser:show', async () => {\n    if (isEgoHosted) { await egoHostRequest('browser.open', { url: 'https://chatgpt.com/', active: true }); return true; }", "hosted sign in");
    const external = source.includes("    else await shell.openExternal(url);") ? "    else await shell.openExternal(url);" : "    await shell.openExternal(url);";
    return replaceOnce(result, external,
      `${external.includes('else') ? '    else ' : '    '}if (isEgoHosted && /^https?:/i.test(url)) await egoHostRequest('browser.open', { url, active: true });\n    else await shell.openExternal(url);`,
      "hosted setup and user links");
  });
  await patch("extension/background.js", source =>
    source + "\nexport async function egoWake() { await pumpBrowserControl(); await maintain(true); }\n");
  await patch("src/main/browser-wake.ts", source => "import { encodeWire } from './ego-wire.cjs';\n" + replaceOnce(source,
    "export function wakeBrowserWork(topic: 'wake' | 'browser-control' = 'wake'): void {",
    "export function wakeBrowserWork(topic: 'wake' | 'browser-control' = 'wake'): void {\n  if (process.env.COS_EGO_HOSTED === '1' && process.connected) process.send?.(encodeWire({ type: 'cos:event', channel: 'ego:browser-wake', args: [topic] }) as object);",
    "private browser wake"));
  await patch("src/main/browser.ts", source => {
    let result = `import { isEgoHosted, egoHostRequest } from './ego-hosted.js';\n${source}`;
    result = replaceOnce(result, "): Promise<boolean | null> {",
      "): Promise<boolean | null> {\n  if (isEgoHosted) return true;", "browser availability");
    // The browser launcher has optional dependency arguments; insert at its actual body.
    const start = result.indexOf("export async function openInPreferredBrowser(");
    if (start < 0) throw new Error("Missing upstream browser launcher");
    const body = result.indexOf("): Promise<string> {", start);
    if (body < 0) throw new Error("Upstream browser launcher signature changed");
    const offset = body + "): Promise<string> {".length;
    return result.slice(0, offset) + "\n  if (isEgoHosted) { await egoHostRequest('browser.open', { url, active: options.reveal === true }); return 'EgoLite'; }" + result.slice(offset);
  });
  if (await readFile(join(sourceRoot, 'src/main/cos-browser/selection.ts'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
    await patch('src/main/cos-browser/selection.ts', source => replaceOnce(source,
      'export async function syncCosBrowser(): Promise<void> {',
      "export async function syncCosBrowser(): Promise<void> {\n  if (process.env.COS_EGO_HOSTED === '1') return;", 'Ego owns browser lifecycle'));
  }
  await patch("src/main/window-lifecycle.ts", source => replaceOnce(source,
    "  app.setLoginItemSettings(", "  if (process.env.COS_EGO_HOSTED === '1') return;\n  app.setLoginItemSettings(", "login setting guard"));
  await patch("src/renderer/main.ts", source => {
    let result = "import { isEgoHosted, initEgoHostedUi, paintEgoHostedUi, egoUpdateSummary, egoBrowserSetup } from './ego-hosted.js';\n" + source;
    if (source.includes('browserSetup.render(next)')) result = replaceOnce(result,
      'browserSetup.render(next)', 'isEgoHosted ? egoBrowserSetup(next) : browserSetup.render(next)', 'hosted setup progress');
    result = replaceOnce(result, "initLanguage();", "initLanguage();\ninitEgoHostedUi();", "hosted UI initialization");
    result = replaceOnce(result, "  chatApply(next, previousState?.config);",
      "  chatApply(next, previousState?.config);\n  paintEgoHostedUi(next);", "hosted UI state");
    result = replaceOnce(result,
      "function updateSummary({ bridge, update, config, status }: AppState):",
      "function updateSummary(next: AppState):", "hosted update state parameter");
    return replaceOnce(result, "  // Only an extension older than this app is the user's to fix.",
      "  if (isEgoHosted) return egoUpdateSummary(next);\n  const { bridge, update, config, status } = next;\n  // Only an extension older than this app is the user's to fix.",
      "hosted update presentation");
  });
  await patch("src/renderer/chat.ts", source => {
    let result = "import { isEgoHosted, paintEgoHostedBrowser } from './ego-hosted.js';\n" + source;
    result = replaceOnce(result, "async function showExtensionPath(): Promise<void> {",
      "async function showExtensionPath(): Promise<void> {\n  if (isEgoHosted) return;", "hosted extension path");
    return replaceOnce(result, "  void showExtensionPath();",
      "  void showExtensionPath();\n  paintEgoHostedBrowser(state);", "hosted browser status");
  });
  const preload = await readFile(join(sourceRoot, "src/preload/index.ts"), "utf8");
  const prefix = await readFile(join(here, "hosted-preload-prefix.ts"), "utf8");
  await writeFile(join(sourceRoot, "src/preload/ego-hosted.ts"), replaceOnce(preload,
    "import { contextBridge, ipcRenderer, webUtils } from 'electron';", prefix, "renderer bridge"));
  await patch("electron.vite.config.ts", source => replaceOnce(source,
    "index: resolve(__dirname, 'src/preload/index.ts'),",
    "index: resolve(__dirname, 'src/preload/index.ts'),\n          'ego-hosted': resolve(__dirname, 'src/preload/ego-hosted.ts'),", "hosted preload build"));
  await writeFile(join(sourceRoot, "ego-adapter-receipt.json"), JSON.stringify({ protocol: 1, patches: receipts }, null, 2) + "\n");
  return receipts;
}
