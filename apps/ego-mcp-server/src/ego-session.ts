import { readFile } from "node:fs/promises";

import {
  createEgoRuntime,
  PipeRuntimeTransport,
  PROTOCOL_VERSION,
  resolveAgentClientId,
  SCOPED_REFS_CAPABILITY,
  startRuntimeKeepalive,
  type RuntimeKeepaliveController,
} from "@ego-compat/runtime-adapter";
import type { BrowserBackendStatus } from "@ego-compat/protocol";
import { installEgoSdk } from "../../../vendor/ego-browser/src/index.js";
import { ensureDesktopHost } from "./desktop-host.ts";

interface EgoPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  reload(options?: Record<string, unknown>): Promise<unknown>;
  goBack(options?: Record<string, unknown>): Promise<unknown>;
  goForward(options?: Record<string, unknown>): Promise<unknown>;
  url(): Promise<string>;
  title(): Promise<string>;
  info(): Promise<Record<string, unknown>>;
  evaluate(expression: string): Promise<unknown>;
  waitForURL(url: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForRequest(
    matcher: string | RegExp | ((request: EgoRequest) => boolean),
    options?: { timeout?: number },
  ): Promise<EgoRequest>;
  waitForResponse(
    matcher: string | RegExp | ((response: EgoResponse) => boolean),
    options?: { timeout?: number },
  ): Promise<EgoResponse>;
  snapshot(options?: Record<string, unknown>): Promise<string>;
  screenshot(options?: Record<string, unknown>): Promise<string>;
  dialogInfo(): Promise<Record<string, unknown> | null>;
  handleDialog(options?: { accept?: boolean; promptText?: string }): Promise<unknown>;
  waitForEvent(eventName: "download", options?: { timeout?: number }): Promise<{
    suggestedFilename(): string;
    url(): string;
    path(): Promise<string>;
    saveAs(path: string): Promise<string>;
  }>;
  locator(selector: string): {
    count(): Promise<number>;
    click(options?: Record<string, unknown>): Promise<unknown>;
    dblclick(options?: Record<string, unknown>): Promise<unknown>;
    dragTo(target: unknown, options?: Record<string, unknown>): Promise<unknown>;
    fill(value: string, options?: Record<string, unknown>): Promise<unknown>;
    press(key: string, options?: Record<string, unknown>): Promise<unknown>;
    selectOption(value: string | string[]): Promise<unknown>;
    check(options?: Record<string, unknown>): Promise<unknown>;
    uncheck(options?: Record<string, unknown>): Promise<unknown>;
    hover(options?: Record<string, unknown>): Promise<unknown>;
    scrollIntoViewIfNeeded(options?: Record<string, unknown>): Promise<unknown>;
    pressSequentially(text: string, options?: Record<string, unknown>): Promise<unknown>;
    setInputFiles(path: string | string[]): Promise<unknown>;
    textContent(): Promise<string | null>;
    innerText(): Promise<string>;
    inputValue(): Promise<string>;
    isChecked(): Promise<boolean>;
    isVisible(): Promise<boolean>;
    isHidden(): Promise<boolean>;
    isEnabled(): Promise<boolean>;
    isDisabled(): Promise<boolean>;
    isEditable(): Promise<boolean>;
    getAttribute(name: string): Promise<string | null>;
    waitFor(options?: Record<string, unknown>): Promise<unknown>;
  };
  keyboard: { press(key: string): Promise<unknown>; type(text: string): Promise<unknown> };
  mouse: { wheel(deltaX: number, deltaY: number): Promise<unknown> };
  waitForTimeout(ms: number): Promise<unknown>;
  waitForLoadState(state?: string, options?: Record<string, unknown>): Promise<unknown>;
}

interface EgoRequest {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
  postData(): string | null;
  resourceType(): string;
}

interface EgoResponse {
  url(): string;
  status(): number;
  statusText(): string;
  ok(): boolean;
  headers(): Record<string, string>;
  request(): EgoRequest;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

interface EgoBrowser {
  listTabs(): Promise<unknown>;
  currentTab(): Promise<unknown>;
  switchTab(target: string): Promise<unknown>;
  openOrReuseTab(url: string, options?: Record<string, unknown>): Promise<unknown>;
  closeTab(target: string): Promise<unknown>;
}

interface EgoTaskSpaces {
  observe(nameOrId: string | number, targetId?: string): Promise<unknown>;
  requestControl(nameOrId: string | number): Promise<unknown>;
  returnControl(nameOrId: string | number, requestId?: string): Promise<unknown>;
  list(): Promise<unknown>;
  switch(nameOrId: string | number): Promise<unknown>;
  new(name: string): Promise<unknown>;
  useOrCreate(nameOrId: string | number): Promise<unknown>;
  claim(nameOrId: string | number): Promise<unknown>;
  complete(nameOrId: string | number, options?: Record<string, unknown>): Promise<unknown>;
  handOff(nameOrId?: string | number): Promise<unknown>;
  takeOver(nameOrId?: string | number): Promise<unknown>;
}

interface EgoSdkContext {
  page: EgoPage;
  browser: EgoBrowser;
  taskSpaces: EgoTaskSpaces;
  fetch: {
    browser(url: string, options?: Record<string, unknown>): Promise<string>;
  };
}

export class EgoMcpSession {
  readonly #transport: PipeRuntimeTransport;
  readonly #clientId: string;
  readonly #keepalive: RuntimeKeepaliveController;
  readonly sdk: EgoSdkContext;
  readonly #automationRequest: (operation: string, input: Record<string, unknown>) => Promise<unknown>;

