import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { AutomationRunner, decisionQuestions, directAction } from "./runner.ts";
import { runSchema, extractSchema, checkSchema } from "./schema.ts";
import { controlStateExpression, parseCandidates, verificationExpression } from "./page-data.ts";

function fixture() {
  let complete = false;
  let selected = "tab";
  let snapshot = '- button "Continue" [@ref-1]\n- textbox "Query" [@ref-2]';
  const actions: string[] = [];
  const events: string[] = [];
  let decide = async (): Promise<unknown> => ({
    model: "jev-1.13.0", usage: { input_tokens: 400, output_tokens: 0 }, elapsedMs: 10, attempts: 1, unknownUsageAttempts: 0,
    answers: {
      operation: { choice: "click", confidence: 0.99, probabilities: { click: 0.99, none: 0.01 } },
      click_target: { choice: "e1", confidence: 0.99, probabilities: { e1: 0.99, none: 0.01 } },
    },
  });
  const page = {
    snapshot: async () => snapshot,
    info: async () => ({ url: "https://example.com/path", scrollY: 0 }),
    evaluate: async (_expression: string): Promise<unknown> => [{ kind: "visible", passed: complete }],
    locator: (target: string) => ({
      count: async (): Promise<number> => target === "#missing" ? 0 : 1,
      textContent: async () => target === "#delete" ? "Delete" : "Continue",
      click: async () => { actions.push(`click:${target}`); complete = true; },
      fill: async (value: string) => { actions.push(`fill:${target}:${value}`); complete = true; },
      selectOption: async (value: string) => { actions.push(`select:${target}:${value}`); complete = true; },
      isVisible: async () => false,
      isEnabled: async () => true,
    }),
    mouse: { wheel: async () => { actions.push("scroll"); } },
  };
  const session = {
    sdk: { page, browser: { currentTab: async () => ({ targetId: selected, url: "https://example.com/path" }) } },
    automationRequest: async (operation: string) => {
      events.push(operation);
      if (operation === "begin") return { timeoutMs: 45000, config: { maxActions: 24, maxDecisions: 18, candidateLimit: 80, maxNoProgress: 3 } };
      if (operation === "decide") return decide();
      return { active: true };
    },
    recordOperation: async () => {},
  };
  return { session: session as any, page, actions, events,
    setComplete: (value: boolean) => { complete = value; },
    setSelected: (value: string) => { selected = value; },
    setSnapshot: (value: string) => { snapshot = value; },
    setDecide: (value: typeof decide) => { decide = value; },
  };
}
const input = (extra = {}) => runSchema.parse({ goal: "Find the next screen", success: { all: [{ kind: "visible", target: "#done" }] }, ...extra });

const relevantInput = (extra = {}, relevance = {}) => extractSchema.parse({
  selector: "tr", fields: { title: { selector: "td" }, href: { selector: "a", attribute: "href" } },
  relevance: { query: "Browser automation", fields: ["title"], batchSize: 2, ...relevance }, ...extra,
});
function relevanceFixture() {
  const f = fixture();
  const rows = [{ title: "Browser automation", href: "/a" }, { title: "Cooking", href: "/b" }, { title: "Unclear", href: "/c" }];
  f.page.evaluate = async () => ({ rows, url: "https://example.com/path", title: "List", truncated: false });
  let count = 0;
  f.setDecide(async () => ({
    model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 0 }, attempts: 1, unknownUsageAttempts: 0,
    answers: count++ === 0 ? { r0: { type: "noul", noul: 0.95 }, r1: { type: "noul", noul: 0.05 } } : { r2: { type: "noul", noul: 0.5 } },
  }));
  return { ...f, rows };
}

test("extraction relevance batches judgments without changing collection coverage or actions", async () => {
  const f = relevanceFixture();
  const result = await new AutomationRunner().extract(f.session, relevantInput());
  assert.equal(result.complete, true);
  assert.equal(result.status, "done");
  assert.equal(result.relevance?.complete, true);
  assert.equal(result.metrics.decisions, 2);
  assert.deepEqual(result.rows, [f.rows[0], f.rows[2]]);
  assert.deepEqual(result.relevance?.rowIndices, [0, 2]);
  assert.equal(result.sources[0]?.rows, 3);
  assert.deepEqual(f.actions, []);
  const plain = relevanceFixture();
  const original = await new AutomationRunner().extract(plain.session, relevantInput({ relevance: undefined }));
  assert.deepEqual(original.rows, plain.rows);
  assert.equal(original.metrics.decisions, 0);
  assert.equal(original.relevance, undefined);
});

