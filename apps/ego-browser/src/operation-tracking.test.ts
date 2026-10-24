import assert from "node:assert/strict";
import test from "node:test";

import { installCliOperationTracking } from "./operation-tracking.ts";

test("CLI operation tracking records page and locator calls without exposing input", async () => {
  const records: Array<Record<string, unknown>> = [];
  const target = {
    page: {
      info: async () => ({ title: "Fixture" }),
      getByLabel: (label: string) => ({
        fill: async (value: string) => ({ label, value }),
      }),
    },
  } as unknown as Record<string, unknown>;

  installCliOperationTracking(target, async (record) => {
    records.push(record as unknown as Record<string, unknown>);
  });

  const page = target.page as {
    info(): Promise<{ title: string }>;
    getByLabel(label: string): { fill(value: string): Promise<unknown> };
  };
  assert.equal((await page.info()).title, "Fixture");
  await page.getByLabel("Email").fill("secret@example.com");

  assert.deepEqual(records.map((record) => [record.tool, record.status]), [
    ["ego_page_info", "running"],
    ["ego_page_info", "completed"],
    ["ego_fill", "running"],
    ["ego_fill", "completed"],
  ]);
  assert.match(String(records[2]?.detail), /"target":"Email"/);
  assert.match(String(records[2]?.detail), /"content":"已隐藏"/);
  assert.doesNotMatch(JSON.stringify(records), /secret@example\.com/);
});

test("CLI operation tracking preserves failures and ignores recorder errors", async () => {
  const records: Array<Record<string, unknown>> = [];
  let calls = 0;
  const target = {
    browser: {
      closeTab: async () => {
        throw new Error("missing target");
      },
    },
  } as unknown as Record<string, unknown>;

  installCliOperationTracking(target, async (record) => {
    calls += 1;
    if (calls === 1) throw new Error("panel unavailable");
    records.push(record as unknown as Record<string, unknown>);
  });

  const browser = target.browser as { closeTab(targetId: string): Promise<unknown> };
  await assert.rejects(browser.closeTab("tab-1"), /missing target/);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "failed");
  assert.match(String(records[0]?.detail), /missing target/);
});

test("CLI operation tracking does not leave task handoff calls running", async () => {
  const records: Array<Record<string, unknown>> = [];
  const target = {
    taskSpaces: {
      complete: async () => ({ done: true }),
      handOff: async () => ({ done: true }),
    },
  } as unknown as Record<string, unknown>;

  installCliOperationTracking(target, async (record) => {
    records.push(record as unknown as Record<string, unknown>);
  });

  const taskSpaces = target.taskSpaces as {
    complete(): Promise<{ done: boolean }>;
    handOff(): Promise<{ done: boolean }>;
  };
  assert.equal((await taskSpaces.complete()).done, true);
  assert.equal((await taskSpaces.handOff()).done, true);
  assert.deepEqual(records, []);
});
