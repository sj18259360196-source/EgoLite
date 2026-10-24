import { AutomationRunner } from "../../ego-mcp-server/src/automation/runner.ts";
import { extractSchema, runSchema } from "../../ego-mcp-server/src/automation/schema.ts";

export type AutomationSession = Parameters<AutomationRunner["run"]>[0];
export type AutomationResult = Awaited<ReturnType<AutomationRunner["run"]>>;

// MCP and SDK share the executor, budgets, native permission checks and verification.
export function createAutomationSdk(
  session: AutomationSession,
  runner = new AutomationRunner(),
  onResult?: (result: AutomationResult) => void,
) {
  async function report<T extends AutomationResult>(pending: Promise<T>): Promise<T> {
    const result = await pending;
    try { onResult?.(result); } catch { /* Diagnostics cannot change a completed action's outcome. */ }
    return result;
  }
  return Object.freeze({
    run(input: unknown, options: { signal?: AbortSignal } = {}) {
      return report(runner.run(session, runSchema.parse(input), options.signal));
    },
    extract(input: unknown, options: { signal?: AbortSignal } = {}) {
      return report(runner.extract(session, extractSchema.parse(input), options.signal));
    },
    cancel() {
      return runner.cancel();
    },
  });
}
