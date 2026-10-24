import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { BrokerPipeServer } from "../../broker/src/server.ts";
import { BrokerCore, TaskSpaceService } from "@ego-compat/broker-core";
import { ManagedEdgeBackend } from "@ego-compat/managed-edge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer as createEgoServer, webMcpCallExpression, webMcpToolsExpression } from "./server.ts";

test("MCP surfaces scoped error code and replay guidance without sensitive details", async () => {
  let nextError: any = Object.assign(new Error("secret-token objectId=remote-1 payload={hidden}"), {
    error_code: "EGO_ACTION_RESULT_UNKNOWN",
  });
  const fake = {
    recordOperation: async () => {},
    sdk: {
      page: {
        locator: () => ({
          click: async () => { throw nextError; },
          textContent: async () => { throw nextError; },
        }),
      },
    },
  };
  const server = createEgoServer(fake as any);
  const client = new Client({ name: "scoped-error-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const scoped = await client.callTool({ name: "ego_click", arguments: { target: "@1" } });
    const scopedText = textOf(scoped);
    assert.equal(scoped.isError, true);
    assert.match(scopedText, /EGO_ACTION_RESULT_UNKNOWN/);
    assert.match(scopedText, /may have happened/i);
    assert.match(scopedText, /Do not automatically replay/i);
    assert.doesNotMatch(scopedText, /secret-token|objectId|payload=/);

    nextError = new Error("legacy generic failure");
    const legacy = await client.callTool({ name: "ego_click", arguments: { target: "#button" } });
    assert.equal(legacy.isError, true);
    assert.match(textOf(legacy), /legacy generic failure/);

    nextError = Object.assign(new Error("stale detail"), { error_code: "EGO_REFERENCE_STALE" });
    const inspect = await client.callTool({ name: "ego_inspect", arguments: { target: "#button", attributes: [] } });
    assert.equal(inspect.isError, true);
    assert.match(textOf(inspect), /EGO_REFERENCE_STALE/);
    assert.match(textOf(inspect), /fresh snapshot/i);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

test("WebMCP page expressions discover and invoke structured site tools", async () => {
  let received: unknown;
  const sandbox = {
    location: { origin: "https://tasks.example" },
    document: {
      modelContext: {
        async getTools() {
          return [{
            name: "create_task",
            description: "Create one task",
            inputSchema: { type: "object", properties: { name: { type: "string" } } },
            annotations: { readOnlyHint: false },
          }];
        },
        async executeTool(tool: { name: string }, input: unknown) {
          received = { name: tool.name, input };
          return JSON.stringify({ content: [{ type: "text", text: "created" }] });
        },
      },
    },
  };

  const discovered = await runInNewContext(webMcpToolsExpression(), sandbox);
  assert.equal(discovered.supported, true);
  assert.equal(discovered.origin, "https://tasks.example");
  assert.equal(discovered.tools[0].name, "create_task");
  assert.equal(discovered.tools[0].annotations.readOnlyHint, false);

  const called = await runInNewContext(
    webMcpCallExpression("create_task", { name: "Structured task" }),
    sandbox,
  );
  assert.equal((received as { name?: string })?.name, "create_task");
  assert.equal((received as { input?: { name?: string } })?.input?.name, "Structured task");
  assert.equal(called.tool, "create_task");
  assert.equal(called.output.content[0].text, "created");
});

test("WebMCP discovery reports unsupported pages without failing", async () => {
  const discovered = await runInNewContext(webMcpToolsExpression(), {
    location: { origin: "https://legacy.example" },
    document: {},
  });
  assert.equal(discovered.supported, false);
  assert.equal(discovered.origin, "https://legacy.example");
  assert.equal(discovered.tools.length, 0);
  assert.equal(discovered.reason, "The current page does not expose the WebMCP modelContext API");
});

test("MCP protocol client drives the Ego task, tab, and snapshot workflow", async () => {
  const pipeName = `\\\\.\\pipe\\ego-mcp-test-${randomUUID()}`;
  const operations: any[] = [];
  const operationStore = {
    listOperations: (taskId: string) => operations.filter((record) => record.taskId === taskId),
    saveOperation: (record: any) => {
      const index = operations.findIndex((candidate) => candidate.id === record.id);
      if (index >= 0) operations[index] = record;
      else operations.push(record);
    },
    clearOperations: (taskId: string) => {
      for (let index = operations.length - 1; index >= 0; index -= 1) {
        if (operations[index].taskId === taskId) operations.splice(index, 1);
      }
    },
  };
  const broker = new BrokerPipeServer(undefined, undefined, undefined, operationStore);
  await broker.listen(pipeName);
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  env.EGO_COMPAT_PIPE = pipeName;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./main.ts", import.meta.url).pathname.slice(1)],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "ego-mcp-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "ego_snapshot"));
    assert.ok("maxResultLength" in (tools.tools.find((tool) => tool.name === "ego_snapshot")?.inputSchema.properties || {}));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_fill"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_type"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_hover"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_upload"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_download"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_dialog_status"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_dialog_respond"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_navigate"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_inspect"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_wait_for"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_click_new_tab"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_double_click"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_drag"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_page_info"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_webmcp_tools"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_webmcp_call"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_evaluate"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_browser_fetch"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_click_wait_for_response"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_task_complete"));
    assert.ok(tools.tools.some((tool) => tool.name === "ego_task_close"));
    assert.equal(tools.tools.find((tool) => tool.name === "ego_status")?.annotations?.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === "ego_webmcp_tools")?.annotations?.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === "ego_webmcp_call")?.annotations?.openWorldHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === "ego_task_close")?.annotations?.destructiveHint, true);
    const status = await client.callTool({ name: "ego_status", arguments: {} });
    assert.match(textOf(status), /"ready": true/);
    assert.match(textOf(status), /"kind": "fake"/);

    const selected = await client.callTool({
      name: "ego_task_use",
      arguments: { task: "Codex MCP fixture" },
    });
    assert.match(textOf(selected), /Codex MCP fixture/);

    const opened = await client.callTool({
      name: "ego_open",
      arguments: { url: "https://example.com", wait: true },
    });
    assert.match(textOf(opened), /example\.com/);
    for (const match of ["exact", "origin", "origin+path", "includes"]) {
      const reused = await client.callTool({ name: "ego_open", arguments: { url: "https://example.com", wait: false, match } });
      assert.match(textOf(reused), /"reused": true/);
    }

    const snapshot = await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    });
    assert.match(textOf(snapshot), /document "https:\/\/example\.com"/);
    assert.ok(operations.some((record) => record.tool === "ego_task_use" && record.status === "completed"));
    assert.ok(operations.some((record) => record.tool === "ego_open" && record.status === "completed" && record.title.includes("example.com")));
    assert.ok(operations.some((record) => record.tool === "ego_snapshot" && record.status === "completed"));
    const closed = await client.callTool({
      name: "ego_task_close",
      arguments: { task: "Codex MCP fixture" },
    });
    assert.match(textOf(closed), /"done": true/);
    const afterClose = await client.callTool({ name: "ego_status", arguments: {} });
    assert.doesNotMatch(textOf(afterClose), /Codex MCP fixture/);
  } finally {
    await client.close().catch(() => {});
    await broker.close().catch(() => {});
  }
});

