import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgentClientId } from "./identity.ts";

test("explicit ego-browser agent id has highest priority", () => {
  assert.equal(
    resolveAgentClientId({
      EGO_BROWSER_AGENT_ID: "  configured-agent  ",
      CODEX_THREAD_ID: "thread-that-must-not-win",
    }, { namespace: "cli" }),
    "configured-agent",
  );
});

test("Codex thread id produces stable opaque identities shared across entrypoints", () => {
  const firstMcp = resolveAgentClientId({ CODEX_THREAD_ID: "thread-123" }, { namespace: "mcp" });
  const secondMcp = resolveAgentClientId({ CODEX_THREAD_ID: "thread-123" }, { namespace: "mcp" });
  const otherMcp = resolveAgentClientId({ CODEX_THREAD_ID: "thread-456" }, { namespace: "mcp" });
  const cli = resolveAgentClientId({ CODEX_THREAD_ID: "thread-123" }, { namespace: "cli" });

  assert.match(firstMcp, /^codex-[a-f0-9]{24}$/);
  assert.match(cli, /^codex-[a-f0-9]{24}$/);
  assert.equal(secondMcp, firstMcp);
  assert.notEqual(otherMcp, firstMcp);
  assert.equal(cli, firstMcp);
  assert.doesNotMatch(firstMcp, /thread-123/);
  assert.doesNotMatch(cli, /thread-123/);
});

test("Codex agent instances in one parent thread share one thread identity", () => {
  const first = resolveAgentClientId({
    CODEX_THREAD_ID: "parent-thread",
    CODEX_SESSION_ID: "subagent-a",
  }, { namespace: "cli" });
  const second = resolveAgentClientId({
    CODEX_THREAD_ID: "parent-thread",
    CODEX_SESSION_ID: "subagent-b",
  }, { namespace: "cli" });
  const explicit = resolveAgentClientId({
    CODEX_THREAD_ID: "parent-thread",
    CODEX_SESSION_ID: "shared-session",
    EGO_BROWSER_AGENT_INSTANCE_ID: "worker-c",
  }, { namespace: "cli" });

  assert.equal(first, second);
  assert.equal(first, explicit);
});

test("matching Codex thread and session ids preserve the stable legacy identity", () => {
  const threadOnly = resolveAgentClientId({ CODEX_THREAD_ID: "thread-123" }, { namespace: "cli" });
  const matchingSession = resolveAgentClientId({
    CODEX_THREAD_ID: "thread-123",
    CODEX_SESSION_ID: "thread-123",
  }, { namespace: "cli" });
  assert.equal(matchingSession, threadOnly);
});

test("non-Codex invocations retain the random CLI fallback", () => {
  assert.equal(
    resolveAgentClientId({}, { namespace: "cli", randomId: () => "fixed-uuid" }),
    "cli-fixed-uuid",
  );
});

test("MCP random fallback is isolated from the CLI namespace", () => {
  assert.equal(
    resolveAgentClientId({}, { namespace: "mcp", randomId: () => "fixed-uuid" }),
    "mcp-fixed-uuid",
  );
});
