import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CosRuntime, resolvePackEntry } from "./cos-runtime.mjs";
import { CosCompanion } from "./cos-companion.mjs";
import { installCosArchive, readCosPack } from "./cos-archive.mjs";
import { CosStatus } from "./cos-status.mjs";
import { CosUpdateStore } from "./cos-update.mjs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { acquireCosPreset } from "./cos-acquire.mjs";
import { migrateMissingLegacyCos } from "./cos-migration.mjs";
import { CosDialogs } from "./cos-dialogs.mjs";

export function assertCosRecoveryControl(space, mode, clientId) {
  if (!space || mode === "manual" || space.agentBlocked || space.ownership === "agentDelegatedToUser") {
    throw new Error("CoS browser execution stopped by user control");
  }
  if (mode !== "agent" && space.ownership === "agent" && space.lastAgentClientId && space.lastAgentClientId !== clientId) {
    throw new Error("CoS workspace is controlled by another agent");
  }
}

export class CosWorkspace {
  #options;
  #dialogs;
  #config;
  #runtime;
  #browser;
  #companion;
  #view;
  #opening;
  #enabling;
  #restored = false;
  #error = "";
  #installing = false;
  #status;
  #updateTask;
  #maintenanceToken = randomBytes(32).toString("hex");
  #recoveryError;
  #execution;
  #acquireTask;
  #acquireController;
  #acquireProgress;