test("relevance decision and candidate budgets keep unevaluated rows", async () => {
  for (const limits of [{ maxDecisions: 1 }, { maxCandidates: 2 }]) {
    const f = relevanceFixture();
    const result = await new AutomationRunner().extract(f.session, relevantInput({}, limits));
    assert.equal(result.status, "needs_reasoning");
    assert.equal(result.reason, "relevance_partial");
    assert.equal(result.complete, true);
    assert.equal(result.relevance?.complete, false);
    assert.equal(result.metrics.decisions, 1);
    assert.deepEqual(result.rows, [f.rows[0], f.rows[2]]);
    assert.equal(result.relevance?.judgments[2]?.status, "unknown");
  }
});

test("provider failure preserves earlier classifications and all unresolved rows", async () => {
  const f = relevanceFixture();
  let calls = 0;
  f.setDecide(async () => {
    if (++calls > 1) throw Object.assign(new Error("PRIVATE_PROVIDER_MESSAGE"), { code: "AUTOMATION_NETWORK" });
    return { model: "jev", usage: { input_tokens: 10 }, attempts: 1, unknownUsageAttempts: 0,
      answers: { r0: { type: "noul", noul: 1 }, r1: { type: "noul", noul: 0 } } };
  });
  const result = await new AutomationRunner().extract(f.session, relevantInput());
  assert.equal(result.complete, false);
  assert.equal(result.reason, "AUTOMATION_NETWORK");
  assert.deepEqual(result.rows, [f.rows[0], f.rows[2]]);
  assert.equal(result.relevance?.judgments[2]?.reason, "request_unresolved");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_MESSAGE/);
});

test("cancelled or switched-page relevance responses cannot discard any rows", async () => {
  for (const changed of ["cancel", "tab", "url"]) {
    const f = relevanceFixture();
    const runner = new AutomationRunner();
    f.setDecide(async () => {
      if (changed === "cancel") runner.cancel();
      if (changed === "tab") f.setSelected("other");
      if (changed === "url") f.session.sdk.browser.currentTab = async () => ({ targetId: "tab", url: "https://other.example/" });
      return { model: "jev", usage: { input_tokens: 10 }, attempts: 1, unknownUsageAttempts: 0,
        answers: { r0: { type: "noul", noul: 0 }, r1: { type: "noul", noul: 0 } } };
    });
    const result = await runner.extract(f.session, relevantInput());
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.rows, f.rows);
    assert.equal(result.relevance?.unknownRows, 3);
  }
});

test("malformed relevance answers and consent denial never remove rows", async () => {
  for (const variant of ["malformed", "denied"]) {
    const f = relevanceFixture();
    f.setDecide(async () => {
      if (variant === "denied") throw Object.assign(new Error("Denied"), { code: "AUTOMATION_CONSENT" });
      return { model: "jev", usage: { input_tokens: 10 }, attempts: 1, unknownUsageAttempts: 0,
        answers: { r0: { type: "noul", noul: 0 } } };
    });
    const result = await new AutomationRunner().extract(f.session, relevantInput());
    assert.equal(result.verified, false);
    assert.deepEqual(result.rows, f.rows);
    assert.equal(result.metrics.decisions, 1);
  }
});

const repairInput = (extra = {}) => input({
  mode: "repair", steps: [{ action: "click", target: "#missing", targetHint: "Continue to the next screen" }], ...extra,
});
function repairFixture() {
  const f = fixture();
  f.setDecide(async () => ({
    model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 0 }, elapsedMs: 10, attempts: 1, unknownUsageAttempts: 0,
    answers: { repair_target: { choice: "e1", confidence: 0.99, probabilities: { e1: 0.99, none: 0.01 } } },
  }));
  return f;
}

test("repair executes an intact plan without model requests or open-ended reasoning", async () => {
  const f = repairFixture();
  const result = await new AutomationRunner().run(f.session, repairInput({
    steps: [{ action: "click", target: "#go", targetHint: "Continue" }],
  }));
  assert.equal(result.verified, true);
  assert.equal(result.metrics.decisions, 0);
  assert.deepEqual(f.actions, ["click:#go"]);
  const empty = repairFixture();
  const unresolved = await new AutomationRunner().run(empty.session, repairInput({ steps: [] }));
  assert.equal(unresolved.reason, "planned_steps_not_verified");
  assert.equal(unresolved.metrics.decisions, 0);
});

