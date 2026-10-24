import assert from "node:assert/strict";
import { EgoMcpSession } from "../apps/ego-mcp-server/src/ego-session.ts";
import { AutomationRunner } from "../apps/ego-mcp-server/src/automation/runner.ts";
import { runSchema } from "../apps/ego-mcp-server/src/automation/schema.ts";

// Compare machine overhead against an already-composed SDK workflow, not a
// deliberately slow one-tool-per-turn baseline. No model latency is simulated.
export async function benchmarkAutomation(pipe, url, repeats = 12) {
  const session = await EgoMcpSession.connect(pipe, { autoStartDesktop: false });
  const samples = { sdk: [], executor: [] };
  const value = "benchmark-query";
  const checks = { all: [{ kind: "visible", target: "#done" }, { kind: "value_equals", target: "#query", value }] };
  const input = runSchema.parse({
    goal: "Fill query and continue", values: { query: value }, mode: "direct", success: checks,
    steps: [{ action: "fill", target: "#query", valueKey: "query" }, { action: "click", target: "#continue" }],
  });
  try {
    await session.sdk.taskSpaces.useOrCreate("Automation overhead benchmark");
    await session.sdk.browser.openOrReuseTab(url, { wait: true });
    for (let index = -2; index < repeats; index++) {
      for (const arm of index % 2 === 0 ? ["sdk", "executor"] : ["executor", "sdk"]) {
        await session.sdk.page.reload({ waitUntil: "load" });
        const started = performance.now();
        if (arm === "sdk") {
          await session.sdk.page.locator("#query").fill(value);
          await session.sdk.page.locator("#continue").click();
          assert.equal(await session.sdk.page.evaluate(`document.querySelector("#query").value === ${JSON.stringify(value)} && !document.querySelector("#done").hidden`), true);
        } else {
          const result = await new AutomationRunner().run(session, input);
          assert.equal(result.verified, true, JSON.stringify(result));
          assert.equal(result.metrics.decisions, 0);
        }
        if (index >= 0) samples[arm].push(performance.now() - started);
      }
    }
    const summarize = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { medianMs: Math.round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2),
        minMs: Math.round(sorted[0]), maxMs: Math.round(sorted.at(-1)), samplesMs: values.map(value => Math.round(value)) };
    };
    const sdk = summarize(samples.sdk);
    const executor = summarize(samples.executor);
    return {
      repeats, warmupsPerArm: 2, providerRequests: 0, sdk, executor,
      executorOverheadMs: executor.medianMs - sdk.medianMs,
      scope: "Local two-action fixture. Both variants are composed workflows. No Codex inference, network-model latency or real-website speedup is measured.",
    };
  } finally { await session.close(); }
}
