import assert from "node:assert/strict";
import test from "node:test";

import { AgentRegistry, inferAgentClientKind } from "./agent-registry.ts";

test("stable Codex MCP and CLI identities infer the Codex kind", () => {
  assert.equal(inferAgentClientKind("codex-mcp-abc123"), "codex");
  assert.equal(inferAgentClientKind("codex-cli-abc123"), "codex");
});

test("agent registry registers and exposes a live agent", () => {
  let now = 1_000;
  const registry = new AgentRegistry({ clock: { now: () => now } });
  const changed: string[] = [];
  registry.onEvent((event) => changed.push(`${event.type}:${event.agent.clientId}`));
  const agent = registry.register({ clientId: "codex-mcp-1", clientKind: "codex", displayName: "Research Codex", version: "1.0" });
  assert.equal(agent.status, "online");
  assert.equal(agent.displayName, "Research Codex");
  assert.equal(registry.list().length, 1);
  assert.deepEqual(changed, ["changed:codex-mcp-1"]);
  now += 10;
  registry.observe("codex-mcp-1");
  assert.equal(registry.get("codex-mcp-1")?.lastSeenAt, new Date(now).toISOString());
  assert.deepEqual(changed, ["changed:codex-mcp-1"]);
});

test("agent disconnect becomes offline and clears active execution", () => {
  const registry = new AgentRegistry();
  const events: string[] = [];
  registry.onEvent((event) => events.push(`${event.type}:${event.agent.status}`));
  registry.register({ clientId: "agent-a" });
  registry.setCurrentTask("agent-a", "task-1");
  registry.startActivity("agent-a", { tool: "ego_click", startedAt: new Date().toISOString() }, "task-1");
  const disconnected = registry.disconnect("agent-a");
  assert.equal(disconnected?.status, "offline");
  assert.equal(disconnected?.currentTaskId, undefined);
  assert.equal(disconnected?.currentAction, undefined);
  assert.equal(registry.list()[0]?.status, "offline");
  registry.observe("agent-a");
  assert.equal(registry.get("agent-a")?.status, "online");
  assert.equal(events.at(-1), "changed:online");
});

test("agent heartbeat timeout marks the agent offline", () => {
  let now = 10_000;
  const registry = new AgentRegistry({ clock: { now: () => now }, timeoutMs: 100 });
  registry.register({ clientId: "agent-timeout" });
  now += 101;
  const expired = registry.sweep();
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.status, "offline");
});

test("agent activity exposes a privacy-safe current action and elapsed anchor", () => {
  const registry = new AgentRegistry();
  registry.register({ clientId: "agent-action", clientKind: "codex" });
  const startedAt = new Date().toISOString();
  const agent = registry.startActivity("agent-action", { tool: "ego_fill", startedAt }, "task-2");
  assert.equal(agent?.status, "executing");
  assert.deepEqual(agent?.currentAction, { tool: "ego_fill", startedAt });
  assert.equal(agent?.currentTaskId, "task-2");
  registry.finishActivity("agent-action");
  assert.equal(registry.get("agent-action")?.status, "online");
});

test("clearing a task also clears executing activity for every matching agent", () => {
  const registry = new AgentRegistry();
  registry.register({ clientId: "agent-a", clientKind: "codex", displayName: "Agent A" });
  registry.register({ clientId: "agent-b", clientKind: "codex", displayName: "Agent B" });
  registry.startActivity("agent-a", { tool: "browser.click", startedAt: new Date().toISOString() }, "task-delete");
  registry.startActivity("agent-b", { tool: "browser.type", startedAt: new Date().toISOString() }, "task-other");

  const cleared = registry.clearTask("task-delete");

  assert.deepEqual(cleared.map((agent) => agent.clientId), ["agent-a"]);
  assert.equal(registry.get("agent-a")?.status, "online");
  assert.equal(registry.get("agent-a")?.currentTaskId, undefined);
  assert.equal(registry.get("agent-a")?.currentAction, undefined);
  assert.equal(registry.get("agent-a")?.activityStartedAt, undefined);
  assert.equal(registry.get("agent-a")?.taskStartedAt, undefined);
  assert.equal(registry.get("agent-b")?.status, "executing");
  assert.equal(registry.get("agent-b")?.currentTaskId, "task-other");
});