test("repair replaces one absent locator then continues the remaining explicit steps", async () => {
  const f = repairFixture();
  const result = await new AutomationRunner().run(f.session, repairInput({
    steps: [{ action: "click", target: "#missing", targetHint: "Advance to the next screen" }, { action: "fill", target: "#query", value: "data" }],
  }));
  assert.equal(result.verified, true);
  assert.deepEqual(f.actions, ["click:@ref-1", "fill:#query:data"]);
  assert.equal(result.metrics.repairAttempts, 1);
  assert.equal(result.metrics.repairedActions, 1);
  assert.equal(result.metrics.decisions, 1);
});

test("repair never retries after dispatched unknown results, timeout, or stale-ref errors", async () => {
  for (const error_code of ["EGO_ACTION_RESULT_UNKNOWN", "EGO_REFERENCE_STALE", "TIMEOUT"]) {
    const f = repairFixture();
    const original = f.page.locator;
    f.page.locator = target => ({ ...original(target), click: async () => {
      f.actions.push("dispatched");
      throw Object.assign(new Error("Action failed"), { error_code });
    } });
    const result = await new AutomationRunner().run(f.session, repairInput({
      steps: [{ action: "click", target: "#go", targetHint: "Continue" }],
    }));
    assert.equal(result.metrics.decisions, 0);
    assert.deepEqual(f.actions, ["dispatched"]);
    assert.equal(result.verified, false);
  }
});

test("repair refuses a nonunique original locator and read errors without model calls", async () => {
  for (const readError of [false, true]) {
    const f = repairFixture();
    const original = f.page.locator;
    f.page.locator = target => ({ ...original(target), count: async () => {
      if (readError) throw new Error("Invalid selector or read failure");
      return 2;
    } });
    const result = await new AutomationRunner().run(f.session, repairInput());
    assert.equal(result.verified, false);
    assert.equal(result.metrics.decisions, 0);
    assert.deepEqual(f.actions, []);
  }
});

test("repair ambiguity, unknown choices and duplicate labels do not expand or retry", async () => {
  for (const variant of ["low-confidence", "unknown", "duplicate"]) {
    const f = repairFixture();
    if (variant === "duplicate") f.setSnapshot('- button "Continue" [@a]\n- button "Continue" [@b]');
    else f.setDecide(async () => ({
      model: "jev-1.13.0", usage: { input_tokens: 100 }, attempts: 1, unknownUsageAttempts: 0,
      answers: { repair_target: { choice: variant === "unknown" ? "e999" : "e1", confidence: variant === "unknown" ? 1 : 0.7,
        probabilities: { e1: 0.7, none: 0.3 } } },
    }));
    const result = await new AutomationRunner().run(f.session, repairInput());
    assert.equal(result.reason, "repair_ambiguous_target");
    assert.equal(result.metrics.decisions, 1);
    assert.deepEqual(f.actions, []);
  }
});

test("repair rechecks page identity, original locator and control after the decision", async () => {
  for (const changed of ["page", "original", "selection"]) {
    const f = repairFixture();
    f.setDecide(async () => {
      if (changed === "page") f.setSnapshot('- button "Delete" [@ref-1]');
      if (changed === "selection") f.setSelected("other-tab");
      return { model: "jev-1.13.0", usage: { input_tokens: 100 }, attempts: 1, unknownUsageAttempts: 0,
        answers: { repair_target: { choice: "e1", confidence: 1, probabilities: { e1: 1 } } } };
    });
    if (changed === "original") {
      const original = f.page.locator;
      f.page.locator = target => ({ ...original(target), count: async () => f.events.includes("decide") ? 1 : 0 });
    }
    const result = await new AutomationRunner().run(f.session, repairInput());
    assert.equal(result.verified, false);
    assert.deepEqual(f.actions, []);
  }
});

test("repaired clicks retain consequential-action authorization", async () => {
  const f = repairFixture();
  f.setSnapshot('- button "Delete record" [@delete]');
  const result = await new AutomationRunner().run(f.session, repairInput({ steps: [{
    action: "click", target: "#missing", targetHint: "Remove the record",
  }] }));
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.metrics.repairedActions, 0);
  assert.deepEqual(f.actions, []);
});