  constructor(options) {
    this.#options = options;
    this.#dialogs = new CosDialogs({ dialog: options.dialog, getParent: options.getParent, enabled: () => this.enabled });
    this.#status = new CosStatus({
      discoveryPath: join(dirname(options.registryPath), "status-endpoint.json"),
      describe: () => this.describe(), runtime: () => this.#runtime,
      agents: () => options.listAgents?.() || Promise.reject(new Error("Agent registry unavailable")),
    });
    try { this.#config = JSON.parse(readFileSync(options.registryPath, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.#config = { enabled: false, directory: options.defaultDirectory, workspace: null, ...(options.builtin ? { source: "builtin" } : {}) };
    }
    if (options.builtin && (this.#config.source === "builtin" || !this.#config.directory)) {
      this.#config.directory = options.defaultDirectory;
      this.#config.source = "builtin";
    }
  }
  get view() { return this.#view; }
  get runtime() { return this.#runtime; }
  get browser() { return this.#browser; }
  get companion() { return this.#companion; }
  get statusService() { return this.#status; }
  get taskId() { return this.#config.workspace?.taskId; }
  get enabled() { return this.#config.enabled === true; }
  get updating() { return Boolean(this.#updateTask); }
  get acquiring() { return Boolean(this.#acquireTask); }

  authorizeMaintenance(token) {
    const supplied = Buffer.from(typeof token === "string" ? token : "");
    const expected = Buffer.from(this.#maintenanceToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("CoS maintenance authentication failed");
  }

  describe() {
    let logo = "";
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(this.#config.directory || "", "manifest.json"), "utf8")); } catch { /* Missing program is reported by installed/state. */ }
    const icon = join(this.#config.directory || "", "source/extension/icons/icon48.png");
    if (existsSync(icon)) logo = `data:image/png;base64,${readFileSync(icon).toString("base64")}`;
    return {
      id: "cos", name: "Chat On Steroids",
      builtin: this.#options.builtin === true, source: this.#config.source || "legacy",
      upstreamVersion: manifest?.upstreamVersion, adapterVersion: manifest?.adapterVersion, commit: manifest?.commit,
      maintenance: this.#options.maintenance?.(),
      installed: Boolean(this.#config.directory && existsSync(join(this.#config.directory, "manifest.json"))),
      enabled: this.enabled, state: this.#runtime?.state || "stopped", error: this.#error,
      directory: this.#config.directory, workspace: this.#config.workspace,
      version: this.#runtime?.manifest?.packVersion || manifest?.packVersion || this.#config.packVersion, logo,
      installing: this.#installing, installRoot: this.#config.installRoot || this.#options.installRoot,
      updating: this.updating, canRollback: Boolean(this.#config.lastUpdateId),
      execution: this.#execution,
      acquisition: this.#acquireProgress, acquiring: this.acquiring,
    };
  }

  #save() {
    const path = this.#options.registryPath;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + ".tmp", JSON.stringify(this.#config, null, 2) + "\n");
    renameSync(path + ".tmp", path);
    this.#options.changed?.(this.describe());
    this.#status.publish("package.changed");
  }

  async load(directory) {
    return this.#changePack(async () => {
      const manifest = await readCosPack(directory);
      return { directory: resolve(directory), packVersion: manifest.packVersion };
    });
  }

  async install(archive, installRoot) {
    return this.#changePack(async () => {
      const root = resolve(installRoot || this.#config.installRoot || this.#options.installRoot);
      const installed = await installCosArchive(archive, root);
      return { directory: installed.directory, installRoot: root, packVersion: installed.manifest.packVersion };
    });
  }

  async #changePack(prepare) {
    if (this.updating || this.#recoveryError) throw new Error(this.#recoveryError || "CoS update is running");
    if (this.enabled || this.#enabling) throw new Error("请先关闭 CoS，再载入其他功能包");
    if (this.#installing) throw new Error("CoS 功能包正在安装");
    this.#installing = true;
    this.#options.changed?.(this.describe());
    const previous = this.#config;
    try {
      const update = await prepare();
      this.#config = { ...previous, ...update, previousDirectory: previous.directory, lastUpdateId: undefined };
      this.#save();
      this.#runtime = undefined;
      this.#error = "";
    } catch (error) {
      this.#config = previous;
      this.#error = error.message;
      throw error;
    } finally {
      this.#installing = false;
      this.#options.changed?.(this.describe());
    }
    return this.describe();
  }

  async installPreset(installRoot) {
    if (this.#acquireTask) throw new Error("CoS 功能包正在下载");
    if (this.describe().installed) throw new Error("CoS 已安装，请使用更新入口");
    const root = resolve(installRoot || this.#config.installRoot || this.#options.installRoot);
    const controller = new AbortController();
    this.#acquireController = controller;
    this.#acquireProgress = { phase: "runtime" };
    const task = this.#changePack(async () => {
      const candidate = await (this.#options.acquirePreset || acquireCosPreset)({
        builderRoot: this.#options.builderRoot, installRoot: root,
        workRoot: this.#options.acquireWorkRoot || join(root, ".tmp/codex/cos-install"),
        signal: controller.signal, onLog: text => this.#options.log?.(text),
        onProgress: progress => {
          this.#acquireProgress = progress;
          this.#options.changed?.(this.describe());
        },
      });
      controller.signal.throwIfAborted();
      const manifest = await readCosPack(candidate.directory);
      return { directory: candidate.directory, installRoot: root, packVersion: manifest.packVersion };
    });
    this.#acquireTask = task;
    this.#options.changed?.(this.describe());
    try { return await task; }
    finally {
      this.#acquireTask = undefined;
      this.#acquireController = undefined;
      this.#acquireProgress = undefined;
      this.#options.changed?.(this.describe());
    }
  }

  cancelInstall() {
    this.#acquireController?.abort(new Error("CoS 安装已取消"));
    if (this.acquiring) this.#acquireProgress = { phase: "cancelling" };
    this.#options.changed?.(this.describe());
    return this.describe();
  }

  async restore() {
    if (this.#restored) return;
    this.#restored = true;
    try {
      const recovered = await new CosUpdateStore(this.#options).recover();
      if (recovered) this.#config = recovered;
      this.#config = await migrateMissingLegacyCos(this.#options, this.#config);
      if (this.#options.automationPipe) {
        const path = join(dirname(this.#options.registryPath), "maintenance-endpoint.json");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ schemaVersion: 1, pid: process.pid,
          pipe: this.#options.automationPipe, token: this.#maintenanceToken }), { mode: 0o600 });
      }
    } catch (error) {
      this.#recoveryError = this.#error = error.message;
      this.#config.enabled = false;
      this.#options.changed?.(this.describe());
      return;
    }
    if (this.enabled) {
      try { await this.enable(this.#config.workspace?.profileId); }
      catch (error) { this.#error = error.message; this.#options.changed?.(this.describe()); }
    }
  }

  async enable(profileId = "default") {
    if (this.updating || this.#recoveryError) throw new Error(this.#recoveryError || "CoS update is running");
    if (this.#installing) throw new Error("请等待 CoS 功能包安装完成");
    if (this.#enabling) return this.#enabling;
    this.#enabling = this.#enable(profileId);
    try { return await this.#enabling; } finally { this.#enabling = undefined; }
  }

  async #enable(profileId, healthCheck = false) {
    this.#error = "";
    const migrated = await migrateMissingLegacyCos(this.#options, this.#config);
    if (migrated !== this.#config) { this.#config = migrated; this.#runtime = undefined; }
    if (!this.#runtime) {
      this.#config = await new CosUpdateStore(this.#options).checkpointBuiltin(this.#config, this.#config.directory);
      this.#runtime = new CosRuntime({
        directory: this.#config.directory, dataDirectory: this.#options.dataDirectory,
        statusFile: this.#status.discoveryPath,
        onHostRequest: async (method, payload) => {
          if (method === "dialog.open" || method === "dialog.save") return this.#dialogs.show(method, payload);
          if (method === "agents.status") return this.#status.agents(payload);
          if (method === "ui.show") {
            if (!this.enabled) throw new Error("CoS workspace is disabled");
            return this.#options.showHome?.();
          }
          if (method === "browser.open") {
            if (!this.enabled || !this.taskId) throw new Error("CoS workspace is disabled");
            if (this.#browser) return this.#browser.call("tabs.create", [{ url: payload.url, active: payload.active === true }],
              { visual: payload.active === true });
            return this.#options.openTab(this.taskId, payload.url);
          }
          throw new Error(`Unsupported CoS host method: ${method}`);
        },
      });
      this.#runtime.on("event", (channel, args) => {
        this.#status.publish(channel);
        if (channel === "ego:browser-wake") this.#companion?.wake();
        if (this.#view && !this.#view.webContents.isDestroyed()) this.#view.webContents.send("ego:cos:event", channel, args);
      });
      this.#runtime.on("log", text => this.#options.log?.(text));
      this.#runtime.on("runtime-error", error => { this.#error = error.message; });
      this.#runtime.on("state", () => {
        this.#status.publish("runtime.changed");
        this.#options.changed?.(this.describe());
      });
    }
    try {
      await this.#runtime.start();
      this.#config.packVersion = this.#runtime.manifest.packVersion;
      if (healthCheck) {
        const response = await this.#runtime.invoke("state:get");
        if (!response?.ok) throw new Error(response?.error || "CoS startup health check failed");
      }
      const spaces = await this.#options.listSpaces();
      const existing = spaces.find(space => space.taskId === this.taskId);
      this.#config.workspace = existing
        ? await this.#options.claimSpace?.(existing) || existing
        : await this.#options.createSpace(profileId);
      this.#config.enabled = true;
      if (this.#options.createBrowser && !this.#companion) {
        this.#browser = this.#options.createBrowser({
          directory: this.#config.directory,
          event: (name, ...args) => this.#companion?.event(name, ...args),
          message: (message, sender) => this.#companion.message(message, sender),
          preferences: keys => this.#companion.preferences(keys),
          diagnostic: text => this.#options.log?.(`CoS page: ${text}\n`),
        });
        this.#companion = new CosCompanion({
          directory: this.#config.directory, dataDirectory: this.#options.dataDirectory,
          debuggerEnabled: true,
          call: (method, args) => method === "bridge.request"
            ? this.#runtime.invoke("ego:browser-request", args[0], 200_000)
            : this.#browser.call(method, args),
        });
        this.#companion.on("diagnostic", text => this.#options.log?.(`CoS companion: ${text}\n`));
        this.#companion.on("preferences", changes => {
          void this.#browser?.preferencesChanged(changes);
        });
        await this.#companion.start();
        await this.#options.restoreTabs?.(this.taskId);
        await this.#browser.resumePages();
      }
      if (this.#runtime.manifest.features?.executionGate === 1) {
        this.#execution = await this.#runtime.invoke("ego:execution-activate", {});
      }
      await this.#status.start();
      this.#save();
      return this.describe();
    } catch (error) {
      this.#error = error.message;
      await this.#stopServices();
      this.#config.enabled = false;
      throw error;
    }
  }

  async disable() {
    if (this.#updateTask) await this.#updateTask.catch(() => {});
    if (this.#enabling) await this.#enabling;
    try { await this.shutdown(); }
    catch (error) { this.#error = error.message; throw error; }
    finally {
      this.#config.enabled = false;
      this.#save();
    }
    return this.describe();
  }

  async update(directory) { return this.#maintain("update", directory); }
  async rollback() { return this.#maintain("rollback"); }
  async resumeTasks() {
    if (!this.enabled || this.updating || this.#runtime?.state !== "ready") throw new Error("CoS 尚未就绪");
    if (this.#runtime.manifest.features?.executionGate !== 1) throw new Error("当前 CoS 包不支持任务恢复");
    if (this.#options.claimSpace) await this.#options.claimSpace(this.#config.workspace);
    this.#execution = await this.#runtime.invoke("ego:execution-activate", { resume: true });
    this.#companion?.wake();
    this.#options.changed?.(this.describe());
    this.#status.publish("execution.changed");
    return this.describe();
  }

  async #maintain(operation, directory) {
    if (this.updating || this.#installing || this.#enabling) throw new Error("CoS package operation is already running");
    if (this.#recoveryError) throw new Error(this.#recoveryError);
    const store = new CosUpdateStore(this.#options);
    const before = structuredClone(this.#config);
    const homeWasOpen = Boolean(this.#view && !this.#view.webContents.isDestroyed());
    const activate = async (config, enabled) => {
      this.#config = { ...config, enabled: false };
      if (operation === "update" && resolve(config.directory) !== resolve(before.directory)) this.#config.source = "updated";
      this.#runtime = undefined;
      if (enabled) {
        await this.#enable(config.workspace?.profileId || "default", true);
        if (homeWasOpen) await this.openHome();
      }
      else if (operation === "update" && resolve(config.directory) !== resolve(before.directory)) {
        const probe = new CosRuntime({ directory: config.directory, dataDirectory: this.#options.dataDirectory, probeOnly: true });
        try {
          await probe.start();
          this.#config.packVersion = probe.manifest.packVersion;
          const response = await probe.invoke("state:get");
          if (!response?.ok) throw new Error(response?.error || "CoS startup health check failed");
        } finally { await probe.stop(); }
        this.#save();
      } else {
        this.#config.packVersion = (await readCosPack(config.directory)).packVersion;
        this.#save();
      }
      return structuredClone(this.#config);
    };
    const options = { before, current: before, directory, stop: () => this.#stopServices(), activate };
    this.#updateTask = store[operation](options);
    this.#options.changed?.(this.describe());
    try {
      const result = await this.#updateTask;
      this.#config = result.config;
      this.#error = "";
      return { ...this.describe(), updating: false, backupDirectory: result.backupDirectory };
    } catch (error) {
      this.#error = error.message;
      if (existsSync(store.pendingPath)) this.#recoveryError = error.message;
      throw error;
    } finally {
      this.#updateTask = undefined;
      this.#options.changed?.(this.describe());
    }
  }

  async openHome() {
    if (!this.enabled || this.#runtime?.state !== "ready") throw new Error("CoS 尚未就绪");
    if (this.#opening) return this.#opening;
    if (this.#view && !this.#view.webContents.isDestroyed()) return true;
    this.#opening = this.#createView();
    try { return await this.#opening; } finally { this.#opening = undefined; }
  }

  async #createView() {
    const parent = this.#options.getParent();
    const directory = this.#config.directory;
    const view = this.#options.createView({
      webPreferences: {
        preload: resolvePackEntry(directory, this.#runtime.manifest.entries.preload),
        partition: "cos-app-ui", contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    this.#view = view;
    view.setVisible(false);
    parent.contentView.addChildView(view);
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", event => event.preventDefault());
    contents.on("will-redirect", event => event.preventDefault());
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.on("render-process-gone", (_event, details) => {
      this.#error = `CoS 页面进程退出 (${details.reason})`;
      this.#options.changed?.(this.describe());
    });
    try {
      await contents.loadFile(resolvePackEntry(directory, this.#runtime.manifest.entries.renderer));
      return true;
    } catch (error) {
      this.#disposeView();
      throw error;
    }
  }

  invokeUi(event, channel, payload) {
    const contents = this.#view?.webContents;
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
      throw new Error("CoS app IPC sender is not authorized");
    }
    return this.#runtime.invoke(channel, payload);
  }

  layout({ visible, bounds } = {}) {
    if (!this.#view || this.#view.webContents.isDestroyed()) return false;
    const parent = this.#options.getParent();
    if (!parent || parent.isDestroyed()) return false;
    const [width, height] = parent.getContentSize();
    const zoom = parent.webContents.getZoomFactor();
    const valid = bounds && ["x", "y", "width", "height"].every(key => Number.isFinite(bounds[key]));
    const x = valid ? Math.max(0, Math.min(width, Math.round(bounds.x * zoom))) : 0;
    const y = valid ? Math.max(0, Math.min(height, Math.round(bounds.y * zoom))) : 0;
    const w = valid ? Math.max(0, Math.min(width - x, Math.round(bounds.width * zoom))) : 0;
    const h = valid ? Math.max(0, Math.min(height - y, Math.round(bounds.height * zoom))) : 0;
    this.#view.setBounds({ x, y, width: w, height: h });
    this.#view.setVisible(visible === true && w > 0 && h > 0 && this.enabled);
    return true;
  }

  #disposeView() {
    if (!this.#view) return;
    const parent = this.#options.getParent();
    if (parent && !parent.isDestroyed()) parent.contentView.removeChildView(this.#view);
    if (!this.#view.webContents.isDestroyed()) this.#view.webContents.close();
    this.#view = undefined;
  }

  async shutdown() {
    if (this.#acquireTask) {
      this.cancelInstall();
      await this.#acquireTask.catch(() => {});
    }
    if (this.#updateTask) await this.#updateTask.catch(() => {});
    return this.#stopServices();
  }

  async #stopServices() {
    this.#dialogs.stop();
    const errors = [];
    // A failed cleanup must not leave later execution services running.
    for (const stop of [
      () => this.#status.stop(),
      () => this.#disposeView(),
      () => this.#browser?.stop(),
      () => this.#companion?.stop(),
      () => this.#runtime?.stop(),
    ]) {
      try { await stop(); } catch (error) { errors.push(error); }
    }
    this.#browser = undefined;
    this.#companion = undefined;
    this.#execution = undefined;
    if (errors.length) throw new AggregateError(errors, "CoS shutdown cleanup failed");
  }
}
