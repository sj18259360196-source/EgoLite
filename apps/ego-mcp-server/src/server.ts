import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DesktopRpcClient } from "../../desktop-mcp-server/src/client.ts";
import { registerPackageStatusTools } from "../../desktop-mcp-server/src/package-status-tools.ts";

import { EgoMcpSession } from "./ego-session.ts";
import { AutomationRunner } from "./automation/runner.ts";
import { runSchema, extractSchema } from "./automation/schema.ts";
// @ts-expect-error Shared Electron-compatible ESM contract is consumed without a TS build.
import { automationToolDescription, AUTOMATION_SERVER_INSTRUCTIONS } from "../../desktop-shell/automation-capabilities.mjs";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { withScopedReferenceAction } from "../../../vendor/ego-browser/src/scoped-reference-context.js";

export interface EgoMcpServerOptions {
  pipeName: string;
  autoStartDesktop?: boolean;
}

export async function runEgoMcpServer(options: EgoMcpServerOptions): Promise<void> {
  let session: Promise<EgoMcpSession> | undefined;
  let closing = false;
  const getSession = () => {
    if (closing) return Promise.reject(new Error("MCP server is closing"));
    session ??= EgoMcpSession.connect(options.pipeName, {
      autoStartDesktop: options.autoStartDesktop === true,
    }).catch((error) => {
      session = undefined;
      throw error;
    });
    return session;
  };
  const server = createServer(getSession);
  const close = async () => {
    if (closing) return;
    closing = true;
    await session?.then((ego) => ego.close()).catch(() => {});
    await server.close().catch(() => {});
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  process.stdin.once("end", () => void close());
  process.stdin.once("close", () => void close());
  await server.connect(new StdioServerTransport());
}

export function createServer(source: EgoMcpSession | (() => Promise<EgoMcpSession>)): McpServer {
  let ego = source as EgoMcpSession;
  const automation = new AutomationRunner();
  const server = new McpServer({ name: "ego-browser", version: "0.1.0" }, { instructions: AUTOMATION_SERVER_INSTRUCTIONS });
  const packageStatus = new DesktopRpcClient(process.env.EGO_DESKTOP_AUTOMATION_PIPE || "\\\\.\\pipe\\ego-compat-desktop");
  registerPackageStatusTools(server, (method, params) => packageStatus.request(method, params));
  const previousClose = server.server.onclose;
  server.server.onclose = () => { packageStatus.close(); previousClose?.(); };
  // MCP's schema generics expand heavily across a large tool set. Runtime validation
  // remains Zod-backed; this boundary keeps TypeScript focused on our handlers.
  const rawRegisterTool = server.registerTool.bind(server) as (
    name: string,
    config: Record<string, unknown>,
    handler: (args: any) => Promise<any>,
  ) => void;
  const registerTool = (
    name: string,
    config: Record<string, unknown>,
    handler: (args: any, signal?: AbortSignal) => Promise<any>,
  ): void => {
    rawRegisterTool(name, { ...config, description: automationToolDescription(name, config.description), annotations: toolAnnotations(name) }, async (args: any, extra: { signal?: AbortSignal } = {}) => {
      if (automation.busy && !["ego_status", "ego_automation_cancel", "ego_task_handoff"].includes(name)) {
        throw new Error("A continuous task is using this MCP session. Cancel it before selecting or modifying another page.");
      }
      if (name === "ego_task_handoff") automation.cancel();
      if (typeof source === "function") ego = await source();
      const id = randomUUID();
      const startedAt = new Date().toISOString();
      const title = operationTitle(name, args);
      const detail = operationDetail(name, args);
      await ego.recordOperation({ id, tool: name, title, ...(detail ? { detail } : {}), status: "running", startedAt }).catch(() => {});
      try {
        const value = await handler(args, extra.signal);
        await ego.recordOperation({
          id,
          tool: name,
          title,
          ...(detail ? { detail } : {}),
          status: "completed",
          startedAt,
          finishedAt: new Date().toISOString(),
        }).catch(() => {});
        return value;
      } catch (error) {
        const surfacedError = scopedMcpToolError(error);
        const failedDetail = failureOperationDetail(detail, surfacedError);
        await ego.recordOperation({
          id,
          tool: name,
          title,
          ...(failedDetail ? { detail: failedDetail } : {}),
          status: "failed",
          startedAt,
          finishedAt: new Date().toISOString(),
        }).catch(() => {});
        throw surfacedError;
      }
    });
  };

  registerTool("ego_status", {
    description: "Inspect Ego backend readiness, task spaces, and the selected task's tabs before browser work.",
    inputSchema: {},
  }, async () => {
    const backend = await ego.status();
    return result({
      backend,
      taskSpaces: await ego.sdk.taskSpaces.list(),
      tabs: await ego.sdk.browser.listTabs().catch(() => ({ tabs: [] })),
      actionRequired: backend.ready ? null : backend.message,
    });
  });

  registerTool("ego_task_use", {
    description: "Select an existing Ego task space by name/id or create it when missing.",
    inputSchema: { task: z.union([z.string(), z.number()]).describe("Task-space name or numeric id") },
  }, async ({ task }) => result(await ego.sdk.taskSpaces.useOrCreate(task)));

  registerTool("ego_task_handoff", {
    description: "Hand the selected browser task to the user and stop agent browser mutations.",
    inputSchema: {},
  }, async () => result(await ego.sdk.taskSpaces.handOff()));

  registerTool("ego_task_observe", {
    description: "Read workspace control state and tabs without selecting it or obtaining write access. Optionally capture a read-only snapshot of a tab in that workspace.",
    inputSchema: { task: z.union([z.string(), z.number()]), targetId: z.string().optional() },
  }, async ({ task, targetId }) => result(await ego.sdk.taskSpaces.observe(task, targetId)));
  registerTool("ego_task_request_control", {
    description: "Request write access; the user or current writer must explicitly approve the handoff.",
    inputSchema: { task: z.union([z.string(), z.number()]) },
  }, async ({ task }) => result(await ego.sdk.taskSpaces.requestControl(task)));
  registerTool("ego_task_return_control", {
    description: "Release this Agent's write access to the user or approve a pending request from another Agent.",
    inputSchema: { task: z.union([z.string(), z.number()]), requestId: z.string().optional() },
  }, async ({ task, requestId }) => result(await ego.sdk.taskSpaces.returnControl(task, requestId)));

  registerTool("ego_task_complete", {
    description: "Complete a browser task and either keep it for the user or close it after verified work.",
    inputSchema: {
      task: z.union([z.string(), z.number()]).describe("Task-space name or numeric id"),
      keep: z.boolean().default(true),
    },
  }, async ({ task, keep }) => result(await ego.sdk.taskSpaces.complete(task, { keep })));

  registerTool("ego_task_close", {
    description: "Close a browser task and all of its tabs after verified work is complete.",
    inputSchema: {
      task: z.union([z.string(), z.number()]).describe("Task-space name or numeric id"),
    },
  }, async ({ task }) => result(await ego.sdk.taskSpaces.complete(task, { keep: false })));

  registerTool("ego_tabs", {
    description: "List tabs in the selected Ego task space.",
    inputSchema: {},
  }, async () => result(await ego.sdk.browser.listTabs()));

  registerTool("ego_open", {
    description: "Open or reuse a tab at a URL in the selected Ego task space and wait for loading.",
    inputSchema: {
      url: z.string().url(),
      wait: z.boolean().default(true),
      match: z.enum(["exact", "origin", "origin+path", "includes"]).default("exact"),
    },
  }, async ({ url, wait, match }) => result(await ego.sdk.browser.openOrReuseTab(url, { wait, match })));

  registerTool("ego_tab_select", {
    description: "Switch the selected task to a tab by current target id, title, or URL.",
    inputSchema: { target: z.string().min(1) },
  }, async ({ target }) => result(await ego.sdk.browser.switchTab(target)));

  registerTool("ego_tab_close", {
    description: "Close a tab in the selected task by current target id, title, or URL.",
    inputSchema: { target: z.string().min(1) },
  }, async ({ target }) => result(await ego.sdk.browser.closeTab(target)));

  registerTool("ego_navigate", {
    description: "Navigate the current tab backward, forward, or reload it and optionally wait for loading.",
    inputSchema: {
      action: z.enum(["back", "forward", "reload"]),
      waitUntil: z.enum(["load", "domcontentloaded", "commit"]).default("load"),
      ignoreCache: z.boolean().default(false),
      timeout: z.number().int().min(1000).max(120_000).default(20_000),
    },
  }, async ({ action, waitUntil, ignoreCache, timeout }) => {
    const options = { waitUntil, timeout, ...(action === "reload" ? { ignoreCache } : {}) };
    const value = action === "back"
      ? await ego.sdk.page.goBack(options)
      : action === "forward"
        ? await ego.sdk.page.goForward(options)
        : await ego.sdk.page.reload(options);
    return result({ action, value, url: await ego.sdk.page.url(), title: await ego.sdk.page.title() });
  });

  registerTool("ego_run", {
    description: "Complete a bounded browser subtask. Pass task to select an existing task by name/ID; SDK selection is separate. Keep an existing composed SDK workflow for deterministic work. For explicit plans needing locator recovery, use mode repair and targetHint: intact targets or exact unique labels run locally; an absent non-ref target may receive one Jev target-selection decision before dispatch. Repair never retries failed actions or adds unplanned actions. Use direct for no model fallback, auto only for deliberate goal-only exploration. Requires structural success checks. Only include authorizedActions explicitly authorized by the user. Returns verified evidence or a handoff; never replay unknown results.",
    inputSchema: runSchema.shape,
  }, async (args, signal) => result(await automation.run(ego, runSchema.parse(args), signal)));

  registerTool("ego_extract", {
    description: "Read table/list rows with optional pagination. Pass task to select an existing task by name/ID in this MCP session; SDK selection is separate. maxPages is 1-30, maxRows is 1-5000. Fields use CSS selectors relative to each row. Optional relevance sends only its named extracted fields to Jev in bounded batches with the selected Profile's cloud consent. It excludes confidently irrelevant rows, always retains unknown rows, and returns original rowIndices, per-row judgments and sourceIndex provenance. complete covers collection; also inspect relevance.complete and unknownRows. Model relevance is not factual verification. Without relevance, no model is used.",
    inputSchema: extractSchema.shape,
  }, async (args, signal) => result(await automation.extract(ego, extractSchema.parse(args), signal)));

  registerTool("ego_automation_cancel", {
    description: "Cancel this MCP session's continuous task. Already dispatched operations may have happened; observe their results before retrying.",
    inputSchema: {},
  }, async () => result(automation.cancel()));

  registerTool("ego_snapshot", {
    description: "Return an accessibility-first page snapshot with actionable @refs for later actions.",
    inputSchema: {
      scope: z.enum(["viewport", "full_page"]).default("viewport"),
      stableLocators: z.boolean().default(true),
      maxResultLength: z.number().int().min(64).optional(),
    },
  }, async ({ scope, stableLocators, maxResultLength }) => text(await ego.sdk.page.snapshot({
    scope,
    includeActionMarks: true,
    includeStableLocator: stableLocators,
    ...(maxResultLength === undefined ? {} : { maxResultLength }),
  })));

  registerTool("ego_page_info", {
    description: "Read the current page URL, title, viewport, scroll position, and document dimensions.",
    inputSchema: {},
  }, async () => result(await ego.sdk.page.info()));

  registerTool("ego_webmcp_tools", {
    description: "List the WebMCP tools exposed by the current page through document.modelContext.",
    inputSchema: {},
  }, async () => result(await ego.sdk.page.evaluate(webMcpToolsExpression())));

  registerTool("ego_webmcp_call", {
    description: "Call one WebMCP tool exposed by the current page. Discover tools first with ego_webmcp_tools.",
    inputSchema: {
      tool: z.string().min(1).max(256).describe("Exact WebMCP tool name returned by ego_webmcp_tools"),
      input: z.record(z.string(), z.unknown()).default({}).describe("JSON object matching the site's tool input schema"),
    },
  }, async ({ tool, input }) => result(await ego.sdk.page.evaluate(webMcpCallExpression(tool, input))));

  registerTool("ego_evaluate", {
    description: "Evaluate a JavaScript expression in the current page and return its JSON-serializable value.",
    inputSchema: {
      expression: z.string().min(1).max(100_000),
    },
  }, async ({ expression }) => result(await ego.sdk.page.evaluate(jsonSafeExpression(expression))));

  registerTool("ego_browser_fetch", {
    description: "Run fetch inside the current page origin so browser cookies, CORS, and session state apply.",
    inputSchema: {
      url: z.string().min(1),
      method: z.string().min(1).default("GET"),
      headers: z.record(z.string(), z.string()).default({}),
      body: z.string().optional(),
      credentials: z.enum(["omit", "same-origin", "include"]).default("same-origin"),
      timeout: z.number().min(0.1).max(120).default(20),
      parse: z.enum(["auto", "json", "text"]).default("auto"),
    },
  }, async ({ url, method, headers, body, credentials, timeout, parse }) => {
    const payload = JSON.stringify({ url, method, headers, body, credentials, timeout });
    const response = await ego.sdk.page.evaluate(`(async () => {
      const input = ${payload};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeout * 1000);
      try {
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          credentials: input.credentials,
          ...(input.body === undefined ? {} : { body: input.body }),
          signal: controller.signal,
        });
        return {
          url: response.url,
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headers: Object.fromEntries(response.headers.entries()),
          body: await response.text(),
        };
      } finally {
        clearTimeout(timer);
      }
    })()`);
    const structured = response as {
      url: string;
      status: number;
      statusText: string;
      ok: boolean;
      headers: Record<string, string>;
      body: string;
    };
    return result({ ...structured, body: parseBody(structured.body, parse) });
  });

  registerTool("ego_click", {
    description: "Click one element using an @ref from the latest snapshot or a strict locator.",
    inputSchema: {
      target: z.string().min(1),
      button: z.enum(["left", "right", "middle"]).default("left"),
      clickCount: z.number().int().min(1).max(3).default(1),
    },
  }, async ({ target, button, clickCount }) => result(
    await ego.sdk.page.locator(target).click({ button, clickCount }),
  ));

  registerTool("ego_double_click", {
    description: "Double-click one element using an @ref from the latest snapshot or a strict locator.",
    inputSchema: { target: z.string().min(1) },
  }, async ({ target }) => result(await ego.sdk.page.locator(target).dblclick()));

  registerTool("ego_drag", {
    description: "Drag one element to another element using current snapshot @refs or strict locators.",
    inputSchema: {
      source: z.string().min(1),
      target: z.string().min(1),
      delay: z.number().int().min(0).max(2000).default(50),
    },
  }, async ({ source, target, delay }) => result(
    await ego.sdk.page.locator(source).dragTo(ego.sdk.page.locator(target), { delay }),
  ));

  registerTool("ego_fill", {
    description: "Replace the value of an editable element identified by @ref or locator.",
    inputSchema: { target: z.string().min(1), value: z.string() },
  }, async ({ target, value }) => result(await ego.sdk.page.locator(target).fill(value)));

  registerTool("ego_type", {
    description: "Type text sequentially into an editable element, preserving keyboard events.",
    inputSchema: {
      target: z.string().min(1),
      text: z.string(),
      delay: z.number().int().min(0).max(1000).default(0),
    },
  }, async ({ target, text: value, delay }) => result(
    await ego.sdk.page.locator(target).pressSequentially(value, { delay }),
  ));

  registerTool("ego_hover", {
    description: "Hover an element using an @ref from the latest snapshot or a strict locator.",
    inputSchema: { target: z.string().min(1) },
  }, async ({ target }) => result(await ego.sdk.page.locator(target).hover()));

  registerTool("ego_inspect", {
    description: "Read text, value, state, and selected attributes from one element identified by @ref or locator.",
    inputSchema: {
      target: z.string().min(1),
      attributes: z.array(z.string().min(1)).max(32).default([]),
    },
  }, async ({ target, attributes }) => {
    return withScopedReferenceAction(target, undefined, async () => {
      const locator = ego.sdk.page.locator(target);
      const optional = async <T>(read: () => Promise<T>): Promise<T | null> => {
        try {
          return await read();
        } catch (error) {
          if (typeof (error as { error_code?: unknown })?.error_code === "string") throw error;
          return null;
        }
      };
      return result({
        target,
        textContent: await optional(() => locator.textContent()),
        innerText: await optional(() => locator.innerText()),
        inputValue: await optional(() => locator.inputValue()),
        visible: await optional(() => locator.isVisible()),
        hidden: await optional(() => locator.isHidden()),
        enabled: await optional(() => locator.isEnabled()),
        disabled: await optional(() => locator.isDisabled()),
        editable: await optional(() => locator.isEditable()),
        checked: await optional(() => locator.isChecked()),
        attributes: Object.fromEntries(await Promise.all(attributes.map(async (name: string) => [
          name,
          await optional(() => locator.getAttribute(name)),
        ]))),
      });
    });
  });

  registerTool("ego_wait_for", {
    description: "Wait until a URL, element state, or text condition is satisfied without relying on a fixed sleep.",
    inputSchema: {
      url: z.string().min(1).optional(),
      target: z.string().min(1).optional(),
      text: z.string().optional(),
      state: z.enum(["attached", "visible", "hidden", "detached"]).optional(),
      timeout: z.number().int().min(0).max(120_000).default(20_000),
      polling: z.number().int().min(20).max(2000).default(100),
    },
  }, async ({ url, target, text: wantedText, state, timeout, polling }) => {
    if (!url && !target && wantedText === void 0) {
      throw new Error("ego_wait_for requires url, target, or text");
    }
    const deadline = Date.now() + timeout;
    if (url) {
      const matched = await ego.sdk.page.waitForURL(url, { timeout, waitUntil: "commit" });
      if (!matched) throw new Error(`Timed out waiting for URL: ${url}`);
    }
    const locator = target ? ego.sdk.page.locator(target) : null;
    if (locator && state) {
      const matched = await locator.waitFor({ state, timeout: Math.max(0, deadline - Date.now()) });
      if (!matched) throw new Error(`Timed out waiting for ${target} to be ${state}`);
    }
    if (wantedText !== void 0) {
      await pollUntil(async () => {
        const current = locator
          ? await locator.innerText().catch(() => "")
          : await ego.sdk.page.snapshot({ scope: "viewport", includeActionMarks: false });
        return String(current).includes(wantedText);
      }, deadline, polling, `text ${JSON.stringify(wantedText)}`, ego);
    }
    return result({ matched: true, url: await ego.sdk.page.url(), target: target ?? null, text: wantedText ?? null, state: state ?? null });
  });

  registerTool("ego_click_new_tab", {
    description: "Click an element, wait for a newly opened tab or popup, and optionally select it.",
    inputSchema: {
      target: z.string().min(1),
      timeout: z.number().int().min(1000).max(120_000).default(20_000),
      select: z.boolean().default(true),
    },
  }, async ({ target, timeout, select }) => {
    const before = new Set(tabList(await ego.sdk.browser.listTabs()).map((tab) => tab.targetId));
    await ego.sdk.page.locator(target).click();
    const deadline = Date.now() + timeout;
    let opened: { targetId: string; title?: string; url?: string } | undefined;
    while (Date.now() < deadline) {
      opened = tabList(await ego.sdk.browser.listTabs()).find((tab) => !before.has(tab.targetId));
      if (opened) break;
      await ego.sdk.page.waitForTimeout(100);
    }
    if (!opened) throw new Error("Timed out waiting for a new tab or popup");
    if (select) {
      await ego.sdk.browser.switchTab(opened.targetId);
      await ego.sdk.page.waitForLoadState("load", { timeout: Math.max(1000, deadline - Date.now()) }).catch(() => false);
    }
    opened = tabList(await ego.sdk.browser.listTabs()).find((tab) => tab.targetId === opened?.targetId) ?? opened;
    return result({ ...opened, selected: select });
  });

  registerTool("ego_click_wait_for_response", {
    description: "Atomically start waiting for a matching network response, click an element, and return response details.",
    inputSchema: {
      target: z.string().min(1),
      url: z.string().min(1),
      match: z.enum(["exact", "contains", "regex"]).default("contains"),
      method: z.string().min(1).optional(),
      status: z.number().int().min(100).max(599).optional(),
      timeout: z.number().int().min(100).max(120_000).default(20_000),
      bodyLimit: z.number().int().min(0).max(1_000_000).default(100_000),
    },
  }, async ({ target, url, match, method, status, timeout, bodyLimit }) => {
    const urlMatcher = buildUrlMatcher(url, match);
    const pending = ego.sdk.page.waitForResponse((response) => {
      const request = response.request();
      return urlMatcher(response.url())
        && (method === void 0 || request.method().toUpperCase() === method.toUpperCase())
        && (status === void 0 || response.status() === status);
    }, { timeout });
    await ego.sdk.page.locator(target).click();
    const response = await pending;
    const request = response.request();
    const rawBody = bodyLimit === 0 ? "" : await response.text();
    const truncated = rawBody.length > bodyLimit;
    return result({
      url: response.url(),
      status: response.status(),
      statusText: response.statusText(),
      ok: response.ok(),
      headers: response.headers(),
      request: {
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        postData: request.postData(),
        resourceType: request.resourceType(),
      },
      body: truncated ? rawBody.slice(0, bodyLimit) : rawBody,
      truncated,
    });
  });

  registerTool("ego_upload", {
    description: "Set one or more existing local files on a file input identified by @ref or locator.",
    inputSchema: {
      target: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    },
  }, async ({ target, paths }) => {
    const normalized = paths.map((path: string) => isAbsolute(path) ? path : resolve(path));
    return result(await ego.sdk.page.locator(target).setInputFiles(normalized));
  });

  registerTool("ego_download", {
    description: "Click a download element and wait for the file to complete, optionally saving it to a local path.",
    inputSchema: {
      target: z.string().min(1),
      saveAs: z.string().min(1).optional(),
      timeout: z.number().int().min(1000).max(120_000).default(30_000),
    },
  }, async ({ target, saveAs, timeout }) => {
    const pending = ego.sdk.page.waitForEvent("download", { timeout });
    await ego.sdk.page.locator(target).click();
    const download = await pending;
    const temporaryPath = await download.path();
    const savedPath = saveAs
      ? await download.saveAs(isAbsolute(saveAs) ? saveAs : resolve(saveAs))
      : temporaryPath;
    return result({
      suggestedFilename: download.suggestedFilename(),
      url: download.url(),
      path: savedPath,
    });
  });

  registerTool("ego_dialog_status", {
    description: "Inspect the currently open JavaScript alert, confirm, prompt, or before-unload dialog.",
    inputSchema: {},
  }, async () => result(await ego.sdk.page.dialogInfo()));

  registerTool("ego_dialog_respond", {
    description: "Accept or dismiss the currently open JavaScript dialog, with optional prompt text.",
    inputSchema: {
      accept: z.boolean().default(true),
      promptText: z.string().optional(),
    },
  }, async ({ accept, promptText }) => result(await ego.sdk.page.handleDialog({
    accept,
    ...(promptText !== void 0 ? { promptText } : {}),
  })));

  registerTool("ego_press", {
    description: "Press a key on a target element, or on the page when target is omitted.",
    inputSchema: { key: z.string().min(1), target: z.string().min(1).optional() },
  }, async ({ key, target }) => result(target
    ? await ego.sdk.page.locator(target).press(key)
    : await ego.sdk.page.keyboard.press(key)));

  registerTool("ego_select", {
    description: "Select one or more values in a select element identified by @ref or locator.",
    inputSchema: { target: z.string().min(1), values: z.array(z.string()).min(1) },
  }, async ({ target, values }) => result(await ego.sdk.page.locator(target).selectOption(values)));

  registerTool("ego_check", {
    description: "Set a checkbox or radio element to the requested checked state.",
    inputSchema: { target: z.string().min(1), checked: z.boolean().default(true) },
  }, async ({ target, checked }) => result(checked
    ? await ego.sdk.page.locator(target).check()
    : await ego.sdk.page.locator(target).uncheck()));

  registerTool("ego_scroll", {
    description: "Scroll the page by CSS-pixel deltas, or reveal a target element.",
    inputSchema: {
      deltaX: z.number().default(0),
      deltaY: z.number().default(500),
      target: z.string().min(1).optional(),
    },
  }, async ({ deltaX, deltaY, target }) => result(target
    ? await ego.sdk.page.locator(target).scrollIntoViewIfNeeded()
    : await ego.sdk.page.mouse.wheel(deltaX, deltaY)));

  registerTool("ego_wait", {
    description: "Wait for page loading or for a short bounded duration after an action.",
    inputSchema: {
      loadState: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      milliseconds: z.number().int().min(0).max(10_000).default(500),
    },
  }, async ({ loadState, milliseconds }) => result(loadState
    ? await ego.sdk.page.waitForLoadState(loadState)
    : await ego.sdk.page.waitForTimeout(milliseconds)));

  registerTool("ego_screenshot", {
    description: "Capture the current page and return a PNG for visual inspection.",
    inputSchema: { fullPage: z.boolean().default(false) },
  }, async ({ fullPage }) => {
    const shot = await ego.screenshot({ fullPage });
    return {
      content: [
        { type: "image" as const, data: shot.data, mimeType: "image/png" },
        { type: "text" as const, text: shot.path },
      ],
    };
  });

  return server;
}

export function webMcpToolsExpression(): string {
  return jsonSafeExpression(`(async () => {
    const context = document.modelContext;
    if (!context || typeof context.getTools !== "function") {
      return {
        supported: false,
        origin: location.origin,
        tools: [],
        reason: "The current page does not expose the WebMCP modelContext API",
      };
    }
    const tools = Array.from(await context.getTools());
    return {
      supported: true,
      origin: location.origin,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema || { type: "object", properties: {} },
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    };
  })()`);
}

export function webMcpCallExpression(tool: string, input: Record<string, unknown>): string {
  return jsonSafeExpression(`(async () => {
    const context = document.modelContext;
    if (!context || typeof context.getTools !== "function" || typeof context.executeTool !== "function") {
      throw new Error("The current page does not expose callable WebMCP tools");
    }
    const toolName = ${JSON.stringify(tool)};
    const available = Array.from(await context.getTools());
    const selected = available.find((candidate) => candidate && candidate.name === toolName);
    if (!selected) {
      throw new Error("WebMCP tool is not available on the current page: " + toolName);
    }
    const rawOutput = await context.executeTool(selected, ${JSON.stringify(input)});
    let output = rawOutput;
    if (typeof rawOutput === "string") {
      try { output = JSON.parse(rawOutput); } catch {}
    }
    return {
      tool: toolName,
      output,
    };
  })()`);
}

const OPERATION_TITLES: Record<string, string> = {
  ego_run: "连续执行浏览器任务",
  ego_extract: "提取页面数据",
  ego_automation_cancel: "停止连续任务",
  ego_status: "检查浏览器连接状态",
  ego_task_use: "选择任务空间",
  ego_task_handoff: "将浏览器交还用户",
  ego_task_complete: "完成浏览器任务",
  ego_task_close: "关闭浏览器任务",
  ego_tabs: "读取标签页列表",
  ego_open: "打开网页",
  ego_tab_select: "切换标签页",
  ego_tab_close: "关闭标签页",
  ego_navigate: "执行页面导航",
  ego_snapshot: "读取页面结构",
  ego_page_info: "读取页面信息",
  ego_webmcp_tools: "读取网站工具",
  ego_webmcp_call: "调用网站工具",
  ego_evaluate: "执行页面脚本",
  ego_browser_fetch: "发起页面请求",
  ego_click: "点击页面元素",
  ego_double_click: "双击页面元素",
  ego_drag: "拖动页面元素",
  ego_fill: "填写页面字段",
  ego_type: "向页面输入文字",
  ego_hover: "悬停页面元素",
  ego_inspect: "检查页面元素",
  ego_wait_for: "等待页面条件",
  ego_click_new_tab: "点击并等待新标签页",
  ego_click_wait_for_response: "点击并等待网络响应",
  ego_upload: "上传文件",
  ego_download: "下载文件",
  ego_dialog_status: "检查网页对话框",
  ego_dialog_respond: "处理网页对话框",
  ego_press: "发送键盘按键",
  ego_select: "选择下拉选项",
  ego_check: "切换复选框",
  ego_scroll: "滚动页面",
  ego_wait: "等待页面加载",
  ego_screenshot: "截取页面画面",
};

function toolAnnotations(name: string) {
  const readOnly = new Set([
    "ego_status",
    "ego_task_observe",
    "ego_tabs",
    "ego_snapshot",
    "ego_page_info",
    "ego_webmcp_tools",
    "ego_inspect",
    "ego_dialog_status",
    "ego_screenshot",
  ]).has(name);
  const destructive = new Set([
    "ego_run",
    "ego_task_close",
    "ego_tab_close",
  ]).has(name);
  const openWorld = new Set([
    "ego_run",
    "ego_extract",
    "ego_open",
    "ego_navigate",
    "ego_browser_fetch",
    "ego_click",
    "ego_double_click",
    "ego_click_new_tab",
    "ego_click_wait_for_response",
    "ego_download",
    "ego_evaluate",
    "ego_webmcp_call",
  ]).has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: readOnly,
    openWorldHint: openWorld,
  };
}