test("repair preserves supplied data and never sends it in model inputs", async () => {
  const f = repairFixture();
  f.setSnapshot('- textbox "Name PRIVATE_VALUE OTHER_PRIVATE_VALUE" [@name]');
  const original = f.session.automationRequest;
  f.session.automationRequest = async (operation: string, payload: unknown) => {
    if (operation === "decide") assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_VALUE/);
    return original(operation, payload);
  };
  const result = await new AutomationRunner().run(f.session, repairInput({
    values: { _stepValue: "OTHER_PRIVATE_VALUE" },
    steps: [{ action: "fill", target: "#missing", targetHint: "Enter the name PRIVATE_VALUE", value: "PRIVATE_VALUE" }],
  }));
  assert.equal(result.verified, true);
  assert.deepEqual(f.actions, ["fill:@name:PRIVATE_VALUE"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VALUE/);
});

test("repair respects cancellation, origin restrictions and the decision budget", async () => {
  const cancelled = repairFixture();
  const runner = new AutomationRunner();
  cancelled.setDecide(async () => {
    runner.cancel();
    return { model: "jev-1.13.0", usage: { input_tokens: 100 }, attempts: 1, unknownUsageAttempts: 0,
      answers: { repair_target: { choice: "e1", confidence: 1, probabilities: { e1: 1 } } } };
  });
  assert.equal((await runner.run(cancelled.session, repairInput())).status, "cancelled");
  assert.deepEqual(cancelled.actions, []);
  const outside = repairFixture();
  assert.equal((await new AutomationRunner().run(outside.session, repairInput({ allowedOrigins: ["https://elsewhere.example"] }))).reason, "outside_allowed_origins");
  assert.equal(outside.events.includes("decide"), false);
  const limited = repairFixture();
  const result = await new AutomationRunner().run(limited.session, repairInput({
    steps: Array.from({ length: 2 }, () => ({ action: "click", target: "#missing", targetHint: "Advance to the next screen" })),
    budget: { maxDecisions: 1 },
  }));
  assert.equal(result.reason, "decision_budget");
  assert.equal(result.metrics.decisions, 1);
  assert.equal(limited.actions.length, 1);
});

test("an exact unique repair hint uses no model while duplicate labels stop locally", async () => {
  for (const duplicate of [false, true]) {
    const f = repairFixture();
    if (duplicate) f.setSnapshot('- button "Continue" [@a]\n- button "Continue" [@b]');
    const result = await new AutomationRunner().run(f.session, repairInput({
      steps: [{ action: "click", target: "#missing", targetHint: "Continue" }],
    }));
    assert.equal(result.verified, !duplicate);
    assert.equal(result.metrics.decisions, 0);
    assert.equal(result.metrics.repairedActions, duplicate ? 0 : 1);
    assert.equal(f.actions.length, duplicate ? 0 : 1);
  }
});

test("continuous executor batches explicit actions without model calls or exposing values", async () => {
  const f = fixture();
  const result = await new AutomationRunner().run(f.session, input({ steps: [{ action: "fill", target: "#query", valueKey: "query" }, { action: "click", target: "#go" }], values: { query: "private search" } }));
  assert.equal(result.status, "done");
  assert.equal(result.verified, true);
  assert.deepEqual(f.actions, ["fill:#query:private search", "click:#go"]);
  assert.equal(result.metrics.decisions, 0);
  assert.doesNotMatch(JSON.stringify(result), /private search/);
  assert.equal(f.events.at(-1), "end");
});

test("explicit task binding precedes native begin without guessing another session's selection", async () => {
  const f = fixture();
  f.session.sdk.taskSpaces = { list: async () => [{ id: 7, name: "Known task" }],
    useOrCreate: async (task: number) => { f.events.push(`select:${task}`); } };
  const result = await new AutomationRunner().run(f.session, input({ task: "Known task", steps: [{ action: "click", target: "#go" }] }));
  assert.equal(result.verified, true);
  assert.deepEqual(f.events.slice(0, 2), ["select:7", "begin"]);
});

test("task selection denial prevents continuous actions and native begin", async () => {
  const f = fixture();
  f.session.sdk.taskSpaces = { list: async () => [{ id: 7, name: "Other task" }],
    useOrCreate: async () => { throw Object.assign(new Error("Not the controller"), { error_code: "EGO_CONTROL_REQUIRED" }); } };
  const runner = new AutomationRunner();
  await assert.rejects(runner.run(f.session, input({ task: "Other task" })), /Not the controller/);
  assert.equal(runner.busy, false);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.actions, []);
});

