import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { EgoMcpSession } from "../apps/ego-mcp-server/src/ego-session.ts";
import { AutomationRunner } from "../apps/ego-mcp-server/src/automation/runner.ts";
import { runSchema } from "../apps/ego-mcp-server/src/automation/schema.ts";
import { automationCorpus } from "./automation-corpus.mjs";

export async function benchmarkRepair(pipe, baseUrl, { checkpoint = () => {} } = {}) {
  const report = {
    scope: "Local synthetic English/Chinese forms with real Jev. Browser execution only, not Codex end-to-end or public-site acceptance.",
    repeats: 3, samples: [], summaries: {}, passed: false,
    sourceHashes: Object.fromEntries(["./automation-repair-benchmark.mjs", "./automation-corpus.mjs",
      "../apps/ego-mcp-server/src/automation/runner.ts", "../apps/ego-mcp-server/src/automation/schema.ts",
      "../apps/desktop-shell/automation-decision-service.mjs", "../vendor/ego-browser/src/driver/pointer.js"].map(path => [
      path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex"),
    ])),
  };
  const session = await EgoMcpSession.connect(pipe, { autoStartDesktop: false });
  try {
    await session.sdk.taskSpaces.useOrCreate(`Repair benchmark ${randomUUID()}`);
    await session.sdk.browser.openOrReuseTab(baseUrl, { wait: true });
    const tasks = automationCorpus().filter(task => ["en-form-1", "zh-form-1"].includes(task.id));
    const arms = ["direct-intact", "auto-intact", "repair-intact", "auto-drift", "repair-drift", "exact-drift"];
    for (let repeat = 0; repeat < report.repeats; repeat++) {
      for (const [taskIndex, task] of tasks.entries()) {
        const offset = (repeat + taskIndex) % arms.length;
        for (const arm of [...arms.slice(offset), ...arms.slice(0, offset)]) {
          const sample = { task: task.id, repeat, arm, success: false, falseCompletion: false };
          try {
            await session.sdk.page.goto(new URL(`/corpus/${task.id}`, baseUrl).href, { waitUntil: "load" });
            if (arm.endsWith("-drift")) await session.sdk.page.evaluate('document.querySelector("#continue").id = "continue-v2"; true');
            const mode = arm.startsWith("exact") ? "repair" : arm.split("-")[0];
            const input = runSchema.parse({
              goal: task.goal, values: task.values, success: task.success, mode,
              steps: mode === "auto" ? [] : task.steps.map(step => ({
                ...step,
                ...(mode === "repair" ? { targetHint: step.action === "click"
                  ? arm.startsWith("exact") ? task.locale === "zh" ? "\u7ee7\u7eed" : "Continue"
                    : task.locale === "zh" ? "\u586b\u5199\u5b8c\u6210\u540e\u8fdb\u5165\u4e0b\u4e00\u6b65" : "Advance to the next step after filling the form"
                  : step.valueKey === "name" ? "Name" : "City" } : {}),
              })),
            });
            const started = performance.now();
            sample.windowBefore = await session.sdk.page.evaluate('({focused:document.hasFocus(),visibility:document.visibilityState})');
            sample.result = await new AutomationRunner().run(session, input);
            sample.elapsedMs = performance.now() - started;
            sample.actual = await session.sdk.page.evaluate(task.inspect);
            sample.windowAfter = await session.sdk.page.evaluate('({focused:document.hasFocus(),visibility:document.visibilityState,events:window.__automationEvents})');
            let correct = false;
            try { assert.deepEqual(sample.actual, task.expected); correct = true; } catch {}
            sample.falseCompletion = sample.result.verified && !correct;
            const expectedRequests = arm === "repair-drift" ? 1 : ["repair-intact", "direct-intact", "exact-drift"].includes(arm) ? 0 : undefined;
            sample.success = sample.result.verified && correct && (expectedRequests === undefined
              ? sample.result.metrics.requestAttempts > 0
              : sample.result.metrics.decisions === expectedRequests);
          } catch (error) { sample.error = { name: error.name, message: error.message }; }
          report.samples.push(sample);
          checkpoint(report);
        }
      }
    }
    for (const arm of arms) {
      const samples = report.samples.filter(sample => sample.arm === arm);
      const times = samples.map(sample => sample.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b);
      report.summaries[arm] = {
        attempts: samples.length, successes: samples.filter(sample => sample.success).length,
        falseCompletions: samples.filter(sample => sample.falseCompletion).length,
        medianMs: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null,
        requests: samples.reduce((sum, sample) => sum + (sample.result?.metrics.requestAttempts || 0), 0),
        inputTokens: samples.reduce((sum, sample) => sum + (sample.result?.metrics.inputTokens || 0), 0),
      };
    }
    report.passed = report.samples.length === 36 && report.samples.every(sample => sample.success && !sample.falseCompletion);
    checkpoint(report);
    return report;
  } finally { await session.close(); }
}
