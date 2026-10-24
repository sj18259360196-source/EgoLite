import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { configureCodexMcp, codexMcpConfigured } from "./codex-mcp-config.mjs";
import { dirname, join, resolve } from "node:path";

const MANAGED_START = "# BEGIN EGOLITE MANAGED MCP";
const MANAGED_END = "# END EGOLITE MANAGED MCP";
const REMOVABLE_MANAGED_SKILLS = new Set(["web-access-ego"]);
const MANAGED_SKILL_MARKER = ".egolite-managed-skill";

export class AgentIntegrationService {
  constructor(options) {
    this.userHome = resolve(options.userHome);
    this.codexHome = options.codexHome ? resolve(options.codexHome) : "";
    this.runtimeDirectory = resolve(options.runtimeDirectory);
    this.skills = normalizeSkillSources(options);
    this.defaultEnabledSkills = normalizeEnabledSkills(options.enabledSkills, this.skills, true);
    this.skillSource = this.skills.find((skill) => skill.name === "ego-browser")?.source || this.skills[0].source;
    this.installRoot = resolve(options.installRoot);
    this.executablePath = resolve(options.executablePath);
    this.desktopAppPath = options.desktopAppPath ? resolve(options.desktopAppPath) : "";
    this.commandDirectory = options.commandDirectory ? resolve(options.commandDirectory) : "";
    this.pipeName = options.pipeName || "\\\\.\\pipe\\ego-compat-desktop-broker";
    this.automationPipeName = options.automationPipeName || "\\\\.\\pipe\\ego-compat-desktop";
    this.version = String(options.version || "0.1.0");
    this.clock = options.clock || (() => new Date());
    this.statePath = join(this.installRoot, "integration-state.json");
  }

