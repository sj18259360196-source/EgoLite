import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../apps/ego-mcp-server/src/server.ts";
import { helperContext } from "../vendor/ego-browser/src/helpers.js";
import { sdkSnapshotOptions } from "../vendor/ego-browser/src/driver/observe.js";
import {
  AUTOMATION_NOTES, AUTOMATION_CONTRACT_VERSION, SCOPED_REFS_CAPABILITY,
  desktopAutomationCapabilities,
} from "../apps/desktop-shell/automation-capabilities.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markerStart = "<!-- BEGIN GENERATED AUTOMATION CONTRACT -->";
const markerEnd = "<!-- END GENERATED AUTOMATION CONTRACT -->";

export async function discoverAutomationInterfaces() {
  const full = createServer(async () => { throw new Error("Documentation discovery must not connect to a browser"); });
  const client = new Client({ name: "automation-docs", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let fullTools;
  try {
    await full.connect(serverTransport);
    await client.connect(clientTransport);
    fullTools = await listAllTools(client);
  } finally {
    await client.close();
    await full.close();
  }
  const direct = new Client({ name: "automation-docs-direct", version: "1.0.0" });
  const directTransport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "apps/desktop-mcp-server/src/main.ts")],
    cwd: root,
    env: { ...process.env, EGO_DESKTOP_AUTOSTART: "0" },
    stderr: "pipe",
  });
  let directTools;
  try {
    // Initialization and tools/list only. No tool calls, Broker, browser or user profile.
    await direct.connect(directTransport);
    directTools = await listAllTools(direct);
  } finally {
    await direct.close();
    await directTransport.close();
  }
  const sdk = helperContext();
  const methods = (value) => Object.entries(value).filter(([, member]) => typeof member === "function").map(([name]) => name).sort();
  return {
    contractVersion: AUTOMATION_CONTRACT_VERSION,
    capability: SCOPED_REFS_CAPABILITY,
    desktop: {
      scopedEnabled: desktopAutomationCapabilities(true),
      scopedDisabled: desktopAutomationCapabilities(false),
    },
    notes: AUTOMATION_NOTES,
    sdkSnapshotDefaults: sdkSnapshotOptions(),
    mcp: { full: fullTools, direct: directTools },
    sdk: Object.fromEntries([
      ...["page", "browser", "taskSpaces", "site", "fetch"].map((name) => [name, methods(sdk[name])]),
      ["page.keyboard", methods(sdk.page.keyboard)],
      ["page.mouse", methods(sdk.page.mouse)],
      ["locator", methods(sdk.page.locator("#documentation-only"))],
    ]),
  };
}

async function listAllTools(client) {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10_000 });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

