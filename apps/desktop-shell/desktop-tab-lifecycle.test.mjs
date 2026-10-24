import assert from "node:assert/strict";
import test from "node:test";

import { DesktopTabCloseCoordinator } from "./desktop-tab-lifecycle.mjs";

function harness(overrides = {}) {
  const tabs = new Map([
    ["active", { targetId: "active", taskId: "task-a", active: true, order: 1 }],
    ["awake", { targetId: "awake", taskId: "task-a", active: false, order: 2 }],
    ["sleeping", { targetId: "sleeping", taskId: "task-a", active: false, sleeping: true, order: 3 }],
    ["other", { targetId: "other", taskId: "task-b", active: true, order: 9 }],
  ]);
  const events = [];
  const operations = {
    getTab: (id) => tabs.get(id),
    assertAllowed: (taskId) => events.push(["assert", taskId]),
    closeHost: async (tab) => events.push(["host", tab.targetId]),
    finalizeClosed: (tab) => { events.push(["finalize", tab.targetId]); tabs.delete(tab.targetId); },
    findReplacement: (taskId) => [...tabs.values()].filter((tab) => tab.taskId === taskId && !tab.sleeping).at(-1),
    activate: async (id) => events.push(["activate", id]),
    persist: () => events.push(["persist"]),
    ...overrides,
  };
  return { tabs, events, closer: new DesktopTabCloseCoordinator(operations) };
}

test("host close rejection leaves tab state and bindings eligible for use", async () => {
  const fixture = harness({ closeHost: async () => { throw new Error("host rejected"); } });
  await assert.rejects(fixture.closer.close("active"), /host rejected/);
  assert.equal(fixture.tabs.has("active"), true);
  assert.deepEqual(fixture.events, [["assert", "task-a"]]);
});

test("duplicate close calls are single-flight while each request is authorized", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let hostCalls = 0;
  const fixture = harness({
    closeHost: async () => { hostCalls += 1; await gate; },
  });
  const first = fixture.closer.close("active");
  const second = fixture.closer.close("active");
  release();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(hostCalls, 1);
  assert.deepEqual(fixture.events.slice(0, 2), [["assert", "task-a"], ["assert", "task-a"]]);
  assert.equal(fixture.tabs.has("active"), false);
  assert.ok(fixture.events.some((event) => event[0] === "activate" && event[1] === "awake"));
  assert.deepEqual(fixture.events.at(-1), ["persist"]);
});

test("activation failure still finalizes and persists the close", async () => {
  let persistedTargets;
  const fixture = harness({
    activate: async () => { throw new Error("replacement vanished"); },
    persist: () => { persistedTargets = [...fixture.tabs.keys()]; fixture.events.push(["persist"]); },
  });
  await assert.rejects(fixture.closer.close("active"), /replacement vanished/);
  assert.equal(fixture.tabs.has("active"), false);
  assert.deepEqual(persistedTargets, ["awake", "sleeping", "other"]);
  assert.deepEqual(fixture.events.at(-1), ["persist"]);
});

test("permanent persistence failure is observable after coherent in-memory close", async () => {
  const fixture = harness({ persist: () => { throw new Error("disk failure"); } });
  await assert.rejects(fixture.closer.close("active"), /disk failure/);
  assert.equal(fixture.tabs.has("active"), false);
  assert.ok(fixture.events.some((event) => event[0] === "activate" && event[1] === "awake"));
});

