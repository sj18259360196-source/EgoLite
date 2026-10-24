import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0);
  const end = source.slice(start).search(/^}/m);
  return source.slice(start, start + end + 1);
}

function harness(mode = "agent", agents = []) {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      textContent: "", value: "", options: [],
      replaceChildren(...children) {
        this.options = children;
        this.value = children[0]?.value ?? "";
      },
      append() {},
    });
    return elements.get(id);
  };
  const ctx = vm.createContext({
    $, state: { agents }, controlPanelRevision: -1,
    browserSettings: { controlMode: mode, autoCollaboration: true },
    Option: function (text, value) { this.text = text; this.value = value; },
    document: { createElement: () => ({ append() {} }) },
    agentStatusText: (status) => status,
  });
  vm.runInContext(["normalizeControlMode", "controlModeLabel", "renderControlPanel"].map(extract).join("\n"), ctx);
  const render = (overrides = {}) => ctx.renderControlPanel({
    revision: 1, space: { id: 1, lifecycle: "active", ownership: "user" },
    requests: [], ...overrides,
  });
  return { $, render };
}

test("unclaimed space is not labelled user-controlled and explains the empty selector", () => {
  const { $, render } = harness();
  render();
  assert.equal($("#control-panel-status").textContent, "Agent 自主 · 共享操作");
  assert.equal($("#control-panel-target").options[0].text, "暂无在线 Agent");
  assert.equal($("#control-panel-assign").disabled, true);
  assert.match($("#control-panel-reason").textContent, /请先连接/);
  assert.equal($("#control-auto-collaboration").disabled, true);
});

test("manual mode disables assignment even with an online agent and explains the mode restriction", () => {
  const { $, render } = harness("manual", [{ clientId: "agent-a", status: "idle" }]);
  render();
  assert.equal($("#control-panel-target").disabled, true);
  assert.equal($("#control-panel-assign").disabled, true);
  assert.match($("#control-panel-status").textContent, /操作已禁用/);
  assert.match($("#control-panel-reason").textContent, /切换全局模式/);
});

test("collaborative panel distinguishes writer, paused state and delegated user control", () => {
  const { $, render } = harness("collaborative", [{ clientId: "agent-a", displayName: "A", status: "idle" }]);
  render({ controllerClientId: "agent-a" });
  assert.equal($("#control-panel-status").textContent, "A · 持有写权限");
  assert.equal($("#control-panel-assign").disabled, false);
  assert.equal($("#control-auto-collaboration").disabled, false);
  assert.equal($("#control-auto-collaboration").checked, true);
  render({ space: { agentBlocked: true }, interactionPending: true });
  assert.match($("#control-panel-status").textContent, /等待确认接管/);
  render({ space: { ownership: "agentDelegatedToUser" } });
  assert.equal($("#control-panel-status").textContent, "用户控制 · Agent 无写权限");
});

test("offline agents cannot be assigned and closed spaces report their own restriction", () => {
  const { $, render } = harness("collaborative", [{ clientId: "agent-a", status: "offline" }]);
  render({ space: { lifecycle: "closed" } });
  assert.equal($("#control-panel-assign").disabled, true);
  assert.equal($("#control-panel-reason").textContent, "当前工作区已关闭");
});