export function renderAutomationDocs(contract) {
  const snapshotDefaults = (surface, name) => Object.fromEntries(Object.entries(
    contract.mcp[surface].find((tool) => tool.name === name).inputSchema.properties,
  ).filter(([, schema]) => schema.default !== undefined).map(([key, schema]) => [key, schema.default]));
  const lines = [
    "# EgoLite automation interface reference", "",
    "Generated from both MCP servers' actual tools/list responses and the SDK facade. Do not edit generated sections.",
    "Run `npm run docs:automation` to regenerate, or `npm run check:automation` to detect drift.", "",
    "## Capability discovery", "",
    "Call `ego_status` and inspect `backend.capabilities` and `backend.automation`; for the direct MCP use `ego_desktop_status` and its top-level fields.",
    "The declaration describes the current desktop backend. SDK method presence and MCP tools/list describe available interfaces, not runtime permission or support on other backends.",
    "`scoped-refs-v1` still requires per-connection negotiation. `EGO_SCOPED_REFS=0` disables it. The action lifetime is reported at runtime and may be configured with `EGO_REFERENCE_ACTION_MAX_MS`.", "",
    "### Desktop declaration with scoped refs enabled", "", "```json",
    JSON.stringify(contract.desktop.scopedEnabled, null, 2), "```", "",
    ...Object.entries(contract.notes).flatMap(([name, note]) => [`### ${name}`, "", note, ""]),
    "## Snapshot defaults", "",
    "Defaults come from the actual MCP schemas and the SDK option-normalization function.", "",
    "| Entry point | Default options |", "| --- | --- |",
    `| Full MCP ego_snapshot | ${escapeCell(JSON.stringify(snapshotDefaults("full", "ego_snapshot")))} |`,
    `| Direct MCP ego_desktop_snapshot | ${escapeCell(JSON.stringify(snapshotDefaults("direct", "ego_desktop_snapshot")))} |`,
    `| SDK page.snapshot() | ${escapeCell(JSON.stringify(contract.sdkSnapshotDefaults))} |`, "",
    "SDK uses `includeStableLocator`, `includeActionMarks` and `maxResultLength`; MCP uses `stableLocators` and, where offered, `actionMarks`.",
    "`actionMarks=false` / `includeActionMarks=false` removes the inline @ref markers. Do not parse refs out of that text. Complete-page results require an untruncated full capture; unavailable frames are reported as incomplete.",
    "Snapshot text is returned by the MCP tools and SDK page.snapshot(); structured refs and completeness are available from the runtime snapshot response, not a JSON shape invented for the text tools.", "",
  ];
  for (const [surface, tools] of Object.entries(contract.mcp)) {
    lines.push(`## ${surface === "full" ? "Full task-space" : "Direct visible-page"} MCP`, "", `${tools.length} registered tools.`, "");
    for (const tool of tools) {
      lines.push(`### ${tool.name}`, "", tool.description || "", "",
        "| Argument | Type | Required | Default | Constraints |",
        "| --- | --- | --- | --- | --- |");
      const properties = tool.inputSchema.properties || {};
      for (const [name, schema] of Object.entries(properties)) {
        const { type, default: defaultValue, description, ...constraints } = schema;
        const typeText = type || (schema.anyOf ? "union" : "object");
        lines.push(`| ${name} | ${escapeCell(typeText)} | ${tool.inputSchema.required?.includes(name) ? "yes" : "no"} | ${defaultValue === undefined ? "—" : escapeCell(JSON.stringify(defaultValue))} | ${escapeCell(JSON.stringify(constraints))} |`);
      }
      if (!Object.keys(properties).length) lines.push("| (none) | | | | |");
      lines.push("");
    }
  }
  lines.push("## SDK method inventory", "", "These are actual facade methods. Use SDK `help()` for signatures. A method may still report unsupported on a given backend.", "");
  for (const [name, methods] of Object.entries(contract.sdk)) lines.push(`- ${name}: ${methods.map((method) => `\`${method}\``).join(", ")}`);
  lines.push("", "## Machine-readable source", "", "`automation-contract.json` preserves full JSON schemas, including enum, bounds, unions and MCP annotations.", "");
  return lines.join("\n");
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export async function syncAutomationDocs({ check = false } = {}) {
  const contract = await discoverAutomationInterfaces();
  assert.ok(contract.mcp.full.length > 0 && contract.mcp.direct.length > 0);
  const markdown = renderAutomationDocs(contract);
  const json = `${JSON.stringify(contract, null, 2)}\n`;
  const outputs = new Map([
    ["docs/automation-api.md", markdown],
    ["docs/automation-contract.json", json],
  ]);
  for (const skill of ["ego-browser", "web-access-ego"]) {
    outputs.set(`vendor/${skill}/skill/references/automation-api.md`, markdown);
    outputs.set(`vendor/${skill}/skill/references/automation-contract.json`, json);
    const file = `vendor/${skill}/skill/SKILL.md`;
    const original = await readFile(join(root, file), "utf8");
    const section = [
      markerStart, "## Installed EgoLite interface contract", "",
      "Read [the generated interface reference](references/automation-api.md) for exact MCP parameters, defaults and SDK method availability.",
      ...Object.values(AUTOMATION_NOTES).map((note) => `\n- ${note}`),
      "", markerEnd,
    ].join("\n");
    const start = original.indexOf(markerStart);
    const end = original.indexOf(markerEnd);
    if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new Error(`Broken generated markers in ${file}`);
    outputs.set(file, start < 0 ? `${original.trimEnd()}\n\n${section}\n`
      : original.slice(0, start) + section + original.slice(end + markerEnd.length));
  }
  const stale = [];
  for (const [file, expected] of outputs) {
    const path = join(root, file);
    const current = await readFile(path, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    if (current.replaceAll("\r\n", "\n") === expected.replaceAll("\r\n", "\n")) continue;
    stale.push(file);
    if (!check) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, expected, "utf8");
    }
  }
  if (check && stale.length) throw new Error(`Automation interface documentation is stale. Run npm run docs:automation.\n${stale.join("\n")}`);
  return { fullTools: contract.mcp.full.length, directTools: contract.mcp.direct.length, updated: stale };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await syncAutomationDocs({ check: process.argv.includes("--check") }), null, 2));
}
