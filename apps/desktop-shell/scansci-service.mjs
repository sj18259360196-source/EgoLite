import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const DEFAULT_PORT = 8765;
const CHECK_CHANNELS = ["egolite", "webvpn", "carsi", "ezproxy", "elsevier", "oa", "tor", "grey"];

export class ScanSciService {
  constructor(options = {}) {
    this.projectDirectory = resolve(options.projectDirectory || process.env.SCANSCI_PROJECT_DIR || "A:\\Project\\ScanSci PDF");
    this.host = options.host || "127.0.0.1";
    this.pythonCommand = options.pythonCommand;
    this.runtimeDirectory = options.runtimeDirectory;
    this.dataDirectory = options.dataDirectory;
    this.pipeName = options.pipeName;
    this.autoRestart = options.autoRestart === true;
    this.restartDelayMs = options.restartDelayMs ?? 1000;
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.stopping = false;
    this.port = Number(options.port || process.env.SCANSCI_PORT || DEFAULT_PORT);
    this.fetch = options.fetch || globalThis.fetch;
    this.spawnProcess = options.spawnProcess || spawn;
    this.probeCommand = options.probeCommand || spawnSync;
    this.findListeningPid = options.findListeningPid || (() => findListeningPid(this.port, this.probeCommand));
    this.terminatePid = options.terminatePid || ((pid) => terminatePid(pid, this.probeCommand));
    this.fileExists = options.fileExists || existsSync;
    this.clock = options.clock || (() => new Date());
    this.startTimeoutMs = Number(options.startTimeoutMs || 30_000);
    this.requestTimeoutMs = Number(options.requestTimeoutMs || 45_000);
    this.child = null;
    this.adoptedPid = null;
    this.startPromise = null;
    this.state = "stopped";
    this.lastError = "";
    this.startedAt = "";
    this.logs = [];
    this.lastCheck = null;
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  async status() {
    const identity = await this.ping().catch(() => null);
    const online = Boolean(identity);
    if (online) this.state = "running";
    if (!online && !this.child && this.state !== "starting") this.state = "stopped";
    return {
      configured: this.fileExists(join(this.projectDirectory, "src", "scansci_pdf", "web.py")),
      online,
      managed: Boolean(this.child || this.adoptedPid),
      state: this.state,
      pid: this.child?.pid || this.adoptedPid || null,
      baseUrl: this.baseUrl,
      settingsUrl: `${this.baseUrl}/settings`,
      projectDirectory: this.projectDirectory,
      startedAt: this.startedAt,
      checkedAt: this.clock().toISOString(),
      error: this.lastError,
      recentLogs: [...this.logs],
      identity,
      lastCheck: this.lastCheck,
    };
  }

  async ensure() {
    this.stopping = false;
    const existing = await this.status();
    if (existing.online) {
      this.adopt(existing.identity);
      return this.status();
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async start() {
    if (!this.fileExists(join(this.projectDirectory, "src", "scansci_pdf", "web.py"))) {
      throw this.fail(`ScanSci PDF 项目不存在: ${this.projectDirectory}`);
    }
    const python = this.findPython();
    if (this.dataDirectory) {
      mkdirSync(this.dataDirectory, { recursive: true });
      try {
        writeFileSync(join(this.dataDirectory, "config.json"), JSON.stringify({ browser_backend: "egolite" }), { encoding: "utf8", flag: "wx" });
      } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    this.state = "starting";
    this.lastError = "";
    this.logs = [];
    const args = [...python.args, "-m", "scansci_pdf.main", "web", "--host", this.host, "--port", String(this.port)];
    const sourceDirectory = join(this.projectDirectory, "src");
    const env = {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONPATH: sourceDirectory,
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PATH: [join(this.projectDirectory, "bin"), join(this.projectDirectory, "tor", "tor"), this.runtimeDirectory, process.env.PATH].filter(Boolean).join(delimiter),
      ...(this.dataDirectory ? { SCANSCI_PDF_DATA_DIR: this.dataDirectory } : {}),
      ...(this.pipeName ? { EGO_COMPAT_PIPE: this.pipeName } : {}),
      ...(this.runtimeDirectory ? { EGOLITE_INSTALL_ROOT: dirname(dirname(this.runtimeDirectory)) } : {}),
    };
    delete env.PYTHONHOME;
    const child = this.spawnProcess(python.command, args, {
      cwd: this.projectDirectory,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.startedAt = this.clock().toISOString();
    child.stdout?.on("data", (chunk) => this.captureLog(chunk));
    child.stderr?.on("data", (chunk) => this.captureLog(chunk));
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.lastError = error?.message || String(error);
      this.state = "failed";
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.state === "stopping") {
        this.state = "stopped";
        return;
      }
      this.state = "failed";
      this.lastError = `ScanSci 服务已退出 (${signal || code || "unknown"})`;
      if (this.autoRestart && !this.stopping && this.restartAttempts < 3) {
        const attempt = ++this.restartAttempts;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.stopping) void this.ensure().catch(error => { this.lastError = error.message; });
        }, this.restartDelayMs * 2 ** (attempt - 1));
        this.restartTimer.unref?.();
      }
    });

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      const current = await this.status();
      if (current.online) return current;
      if (!this.child || this.state === "failed") throw this.fail(this.lastError || "ScanSci 服务启动失败");
      await delay(250);
    }
    await this.stop();
    throw this.fail(`ScanSci 服务在 ${this.startTimeoutMs}ms 内未就绪`);
  }

  async restart() {
    this.restartAttempts = 0;
    let current = await this.status();
    if (current.online && !current.managed) {
      this.adopt(current.identity);
      current = await this.status();
    }
    if (current.online && !current.managed) {
      return { ...current, restartSkipped: true, message: "无法识别当前 ScanSci 实例的监听进程。" };
    }
    await this.stop();
    return this.ensure();
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    if (!this.child && this.adoptedPid) {
      const pid = this.adoptedPid;
      this.adoptedPid = null;
      this.state = "stopping";
      const stopped = this.terminatePid(pid);
      this.state = "stopped";
      return { ...(await this.status()), stopped, adopted: true };
    }
    if (!this.child) {
      const current = await this.status();
      return { ...current, stopped: false, external: current.online };
    }
    const child = this.child;
    this.state = "stopping";
    this.child = null;
    try { child.kill(); } catch {}
    await waitForExit(child, 4_000);
    this.state = "stopped";
    return { ...(await this.status()), stopped: true };
  }

  dispose() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    if (this.adoptedPid) {
      const pid = this.adoptedPid;
      this.adoptedPid = null;
      this.terminatePid(pid);
    }
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.state = "stopped";
    try { child.kill(); } catch {}
  }

  async checkAll() {
    const service = await this.ensure();
    const startedAt = this.clock().toISOString();
    const checkChannel = async (channel) => {
      try {
        const result = await this.request("/api/channel/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel, action: "check" }),
        });
        return [channel, { ok: true, result }];
      } catch (error) {
        return [channel, { ok: false, error: error?.message || String(error) }];
      }
    };
    const results = [];
    results.push(await checkChannel("egolite"));
    results.push(await checkChannel("webvpn"));
    results.push(...await Promise.all(CHECK_CHANNELS.slice(2).map(checkChannel)));
    const channels = Object.fromEntries(results);
    const failed = Object.entries(channels).filter(([, value]) => !value.ok).map(([channel]) => channel);
    const report = {
      service,
      startedAt,
      finishedAt: this.clock().toISOString(),
      checked: CHECK_CHANNELS.length,
      passed: CHECK_CHANNELS.length - failed.length,
      failed,
      channels,
      dashboard: await this.dashboard().catch(() => null),
    };
    this.lastCheck = report;
    return report;
  }

  async dashboard() {
    return this.request("/api/dashboard", { method: "GET" }, 1_500);
  }

  async ping() {
    return this.request("/api/ping", { method: "GET" }, 1_500);
  }

  async request(path, init, timeoutMs = this.requestTimeoutMs) {
    if (typeof this.fetch !== "function") throw new Error("当前 Node.js 运行时不支持 fetch");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`);
      }
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  findPython() {
    if (this.pythonCommand) {
      if (!this.fileExists(this.pythonCommand)) throw this.fail("随软件提供的 Python 运行环境缺失，请重新安装 EgoLite");
      return { command: this.pythonCommand, args: [] };
    }
    const configured = String(process.env.SCANSCI_PYTHON || "").trim();
    const candidates = [
      ...(configured ? [{ command: configured, args: [] }] : []),
      { command: join(this.projectDirectory, ".venv", "Scripts", "python.exe"), args: [] },
      { command: "python", args: [] },
      { command: "py", args: ["-3.11"] },
    ];
    for (const candidate of candidates) {
      if (candidate.command.includes("\\") && !this.fileExists(candidate.command)) continue;
      try {
        const result = this.probeCommand(candidate.command, [...candidate.args, "--version"], { windowsHide: true, stdio: "ignore" });
        if (result?.status === 0) return candidate;
      } catch {}
    }
    throw this.fail("未找到可运行 ScanSci PDF 的 Python 3.11+");
  }

  captureLog(chunk) {
    const lines = String(chunk).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    this.logs.push(...lines);
    if (this.logs.length > 30) this.logs.splice(0, this.logs.length - 30);
  }

  adopt(dashboard) {
    if (this.child || this.adoptedPid) return;
    const reportedRoot = dashboard?.project?.root;
    if (!reportedRoot || resolve(reportedRoot).toLocaleLowerCase() !== this.projectDirectory.toLocaleLowerCase()) return;
    const pid = Number(this.findListeningPid());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) this.adoptedPid = pid;
  }

  fail(message) {
    this.state = "failed";
    this.lastError = message;
    return new Error(message);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function findListeningPid(port, run) {
  try {
    const result = run("netstat.exe", ["-ano", "-p", "tcp"], { windowsHide: true, encoding: "utf8" });
    if (result?.status !== 0) return null;
    for (const line of String(result.stdout || "").split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5 || columns[0].toUpperCase() !== "TCP") continue;
      if (!columns[1].endsWith(`:${port}`) || columns[3].toUpperCase() !== "LISTENING") continue;
      const pid = Number(columns[4]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {}
  return null;
}

function terminatePid(pid, run) {
  try {
    const result = run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return result?.status === 0;
  } catch {
    return false;
  }
}
