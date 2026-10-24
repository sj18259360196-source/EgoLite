import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DesktopRpcClient } from "./client.ts";
import { registerPackageStatusTools } from "./package-status-tools.ts";
// @ts-expect-error Shared Electron-compatible ESM contract is consumed without a TS build.
import { automationToolDescription, AUTOMATION_SERVER_INSTRUCTIONS } from "../../desktop-shell/automation-capabilities.mjs";
import { resolveDesktopScopedRef } from "./scoped-refs.ts";
import type { SnapshotRef, SnapshotResult } from "../../../packages/protocol/src/types.ts";
import { scopedMcpToolError } from "../../ego-mcp-server/src/server.ts";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { browserSnapshotRefsToRefMap, clearPreferredTarget, invalidateSession, setPreferredTarget } from "../../../vendor/ego-browser/src/browser-runtime.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { browserRefMap, clearScopedReferenceState } from "../../../vendor/ego-browser/src/ref-state.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { click, hover } from "../../../vendor/ego-browser/src/driver/pointer.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { fill } from "../../../vendor/ego-browser/src/driver/keyboard.js";

const client = new DesktopRpcClient(process.env.EGO_DESKTOP_AUTOMATION_PIPE || "\\\\.\\pipe\\ego-compat-desktop");
const server = new McpServer({ name: "ego-desktop", version: "0.1.0" }, { instructions: AUTOMATION_SERVER_INSTRUCTIONS });
registerPackageStatusTools(server, (method, params) => client.request(method, params));
const rawRegister = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, handler: (args: any) => Promise<any>) => void;
const register = (name: string, config: Record<string, unknown>, handler: (args: any) => Promise<any>) => {
  rawRegister(name, { ...config, description: automationToolDescription(name, config.description) }, async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      throw scopedMcpToolError(error);
    }
  });
};
let refs: SnapshotRef[] = [];
let refFormat: "native-v0" | "scoped-v1" = "native-v0";
let scopedPageId: string | undefined;
let scopedRuntimeId: string | undefined;
client.onReconnect(clearRefs);

register("ego_desktop_status", { description: "Check whether the visible Ego desktop browser is available.", inputSchema: {} }, async () => result(await client.request("desktop.status")));
register("ego_desktop_request_control", { description: "Request write access to the visible workspace. The user must approve this Agent in the desktop control panel before page operations can proceed.", inputSchema: {} }, async () => result(await client.request("control.request")));
register("ego_desktop_page_info", { description: "Read title, URL, loading state, and navigation availability from the visible Ego page.", inputSchema: {} }, async () => result(await client.request("page.info")));
register("ego_desktop_open", { description: "Navigate the visible Ego desktop page to a URL or search query.", inputSchema: { url: z.string().min(1) } }, async ({ url }) => {
  clearRefs();
  return result(await client.request("page.goto", { url }));
});
register("ego_desktop_navigate", { description: "Navigate the visible Ego page backward, forward, or reload.", inputSchema: { action: z.enum(["back", "forward", "reload"]) } }, async ({ action }) => {
  clearRefs();
  return result(await client.request("page.navigate", { action }));
});
register("ego_desktop_snapshot", {
  description: "Capture an accessibility snapshot of the visible Ego page and create actionable @refs.",
  inputSchema: {
    scope: z.enum(["viewport", "full_page"]).default("full_page"),
    stableLocators: z.boolean().default(false),
    actionMarks: z.boolean().default(true),
    maxResultLength: z.number().int().min(64).optional(),
  },
}, async ({ scope, stableLocators, actionMarks, maxResultLength }) => {
  const options = {
    scope,
    includeStableLocator: stableLocators,
    includeActionMarks: actionMarks,
    ...(maxResultLength === undefined ? {} : { maxResultLength }),
  };
  const scoped = await client.captureScopedSnapshot(options);
  const snapshot = scoped ?? await client.request<SnapshotResult>("page.snapshot", { options });
  refs = snapshot.refs;
  refFormat = snapshot.refFormat === "scoped-v1" ? "scoped-v1" : "native-v0";
  scopedPageId = refFormat === "scoped-v1" ? requiredSnapshotPageId(snapshot) : undefined;
  scopedRuntimeId = refFormat === "scoped-v1" ? snapshot.runtimeId : undefined;
  if (refFormat === "scoped-v1") browserSnapshotRefsToRefMap(browserRefMap, snapshot);
  return text(snapshot.content);
});
register("ego_desktop_click", { description: "Click an element in the visible Ego page using an @ref from the latest snapshot.", inputSchema: { target: z.string().regex(/^@\d+$/) } }, async ({ target }) => result(await runRefAction(target, () => click(target), (backendNodeId) => client.request("page.click", { backendNodeId }))));
register("ego_desktop_fill", { description: "Fill an editable element in the visible Ego page using an @ref from the latest snapshot.", inputSchema: { target: z.string().regex(/^@\d+$/), value: z.string() } }, async ({ target, value }) => result(await runRefAction(target, () => fill(target, value), (backendNodeId) => client.request("page.fill", { backendNodeId, value }))));
register("ego_desktop_hover", { description: "Hover an element in the visible Ego page using an @ref from the latest snapshot.", inputSchema: { target: z.string().regex(/^@\d+$/) } }, async ({ target }) => result(await runRefAction(target, () => hover(target), (backendNodeId) => client.request("page.hover", { backendNodeId }))));
register("ego_desktop_press", { description: "Send a key or keyboard shortcut to the visible Ego page.", inputSchema: { key: z.string().min(1).max(100) } }, async ({ key }) => result(await client.request("page.press", { key })));
register("ego_desktop_type", { description: "Type text into the currently focused element in the visible Ego page.", inputSchema: { text: z.string().max(100_000) } }, async ({ text }) => result(await client.request("page.type", { text })));
register("ego_desktop_scroll", { description: "Scroll the visible Ego page by pixel deltas.", inputSchema: { deltaY: z.number().min(-100_000).max(100_000), deltaX: z.number().min(-100_000).max(100_000).default(0) } }, async ({ deltaX, deltaY }) => result(await client.request("page.scroll", { deltaX, deltaY })));
register("ego_desktop_wait", { description: "Wait until the visible page finishes loading or matches URL and text conditions.", inputSchema: { timeout: z.number().int().min(100).max(60_000).default(10_000), loadComplete: z.boolean().default(true), urlContains: z.string().max(10_000).optional(), text: z.string().max(100_000).optional() } }, async (args) => result(await client.request("page.wait", args)));
register("ego_desktop_evaluate", { description: "Evaluate a JSON-serializable JavaScript expression in the visible Ego page.", inputSchema: { expression: z.string().min(1).max(100_000) } }, async ({ expression }) => result(await client.request("page.evaluate", { expression })));
register("ego_desktop_screenshot", { description: "Capture the visible Ego page as a PNG.", inputSchema: {} }, async () => {
  const shot = await client.request<{ data: string; mimeType: string }>("page.screenshot");
  return { content: [{ type: "image" as const, data: shot.data, mimeType: shot.mimeType }] };
});
register("ego_desktop_tabs", { description: "List tabs in the currently visible Ego task space.", inputSchema: {} }, async () => result(await client.request("tabs.list")));
register("ego_desktop_new_tab", { description: "Create and activate a new tab in the visible Ego task space.", inputSchema: { url: z.string().min(1).optional() } }, async ({ url }) => {
  clearRefs();
  return result(await client.request("tabs.create", { ...(url ? { url } : {}) }));
});
register("ego_desktop_switch_tab", { description: "Activate a visible Ego tab by target id.", inputSchema: { targetId: z.string().min(1) } }, async ({ targetId }) => {
  clearRefs();
  return result(await client.request("tabs.activate", { targetId }));
});
register("ego_desktop_close_tab", { description: "Close a visible Ego tab by target id, or close the active tab when omitted.", inputSchema: { targetId: z.string().min(1).optional() } }, async ({ targetId }) => {
  clearRefs();
  return result(await client.request("tabs.close", { ...(targetId ? { targetId } : {}) }));
});