test("Codex MCP entry reuses its opaque thread identity after reconnecting", { timeout: 20_000 }, async () => {
  const pipeName = `\\\\.\\pipe\\ego-mcp-identity-${randomUUID()}`;
  const broker = new BrokerPipeServer();
  const threadId = "codex-thread-secret-that-must-not-leak";
  let first: Awaited<ReturnType<typeof connectMcp>> | undefined;
  let second: Awaited<ReturnType<typeof connectMcp>> | undefined;
  await broker.listen(pipeName);

  try {
    first = await connectMcp(pipeName, {
      EGO_BROWSER_AGENT_ID: undefined,
      CODEX_THREAD_ID: threadId,
    });
    await first.client.callTool({ name: "ego_status", arguments: {} });
    await first.client.callTool({ name: "ego_status", arguments: {} });
    const firstAgent = broker.broker.agents.list()[0];
    assert.ok(firstAgent);
    assert.match(firstAgent.clientId, /^codex-[a-f0-9]{24}$/);
    assert.doesNotMatch(firstAgent.clientId, /codex-thread-secret/);

    await first.client.close();
    first = undefined;
    await waitFor(() => broker.broker.agents.get(firstAgent.clientId)?.status === "offline");

    second = await connectMcp(pipeName, {
      EGO_BROWSER_AGENT_ID: undefined,
      CODEX_THREAD_ID: threadId,
    });
    await second.client.callTool({ name: "ego_status", arguments: {} });
    await second.client.callTool({ name: "ego_status", arguments: {} });
    await waitFor(() => broker.broker.agents.get(firstAgent.clientId)?.status === "online");

    const reconnectedAgents = broker.broker.agents.list();
    assert.equal(reconnectedAgents.length, 1);
    assert.equal(reconnectedAgents[0]?.clientId, firstAgent.clientId);
  } finally {
    await first?.client.close().catch(() => {});
    await second?.client.close().catch(() => {});
    await broker.close().catch(() => {});
  }
});