test("a pending explicit selection reserves the runner before any second task can switch", async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.session.sdk.taskSpaces = { list: async () => [{ id: 1, name: "First" }, { id: 2, name: "Second" }],
    useOrCreate: async (task: number) => { f.events.push(`select:${task}`); await pending; } };
  const runner = new AutomationRunner();
  const first = runner.run(f.session, input({ task: "First", steps: [{ action: "click", target: "#go" }] }));
  await assert.rejects(runner.run(f.session, input({ task: "Second" })), /continuous task/);
  release();
  await first;
  assert.deepEqual(f.events.filter(event => event.startsWith("select:")), ["select:1"]);
});

test("extraction accepts an explicit task through the same permission-bound selection", async () => {
  const f = fixture();
  f.session.sdk.taskSpaces = { useOrCreate: async (task: number) => { f.events.push(`select:${task}`); } };
  f.page.evaluate = async () => ({ rows: [{ name: "One" }], url: "https://example.com", title: "One", truncated: false });
  const result = await new AutomationRunner().extract(f.session, extractSchema.parse({ task: 7, selector: "tr", fields: { name: { selector: "td" } } }));
  assert.equal(result.complete, true);
  assert.deepEqual(f.events.slice(0, 2), ["select:7", "begin"]);
});

test("explicit missing or ambiguous task names never create a task or begin a run", async () => {
  for (const spaces of [[], [{ id: 1, name: "Target" }, { id: 2, name: "Target" }]]) {
    const f = fixture();
    f.session.sdk.taskSpaces = { list: async () => spaces,
      useOrCreate: async () => assert.fail("Must not create or guess a task") };
    await assert.rejects(new AutomationRunner().run(f.session, input({ task: "Target" })), /missing or ambiguous/);
    assert.deepEqual(f.events, []);
  }
});

test("explicit actions cannot leave the caller's allowed origin", async () => {
  const f = fixture();
  const result = await new AutomationRunner().run(f.session, input({
    allowedOrigins: ["https://allowed.example"], steps: [{ action: "click", target: "#go" }],
  }));
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "outside_allowed_origins");
  assert.deepEqual(f.actions, []);
});

test("candidate questions redact supplied values from page labels", () => {
  const questions = decisionQuestions([{ id: "e1", role: "button", label: "Continue PRIVATE_FORM_VALUE", ref: "@ref" }], { query: "PRIVATE_FORM_VALUE" });
  assert.doesNotMatch(JSON.stringify(questions), /PRIVATE_FORM_VALUE/);
});

test("decision choices reference shared state and omit impossible or disabled actions", () => {
  const questions = decisionQuestions([
    { id: "e1", role: "button", label: "Continue", ref: "@a" },
    { id: "e2", role: "textbox", label: "Query PRIVATE_VALUE", ref: "@b", state: { disabled: false, editable: true } },
    { id: "e3", role: "button", label: "Next", ref: "@c", state: { disabled: true } },
  ], { query: "PRIVATE_VALUE" }, new Map(), true);
  assert.equal(Object.hasOwn(questions.operation.criteria, "fill"), true);
  assert.equal(Object.hasOwn(questions.operation.criteria, "select"), false);
  assert.equal(Object.hasOwn(questions.operation.criteria, "check"), false);
  assert.deepEqual(Object.keys(questions.click_target!.criteria), ["e1", "none"]);
  assert.equal(questions.click_target!.criteria.e1, 'button "Continue"');
  assert.match(questions.click_target!.instructions, /state.elements/);
  assert.match(questions.value_for_e2!.instructions, /Query/);
  assert.doesNotMatch(JSON.stringify(questions), /PRIVATE_VALUE/);
});

test("compact target questions preserve choices and independent field questions", () => {
  const candidates = [
    { id: "e1", role: "button", label: "Continue", ref: "@a" },
    { id: "e2", role: "checkbox", label: "Active", ref: "@b", state: { disabled: false, checked: false } },
    { id: "e3", role: "switch", label: "Archived", ref: "@c", state: { disabled: false, checked: true } },
    { id: "e4", role: "textbox", label: "Query", ref: "@d", state: { disabled: false, editable: true } },
  ];
  const compact = decisionQuestions(candidates, { query: "private" }, new Map(), true);
  const legacy = decisionQuestions(candidates, { query: "private" }, new Map(), false);
  assert.deepEqual(Object.keys(compact), Object.keys(legacy));
  for (const head of Object.keys(legacy)) {
    assert.deepEqual(Object.keys(compact[head]!.criteria), Object.keys(legacy[head]!.criteria));
    if (head.endsWith("_target")) {
      for (const id of Object.keys(compact[head]!.criteria)) {
        if (id === "none") assert.equal(compact[head]!.criteria[id], "No suitable element");
        else {
          const candidate = candidates.find(item => item.id === id)!;
          assert.equal(compact[head]!.criteria[id], `${candidate.role} ${JSON.stringify(candidate.label)}`);
          assert.doesNotMatch(compact[head]!.criteria[id]!, /checked|editable|disabled/);
        }
      }
    } else assert.deepEqual(compact[head], legacy[head]);
  }
  assert.ok(JSON.stringify(compact).length < JSON.stringify(legacy).length);
});