function operationTitle(name: string, args: Record<string, unknown>): string {
  const base = OPERATION_TITLES[name] || name;
  if (name === "ego_open" && typeof args.url === "string") return `${base}：${shortText(args.url, 160)}`;
  if (name === "ego_task_use" && ["string", "number"].includes(typeof args.task)) return `${base}：${String(args.task)}`;
  if (name === "ego_navigate" && typeof args.action === "string") {
    return `${base}：${({ back: "后退", forward: "前进", reload: "刷新" } as Record<string, string>)[args.action] || args.action}`;
  }
  if (name === "ego_webmcp_call" && typeof args.tool === "string") return `${base}：${shortText(args.tool, 160)}`;
  return base;
}

function operationDetail(name: string, args: Record<string, unknown>): string | undefined {
  const safe: Record<string, unknown> = {};
  const allowed = ["target", "source", "action", "scope", "url", "method", "state", "key", "accept", "checked", "tool"];
  for (const key of allowed) {
    const value = args[key];
    if (typeof value === "string") safe[key] = shortText(value, key === "url" ? 240 : 160);
    else if (typeof value === "boolean" || typeof value === "number") safe[key] = value;
  }
  if (["ego_fill", "ego_type", "ego_evaluate", "ego_browser_fetch", "ego_webmcp_call"].includes(name)) safe.content = "已隐藏";
  return Object.keys(safe).length ? JSON.stringify(safe) : undefined;
}