test("Codex MCP tools fill and submit a real Managed Edge form using snapshot refs", { timeout: 45_000 }, async (t) => {
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  try {
    await readFile(edgePath);
  } catch {
    t.skip("Microsoft Edge is not installed");
    return;
  }

  const profilePath = await mkdtemp(join(tmpdir(), "ego-mcp-edge-"));
  const uploadPath = join(profilePath, "mcp-upload-fixture.txt");
  const downloadPath = join(profilePath, "mcp-download-fixture.txt");
  await writeFile(uploadPath, "ego upload fixture", "utf8");
  const fixture = await startFixtureServer();
  const backend = new ManagedEdgeBackend({ executablePath: edgePath, profilePath, headless: true });
  const broker = new BrokerPipeServer(
    new BrokerCore(new TaskSpaceService({ backend: "managed" }), backend),
  );
  const pipeName = `\\\\.\\pipe\\ego-mcp-managed-${randomUUID()}`;
  await broker.listen(pipeName);
  const { client, transport } = await connectMcp(pipeName);

  try {
    const taskUse = textOf(await client.callTool({ name: "ego_task_use", arguments: { task: "Codex real browser" } }));
    assert.match(taskUse, /Codex real browser/);
    const openResult = textOf(await client.callTool({ name: "ego_open", arguments: { url: fixture.url, wait: true } }));
    assert.match(openResult, /form\.html/);
    const webMcpTools = textOf(await client.callTool({ name: "ego_webmcp_tools", arguments: {} }));
    assert.match(webMcpTools, /"supported": true/);
    assert.match(webMcpTools, /"name": "create_task"/);
    assert.match(webMcpTools, /Create a task through the page's WebMCP API/);
    const webMcpResult = textOf(await client.callTool({
      name: "ego_webmcp_call",
      arguments: { tool: "create_task", input: { name: "Structured task" } },
    }));
    assert.match(webMcpResult, /"tool": "create_task"/);
    assert.match(webMcpResult, /Created via WebMCP: Structured task/);
    const afterWebMcp = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    assert.match(afterWebMcp, /Created via WebMCP: Structured task/);
    const pageInfo = textOf(await client.callTool({ name: "ego_page_info", arguments: {} }));
    assert.match(pageInfo, /Ego Windows compatibility fixture/);
    assert.match(pageInfo, /"w":/);
    const evaluated = textOf(await client.callTool({
      name: "ego_evaluate",
      arguments: { expression: "({ title: document.title, marker: 6 * 7 })" },
    }));
    assert.match(evaluated, /"marker": 42/);
    const evaluatedAsync = textOf(await client.callTool({
      name: "ego_evaluate",
      arguments: { expression: "Promise.resolve({ big: 9007199254740993n })" },
    }));
    assert.match(evaluatedAsync, /"type": "bigint"/);
    assert.match(evaluatedAsync, /9007199254740993/);
    await client.callTool({
      name: "ego_evaluate",
      arguments: { expression: "document.cookie = 'ego_fixture=active; path=/'" },
    });
    const fetched = textOf(await client.callTool({
      name: "ego_browser_fetch",
      arguments: { url: "/api/context", parse: "json" },
    }));
    assert.match(fetched, /"message": "browser-context-ok"/);
    assert.match(fetched, /"cookie": "ego_fixture=active"/);
    const first = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    const textbox = /textbox \[ref=(@\d+)\]/.exec(first)?.[1];
    const button = /button \[ref=(@\d+)\]/.exec(first)?.[1];
    assert.ok(textbox, first);
    assert.ok(button, first);

    await client.callTool({
      name: "ego_fill",
      arguments: { target: textbox, value: "Codex MCP" },
    });
    const fresh = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    const freshButton = /button \[ref=(@\d+)\]/.exec(fresh)?.[1];
    assert.ok(freshButton, fresh);
    await client.callTool({ name: "ego_click", arguments: { target: freshButton } });
    const submitted = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    assert.match(submitted, /Created: Codex MCP/);

    const freshTextbox = /textbox \[ref=(@\d+)\]/.exec(submitted)?.[1];
    assert.ok(freshTextbox, submitted);
    await client.callTool({ name: "ego_fill", arguments: { target: freshTextbox, value: "" } });
    await client.callTool({
      name: "ego_type",
      arguments: { target: freshTextbox, text: "中文🙂", delay: 1 },
    });
    const typed = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    assert.match(typed, /value="中文🙂"/);

    const hoverRef = refFromLine(typed, /Hover target/i);
    assert.ok(hoverRef, typed);
    await client.callTool({ name: "ego_hover", arguments: { target: hoverRef } });
    const hovered = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    assert.match(hovered, /Hovered by Ego/);

    const doubleRef = refFromLine(hovered, /Double click target/i);
    const contextRef = refFromLine(hovered, /Context menu target/i);
    const dragSourceRef = refFromLine(hovered, /Drag source/i);
    const dropTargetRef = refFromLine(hovered, /Drop target/i);
    const hideTriggerRef = refFromLine(hovered, /Hide dynamic target/i);
    const dynamicTargetRef = refFromLine(hovered, /loc="#dynamic-target"/i);
    assert.ok(doubleRef && contextRef && dragSourceRef && dropTargetRef && hideTriggerRef && dynamicTargetRef, hovered);
    await client.callTool({ name: "ego_double_click", arguments: { target: doubleRef } });
    await client.callTool({
      name: "ego_click",
      arguments: { target: contextRef, button: "right", clickCount: 1 },
    });
    await client.callTool({
      name: "ego_drag",
      arguments: { source: dragSourceRef, target: dropTargetRef, delay: 50 },
    });
    const mouseActions = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    assert.match(mouseActions, /Double clicked by Ego \(2 clicks\)/);
    assert.match(mouseActions, /Context opened by Ego/);
    assert.doesNotMatch(mouseActions, /Unexpected left click/);
    assert.match(mouseActions, /Dropped by Ego/);

    const apiRef = refFromLine(mouseActions, /Load API result/i);
    assert.ok(apiRef, mouseActions);
    const apiResponse = textOf(await client.callTool({
      name: "ego_click_wait_for_response",
      arguments: {
        target: apiRef,
        url: "/api/action",
        match: "contains",
        method: "POST",
        status: 201,
        timeout: 10_000,
      },
    }));
    assert.match(apiResponse, /"status": 201/);
    assert.match(apiResponse, /"method": "POST"/);
    assert.match(apiResponse, /fixture-click/);

    const freshHideTrigger = refFromLine(mouseActions, /Hide dynamic target/i);
    const freshDynamicTarget = refFromLine(mouseActions, /loc="#dynamic-target"/i);
    assert.ok(freshHideTrigger && freshDynamicTarget, mouseActions);
    await client.callTool({ name: "ego_click", arguments: { target: freshHideTrigger } });
    const hidden = textOf(await client.callTool({
      name: "ego_wait_for",
      arguments: { target: freshDynamicTarget, state: "hidden", timeout: 5_000 },
    }));
    assert.match(hidden, /"matched": true/);
    const detached = textOf(await client.callTool({
      name: "ego_wait_for",
      arguments: { target: freshDynamicTarget, state: "detached", timeout: 5_000 },
    }));
    assert.match(detached, /"matched": true/);

    const afterDynamic = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    const uploadRef = refFromLine(afterDynamic, /Upload file|Choose File|upload/i);
    const downloadRef = refFromLine(afterDynamic, /Download file/i);
    const dialogRef = refFromLine(afterDynamic, /Open dialog/i);
    assert.ok(uploadRef, submitted);
    assert.ok(downloadRef, submitted);
    assert.ok(dialogRef, submitted);

    await client.callTool({
      name: "ego_upload",
      arguments: { target: uploadRef, paths: [uploadPath] },
    });
    const uploaded = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    assert.match(uploaded, /mcp-upload-fixture\.txt/);

    const freshDownloadRef = refFromLine(uploaded, /Download file/i);
    assert.ok(freshDownloadRef, uploaded);
    const downloaded = textOf(await client.callTool({
      name: "ego_download",
      arguments: { target: freshDownloadRef, saveAs: downloadPath },
    }));
    assert.match(downloaded, /ego-fixture\.txt/);
    assert.equal(await readFile(downloadPath, "utf8"), "ego download fixture");

    const afterDownload = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    const freshDialogRef = refFromLine(afterDownload, /Open dialog/i);
    assert.ok(freshDialogRef, afterDownload);
    await client.callTool({ name: "ego_click", arguments: { target: freshDialogRef } });
    await client.callTool({ name: "ego_wait", arguments: { milliseconds: 100 } });
    const dialog = textOf(await client.callTool({ name: "ego_dialog_status", arguments: {} }));
    assert.match(dialog, /Ego dialog/);
    assert.match(dialog, /alert/);
    const handled = textOf(await client.callTool({
      name: "ego_dialog_respond",
      arguments: { accept: true },
    }));
    assert.match(handled, /"handled": true/);
    const cleared = textOf(await client.callTool({ name: "ego_dialog_status", arguments: {} }));
    assert.equal(cleared.trim(), "null");

    const historyOneUrl = new URL("/history-one", fixture.url).href;
    const historyTwoUrl = new URL("/history-two", fixture.url).href;
    await client.callTool({ name: "ego_open", arguments: { url: historyOneUrl, wait: true } });
    const historyOne = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    const historyLink = refFromLine(historyOne, /Go history two/i);
    assert.ok(historyLink, historyOne);
    const inspected = textOf(await client.callTool({
      name: "ego_inspect",
      arguments: { target: historyLink, attributes: ["href"] },
    }));
    assert.match(inspected, /history-two/);
    assert.match(inspected, /history two/i);
    await client.callTool({ name: "ego_click", arguments: { target: historyLink } });
    await client.callTool({
      name: "ego_wait_for",
      arguments: { url: historyTwoUrl, text: "History page two", timeout: 10_000 },
    });
    const back = textOf(await client.callTool({
      name: "ego_navigate",
      arguments: { action: "back", waitUntil: "load" },
    }));
    assert.match(back, /history-one/);
    const forward = textOf(await client.callTool({
      name: "ego_navigate",
      arguments: { action: "forward", waitUntil: "load" },
    }));
    assert.match(forward, /history-two/);
    const reloaded = textOf(await client.callTool({
      name: "ego_navigate",
      arguments: { action: "reload", waitUntil: "load", ignoreCache: true },
    }));
    assert.match(reloaded, /history-two/);

    await client.callTool({ name: "ego_open", arguments: { url: fixture.url, wait: true } });
    const beforePopup = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    const popupRef = refFromLine(beforePopup, /Open popup/i);
    assert.ok(popupRef, beforePopup);
    const popup = textOf(await client.callTool({
      name: "ego_click_new_tab",
      arguments: { target: popupRef, select: true, timeout: 10_000 },
    }));
    assert.match(popup, /\/popup/);
    const popupSnapshot = textOf(await client.callTool({
      name: "ego_snapshot",
      arguments: { scope: "viewport", stableLocators: true },
    }));
    assert.match(popupSnapshot, /Popup content/);
  } finally {
    await client.close().catch(() => {});
    await broker.close().catch(() => {});
    await fixture.close().catch(() => {});
    await rm(profilePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function connectMcp(
  pipeName: string,
  environment: Record<string, string | undefined> = {},
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  env.EGO_COMPAT_PIPE = pipeName;
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./main.ts", import.meta.url).pathname.slice(1)],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "ego-mcp-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for MCP session state");
}

async function startFixtureServer(): Promise<{ url: string; close(): Promise<void> }> {
  const html = await readFile(new URL("../../../fixtures/browser/form.html", import.meta.url), "utf8");
  const server = createHttpServer((request, response) => {
    if (request.url === "/api/context") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({
        message: "browser-context-ok",
        cookie: request.headers.cookie || "",
      }));
      return;
    }
    if (request.url?.startsWith("/api/action")) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        response.writeHead(201, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ message: "network action complete", received: JSON.parse(body || "null") }));
      });
      return;
    }
    if (request.url === "/download") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="ego-fixture.txt"',
      });
      response.end("ego download fixture");
      return;
    }
    if (request.url === "/history-one") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><title>History one</title><h1>History page one</h1><a href="/history-two">Go history two</a>');
      return;
    }
    if (request.url === "/history-two") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><title>History two</title><h1>History page two</h1>');
      return;
    }
    if (request.url === "/popup") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Ego popup</title><h1>Popup content</h1>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/form.html`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

function refFromLine(snapshot: string, pattern: RegExp): string | undefined {
  return snapshot
    .split(/\r?\n/)
    .find((line) => line.includes("[ref=@") && pattern.test(line))
    ?.match(/\[ref=(@\d+)\]/)?.[1];
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = Array.isArray(result.content) ? result.content as Array<{ type?: string; text?: string }> : [];
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("\n");
}
