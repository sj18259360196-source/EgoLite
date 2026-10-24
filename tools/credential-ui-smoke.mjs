import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "ego-credential-ui-smoke-"));
const suffix = randomUUID().replaceAll("-", "");
const pipe = `\\\\.\\pipe\\ego-credential-ui-${suffix}`;
const automationPipe = `\\\\.\\pipe\\ego-credential-ui-automation-${suffix}`;
const controlToken = randomBytes(32).toString("base64url");
const resultPath = join(work, "credential-ui-result.json");
const electronPath = join(root, "node_modules", "electron", "dist", "electron.exe");
const fixture = await startFixture();
let broker;
let electron;
let brokerOutput = "";
let electronOutput = "";

try {
  if (!existsSync(electronPath)) throw new Error("Electron is not installed; run npm install first");
  broker = spawn(process.execPath, [join(root, "apps", "broker", "src", "main.ts")], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      EGO_COMPAT_PIPE: pipe,
      EGO_COMPAT_BACKEND: "fake",
      EGO_DESKTOP_CONTROL_TOKEN: controlToken,
      EGO_STATE_DB: join(work, "state.db"),
    },
  });
  broker.stdout.on("data", (chunk) => { brokerOutput += String(chunk); });
  broker.stderr.on("data", (chunk) => { brokerOutput += String(chunk); });
  await waitForPipe(pipe, 10_000);

  electron = spawn(electronPath, [join(root, "apps", "desktop-shell")], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      EGO_DESKTOP_PIPE: pipe,
      EGO_DESKTOP_CONTROL_TOKEN: controlToken,
      EGO_DESKTOP_AUTOMATION_PIPE: automationPipe,
      EGO_DESKTOP_STATE: join(work, "desktop-tabs.json"),
      EGO_DESKTOP_CREDENTIALS: join(work, "credentials.json"),
      EGO_DESKTOP_USER_DATA: join(work, "electron-user-data"),
      EGO_DESKTOP_CREDENTIAL_SMOKE_RESULT: resultPath,
      EGO_DESKTOP_HISTORY_FIXTURE_URL: fixture.url,
      EGO_HOME_BAR_SHORTCUT: "CommandOrControl+Shift+F10",
      EGO_DESKTOP_ONBOARDING: "0",
      EGO_AGENT_INTEGRATION_DISABLED: "1",
    },
  });
  electron.stdout.on("data", (chunk) => { electronOutput += String(chunk); });
  electron.stderr.on("data", (chunk) => { electronOutput += String(chunk); });

  const result = await waitForJsonFile(resultPath, 40_000);
  const exitCode = await waitForExit(electron, 10_000);
  if (exitCode !== 0 || result.error || !Object.values(result).every(Boolean)) {
    throw new Error(`Credential UI smoke failed: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (brokerOutput.trim()) console.error(brokerOutput.trim());
  if (electronOutput.trim()) console.error(electronOutput.trim());
  throw error;
} finally {
  if (electron?.exitCode === null) {
    electron.kill();
    await waitForExit(electron, 5_000).catch(() => {});
  }
  if (broker?.exitCode === null) {
    broker.kill();
    await waitForExit(broker, 5_000).catch(() => {});
  }
  await fixture.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function startFixture() {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.url === "/login") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(readFileSync(join(root, "fixtures", "browser", "login.html"), "utf8"));
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closeResolve, closeReject) => server.close((error) => error ? closeReject(error) : closeResolve())),
      });
    });
  });
}

function waitForPipe(pipeName, timeout) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(pipeName);
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error("Timed out waiting for credential smoke Broker"));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function waitForExit(child, timeout) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error(`Process timed out after ${timeout} ms`)), timeout);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForJsonFile(path, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try { return JSON.parse(readFileSync(path, "utf8")); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for credential UI smoke result");
}
