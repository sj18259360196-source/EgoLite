import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer, connect } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateDesktopArchive } from "./validate-desktop-package.mjs";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const parent = resolve(process.env.EGO_TEST_TEMP_ROOT || join(root, ".tmp", "codex", "windows-suite-smoke"));
const packageVersion = JSON.parse(await readFile(join(root, "apps", "desktop-shell", "package.json"), "utf8")).version;
await mkdir(parent, { recursive: true });
const work = await mkdtemp(join(parent, "run-"));
const executable = resolve(process.argv[2] || join(root, "release", "win-unpacked", "EgoLite.exe"));
const runtime = join(executable, "..", "resources", "runtime");
await validateDesktopArchive(join(runtime, "..", "app.asar"), work);
const suffix = randomUUID();
const pipe = `\\\\.\\pipe\\ego-suite-${suffix}`;
const automation = `\\\\.\\pipe\\ego-suite-ui-${suffix}`;
const bridgeToken = randomUUID() + randomUUID();
const listener = createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const capture = join(work, "desktop.png");
const env = {
  ...process.env,
  PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
  LOCALAPPDATA: join(work, "local"), APPDATA: join(work, "roaming"),
  EGO_DESKTOP_USER_DATA: join(work, "user-data"), EGO_DESKTOP_STATE: join(work, "state.json"),
  EGO_DESKTOP_PIPE: pipe, EGO_COMPAT_PIPE: pipe, EGO_DESKTOP_AUTOMATION_PIPE: automation,
  EGO_DESKTOP_CONTROL_TOKEN: bridgeToken,
  EGO_AGENT_INTEGRATION_DISABLED: "1", EGO_DESKTOP_CAPTURE: capture,
  SCANSCI_PORT: String(port), OPENAI_API_KEY: "", TEMP: work, TMP: work,
};
for (const name of ["ELECTRON_RUN_AS_NODE", "PYTHONHOME", "PYTHONPATH", "SCANSCI_PROJECT_DIR", "SCANSCI_PYTHON", "EGO_DESKTOP_SMOKE_RESULT"]) delete env[name];
const launchArgs = process.env.EGO_TEST_SOFTWARE_RENDERING === "1"
  ? ["--disable-gpu", "--disable-features=CalculateNativeWinOcclusion"]
  : [];
