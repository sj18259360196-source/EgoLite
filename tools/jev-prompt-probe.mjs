import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluateJev } from "../apps/desktop-shell/automation-decision-service.mjs";
import { decisionQuestions } from "../apps/ego-mcp-server/src/automation/runner.ts";

const key = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
if (!key) throw new Error("Use test-jev-live.ps1 -UseSavedOnly -Probe");
const output = resolve(import.meta.dirname, "../output/jev-prompt-probe");
mkdirSync(output, { recursive: true });
const results = [];
for (const goal of ["Fill supplied query and continue", "Proceed to the completed screen", "\u586b\u5165\u63d0\u4f9b\u7684\u67e5\u8be2\u5185\u5bb9\u5e76\u7ee7\u7eed"]) {
  const elements = [
    { id: "e1", role: "button", label: "Continue", ref: "@1", state: { disabled: false } },
    { id: "e2", role: "button", label: "Next", ref: "@2", state: { disabled: false } },
    { id: "e3", role: "textbox", label: "Query", ref: "@3", state: { disabled: false, editable: true, filled: false, matchingValueKeys: [] } },
  ];
  const state = { goal, elements: elements.map(({ ref, ...rest }) => rest), valueKeys: ["query"], recentActions: [], completion: [{ kind: "visible", passed: false }, { kind: "value_equals", passed: false }] };
  const current = decisionQuestions(elements, { query: "synthetic" });
  const questions = {
    current_value: current.value_for_e3,
    short_value: { type: "choice", instructions: 'Which supplied key in `valueKeys` matches the field label "Query"?', criteria: { query: "Query", none: "No matching key" } },
    literal_value: { type: "choice", instructions: 'Match the field label "Query" to the supplied value name. Which option has the same meaning?', criteria: { query: "query", none: "No match" } },
    current_click: current.click_target,
    short_click: { type: "choice", instructions: "Which button best matches the click requested in `goal`?", criteria: { e1: "Continue", e2: "Next", none: "No matching button" } },
    current_operation: current.operation,
  };
  for (let repeat = 0; repeat < 3; repeat++) {
    results.push({ goal, repeat, response: await evaluateJev({ state, questions }, { key }) });
  }
}
for (const category of ["\u56fe\u4e66", "\u5de5\u5177", "\u97f3\u4e50"]) {
  const goal = `\u7b5b\u9009${category}\u5206\u7c7b\uff0c\u4ec5\u663e\u793a\u542f\u7528\u9879\uff0c\u5e76\u5e94\u7528\u7b5b\u9009`;
  const elements = [
    { id: "e1", role: "checkbox", label: "\u4ec5\u663e\u793a\u542f\u7528\u9879", ref: "@1", state: { disabled: false, checked: false } },
    { id: "e2", role: "button", label: "\u5e94\u7528\u7b5b\u9009", ref: "@2", state: { disabled: false } },
    { id: "e3", role: "combobox", label: "\u5206\u7c7b", ref: "@3", state: { disabled: false, editable: false, selectable: true, filled: false, matchingValueKeys: [] } },
  ];
  const state = { goal, elements: elements.map(({ ref, ...rest }) => rest), valueKeys: ["category"], recentActions: [], completion: [{ kind: "value_equals", passed: false }, { kind: "checked", passed: false }, { kind: "text_contains", passed: false }] };
  const generated = decisionQuestions(elements, { category: "synthetic" });
  const baseline = generated.operation;
  const questions = {
    baseline_operation: baseline,
    configuration_order: generated.configuration_order,
    priority_operation: { ...baseline, instructions: `${baseline.instructions} If several required input changes are pending and the goal does not specify their order, do fill/select before check/uncheck, then click to apply.` },
  };
  for (let repeat = 0; repeat < 3; repeat++) {
    results.push({ goal, repeat, response: await evaluateJev({ state, questions }, { key }) });
  }
}
for (const goal of [
  "First check Active only. Only after that, choose the supplied Category.",
  "\u5fc5\u987b\u5148\u52fe\u9009\u4ec5\u663e\u793a\u542f\u7528\u9879\uff0c\u7136\u540e\u624d\u80fd\u9009\u62e9\u5206\u7c7b\u3002",
]) {
  const elements = [
    { id: "e1", role: "checkbox", label: "Active only", ref: "@1", state: { disabled: false, checked: false } },
    { id: "e2", role: "combobox", label: "Category", ref: "@2", state: { disabled: false, editable: false, selectable: true, filled: false, matchingValueKeys: [] } },
  ];
  const state = { goal, elements: elements.map(({ ref, ...rest }) => rest), valueKeys: ["category"], recentActions: [] };
  const questions = { configuration_order: decisionQuestions(elements, { category: "synthetic" }).configuration_order };
  for (let repeat = 0; repeat < 3; repeat++) results.push({ goal, repeat, response: await evaluateJev({ state, questions }, { key }) });
}
const path = join(output, `${new Date().toISOString().replaceAll(":", "-")}.json`);
writeFileSync(path, JSON.stringify({ provider: "TypeSafe live API", results }, null, 2), "utf8");
console.log(JSON.stringify({ path, requests: results.length, inputTokens: results.reduce((sum, item) => sum + item.response.usage.input_tokens, 0) }));
