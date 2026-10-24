import assert from "node:assert/strict";
import test from "node:test";
import { createAutomationSdk, type AutomationSession } from "./automation.ts";
import { AutomationRunner } from "../../ego-mcp-server/src/automation/runner.ts";

test("SDK automation passes the same session, parsed defaults and cancellation signal to the shared runner", async () => {
  const session = {} as AutomationSession;
  const calls: unknown[][] = [];
  const runner = {
    run: async (...args: unknown[]) => { calls.push(args); return { status: "done", verified: true }; },
    extract: async (...args: unknown[]) => { calls.push(args); return { rows: [], complete: true }; },
    cancel: () => ({ cancelled: true }),
  } as unknown as AutomationRunner;
  const api = createAutomationSdk(session, runner);
  const controller = new AbortController();
  await api.run({ goal: "Click Next", success: { all: [{ kind: "visible", target: "#done" }] } },
    { signal: controller.signal });
  assert.equal(calls[0]![0], session);
  assert.equal(calls[0]![2], controller.signal);
  assert.equal((calls[0]![1] as { mode: string }).mode, "auto");
  assert.deepEqual((calls[0]![1] as { authorizedActions: string[] }).authorizedActions, []);
  await api.extract({ selector: "tr", fields: { name: { selector: "td" } } });
  assert.equal(calls[1]![0], session);
  assert.equal((calls[1]![1] as { maxPages: number }).maxPages, 1);
  assert.deepEqual(api.cancel(), { cancelled: true });
  assert.equal(Object.isFrozen(api), true);
});

test("SDK automation rejects invalid completion checks before invoking the runner", () => {
  let invoked = false;
  const runner = { run: () => { invoked = true; } } as unknown as AutomationRunner;
  const api = createAutomationSdk({} as AutomationSession, runner);
  assert.throws(() => api.run({ goal: "Complete", success: { all: [] } }));
  assert.throws(() => api.run({ goal: "Complete", success: { all: [{ kind: "visible", target: "@1" }] } }));
  assert.equal(invoked, false);
});

test("SDK diagnostic failures do not turn completed actions into retryable errors", async () => {
  const result = { status: "done", verified: true };
  const runner = { run: async () => result } as unknown as AutomationRunner;
  const api = createAutomationSdk({} as AutomationSession, runner, () => { throw new Error("diagnostic failed"); });
  assert.equal(await api.run({ goal: "Click Next", success: { all: [{ kind: "visible", target: "#done" }] } }), result);
});

test("SDK extraction forwards relevance defaults and rejects non-extracted model fields", async () => {
  let received: any;
  const runner = { extract: async (_session: unknown, input: unknown) => {
    received = input;
    return { status: "done", rows: [], complete: true };
  } } as unknown as AutomationRunner;
  const api = createAutomationSdk({} as AutomationSession, runner);
  const input = { selector: "article", fields: { title: { selector: "h2" } },
    relevance: { query: "Browser tools", fields: ["title"] } };
  await api.extract(input);
  assert.equal(received.relevance.batchSize, 20);
  assert.equal(received.relevance.maxCandidates, 200);
  assert.throws(() => api.extract({ ...input, relevance: { ...input.relevance, fields: ["not_extracted"] } }));
});