  private constructor(
    transport: PipeRuntimeTransport,
    clientId: string,
    sdk: EgoSdkContext,
    keepalive: RuntimeKeepaliveController,
    automationRequest: (operation: string, input: Record<string, unknown>) => Promise<unknown>,
  ) {
    this.#transport = transport;
    this.#clientId = clientId;
    this.#keepalive = keepalive;
    this.sdk = sdk;
    this.#automationRequest = automationRequest;
  }

  static async connect(
    pipeName: string,
    options: { autoStartDesktop?: boolean } = {},
  ): Promise<EgoMcpSession> {
    if (options.autoStartDesktop) {
      await ensureDesktopHost({
        pipeName,
        ...(process.env.EGO_DESKTOP_AUTOMATION_PIPE
          ? { automationPipeName: process.env.EGO_DESKTOP_AUTOMATION_PIPE }
          : {}),
        ...(process.env.EGO_DESKTOP_EXECUTABLE
          ? { executablePath: process.env.EGO_DESKTOP_EXECUTABLE }
          : {}),
        ...(process.env.EGO_DESKTOP_APP_PATH
          ? { appPath: process.env.EGO_DESKTOP_APP_PATH }
          : {}),
      });
    }
    const transport = await PipeRuntimeTransport.connect(pipeName);
    let keepalive: RuntimeKeepaliveController | undefined;
    try {
      // Stable Codex thread identities are shared with the CLI.
      const clientId = resolveAgentClientId(process.env, { namespace: "mcp" });
      await transport.negotiateHello({
        protocolVersion: PROTOCOL_VERSION,
        clientId,
        pid: process.pid,
        sdkVersion: process.env.EGO_AGENT_VERSION || "ego-mcp-server",
        clientKind: validAgentKind(process.env.EGO_AGENT_KIND) ?? "codex",
        displayName: process.env.EGO_AGENT_NAME || "Codex",
        version: process.env.EGO_AGENT_VERSION || "ego-mcp-server",
        capabilities: [SCOPED_REFS_CAPABILITY],
      });
      const runtime = createEgoRuntime(transport, {
        clientId,
        capabilities: () => transport.negotiatedCapabilities,
        referenceActionMaxLifetimeMs: () => transport.referenceActionMaxLifetimeMs,
      });
      await transport.request("agent.register", {
        clientId,
        clientKind: validAgentKind(process.env.EGO_AGENT_KIND) ?? "codex",
        displayName: process.env.EGO_AGENT_NAME || "Codex",
        version: process.env.EGO_AGENT_VERSION || "ego-mcp-server",
      });
      keepalive = startRuntimeKeepalive(runtime, transport, clientId);
      const target = globalThis as unknown as Record<string, unknown>;
      target.ego = runtime;
      const sdkModule = await importPublicSdk();
      sdkModule.installEgoSdk(target, {
        ready: Promise.resolve(),
        cliLog: (...args: unknown[]) => console.error(...args),
      });
      return new EgoMcpSession(transport, clientId, target as unknown as EgoSdkContext, keepalive, runtime.automationRequest!.bind(runtime));
    } catch (error) {
      keepalive?.stop();
      await transport.close().catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#keepalive.stop();
    await this.#transport.close();
  }

  automationRequest(operation: string, input: Record<string, unknown>): Promise<unknown> {
    return this.#automationRequest(operation, input);
  }

  async status(): Promise<BrowserBackendStatus> {
    return this.#transport.request<BrowserBackendStatus>("backend.status", {
      clientId: this.#clientId,
    });
  }

  async recordOperation(record: {
    id: string;
    tool: string;
    title: string;
    detail?: string;
    status: "running" | "completed" | "failed";
    startedAt: string;
    finishedAt?: string;
  }): Promise<void> {
    await this.#transport.request("operation.record", { clientId: this.#clientId, ...record });
  }

  async screenshot(options: Record<string, unknown> = {}): Promise<{
    path: string;
    data: string;
  }> {
    const path = await this.sdk.page.screenshot(options);
    return { path, data: (await readFile(path)).toString("base64") };
  }
}

function validAgentKind(value: string | undefined): "codex" | "claude" | "cursor" | "other" | "desktop-ui" | undefined {
  return value === "codex" || value === "claude" || value === "cursor" || value === "other" || value === "desktop-ui"
    ? value
    : undefined;
}

async function importPublicSdk(): Promise<{
  installEgoSdk(
    target: Record<string, unknown>,
    options: { ready: Promise<void>; cliLog: (...args: unknown[]) => void },
  ): void;
}> {
  return { installEgoSdk };
}