function failureOperationDetail(detail: string | undefined, error: unknown): string | undefined {
  const message = error instanceof Error ? error.message.slice(0, 1_000) : String(error || "").slice(0, 1_000);
  try {
    const parsed = detail ? JSON.parse(detail) as Record<string, unknown> : {};
    return JSON.stringify({ ...parsed, ...(message ? { error: message } : {}) });
  } catch {
    return message || detail;
  }
}

const SCOPED_MCP_ERROR_GUIDANCE: Record<string, string> = {
  EGO_ACTION_RESULT_UNKNOWN: "The action may have happened. Observe the current page state before deciding what to do. Do not automatically replay it.",
  EGO_REFERENCE_STALE: "Take a fresh snapshot and choose a current ref before retrying.",
  EGO_REFERENCE_DETACHED: "The referenced node is detached. Take a fresh snapshot before choosing another target.",
  EGO_FRAME_UNAVAILABLE: "The referenced frame is unavailable. Take a fresh snapshot before retrying.",
  EGO_ACTION_EXPIRED: "The scoped action expired before a confirmed result. Take a fresh snapshot before retrying.",
  EGO_ACTION_CONTEXT_INVALID: "The scoped action context is no longer valid. Take a fresh snapshot before retrying.",
  EGO_ACTION_SCOPE_MISMATCH: "The ref no longer belongs to the selected page scope. Select the intended page and take a fresh snapshot.",
};