const app = spawn(executable, launchArgs, { env, cwd: work, windowsHide: true, stdio: "ignore" });
const clients = [];
const checks = {};
try {
  await until(async () => (await rpc(automation, "desktop.status", {})).ready);
  checks.desktop = true;
  console.log("Desktop ready");
  await until(async () => (await rpc(pipe, "hello", { clientId: "suite-smoke" })).protocolVersion);
  checks.broker = true;
  console.log("Broker ready");
  const ping = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const identity = await until(ping);
  assert.equal(resolve(identity.project.root), resolve(runtime, "scansci"));
  checks.scanSciBundledService = true;
  console.log("ScanSci ready");
  const cfg = JSON.parse(await readFile(join(work, "scansci", "config.json"), "utf8"));
  assert.equal(cfg.browser_backend, "egolite");
  checks.defaultBrowserIntegration = true;
  const space = await rpc(pipe, "space.create", { clientId: `suite-${suffix}`, name: "Suite browser test" });
  const taskId = space.taskId;
  const bridge = (method, params) => rpc(automation, method, { ...params, __egoBridgeToken: bridgeToken });
  const tab = await bridge("tabs.create", { taskId, url: 'data:text/html,<title>Suite test</title><input id="name"><button onclick="document.title=document.getElementById(\'name\').value">Apply</button>' });
  await until(async () => {
    return await bridge("page.evaluate", { taskId, targetId: tab.targetId, expression: "document.querySelector('input') !== null" });
  });
  await bridge("page.evaluate", { taskId, targetId: tab.targetId, expression: "document.querySelector('input').value='Package works'; document.querySelector('button').click(); true" });
  assert.equal(await bridge("page.evaluate", { taskId, targetId: tab.targetId, expression: "document.title" }), "Package works");
  checks.browserPageInteraction = true;
  await bridge("tabs.close", { taskId, targetId: tab.targetId });

  assert.equal((await rpc(pipe, "control.mode.get", { clientId: `suite-${suffix}` })).mode, "agent");
  const peer = `suite-peer-${suffix}`;
  const shared = await rpc(pipe, "space.claim", { clientId: peer, id: space.id });
  assert.equal(shared.leaseEpoch, space.leaseEpoch);
  for (const actor of [`suite-${suffix}`, peer]) {
    const sharedTab = await rpc(pipe, "tab.create", {
      clientId: actor, taskSpaceId: space.id, leaseEpoch: space.leaseEpoch,
      url: "data:text/html,<title>Shared workspace</title>",
    });
    assert.ok(sharedTab.targetId);
    await bridge("tabs.close", { taskId, targetId: sharedTab.targetId });
  }
  checks.autonomousSharedWorkspace = true;

  for (const entry of ["desktop-mcp.mjs", "ego-mcp.mjs"]) {
    const client = new Client({ name: "suite-smoke", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: executable, args: [join(runtime, entry)], env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stderr: "pipe" });
    clients.push(client);
    await client.connect(transport);
    const list = await client.listTools();
    assert.ok(list.tools.length > 0);
    checks[entry] = list.tools.length;
    console.log(`${entry}: ${list.tools.length} tools`);
    if (entry === "desktop-mcp.mjs") {
      const status = await client.callTool({ name: "ego_desktop_status", arguments: {} });
      assert.ok(!status.isError);
      checks.desktopMcpCall = true;
    }
  }
  const pyEnv = {
    ...env, PYTHONPATH: join(runtime, "scansci", "src"), PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
    SCANSCI_PDF_DATA_DIR: join(work, "scansci"), EGOLITE_INSTALL_ROOT: resolve(executable, ".."),
    PATH: [join(runtime, "scansci", "bin"), runtime, env.PATH].join(";"),
  };
  const python = join(runtime, "scansci", "python", "python.exe");
  const probe = await run(python, ["-c", "from scansci_pdf.discovery import find_cli_available; from scansci_pdf.egolite_bridge import _native_install; import fitz, openpyxl; assert find_cli_available(); assert _native_install(); print('OK')"], { env: pyEnv, cwd: work, windowsHide: true, timeout: 20000 });
  assert.match(probe.stdout, /OK/);
  checks.pythonDiscoveryPdfBridge = true;
  await run(python, ["-c", "import pymupdf,sys; d=pymupdf.open(); p=d.new_page(); p.insert_text((40,40),'ScanSci Ego authenticated PDF fixture'); d.save(sys.argv[1]); d.close()", join(work, "fixture.pdf")], { env: pyEnv, windowsHide: true });
  const fixturePdf = await readFile(join(work, "fixture.pdf"));
  const fixture = createHttpServer((request, response) => {
    if (request.url === "/protected.pdf") {
      if (!String(request.headers.cookie || "").includes("scansci_fixture=fixture")) { response.writeHead(403); response.end("Missing fixture session"); return; }
      response.writeHead(200, { "content-type": "application/pdf" }); response.end(fixturePdf); return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<title>ScanSci fixture</title><input id="q"><button id="go" onclick="document.title=document.querySelector(\'#q\').value">Apply</button><script>document.cookie="scansci_fixture=fixture; path=/"</script>');
  });
  await new Promise(resolveListen => fixture.listen(0, "127.0.0.1", resolveListen));
  try {
    const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
    const script = `import json,sys\nfrom pathlib import Path\nfrom scansci_pdf import egolite_bridge as b\ncfg={'egolite_auto_start':False,'egolite_task_space':'ScanSci bridge verification','cache_dir':sys.argv[3]}\nb.navigate(sys.argv[1],cfg)\nassert b.evaluate('(value)=>{document.querySelector("#q").value=value;document.querySelector("#go").click();return document.title}', 'Ego bridge works',cfg)=='Ego bridge works'\nassert b.import_cookies([{'name':'scansci_extra','value':'fixture','domain':'127.0.0.1','path':'/'}],cfg)>0\nassert any(c['name']=='scansci_fixture' for c in b.export_cookies(cfg))\nassert b.download_pdf(sys.argv[1]+'/protected.pdf',Path(sys.argv[2]),cfg,timeout=45)\nprint('BRIDGE_OK')`;
    const bridgeProbe = await run(python, ["-c", script, fixtureUrl, join(work, "browser.pdf"), join(work, "bridge-cache")], { env: pyEnv, cwd: work, windowsHide: true, timeout: 90000 });
    assert.match(bridgeProbe.stdout, /BRIDGE_OK/);
    assert.deepEqual(await readFile(join(work, "browser.pdf")), fixturePdf);
    checks.scanSciRealBrowserBridge = true;
    checks.scanSciCookieReadWrite = true;
    checks.scanSciAuthenticatedBrowserPdf = true;
  } finally {
    await new Promise(resolveClose => fixture.close(resolveClose));
  }
  const sdkProbe = await run(executable, ["--input-type=module", "-e", "import { Codex } from '@openai/codex-sdk'; import { fileURLToPath } from 'node:url'; import path from 'node:path'; if (!fileURLToPath(import.meta.resolve('@openai/codex-sdk')).startsWith(path.join(process.cwd(), 'node_modules'))) throw Error('SDK escaped bundle'); new Codex(); console.log('OK')"], { cwd: runtime, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, timeout: 10000 });
  assert.match(sdkProbe.stdout, /OK/);
  checks.codexNativeRuntime = true;
  const scanClient = new Client({ name: "suite-smoke", version: "1.0.0" });
  clients.push(scanClient);
  await scanClient.connect(new StdioClientTransport({ command: python, args: ["-m", "scansci_pdf.main", "run"], env: pyEnv, cwd: work, stderr: "pipe" }));
  checks.scanSciMcpTools = (await scanClient.listTools()).tools.length;
  assert.ok(checks.scanSciMcpTools > 0);
  const tor = await run(join(runtime, "scansci", "tor", "tor", "tor.exe"), ["--version"], { env, windowsHide: true, timeout: 10000 });
  assert.match(tor.stdout, /Tor version/);
  checks.torBinary = true;

  const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const nativeEnv = { ...env, EGO_COMPANION_CONFIG: join(work, "native-config.json"), DOTNET_ROOT: join(work, "no-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0" };
  await run(powershell, ["-NoProfile", "-Command", 'Add-Type -AssemblyName System.Security; $secret = New-Object byte[] 32; $protected = [System.Security.Cryptography.ProtectedData]::Protect($secret,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); $json = @{pipeName="suite-native";protectedSecret=[Convert]::ToBase64String($protected)} | ConvertTo-Json; [IO.File]::WriteAllText($env:EGO_COMPANION_CONFIG,$json,[Text.UTF8Encoding]::new($false))'], { env: nativeEnv, windowsHide: true });
  const native = await run(join(runtime, "companion", "native", "publish", "ego-native-host.exe"), ["--broker-config"], { env: nativeEnv, windowsHide: true, timeout: 10000 });
  assert.equal(JSON.parse(native.stdout).pipeName, "\\\\.\\pipe\\suite-native");
  checks.selfContainedNativeHost = true;

  const processes = await run(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${app.pid}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`], { windowsHide: true });
  const children = [].concat(JSON.parse(processes.stdout));
  const service = children.find(p => p.Name === "python.exe" && /scansci_pdf\.(main|ego_host)/.test(p.CommandLine));
  assert.ok(service, "ScanSci must be a bundled child process");
  await run("taskkill.exe", ["/PID", String(service.ProcessId), "/F", "/T"], { windowsHide: true });
  await new Promise(resolve => setTimeout(resolve, 1500));
  await until(ping);
  checks.scanSciCrashRecovery = true;
  const broker = children.find(p => p.CommandLine?.includes("broker.mjs"));
  assert.ok(broker, "Broker must be a managed child process");
  await run("taskkill.exe", ["/PID", String(broker.ProcessId), "/F", "/T"], { windowsHide: true });
  await new Promise(resolve => setTimeout(resolve, 1500));
  await until(async () => (await rpc(pipe, "hello", { clientId: "suite-recovery" })).protocolVersion);
  checks.brokerCrashRecovery = true;
  await until(async () => (await readFile(capture)).length > 1000);
  await copyFile(capture, join(root, "release", "windows-suite-desktop.png"));
  checks.screenshot = true;
  await writeFile(join(root, "release", `validation-${packageVersion}.json`), JSON.stringify({ passed: true, executable, developerToolsOnPath: false, checkedAt: new Date().toISOString(), checks }, null, 2));
  console.log(JSON.stringify(checks, null, 2));
} finally {
  for (const client of clients) await client.close().catch(() => {});
  await run("taskkill.exe", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 1500));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

async function until(operation) {
  const deadline = Date.now() + 45000;
  let error;
  while (Date.now() < deadline) {
    try { const value = await operation(); if (value) return value; } catch (failure) { error = failure; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw error || new Error("Readiness check timed out");
}

function rpc(path, method, params) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${method} timed out`)); }, 15000);
    socket.once("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const response = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (response.id !== 1) continue;
        clearTimeout(timer); socket.destroy();
        if (response.error) reject(new Error(response.error.message)); else resolve(response.result);
      }
    });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
}
