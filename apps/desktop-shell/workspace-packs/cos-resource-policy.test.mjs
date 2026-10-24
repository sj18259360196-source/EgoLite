import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function functionSource(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
function setup() {
  const slept = [];
  const tabs = ["protected", "ordinary"].map(targetId => ({
    targetId, url: "https://example.com", lastActiveAt: new Date(0).toISOString(),
    ...(targetId === "protected" ? { autoDiscardable: false } : {}),
  }));
  const context = vm.createContext({
    autoSleepRunning: false, resourceManagementRunning: false,
    state: { tabs, backend: { kind: "desktop" } },
    tabBehaviorPreferences: { autoSleepMinutes: 15, resourcePolicy: "balanced" },
    tabActivityTimes: new Map(), currentTab: null, mediaPlayingTargets: new Set(),
    isStartPageUrl: () => false, isNeverSleepUrl: () => false,
    tabHasEditedForm: async () => false,
    setTabSleeping: async tab => slept.push(tab.targetId),
    updateTabBehaviorStatus: () => {}, renderResourceSnapshot: () => {}, formatBytes: String,
    $: () => ({}),
    RESOURCE_POLICIES: { balanced: { thresholdBytes: 100, targetBytes: 10, minimumIdleMinutes: 1 } },
    refreshResourceSnapshot: async () => ({ totalWorkingSetBytes: 1000, tabs: tabs.map(tab => ({ ...tab, estimatedBytes: 100 })) }),
  });
  vm.runInContext(functionSource("async function runAutoSleep(", "\nconst RESOURCE_POLICIES"), context);
  vm.runInContext(functionSource("async function runAdaptiveResourceManagement(", "\nasync function tabHasEditedForm"), context);
  return { context, slept };
}

test("idle sleep leaves CoS-protected tabs running while sleeping ordinary tabs", async () => {
  const { context, slept } = setup();
  await context.runAutoSleep();
  assert.deepEqual(slept, ["ordinary"]);
  assert.equal(context.autoSleepRunning, false);
});

test("memory pressure and explicit memory release respect CoS tab protection", async () => {
  for (const force of [false, true]) {
    const { context, slept } = setup();
    await context.runAdaptiveResourceManagement({ force });
    assert.deepEqual(slept, ["ordinary"]);
    assert.equal(context.resourceManagementRunning, false);
  }
});
