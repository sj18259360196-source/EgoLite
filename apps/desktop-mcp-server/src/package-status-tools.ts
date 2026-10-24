import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPackageStatusTools(
  server: McpServer,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): void {
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const reply = async (method: string, params: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await request(method, params)) }],
  });
  server.registerTool("ego_package_status", {
    description: "Read CoS runtime, queued-task metadata and recent session summaries. Does not imply that a task has completed.",
    inputSchema: { packageId: z.literal("cos").default("cos"), instanceId: z.literal("default").optional() },
    annotations,
  }, args => reply("package.status", args));
  server.registerTool("ego_agent_status", {
    description: "Read Agent connection and browser activity known to Ego. External Codex Desktop conversations are unavailable without a status provider.",
    inputSchema: { clientId: z.string().max(256).optional(), sourceScope: z.enum(["ego", "codex-desktop"]).default("ego") },
    annotations,
  }, args => reply("agent.knownStatus", args));
  server.registerTool("ego_package_wait", {
    description: "Wait up to 25 seconds for CoS metadata events. Reuse its cursor; a timeout does not mean task completion.",
    inputSchema: { instanceId: z.literal("default").optional(), afterCursor: z.string().max(128).optional(), timeoutMs: z.number().int().min(0).max(25000).default(0) },
    annotations,
  }, args => reply("package.wait", args));
}
