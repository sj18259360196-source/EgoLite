import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentIntegrationService } from "./agent-integrations.mjs";

test("installs local Agent skills and idempotent MCP configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "egolite-agent-integrations-"));
  try {
    const home = join(root, "home");
    const codex = join(root, "codex");
    const runtime = join(root, "runtime");
    const skill = join(root, "skill");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(codex, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(runtime, "ego-browser.mjs"), "", "utf8");
    writeFileSync(join(runtime, "ego-mcp.mjs"), "", "utf8");
    writeFileSync(join(skill, "SKILL.md"), 'metadata:\n  version: "1.2.5"\n', "utf8");
    writeFileSync(join(codex, "config.toml"), 'model = "test"\n', "utf8");
    writeFileSync(join(home, ".claude.json"), '{"mcpServers":{"existing":{"command":"keep"}}}\n', "utf8");

    const service = new AgentIntegrationService({
      userHome: home,
      codexHome: codex,
      runtimeDirectory: runtime,
      skillSource: skill,
      installRoot: join(root, "installed"),
      commandDirectory: join(root, "path-bin"),
      executablePath: join(root, "EgoLite.exe"),
      version: "0.1.0",
      clock: () => new Date("2026-08-28T12:00:00.000Z"),
    });
    const first = service.sync();
    const second = service.sync();

    assert.equal(first.integrations.find((item) => item.kind === "codex")?.installed, true);
    assert.equal(second.integrations.find((item) => item.kind === "claude")?.installed, true);
    assert.equal(existsSync(join(codex, "skills", "ego-browser", "SKILL.md")), true);
    assert.equal(existsSync(join(home, ".agents", "skills", "ego-browser", "SKILL.md")), true);
    const codexConfig = readFileSync(join(codex, "config.toml"), "utf8");
    assert.equal(codexConfig.match(/BEGIN EGOLITE MANAGED MCP/g)?.length, 1);
    assert.match(codexConfig, /ego-browser-desktop/);
    const claudeConfig = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    assert.equal(claudeConfig.mcpServers.existing.command, "keep");
    assert.match(claudeConfig.mcpServers["ego-browser-desktop"].command, /start-ego-mcp\.cmd$/);
    const launcher = readFileSync(join(root, "installed", "start-ego-mcp.cmd"), "ascii");
    assert.match(launcher, /EGO_COMPAT_PIPE=.*ego-compat-desktop-broker/);
    assert.match(launcher, /EGO_DESKTOP_PIPE=.*ego-compat-desktop-broker/);
    assert.match(launcher, /EGO_DESKTOP_AUTOMATION_PIPE=.*ego-compat-desktop/);
    assert.match(launcher, /EGO_DESKTOP_AUTOSTART=1/);
    assert.match(launcher, /EGO_DESKTOP_EXECUTABLE=.*EgoLite\.exe/);
    assert.match(readFileSync(join(root, "installed", "ego-browser.cmd"), "ascii"), /ego-compat-desktop-broker/);
    assert.match(readFileSync(join(root, "path-bin", "ego-browser.cmd"), "ascii"), /EGOLITE MANAGED LAUNCHER/);
    assert.equal(service.status().integrations.every((item) => item.installed), true);
    assert.deepEqual(service.status().integrations[0].skills.map((item) => item.name), ["ego-browser"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installs web-access-ego beside ego-browser and reports each required skill", () => {
  const root = mkdtempSync(join(tmpdir(), "egolite-agent-multi-skill-"));
  try {
    const home = join(root, "home");
    const codex = join(root, "codex");
    const runtime = join(root, "runtime");
    const egoSkill = join(root, "skills", "ego-browser");
    const webAccessSkill = join(root, "skills", "web-access-ego");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(codex, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    mkdirSync(egoSkill, { recursive: true });
    mkdirSync(webAccessSkill, { recursive: true });
    writeFileSync(join(runtime, "ego-browser.mjs"), "", "utf8");
    writeFileSync(join(runtime, "ego-mcp.mjs"), "", "utf8");
    writeFileSync(join(egoSkill, "SKILL.md"), 'metadata:\n  version: "1.2.5"\n', "utf8");
    writeFileSync(join(webAccessSkill, "SKILL.md"), 'metadata:\n  version: "0.1.0"\n', "utf8");

    const service = new AgentIntegrationService({
      userHome: home,
      codexHome: codex,
      runtimeDirectory: runtime,
      skillSources: {
        "ego-browser": egoSkill,
        "web-access-ego": webAccessSkill,
      },
      installRoot: join(root, "installed"),
      executablePath: join(root, "EgoLite.exe"),
    });
    const synced = service.sync();

    assert.deepEqual(synced.integrations.map((item) => item.kind), ["codex", "claude", "cursor", "agents"]);
    assert.equal(synced.integrations.every((item) => item.installed), true);
    for (const integration of synced.integrations) {
      assert.deepEqual(integration.skills.map((item) => [item.name, item.installed]), [
        ["ego-browser", true],
        ["web-access-ego", true],
      ]);
    }
    assert.equal(existsSync(join(codex, "skills", "ego-browser", "SKILL.md")), true);
    assert.equal(existsSync(join(codex, "skills", "web-access-ego", "SKILL.md")), true);
    assert.equal(existsSync(join(home, ".claude", "skills", "web-access-ego", "SKILL.md")), true);
    assert.equal(existsSync(join(home, ".cursor", "skills", "web-access-ego", "SKILL.md")), true);
    assert.equal(existsSync(join(home, ".agents", "skills", "web-access-ego", "SKILL.md")), true);
    assert.match(readFileSync(join(codex, "config.toml"), "utf8"), /start-ego-mcp\.cmd/);
    assert.match(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["ego-browser-desktop"].command, /start-ego-mcp\.cmd$/);
    assert.match(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ego-browser-desktop"].command, /start-ego-mcp\.cmd$/);

    rmSync(join(codex, "skills", "web-access-ego", "SKILL.md"));
    const codexStatus = service.status().integrations.find((item) => item.kind === "codex");
    assert.equal(codexStatus.installed, false);
    assert.equal(codexStatus.skillInstalled, false);
    assert.equal(codexStatus.mcpConfigured, true);
    assert.equal(codexStatus.skills.find((item) => item.name === "ego-browser")?.installed, true);
    assert.equal(codexStatus.skills.find((item) => item.name === "web-access-ego")?.installed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disables and restores only the managed web-access-ego skill", () => {
  const root = mkdtempSync(join(tmpdir(), "egolite-agent-web-access-toggle-"));
  try {
    const home = join(root, "home");
    const codex = join(root, "codex");
    const runtime = join(root, "runtime");
    const egoSkill = join(root, "skills", "ego-browser");
    const webAccessSkill = join(root, "skills", "web-access-ego");
    mkdirSync(codex, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    mkdirSync(egoSkill, { recursive: true });
    mkdirSync(webAccessSkill, { recursive: true });
    writeFileSync(join(runtime, "ego-browser.mjs"), "", "utf8");
    writeFileSync(join(runtime, "ego-mcp.mjs"), "", "utf8");
    writeFileSync(join(egoSkill, "SKILL.md"), 'metadata:\n  version: "1.2.5"\n', "utf8");
    writeFileSync(join(webAccessSkill, "SKILL.md"), 'metadata:\n  version: "0.1.0"\n', "utf8");

    const service = new AgentIntegrationService({
      userHome: home,
      codexHome: codex,
      runtimeDirectory: runtime,
      skillSources: {
        "ego-browser": egoSkill,
        "web-access-ego": webAccessSkill,
      },
      installRoot: join(root, "installed"),
      executablePath: join(root, "EgoLite.exe"),
    });
    service.sync();

    const customSkill = join(codex, "skills", "custom-user-skill");
    mkdirSync(customSkill, { recursive: true });
    writeFileSync(join(customSkill, "SKILL.md"), "# keep\n", "utf8");
    const disabled = service.sync({ enabledSkills: ["ego-browser"] });
    const disabledCodex = disabled.integrations.find((item) => item.kind === "codex");

    assert.deepEqual(disabled.enabledSkills, ["ego-browser"]);
    assert.equal(disabledCodex?.installed, true);
    assert.equal(disabledCodex?.skillInstalled, true);
    assert.deepEqual(disabledCodex?.skills.map((item) => [item.name, item.enabled, item.installed]), [
      ["ego-browser", true, true],
      ["web-access-ego", false, false],
    ]);
    assert.equal(existsSync(join(codex, "skills", "web-access-ego")), false);
    assert.equal(existsSync(join(home, ".agents", "skills", "web-access-ego")), false);
    assert.equal(existsSync(join(customSkill, "SKILL.md")), true);

    const rememberedStatus = service.status();
    const rememberedCodex = rememberedStatus.integrations.find((item) => item.kind === "codex");
    assert.deepEqual(rememberedStatus.enabledSkills, ["ego-browser"]);
    assert.equal(rememberedCodex?.installed, true);
    assert.equal(rememberedCodex?.skills.find((item) => item.name === "web-access-ego")?.enabled, false);

    const restored = service.sync({ enabledSkills: ["ego-browser", "web-access-ego"] });
    assert.equal(restored.integrations.every((item) => item.installed), true);
    assert.equal(existsSync(join(codex, "skills", "web-access-ego", "SKILL.md")), true);
    assert.equal(existsSync(join(home, ".agents", "skills", "web-access-ego", "SKILL.md")), true);
    assert.equal(existsSync(join(customSkill, "SKILL.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves an unmanaged web-access-ego directory when the feature starts disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "egolite-agent-web-access-unmanaged-"));
  try {
    const home = join(root, "home");
    const codex = join(root, "codex");
    const runtime = join(root, "runtime");
    const egoSkill = join(root, "skills", "ego-browser");
    const webAccessSkill = join(root, "skills", "web-access-ego");
    const unmanagedSkill = join(codex, "skills", "web-access-ego");
    mkdirSync(runtime, { recursive: true });
    mkdirSync(egoSkill, { recursive: true });
    mkdirSync(webAccessSkill, { recursive: true });
    mkdirSync(unmanagedSkill, { recursive: true });
    writeFileSync(join(runtime, "ego-browser.mjs"), "", "utf8");
    writeFileSync(join(runtime, "ego-mcp.mjs"), "", "utf8");
    writeFileSync(join(egoSkill, "SKILL.md"), "# ego\n", "utf8");
    writeFileSync(join(webAccessSkill, "SKILL.md"), "# bundled\n", "utf8");
    writeFileSync(join(unmanagedSkill, "SKILL.md"), "# user managed\n", "utf8");

    const service = new AgentIntegrationService({
      userHome: home,
      codexHome: codex,
      runtimeDirectory: runtime,
      skillSources: { "ego-browser": egoSkill, "web-access-ego": webAccessSkill },
      installRoot: join(root, "installed"),
      executablePath: join(root, "EgoLite.exe"),
    });
    service.sync({ enabledSkills: ["ego-browser"] });

    assert.equal(readFileSync(join(unmanagedSkill, "SKILL.md"), "utf8"), "# user managed\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not overwrite malformed third-party JSON configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "egolite-agent-config-error-"));
  try {
    const home = join(root, "home");
    const runtime = join(root, "runtime");
    const skill = join(root, "skill");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(runtime, { recursive: true });
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(runtime, "ego-browser.mjs"), "", "utf8");
    writeFileSync(join(runtime, "ego-mcp.mjs"), "", "utf8");
    writeFileSync(join(skill, "SKILL.md"), "# test\n", "utf8");
    const configPath = join(home, ".cursor", "mcp.json");
    writeFileSync(configPath, "{broken", "utf8");
    const service = new AgentIntegrationService({ userHome: home, runtimeDirectory: runtime, skillSource: skill, installRoot: join(root, "installed"), executablePath: join(root, "EgoLite.exe") });
    const cursor = service.sync().integrations.find((item) => item.kind === "cursor");
    assert.equal(cursor.installed, false);
    assert.match(cursor.error, /JSON/);
    assert.equal(readFileSync(configPath, "utf8"), "{broken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