  sync(options) {
    mkdirSync(this.installRoot, { recursive: true });
    const enabledSkills = this.resolveEnabledSkills(options);
    const previousState = readJson(this.statePath);
    const launchers = this.writeLaunchers();
    const integrations = this.targets().map((target) => this.syncTarget(target, launchers, enabledSkills, previousState));
    const state = {
      version: this.version,
      updatedAt: this.clock().toISOString(),
      command: launchers.cli,
      enabledSkills: [...enabledSkills],
      integrations,
    };
    atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  status(options) {
    try {
      const saved = JSON.parse(readFileSync(this.statePath, "utf8"));
      const enabledSkills = this.resolveEnabledSkills(options, saved.enabledSkills);
      return {
        ...saved,
        enabledSkills: [...enabledSkills],
        integrations: this.targets().map((target) => this.targetStatus(target, saved, {}, enabledSkills)),
      };
    } catch {
      const enabledSkills = this.resolveEnabledSkills(options);
      return {
        version: this.version,
        updatedAt: "",
        command: join(this.installRoot, "ego-browser.cmd"),
        enabledSkills: [...enabledSkills],
        integrations: this.targets().map((target) => this.targetStatus(target, null, {}, enabledSkills)),
      };
    }
  }

  resolveEnabledSkills(options, savedEnabledSkills) {
    const requested = enabledSkillsFromOptions(options);
    if (requested !== undefined) return normalizeEnabledSkills(requested, this.skills, true);
    if (this.defaultEnabledSkills) return new Set(this.defaultEnabledSkills);
    if (savedEnabledSkills !== undefined) return normalizeEnabledSkills(savedEnabledSkills, this.skills, true);
    return new Set(this.skills.map((skill) => skill.name));
  }

  targets() {
    const targets = [];
    const seen = new Set();
    const add = (target) => {
      const key = `${target.kind}:${target.root.toLocaleLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push(target);
    };
    const defaultCodexHome = join(this.userHome, ".codex");
    if (this.codexHome) add(codexTarget(this.codexHome));
    else if (existsSync(defaultCodexHome)) add(codexTarget(defaultCodexHome));

    const claudeRoot = join(this.userHome, ".claude");
    const claudeConfig = join(this.userHome, ".claude.json");
    if (existsSync(claudeRoot) || existsSync(claudeConfig)) add({
      kind: "claude",
      name: "Claude",
      root: claudeRoot,
      skillDirectory: join(claudeRoot, "skills", "ego-browser"),
      configPath: claudeConfig,
      configKind: "json",
    });

    const cursorRoot = join(this.userHome, ".cursor");
    if (existsSync(cursorRoot)) add({
      kind: "cursor",
      name: "Cursor",
      root: cursorRoot,
      skillDirectory: join(cursorRoot, "skills", "ego-browser"),
      configPath: join(cursorRoot, "mcp.json"),
      configKind: "json",
    });

    const agentsRoot = join(this.userHome, ".agents");
    add({
      kind: "agents",
      name: "通用本地 Agent",
      root: agentsRoot,
      skillDirectory: join(agentsRoot, "skills", "ego-browser"),
      configPath: "",
      configKind: "skill-only",
    });
    return targets;
  }

  writeLaunchers() {
    const cliEntry = join(this.runtimeDirectory, "ego-browser.mjs");
    const mcpEntry = join(this.runtimeDirectory, "ego-mcp.mjs");
    if (!existsSync(cliEntry)) throw new Error(`ego-browser runtime missing: ${cliEntry}`);
    if (!existsSync(mcpEntry)) throw new Error(`ego MCP runtime missing: ${mcpEntry}`);
    const cli = join(this.installRoot, "ego-browser.cmd");
    const mcp = join(this.installRoot, "start-ego-mcp.cmd");
    atomicWrite(cli, windowsLauncher(this.executablePath, cliEntry, true, this.pipeName, this.desktopAppPath, this.automationPipeName), "utf8");
    atomicWrite(mcp, windowsLauncher(this.executablePath, mcpEntry, false, this.pipeName, this.desktopAppPath, this.automationPipeName), "utf8");
    return { cli: this.publishCliCommand(cli), mcp };
  }

  publishCliCommand(privateLauncher) {
    if (!this.commandDirectory) return privateLauncher;
    const publicLauncher = join(this.commandDirectory, "ego-browser.cmd");
    mkdirSync(this.commandDirectory, { recursive: true });
    if (existsSync(publicLauncher)) {
      const current = readFileSync(publicLauncher, "utf8");
      if (!current.includes("EGOLITE MANAGED LAUNCHER")) return privateLauncher;
    }
    atomicWrite(publicLauncher, [
      "@echo off",
      "rem EGOLITE MANAGED LAUNCHER",
      "chcp 65001 >nul",
      `call "${privateLauncher}" %*`,
      "exit /b %errorlevel%",
      "",
    ].join("\r\n"), "utf8");
    return publicLauncher;
  }

  syncTarget(target, launchers, enabledSkills, previousState) {
    try {
      for (const skill of this.skills) {
        const skillDirectory = targetSkillDirectory(target, skill.name);
        if (!enabledSkills.has(skill.name)) {
          if (REMOVABLE_MANAGED_SKILLS.has(skill.name) && isManagedSkillDirectory(skillDirectory, target, skill.name, previousState)) {
            rmSync(skillDirectory, { recursive: true, force: true });
          }
          continue;
        }
        if (!existsSync(skill.source)) throw new Error(`skill source missing: ${skill.source}`);
        mkdirSync(dirname(skillDirectory), { recursive: true });
        cpSync(skill.source, skillDirectory, { recursive: true, force: true });
        if (REMOVABLE_MANAGED_SKILLS.has(skill.name)) {
          writeFileSync(join(skillDirectory, MANAGED_SKILL_MARKER), `${this.version}\n`, "utf8");
        }
      }
      const scansciLauncher = join(this.runtimeDirectory, "start-scansci-mcp.cmd");
      const extraServers = existsSync(scansciLauncher) ? { "scansci-pdf-egolite": scansciLauncher } : {};
      if (target.configKind === "toml") updateCodexConfig(target.configPath, launchers.mcp, extraServers);
      if (target.configKind === "json") updateJsonMcpConfig(target.configPath, launchers.mcp, extraServers);
      return this.targetStatus(target, null, { error: "" }, enabledSkills);
    } catch (error) {
      return this.targetStatus(target, null, { installed: false, error: error?.message || String(error) }, enabledSkills);
    }
  }

  targetStatus(target, saved, override = {}, enabledSkills = new Set(this.skills.map((skill) => skill.name))) {
    const previous = saved?.integrations?.find((item) => item.kind === target.kind && item.root === target.root);
    const skills = this.skills.map((skill) => {
      const directory = targetSkillDirectory(target, skill.name);
      const installed = existsSync(join(directory, "SKILL.md"));
      return {
        name: skill.name,
        directory,
        enabled: enabledSkills.has(skill.name),
        installed,
        version: installed ? readSkillVersion(directory) : "",
      };
    });
    const skillInstalled = skills.every((skill) => !skill.enabled || skill.installed);
    const configured = target.configKind === "skill-only" ? skillInstalled : configContainsLauncher(target, join(this.installRoot, "start-ego-mcp.cmd"));
    const primarySkill = skills.find((skill) => skill.name === "ego-browser") || skills[0];
    return {
      kind: target.kind,
      name: target.name,
      root: target.root,
      detected: target.kind === "agents" || existsSync(target.root) || existsSync(target.configPath),
      installed: override.installed ?? (skillInstalled && configured),
      skillInstalled,
      skills,
      mcpConfigured: configured,
      version: primarySkill?.version || "",
      error: override.error ?? previous?.error ?? "",
    };
  }
}

function isManagedSkillDirectory(directory, target, skillName, previousState) {
  if (existsSync(join(directory, MANAGED_SKILL_MARKER))) return true;
  const previous = previousState?.integrations?.find((item) => item.kind === target.kind && item.root === target.root);
  return previous?.skills?.some((skill) => skill.name === skillName && skill.installed === true) === true;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function enabledSkillsFromOptions(options) {
  if (options === undefined || options === null) return undefined;
  if (Array.isArray(options) || options instanceof Set) return options;
  if (typeof options === "object" && Object.hasOwn(options, "enabledSkills")) return options.enabledSkills;
  return undefined;
}

function normalizeEnabledSkills(configured, skills, rejectUnknown = false) {
  if (configured === undefined || configured === null) return null;
  if (!Array.isArray(configured) && !(configured instanceof Set)) {
    throw new TypeError("enabledSkills must be an array or Set");
  }
  const known = new Set(skills.map((skill) => skill.name));
  const enabled = new Set();
  for (const rawName of configured) {
    const name = String(rawName || "").trim();
    if (!known.has(name)) {
      if (rejectUnknown) throw new TypeError(`unknown skill name: ${name}`);
      continue;
    }
    enabled.add(name);
  }
  return enabled;
}

function normalizeSkillSources(options) {
  const configured = options.skillSources;
  const entries = Array.isArray(configured)
    ? configured.map((skill) => [skill?.name, skill?.source])
    : configured && typeof configured === "object"
      ? Object.entries(configured)
      : [];
  if (options.skillSource && !entries.some(([name]) => name === "ego-browser")) {
    entries.unshift(["ego-browser", options.skillSource]);
  }
  if (!entries.length) throw new TypeError("skillSource or skillSources is required");
  const seen = new Set();
  return entries.map(([rawName, rawSource]) => {
    const name = String(rawName || "").trim();
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new TypeError(`invalid skill name: ${rawName}`);
    }
    if (seen.has(name)) throw new TypeError(`duplicate skill name: ${name}`);
    if (!rawSource) throw new TypeError(`skill source is required: ${name}`);
    seen.add(name);
    return { name, source: resolve(rawSource) };
  });
}

function targetSkillDirectory(target, skillName) {
  return join(dirname(target.skillDirectory), skillName);
}

function codexTarget(root) {
  return {
    kind: "codex",
    name: "Codex",
    root,
    skillDirectory: join(root, "skills", "ego-browser"),
    configPath: join(root, "config.toml"),
    configKind: "toml",
  };
}

function windowsLauncher(executablePath, entryPath, isCli, pipeName, appPath = "", automationPipeName = "\\\\.\\pipe\\ego-compat-desktop") {
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    "chcp 65001 >nul",
    `set "EGO_COMPAT_PIPE=${pipeName.replaceAll("%", "%%")}"`,
    `set "EGO_DESKTOP_PIPE=${pipeName.replaceAll("%", "%%")}"`,
    `set "EGO_DESKTOP_AUTOMATION_PIPE=${automationPipeName.replaceAll("%", "%%")}"`,
    'set "EGO_DESKTOP_AUTOSTART=1"',
    `set "EGO_DESKTOP_EXECUTABLE=${executablePath.replaceAll("%", "%%")}"`,
    ...(appPath ? [`set "EGO_DESKTOP_APP_PATH=${appPath.replaceAll("%", "%%")}"`] : []),
    "set ELECTRON_RUN_AS_NODE=1",
    `"${executablePath.replaceAll("%", "%%")}" "${entryPath.replaceAll("%", "%%")}"${isCli ? " %*" : ""}`,
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
}

export function updateCodexConfig(path, launcher, extraServers = {}) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  let next = configureCodexMcp(current, launcher);
  for (const [name, command] of Object.entries(extraServers)) next = configureCodexMcp(next, command, name);
  if (next === current) return;
  // Refuse a stale write if another application changed the file meanwhile.
  if ((existsSync(path) ? readFileSync(path, "utf8") : "") !== current) throw new Error("Codex configuration changed during sync; retry");
  if (current) writeFileSync(path + ".before-egolite-" + randomUUID() + ".bak", current, "utf8");
  atomicWrite(path, next);
}

function updateJsonMcpConfig(path, launcher, extraServers = {}) {
  mkdirSync(dirname(path), { recursive: true });
  let config = {};
  if (existsSync(path)) config = JSON.parse(readFileSync(path, "utf8"));
  if (!config || Array.isArray(config) || typeof config !== "object") throw new Error(`unsupported MCP config: ${path}`);
  config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ? config.mcpServers : {};
  config.mcpServers["ego-browser-desktop"] = { command: launcher, args: [] };
  for (const [name, command] of Object.entries(extraServers)) config.mcpServers[name] = { command, args: [] };
  atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
}

function configContainsLauncher(target, launcher) {
  if (!target.configPath || !existsSync(target.configPath)) return false;
  try {
    if (target.configKind === "json") {
      const config = JSON.parse(readFileSync(target.configPath, "utf8"));
      return config?.mcpServers?.["ego-browser-desktop"]?.command === launcher;
    }
    const text = readFileSync(target.configPath, "utf8");
    return codexMcpConfigured(text, launcher);
  } catch {
    return false;
  }
}

function readSkillVersion(skillDirectory) {
  try {
    const source = readFileSync(join(skillDirectory, "SKILL.md"), "utf8");
    return source.match(/^\s*version:\s*["']?([^"'\r\n]+)["']?/m)?.[1]?.trim() || "installed";
  } catch {
    return "";
  }
}

function atomicWrite(path, content, encoding = "utf8") {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && readFileSync(path, encoding) === content) return;
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, encoding);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