test("small observations retain full descriptions; large ones omit repeated state", () => {
  const candidates = Array.from({ length: 40 }, (_, i) => ({
    id: `e${i + 1}`, ref: `@${i + 1}`, role: "button", label: `Item ${i + 1}`, state: { disabled: false },
  }));
  assert.match(decisionQuestions(candidates.slice(0, 39), {}).click_target!.criteria.e1!, /current state/);
  assert.equal(decisionQuestions(candidates, {}).click_target!.criteria.e1, 'button "Item 1"');
});

test("runner sends redacted labels with compact questions for large observations", async () => {
  const f = fixture();
  f.setSnapshot(['- button "Continue PRIVATE_VALUE" [@ref-1]',
    ...Array.from({ length: 39 }, (_, i) => `- button "Other ${i}" [@other-${i}]`)].join("\n"));
  const original = f.session.automationRequest;
  f.session.automationRequest = async (operation: string, payload: any) => {
    if (operation === "decide") {
      assert.equal(payload.input.questions.click_target.criteria.e1, 'button "Continue [provided value]"');
      assert.equal(payload.input.state.elements[0].label, "Continue [provided value]");
      assert.doesNotMatch(JSON.stringify(payload.input), /PRIVATE_VALUE/);
    }
    return original(operation, payload);
  };
  const result = await new AutomationRunner().run(f.session, input({ values: { query: "PRIVATE_VALUE" } }));
  assert.equal(result.verified, true);
});

test("completed fields leave the action choices only for an exact confirmed scoped binding", () => {
  const candidate = { id: "e1", role: "combobox", label: "Category", ref: "@category",
    state: { disabled: false, editable: false, selectable: true, matchingValueKeys: ["category"] } };
  const bindings = new Map([["@category", { role: "combobox", label: "Category", valueKey: "category" }]]);
  assert.equal(Object.hasOwn(decisionQuestions([candidate], { category: "books" }, bindings).operation.criteria, "select"), false);
  assert.equal(Object.hasOwn(decisionQuestions([{ ...candidate, ref: "@replacement" }], { category: "books" }, bindings).operation.criteria, "select"), true);
  assert.equal(Object.hasOwn(decisionQuestions([{ ...candidate, label: "Other category" }], { category: "books" }, bindings).operation.criteria, "select"), true);
});

test("form state exposes only presence and matching keys, not values", () => {
  const node = { tagName: "INPUT", type: "text", value: "PRIVATE_FORM_VALUE", disabled: false,
    labels: [], getAttribute: (name: string) => name === "aria-label" ? "Query" : null, hasAttribute: () => false };
  const state = runInNewContext(controlStateExpression({ query: "PRIVATE_FORM_VALUE" }), {
    document: { querySelectorAll: () => [node], getElementById: () => null },
  });
  assert.equal(state[0].filled, true);
  assert.deepEqual(Array.from(state[0].matchingValueKeys), ["query"]);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_FORM_VALUE/);
});

test("goal-only executor uses a bounded Jev decision and verifies independently", async () => {
  const f = fixture();
  const result = await new AutomationRunner().run(f.session, input());
  assert.equal(result.status, "done");
  assert.equal(result.metrics.decisions, 1);
  assert.equal(result.metrics.inputTokens, 400);
  assert.deepEqual(f.actions, ["click:@ref-1"]);
});

test("field-specific decisions cannot pair a city field with a global name choice", async () => {
  const f = fixture();
  f.setSnapshot('- textbox "City" [@city]\n- textbox "Name" [@name]');
  f.setDecide(async () => ({
    model: "jev-1.13.0", usage: { input_tokens: 100 }, attempts: 1, unknownUsageAttempts: 0,
    answers: {
      operation: { choice: "fill", confidence: 1, probabilities: { fill: 1 } },
      value_for_e1: { choice: "city", confidence: 1, probabilities: { city: 1 } },
      value_for_e2: { choice: "name", confidence: 1, probabilities: { name: 1 } },
    },
  }));
  const result = await new AutomationRunner().run(f.session, input({ values: { name: "Alice", city: "Shanghai" } }));
  assert.equal(result.status, "done");
  assert.deepEqual(f.actions, ["fill:@city:Shanghai"]);
  assert.doesNotMatch(JSON.stringify(result.decisions), /Shanghai|Alice/);
  assert.equal(result.decisions.find(item => item.head === "value_for_e1")?.choice, "provided_value");
});