export function scopedMcpToolError(error: unknown): unknown {
  const code = typeof (error as { error_code?: unknown })?.error_code === "string"
    ? (error as { error_code: string }).error_code
    : undefined;
  const guidance = code ? SCOPED_MCP_ERROR_GUIDANCE[code] : undefined;
  if (!code || !guidance) return error;
  return Object.assign(new Error(`[${code}] ${guidance}`), {
    error_code: code,
  });
}

function shortText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function result(value: unknown) {
  return text(JSON.stringify(value ?? null, null, 2));
}

async function pollUntil(
  predicate: () => Promise<boolean>,
  deadline: number,
  polling: number,
  description: string,
  ego: EgoMcpSession,
): Promise<void> {
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await ego.sdk.page.waitForTimeout(polling);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function tabList(value: unknown): Array<{ targetId: string; title?: string; url?: string }> {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { tabs?: unknown }).tabs)) {
    return (value as { tabs: Array<{ targetId: string; title?: string; url?: string }> }).tabs;
  }
  return [];
}

function parseBody(raw: string, mode: "auto" | "json" | "text"): unknown {
  if (mode === "text") return raw;
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (mode === "json") {
      throw new Error(`Browser fetch returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return raw;
  }
}

function buildUrlMatcher(pattern: string, mode: "exact" | "contains" | "regex"): (url: string) => boolean {
  if (mode === "exact") return (url) => url === pattern;
  if (mode === "contains") return (url) => url.includes(pattern);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new Error(`Invalid response URL regex: ${error instanceof Error ? error.message : String(error)}`);
  }
  return (url) => {
    regex.lastIndex = 0;
    return regex.test(url);
  };
}

function jsonSafeExpression(expression: string): string {
  return `(async () => {
    const seen = new WeakSet();
    const normalize = (value, path) => {
      if (value === null || typeof value === "string" || typeof value === "boolean") return value;
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : { type: "number", value: String(value) };
      }
      if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
      if (typeof value === "undefined") return { type: "undefined" };
      if (typeof value === "function" || typeof value === "symbol") {
        throw new Error(path + " is not JSON-serializable (" + typeof value + ")");
      }
      if (typeof Node !== "undefined" && value instanceof Node) {
        throw new Error(path + " is a DOM node; return its text, attributes, or other serializable data instead");
      }
      if (seen.has(value)) throw new Error("Circular reference at " + path);
      seen.add(value);
      if (Array.isArray(value)) return value.map((item, index) => normalize(item, path + "[" + index + "]"));
      if (value instanceof Date) return value.toISOString();
      const output = {};
      for (const [key, item] of Object.entries(value)) output[key] = normalize(item, path + "." + key);
      return output;
    };
    return normalize(await (${expression}), "$");
  })()`;
}
