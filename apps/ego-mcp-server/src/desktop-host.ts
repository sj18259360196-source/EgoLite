import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";

export const DEFAULT_DESKTOP_BROKER_PIPE = "\\\\.\\pipe\\ego-compat-desktop-broker";
export const DEFAULT_DESKTOP_AUTOMATION_PIPE = "\\\\.\\pipe\\ego-compat-desktop";
const DEFAULT_TIMEOUT_MS = 30_000;
const LOCK_STALE_AFTER_MS = 60_000;

export interface DesktopHostBootstrapOptions {
  pipeName: string;
  automationPipeName?: string;
  executablePath?: string;
  appPath?: string;
  lockPath?: string;
  timeoutMs?: number;
  probe?: (pipeName: string) => Promise<boolean>;
  spawnHost?: (
    executablePath: string,
    args: string[],
    environment: Record<string, string | undefined>,
  ) => Promise<void>;
  now?: () => number;
}

export async function ensureDesktopHost(options: DesktopHostBootstrapOptions): Promise<void> {
  const probe = options.probe ?? canConnect;
  const automationPipeName = options.automationPipeName ?? DEFAULT_DESKTOP_AUTOMATION_PIPE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const ready = () => isDesktopReady(probe, options.pipeName, automationPipeName);

  if (await ready()) return;

  const lockPath = options.lockPath ?? defaultLockPath();
  const release = await acquireWakeLock(lockPath, now);
  if (!release) {
    await waitForReady(ready, timeoutMs);
    return;
  }

  try {
    if (await ready()) return;
    const spawnHost = options.spawnHost ?? spawnDesktopHost;
    const executablePath = options.spawnHost ? "" : resolveExecutablePath(options);
    if (!options.spawnHost && !executablePath) {
      throw Object.assign(
        new Error(
          "EgoLite cannot be started automatically. Set EGO_DESKTOP_EXECUTABLE or start EgoLite manually.",
        ),
        { error_code: "EGO_BROWSER_UNAVAILABLE" },
      );
    }
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    environment.EGO_COMPAT_PIPE = options.pipeName;
    environment.EGO_DESKTOP_PIPE = options.pipeName;
    environment.EGO_DESKTOP_AUTOMATION_PIPE = automationPipeName;
    const args = options.appPath ? [options.appPath] : [];
    await spawnHost(executablePath, args, environment);
    await waitForReady(ready, timeoutMs);
  } finally {
    await release();
  }
}

async function waitForReady(ready: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Desktop host bootstrap timeout must be greater than zero");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now()))));
  }
  throw Object.assign(
    new Error("EgoLite did not become ready before the desktop host bootstrap timed out"),
    { error_code: "EGO_BROWSER_UNAVAILABLE" },
  );
}

async function isDesktopReady(
  probe: (pipeName: string) => Promise<boolean>,
  brokerPipeName: string,
  automationPipeName: string,
): Promise<boolean> {
  const [brokerReady, automationReady] = await Promise.all([
    probe(brokerPipeName),
    probe(automationPipeName),
  ]);
  return brokerReady && automationReady;
}

function resolveExecutablePath(options: DesktopHostBootstrapOptions): string {
  return options.executablePath
    || process.env.EGO_DESKTOP_EXECUTABLE
    || (process.versions.electron ? process.execPath : "");
}

function defaultLockPath(): string {
  return join(
    process.env.LOCALAPPDATA || process.env.TEMP || process.cwd(),
    "EgoCompat",
    "desktop-host-wake.lock",
  );
}

async function acquireWakeLock(
  lockPath: string,
  now: () => number,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: now() }));
      } finally {
        await handle.close();
      }
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && await isStaleLock(lockPath, now)) {
        await rm(lockPath, { force: true });
        continue;
      }
      return async () => {};
    }
  }
  return async () => {};
}

async function isStaleLock(lockPath: string, now: () => number): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: unknown;
      createdAt?: unknown;
    };
    const createdAt = typeof value.createdAt === "number" ? value.createdAt : 0;
    if (createdAt <= 0 || now() - createdAt < LOCK_STALE_AFTER_MS) return false;
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return true;
    try {
      process.kill(value.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return true;
  }
}

function spawnDesktopHost(
  executablePath: string,
  args: string[],
  environment: Record<string, string | undefined>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(executablePath, args, {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: environment,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function canConnect(pipeName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(pipeName);
    const done = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(400, () => done(false));
  });
}