test("equivalent independent setters can proceed without weakening navigation confidence", async () => {
  for (const [order, clickProbability, expected] of [["independent", 0.02, "done"], ["ordered", 0.02, "needs_reasoning"], ["independent", 0.48, "needs_reasoning"]] as const) {
    const f = fixture();
    f.setSnapshot('- combobox "Category" [@category]\n- checkbox "Active only" [@active]');
    f.setDecide(async () => ({
      model: "jev-1.13.0", usage: { input_tokens: 100 }, attempts: 1, unknownUsageAttempts: 0,
      answers: {
        operation: { choice: "select", confidence: 0.4, probabilities: { select: 0.49, check: 0.51 - clickProbability, click: clickProbability } },
        configuration_order: { choice: order, confidence: 1, probabilities: { [order]: 1 } },
        value_for_e1: { choice: "category", confidence: 1, probabilities: { category: 1 } },
      },
    }));
    const result = await new AutomationRunner().run(f.session, input({ values: { category: "books" } }));
    assert.equal(result.status, expected);
    assert.equal(f.actions.length, expected === "done" ? 1 : 0);
    if (expected === "done") {
      assert.deepEqual(f.actions, ["select:@category:books"]);
      assert.equal(result.decisions[0]!.resolution, "independent_input_settings");
      assert.equal(result.decisions[0]!.confidence, 0.4);
    }
  }
});

test("model DONE cannot replace an unsatisfied completion condition", async () => {
  const f = fixture();
  f.setDecide(async () => ({
    model: "jev-1.13.0", usage: { input_tokens: 1 }, attempts: 1, unknownUsageAttempts: 0,
    answers: { operation: { choice: "done", confidence: 1, probabilities: { done: 1 } } },
  }));
  const result = await new AutomationRunner().run(f.session, input());
  assert.equal(result.status, "needs_reasoning");
  assert.equal(result.verified, false);
  assert.deepEqual(f.actions, []);
});

test("ambiguous decisions retain numerical evidence without page text or supplied values", async () => {
  const f = fixture();
  f.setDecide(async () => ({
    model: "jev-1.13.0", usage: { input_tokens: 100 }, attempts: 1, unknownUsageAttempts: 0,
    answers: {
      operation: { choice: "fill", confidence: 0.9, probabilities: { fill: 0.52, click: 0.48 } },
      value_for_e2: { choice: "PRIVATE_KEY", confidence: 0.6, probabilities: { PRIVATE_KEY: 0.9, none: 0.1 } },
    },
  }));
  const result = await new AutomationRunner().run(f.session, input({ values: { PRIVATE_KEY: "PRIVATE_VALUE" } }));
  assert.equal(result.reason, "ambiguous_operation");
  assert.equal(result.decisions.length, 4);
  assert.equal(result.decisions[0]!.confidence, 0.9);
  assert.ok(Math.abs(result.decisions[0]!.gap - 0.04) < 0.00001);
  assert.equal(result.decisions[0]!.accepted, false);
  assert.equal(result.decisions[1]!.accepted, false);
  assert.doesNotMatch(JSON.stringify(result.decisions), /PRIVATE_|Continue|Query/);
  assert.deepEqual(f.actions, []);
});

test("cancelling while Jev is in flight cannot dispatch its late action", async () => {
  const f = fixture();
  const runner = new AutomationRunner();
  f.setDecide(async () => {
    runner.cancel();
    return { model: "jev-1.13.0", usage: { input_tokens: 1 }, attempts: 1, unknownUsageAttempts: 0, answers: {} };
  });
  const result = await runner.run(f.session, input());
  assert.equal(result.status, "cancelled");
  assert.deepEqual(f.actions, []);
});

test("page switching during a decision cannot redirect a continuous task", async () => {
  const f = fixture();
  f.setDecide(async () => {
    f.setSelected("another-tab");
    return { model: "jev-1.13.0", usage: { input_tokens: 1 }, attempts: 1, unknownUsageAttempts: 0, answers: {} };
  });
  const result = await new AutomationRunner().run(f.session, input());
  assert.equal(result.status, "cancelled");
  assert.deepEqual(f.actions, []);
});

