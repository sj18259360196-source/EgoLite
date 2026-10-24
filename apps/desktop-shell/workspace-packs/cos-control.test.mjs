import test from "node:test";
import assert from "node:assert/strict";
import { assertCosRecoveryControl } from "./cos-workspace.mjs";

test("CoS restart may reclaim its inactive workspace or its own active lease", () => {
  assert.doesNotThrow(() => assertCosRecoveryControl({ ownership: "user", lifecycle: "inactive" }, "agent", "desktop-current"));
  assert.doesNotThrow(() => assertCosRecoveryControl({ ownership: "agent", lastAgentClientId: "desktop-current" }, "collaborative", "desktop-current"));
});

test("CoS recovery respects manual mode, explicit stop, user takeover and another writer", () => {
  for (const [space, mode] of [
    [undefined, "agent"],
    [{ ownership: "user" }, "manual"],
    [{ ownership: "user", agentBlocked: true }, "agent"],
    [{ ownership: "agentDelegatedToUser" }, "collaborative"],
    [{ ownership: "agent", lastAgentClientId: "other-agent" }, "collaborative"],
  ]) {
    assert.throws(() => assertCosRecoveryControl(space, mode, "desktop-current"), /stopped by user control|another agent/);
  }
});

test("CoS autonomous recovery does not compete with another Agent", () => {
  assert.doesNotThrow(() => assertCosRecoveryControl({ ownership: "agent", lastAgentClientId: "other-agent" }, "agent", "desktop-current"));
});
