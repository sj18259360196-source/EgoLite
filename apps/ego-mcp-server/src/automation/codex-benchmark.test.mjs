import assert from "node:assert/strict";
import test from "node:test";
import { assessCodexBenchmark, benchmarkClientId, benchmarkPrompt, parseSdkAutomationMetrics, summarizeCodexSamples } from "../../../../tools/automation-codex-benchmark.mjs";
import { automationCorpus } from "../../../../tools/automation-corpus.mjs";

test("benchmark uses an isolated Codex identity compatible with concurrent MCP and SDK", () => {
  assert.match(benchmarkClientId("trial-a"), /^codex-[a-f0-9]{24}$/);
  assert.equal(benchmarkClientId("trial-a"), benchmarkClientId("trial-a"));
  assert.notEqual(benchmarkClientId("trial-a"), benchmarkClientId("trial-b"));
});

test("Codex benchmark baseline permits composed SDK without disclosing fixture implementation", () => {
  const task = { goal: "Fill the name", values: { name: "Synthetic" }, steps: [{ secretFixtureStep: true }],
    body: "SECRET_FIXTURE_SOURCE", expected: "SECRET_EXPECTED",
    success: { all: [{ kind: "visible", target: "#done" }] } };
  const prompt = benchmarkPrompt(task, "sdk", "http://127.0.0.1:1234/", "test");
  assert.match(prompt, /Prefer one composed SDK script/);
  assert.match(prompt, /ego_run and ego_extract are disabled/);
  assert.doesNotMatch(prompt, /SECRET_|secretFixtureStep/);
  assert.match(benchmarkPrompt(task, "auto", "http://127.0.0.1/", "test"), /Supply explicit steps when you already know them/);
  assert.match(benchmarkPrompt(task, "direct", "http://127.0.0.1/", "test"), /Jev must not be called/);
  assert.match(benchmarkPrompt(task, "repair", "http://127.0.0.1/", "test"), /mode repair/);
  assert.doesNotMatch(benchmarkPrompt(task, "repair", "http://127.0.0.1/", "test"), /SECRET_|secretFixtureStep/);
});

test("Codex benchmark summaries retain failed timing and unknown usage", () => {
  const result = summarizeCodexSamples([
    { success: true, elapsedMs: 100, toolCalls: 1, toolBatches: 1, usage: { input_tokens: 20, output_tokens: 5 } },
    { success: false, falseCompletion: true, elapsedMs: 500, toolCalls: 3, toolBatches: 2, jevRequests: 2, jevInputTokens: 40 },
  ]);
  assert.equal(result.attempts, 2);
  assert.equal(result.successes, 1);
  assert.equal(result.falseCompletions, 1);
  assert.equal(result.medianMs, 300);
  assert.equal(result.p95Ms, 500);
  assert.equal(result.toolCalls, 4);
  assert.equal(result.missingCodexUsage, 1);
  assert.equal(result.codexInputTokens, 20);
  assert.equal(result.jevRequests, 2);
});

test("Codex benchmark parses only explicit SDK diagnostic records", () => {
  const output = 'warning\nEGO_AUTOMATION_RESULT {"runId":"one","metrics":{"requestAttempts":2}}\n{"metrics":{"requestAttempts":999}}\nEGO_AUTOMATION_RESULT invalid\n';
  assert.deepEqual(parseSdkAutomationMetrics(output), [{ runId: "one", metrics: { requestAttempts: 2 } }]);
});

test("pilot success never substitutes for the full performance acceptance matrix", () => {
  const samples = ["sdk", "direct", "auto"].map(arm => ({
    task: "en-menu-1", repeat: 0, arm, success: true, elapsedMs: arm === "auto" ? 50 : 100,
    toolCalls: arm === "auto" ? 1 : 4, toolBatches: arm === "auto" ? 1 : 4, usage: { input_tokens: 10 },
  }));
  const assessment = assessCodexBenchmark({ pilot: true, repeats: 1, samples });
  assert.equal(assessment.performanceTargetsMet, true);
  assert.equal(assessment.fullCoverage, false);
  assert.equal(assessment.releaseBenchmarkPassed, false);
  assert.equal(assessCodexBenchmark({ pilot: false, repeats: 3, samples: [] }).releaseBenchmarkPassed, false);
});

test("full acceptance requires coverage, reliability, real usage and both speed targets", () => {
  const samples = automationCorpus().flatMap(task => Array.from({ length: 3 }, (_, repeat) =>
    ["sdk", "direct", "auto"].map(arm => ({
      task: task.id, repeat, arm, success: true, falseCompletion: false,
      elapsedMs: arm === "auto" ? 50 : 100, toolCalls: arm === "auto" ? 1 : 4,
      toolBatches: arm === "auto" ? 1 : 4, usage: { input_tokens: 10 },
    }))).flat());
  const report = { pilot: false, repeats: 3, samples };
  assert.equal(assessCodexBenchmark(report).releaseBenchmarkPassed, true);
  samples[0].falseCompletion = true;
  assert.equal(assessCodexBenchmark(report).releaseBenchmarkPassed, false);
  samples[0].falseCompletion = false;
  samples.find(sample => sample.arm === "auto").success = false;
  assert.equal(assessCodexBenchmark(report).releaseBenchmarkPassed, false);
});
