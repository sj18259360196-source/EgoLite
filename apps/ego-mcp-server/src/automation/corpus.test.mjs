import assert from "node:assert/strict";
import test from "node:test";
import { automationCorpus, corpusPage, summarizeSamples } from "../../../../tools/automation-corpus.mjs";
import { runSchema, extractSchema } from "./schema.ts";

test("corpus covers 24 distinct resettable bilingual browser tasks with valid inputs", () => {
  const tasks = automationCorpus();
  assert.equal(tasks.length, 24);
  assert.equal(new Set(tasks.map(task => task.id)).size, 24);
  for (const locale of ["en", "zh"]) {
    for (const kind of ["menu", "form", "filter", "pagination"]) {
      assert.equal(tasks.filter(task => task.locale === locale && task.kind === kind).length, 3);
    }
  }
  for (const task of tasks) {
    assert.ok(corpusPage(`/corpus/${task.id}`)?.includes('<meta charset="utf-8">'));
    if (task.extract) extractSchema.parse(task.extract);
    else runSchema.parse({ goal: task.goal, values: task.values, steps: task.steps, success: task.success });
  }
  assert.equal(corpusPage("/corpus/missing"), undefined);
});

test("benchmark summaries retain failures and separate missing timings from zero", () => {
  const summary = summarizeSamples([
    { elapsedMs: 100, success: true },
    { elapsedMs: 500, success: false, falseCompletion: true },
    { elapsedMs: null, success: false },
  ]);
  assert.equal(summary.attempts, 3);
  assert.equal(summary.failures, 2);
  assert.equal(summary.falseCompletions, 1);
  assert.equal(summary.medianMs, 300);
  assert.equal(summary.p95Ms, 500);
  assert.equal(summarizeSamples([]).medianMs, null);
});