test("new candidate order after a decision causes re-observation, never an old click", async () => {
  const f = fixture();
  f.setDecide(async () => {
    f.setSnapshot('- button "Delete" [@new-1]');
    return {
      model: "jev-1.13.0", usage: { input_tokens: 1 }, attempts: 1, unknownUsageAttempts: 0,
      answers: {
        operation: { choice: "click", confidence: 1, probabilities: { click: 1 } },
        click_target: { choice: "e1", confidence: 1, probabilities: { e1: 1 } },
      },
    };
  });
  const result = await new AutomationRunner().run(f.session, input({ budget: { maxDecisions: 1 } }));
  assert.equal(result.status, "budget_exhausted");
  assert.deepEqual(f.actions, []);
});

test("consequential actions require explicit user authorization passed by Codex", async () => {
  const f = fixture();
  const result = await new AutomationRunner().run(f.session, input({ steps: [{ action: "click", target: "#delete" }] }));
  assert.equal(result.status, "needs_confirmation");
  assert.deepEqual(f.actions, []);
  const permitted = await new AutomationRunner().run(f.session, input({ steps: [{ action: "click", target: "#delete" }], authorizedActions: ["delete"] }));
  assert.equal(permitted.status, "done");
});

test("unknown action outcomes stop the loop without replay", async () => {
  const f = fixture();
  f.page.locator = () => ({
    textContent: async () => "Continue",
    click: async () => { f.actions.push("dispatch"); throw Object.assign(new Error("secret"), { error_code: "EGO_ACTION_RESULT_UNKNOWN" }); },
  } as any);
  const result = await new AutomationRunner().run(f.session, input({ steps: [{ action: "click", target: "#go" }] }));
  assert.equal(result.status, "action_result_unknown");
  assert.deepEqual(f.actions, ["dispatch"]);
});

test("extraction returns coverage and does not mistake row truncation for completeness", async () => {
  const f = fixture();
  f.page.evaluate = async () => ({ rows: [{ name: "A" }], url: "https://example.com/list", title: "List", truncated: true });
  const result = await new AutomationRunner().extract(f.session, extractSchema.parse({ selector: "tr", fields: { name: { selector: "td" } }, maxRows: 1 }));
  assert.equal(result.complete, false);
  assert.equal(result.reason, "row_limit");
  assert.equal(result.rows.length, 1);
  assert.equal(result.sources[0]?.url, "https://example.com/list");
});

test("candidate parsing excludes raw snapshots and generates only observed closed choices", () => {
  const candidates = parseCandidates('- button "Search" [@s_1] loc="#go"\n- StaticText "private input" [@s_2]');
  assert.deepEqual(candidates, [{ id: "e1", role: "button", label: "Search", ref: "@s_1" }]);
  const questions = decisionQuestions(candidates, { query: "SECRET" });
  assert.doesNotMatch(JSON.stringify(questions), /SECRET|@s_1|private input/);
  assert.deepEqual(directAction("Click Search", candidates, {}), { action: "click", target: "@s_1" });
  assert.equal(directAction("Click Search", [...candidates, { ...candidates[0]!, id: "e2" }], {}), undefined);
  const field = [{ id: "e1", role: "textbox", label: "Query", ref: "@q" }];
  assert.deepEqual(directAction("Fill Query", field, { query: "value" }), { action: "fill", target: "@q", valueKey: "query" });
  assert.equal(directAction("Fill Query and continue", field, { query: "value" }), undefined);
});

test("completion checks reject vacuous conditions and use real DOM values", () => {
  assert.throws(() => checkSchema.parse({ kind: "url_contains", value: "" }));
  assert.throws(() => checkSchema.parse({ kind: "visible", target: "@1" }));
  assert.throws(() => checkSchema.parse({ kind: "count_equals", target: "tr", value: "3" }));
  assert.throws(() => checkSchema.parse({ kind: "checked", target: "#toggle", value: "false" }));
  const element = { value: "bug", getBoundingClientRect: () => ({ width: 10, height: 10 }), getAttribute: () => "label" };
  const evidence = runInNewContext(verificationExpression([{ kind: "value_equals", target: "#label", value: "bug" }]), {
    document: { querySelectorAll: () => [element] }, getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  });
  assert.equal(evidence[0].passed, true);
});
