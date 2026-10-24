import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  desktopAutomationCapabilities, AUTOMATION_NOTES, automationToolDescription, SCOPED_REFS_CAPABILITY,
} from "./automation-capabilities.mjs";
import { SCOPED_REFS_CAPABILITY as protocolCapability } from "../../packages/protocol/src/types.ts";
import { syncAutomationDocs, renderAutomationDocs } from "../../tools/sync-automation-docs.mjs";
import { sdkSnapshotOptions } from "../../vendor/ego-browser/src/driver/observe.js";

test("disabled desktop never claims scoped frame, drag, network or screenshot support", () => {
  const disabled = desktopAutomationCapabilities(false);
  assert.equal(SCOPED_REFS_CAPABILITY, protocolCapability);
  assert.equal(disabled.refFormat, "native-v0");
  assert.equal(disabled.scopedRefsEnabled, false);
  for (const feature of ["scopedDrag", "scopedElementScreenshot", "scopedNetworkWait"]) {
    assert.equal(disabled[feature], "unavailable");
  }
  assert.equal(disabled.referenceActionMaxLifetimeMs, undefined);
  const enabled = desktopAutomationCapabilities(true, 91_000);
  assert.equal(enabled.referenceActionMaxLifetimeMs, 91_000);
  assert.equal(enabled.rawCdpScopedGuarantees, false);
  assert.equal(enabled.locatorScope, "main-frame");
});

test("actual desktop status reports capability state and configured action limit", async () => {
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const dispatch = source.match(/async function dispatchDesktopAutomation\([^]*?\n\}/)?.[0];
  assert.ok(dispatch);
  for (const enabled of [false, true]) {
    const context = vm.createContext({
      mainWindow: { isDestroyed: () => false },
      hostRequest: async () => ({ taskId: "task-A", targetId: "page-A" }),
      activeWebviewId: 10, scopedReferencesEnabled: enabled,
      desktopScopedAutomation: {}, scopedReferenceActionTtlMs: 91_000,
      SCOPED_REFS_CAPABILITY, desktopAutomationCapabilities,
    });
    vm.runInContext(dispatch, context);
    const status = await context.dispatchDesktopAutomation("desktop.status");
    assert.deepEqual(status.automation, desktopAutomationCapabilities(enabled, 91_000));
    assert.equal(status.capabilities?.includes(SCOPED_REFS_CAPABILITY) === true, enabled);
    assert.equal(status.visible.targetId, "page-A");
  }
});

test("tool declarations carry the same actionable limitations as the distributed skill contract", () => {
  assert.ok(automationToolDescription("ego_drag", "Drag.").includes(AUTOMATION_NOTES.drag));
  assert.ok(automationToolDescription("ego_snapshot", "Snapshot.").includes(AUTOMATION_NOTES.frames));
  assert.ok(automationToolDescription("ego_click_wait_for_response", "Wait.").includes(AUTOMATION_NOTES.network));
  assert.equal(automationToolDescription("ego_fill", "Fill."), "Fill.");
  assert.deepEqual(sdkSnapshotOptions({ scope: "viewport", includeActionMarks: false, includeStableLocator: false, maxResultLength: 64 }), {
    scope: "viewport", includeActionMarks: false, includeStableLocator: false, maxResultLength: 64,
  });
});

test("distributed docs match live tools/list from both MCP servers without connecting to a browser", async () => {
  const result = await syncAutomationDocs({ check: true });
  const contract = JSON.parse(await readFile(new URL("../../docs/automation-contract.json", import.meta.url), "utf8"));
  assert.equal(result.fullTools, contract.mcp.full.length);
  assert.equal(result.directTools, contract.mcp.direct.length);
  assert.ok(contract.mcp.full.some((tool) => tool.name === "ego_drag"));
  assert.ok(!contract.mcp.direct.some((tool) => /drag|upload/.test(tool.name)));
  const full = contract.mcp.full.find((tool) => tool.name === "ego_snapshot");
  const direct = contract.mcp.direct.find((tool) => tool.name === "ego_desktop_snapshot");
  assert.equal(full.inputSchema.properties.scope.default, "viewport");
  assert.equal(direct.inputSchema.properties.scope.default, "full_page");
  assert.deepEqual(contract.sdkSnapshotDefaults, sdkSnapshotOptions());
  assert.ok(contract.sdk.taskSpaces.includes("observe") && contract.sdk.taskSpaces.includes("requestControl"));
  // A schema default change must alter both the summary and detailed parameter table.
  const changed = structuredClone(contract);
  changed.mcp.full.find((tool) => tool.name === "ego_snapshot").inputSchema.properties.scope.default = "full_page";
  assert.notEqual(renderAutomationDocs(changed), renderAutomationDocs(contract));
});