await server.connect(new StdioServerTransport());

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  client.close();
  await server.close().catch(() => {});
};
process.stdin.once("end", () => { void close(); });
process.stdin.once("close", () => { void close(); });
process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });

async function runRefAction<T>(
  target: string,
  scopedAction: () => Promise<T>,
  nativeAction: (backendNodeId: number) => Promise<T>,
): Promise<T> {
  const ref = resolveRef(target);
  if (refFormat !== "scoped-v1") return nativeAction(ref.backendNodeId);
  if (!scopedPageId) throw refError("Scoped snapshot page is unavailable");
  const prepared = await client.prepareScopedAction(scopedPageId);
  if (!prepared) throw refError("Scoped reference capability is no longer available");
  (globalThis as Record<string, unknown>).ego = prepared.runtime as unknown as Record<string, unknown>;
  invalidateSession();
  setPreferredTarget(prepared.targetId);
  return scopedAction();
}

function resolveRef(target: string): SnapshotRef {
  if (refFormat === "scoped-v1") return resolveDesktopScopedRef(target, scopedRuntimeId, scopedPageId);
  const publicId = Number(target.slice(1));
  const ref = refs.find((item) => item.backendNodeId === publicId);
  if (!ref) throw refError(`Unknown desktop ref ${target}; take a new snapshot`);
  return ref;
}

function requiredSnapshotPageId(snapshot: SnapshotResult): string {
  if (typeof snapshot.pageId === "string" && snapshot.pageId) return snapshot.pageId;
  const pageId = snapshot.refs.find((ref) => typeof ref.pageId === "string" && ref.pageId)?.pageId;
  if (pageId) return pageId;
  throw refError("Scoped snapshot did not identify its visible page");
}

function clearRefs(): void {
  refs = [];
  refFormat = "native-v0";
  scopedPageId = undefined;
  scopedRuntimeId = undefined;
  clearScopedReferenceState();
  invalidateSession();
  clearPreferredTarget();
}

function refError(message: string): Error {
  return Object.assign(new Error(message), { error_code: "EGO_REFERENCE_STALE" });
}

function text(value: string) { return { content: [{ type: "text" as const, text: value }] }; }
function result(value: unknown) { return text(JSON.stringify(value ?? null, null, 2)); }
