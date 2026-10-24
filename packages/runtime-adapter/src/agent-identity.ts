import { createHash, randomUUID } from "node:crypto";

export interface AgentIdentityEnvironment {
  EGO_BROWSER_AGENT_ID?: string;
  EGO_BROWSER_AGENT_INSTANCE_ID?: string;
  CODEX_THREAD_ID?: string;
  CODEX_SESSION_ID?: string;
}

export type AgentIdentityNamespace = "cli" | "mcp";

export interface AgentIdentityOptions {
  namespace?: AgentIdentityNamespace;
  randomId?: () => string;
}

/**
 * Resolves the broker client id shared by the CLI and the Codex MCP server.
 * Codex thread ids are hashed so the stable broker identity does not expose
 * the original thread identifier.
 */
export function resolveAgentClientId(
  environment: AgentIdentityEnvironment = process.env,
  options: AgentIdentityOptions = {},
): string {
  const explicitId = environment.EGO_BROWSER_AGENT_ID?.trim();
  if (explicitId) return explicitId;

  const namespace = options.namespace ?? "mcp";
  const threadId = environment.CODEX_THREAD_ID?.trim();
  if (threadId) {
    const digest = createHash("sha256").update(threadId, "utf8").digest("hex").slice(0, 24);
    return `codex-${digest}`;
  }

  return `${namespace}-${(options.randomId ?? randomUUID)()}`;
}
