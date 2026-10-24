import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Codex, type Input, type Thread, type ThreadItem } from "@openai/codex-sdk";

export interface CodexImageAttachment {
  kind: "image";
  id: string;
  name: string;
  mimeType: string;
  size: number;
  source: string;
  dataBase64: string;
}

export interface CodexAgentRequest {
  prompt: string;
  context?: string;
  threadId?: string;
  conversationKey?: string;
  workingDirectory?: string;
  attachments?: CodexImageAttachment[];
}

export interface CodexAgentResponse {
  text: string;
  model: string;
  threadId: string;
  activities: string[];
}

export interface CodexActivity {
  id: string;
  type: Exclude<ThreadItem["type"], "agent_message">;
  status: string;
  title: string;
  detail?: string;
}

export type CodexAgentEvent =
  | { type: "thread"; threadId: string }
  | { type: "turn"; phase: "started" | "completed"; usage?: unknown }
  | { type: "message"; phase: "started" | "updated" | "completed"; itemId: string; text: string }
  | { type: "activity"; phase: "started" | "updated" | "completed"; activity: CodexActivity };

export interface CodexAgentProvider {
  send(request: CodexAgentRequest): Promise<CodexAgentResponse>;
  stream?(
    request: CodexAgentRequest,
    options: { signal?: AbortSignal; onEvent: (event: CodexAgentEvent) => void },
  ): Promise<CodexAgentResponse>;
}

export interface CodexSdkAgentOptions {
  workingDirectory: string;
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  browserMcpServer?: string;
  mcpServers?: CodexConfigObject;
  codex?: Codex;
}

export type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
export interface CodexConfigObject { [key: string]: CodexConfigValue }

export class CodexSdkAgentProvider implements CodexAgentProvider {
  readonly #codex: Codex;
  readonly #workingDirectory: string;
  readonly #model: string | undefined;
  readonly #reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly #browserMcpServer: string | undefined;
  readonly #threads = new Map<string, Thread>();
  readonly #claims = new Map<string, symbol>();

  constructor(options: CodexSdkAgentOptions) {
    this.#codex = options.codex ?? new Codex(options.mcpServers
      ? { config: { mcp_servers: options.mcpServers } }
      : undefined);
    this.#workingDirectory = options.workingDirectory;
    this.#model = options.model;
    this.#reasoningEffort = options.reasoningEffort ?? "medium";
    this.#browserMcpServer = options.browserMcpServer;
  }

  async send(request: CodexAgentRequest): Promise<CodexAgentResponse> {
    return this.stream(request, { onEvent: () => undefined });
  }

  async stream(
    request: CodexAgentRequest,
    options: { signal?: AbortSignal; onEvent: (event: CodexAgentEvent) => void },
  ): Promise<CodexAgentResponse> {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error("Codex prompt must not be empty");
    const thread = this.#getThread(request);
    const claim = Symbol("codex-turn");
    this.#claim(request.threadId ? `thread:${request.threadId}` : `conversation:${request.conversationKey ?? "default"}`, claim);
    let attachmentDirectory: string | undefined;
    try {
      const items = new Map<string, ThreadItem>();
      let threadId = request.threadId ?? "";
      let finalResponse = "";
      const prepared = await prepareCodexInput(
        buildPrompt(prompt, request.context, this.#browserMcpServer),
        request.attachments ?? [],
      );
      attachmentDirectory = prepared.directory;
      const { events } = await thread.runStreamed(prepared.input, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      for await (const event of events) {
        if (event.type === "thread.started") {
          threadId = event.thread_id;
          this.#claim(`thread:${threadId}`, claim);
          options.onEvent({ type: "thread", threadId });
        } else if (event.type === "turn.started") {
          options.onEvent({ type: "turn", phase: "started" });
        } else if (event.type === "turn.completed") {
          options.onEvent({ type: "turn", phase: "completed", usage: event.usage });
        } else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
          items.set(event.item.id, event.item);
          const phase = event.type.slice("item.".length) as "started" | "updated" | "completed";
          if (event.item.type === "agent_message") {
            finalResponse = event.item.text;
            options.onEvent({ type: "message", phase, itemId: event.item.id, text: clamp(event.item.text, 200_000) });
          } else {
            options.onEvent({ type: "activity", phase, activity: normalizeActivity(event.item) });
          }
        } else if (event.type === "turn.failed") {
          throw new Error(event.error.message);
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
      threadId ||= thread.id ?? "";
      if (!threadId) throw new Error("Codex did not return a thread id");
      this.#threads.set(threadId, thread);
      return {
        text: finalResponse,
        model: this.#model ?? "Codex",
        threadId,
        activities: summarizeActivities([...items.values()]),
      };
    } finally {
      await removeAttachmentDirectory(attachmentDirectory);
      for (const [key, owner] of this.#claims) if (owner === claim) this.#claims.delete(key);
    }
  }

  #claim(key: string, claim: symbol): void {
    const active = this.#claims.get(key);
    if (active && active !== claim) throw new Error("This Codex thread already has a running turn");
    this.#claims.set(key, claim);
  }

  #getThread(request: CodexAgentRequest): Thread {
    if (request.threadId) {
      const active = this.#threads.get(request.threadId);
      if (active) return active;
      const resumed = this.#codex.resumeThread(request.threadId, this.#threadOptions(request));
      this.#threads.set(request.threadId, resumed);
      return resumed;
    }
    return this.#codex.startThread(this.#threadOptions(request));
  }

  #threadOptions(request: CodexAgentRequest) {
    return {
      workingDirectory: request.workingDirectory ?? this.#workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write" as const,
      approvalPolicy: "never" as const,
      networkAccessEnabled: true,
      modelReasoningEffort: this.#reasoningEffort,
      ...(this.#model ? { model: this.#model } : {}),
    };
  }
}

async function prepareCodexInput(prompt: string, attachments: CodexImageAttachment[]): Promise<{ input: Input; directory?: string }> {
  if (!attachments.length) return { input: prompt };
  if (attachments.length > 8) throw new Error("Codex supports at most 8 image attachments");
  const directory = await mkdtemp(join(tmpdir(), "ego-codex-images-"));
  try {
    const input: Input = [{ type: "text", text: prompt }];
    let totalBytes = 0;
    for (const [index, attachment] of attachments.entries()) {
      if (attachment.kind !== "image" || !/^image\/(png|jpeg|webp|gif)$/.test(attachment.mimeType)) {
        throw new Error(`Unsupported Codex image type: ${attachment.mimeType}`);
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.dataBase64)) throw new Error("Codex image attachment is not valid base64");
      const data = Buffer.from(attachment.dataBase64, "base64");
      if (!matchesImageSignature(data, attachment.mimeType)) throw new Error(`Codex image data does not match ${attachment.mimeType}`);
      if (attachment.size !== data.length) throw new Error("Codex image attachment size does not match its payload");
      totalBytes += data.length;
      if (data.length > 8 * 1024 * 1024 || totalBytes > 20 * 1024 * 1024) throw new Error("Codex image attachments exceed the size limit");
      const extension = attachment.mimeType === "image/jpeg" ? ".jpg" : `.${attachment.mimeType.slice("image/".length)}`;
      const path = join(directory, `${String(index + 1).padStart(2, "0")}${extension}`);
      await writeFile(path, data);
      input.push({ type: "local_image", path });
    }
    return { input, directory };
  } catch (error) {
    await removeAttachmentDirectory(directory);
    throw error;
  }
}

async function removeAttachmentDirectory(directory?: string): Promise<void> {
  if (!directory) return;
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Cleanup must not turn a completed Codex turn into an error.
  }
}

function matchesImageSignature(data: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === "image/gif") return data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"));
  if (mimeType === "image/webp") return data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

export class FixtureCodexAgentProvider implements CodexAgentProvider {
  async send(request: CodexAgentRequest): Promise<CodexAgentResponse> {
    return this.stream(request, { onEvent: () => undefined });
  }

  async stream(
    request: CodexAgentRequest,
    options: { signal?: AbortSignal; onEvent: (event: CodexAgentEvent) => void },
  ): Promise<CodexAgentResponse> {
    const threadId = request.threadId || "thread-desktop-smoke";
    options.onEvent({ type: "thread", threadId });
    options.onEvent({ type: "turn", phase: "started" });
    options.onEvent({
      type: "activity",
      phase: "started",
      activity: { id: "command-smoke", type: "command_execution", status: "in_progress", title: "npm run smoke" },
    });
    await fixtureDelay(300, options.signal);
    if (/cancel/i.test(request.prompt)) {
      await new Promise<never>((_resolve, reject) => {
        if (options.signal?.aborted) return reject(new Error("aborted"));
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    options.onEvent({
      type: "activity",
      phase: "completed",
      activity: { id: "command-smoke", type: "command_execution", status: "completed", title: "npm run smoke", detail: "fixture passed" },
    });
    for (const activity of [
      { id: "file-smoke", type: "file_change", status: "completed", title: "update: README.md" },
      { id: "mcp-smoke", type: "mcp_tool_call", status: "completed", title: "ego-browser/page.snapshot" },
      { id: "search-smoke", type: "web_search", status: "completed", title: "Ego Browser" },
      { id: "todo-smoke", type: "todo_list", status: "completed", title: "任务进度 1/1", detail: "[x] Desktop smoke" },
    ] as CodexActivity[]) {
      options.onEvent({ type: "activity", phase: "completed", activity });
    }
    options.onEvent({ type: "message", phase: "updated", itemId: "message-smoke", text: "Codex streamed answer" });
    options.onEvent({ type: "turn", phase: "completed" });
    const text = request.attachments?.length ? `Codex received ${request.attachments.length} image` : "Codex streamed answer";
    return {
      text,
      model: "Codex fixture",
      threadId,
      activities: ["已运行：npm run smoke", "已修改：README.md"],
    };
  }
}

function normalizeActivity(item: Exclude<ThreadItem, { type: "agent_message" }>): CodexActivity {
  if (item.type === "command_execution") {
    return {
      id: item.id,
      type: item.type,
      status: item.status,
      title: clamp(item.command, 2_000),
      ...(item.aggregated_output ? { detail: clampTail(item.aggregated_output, 32_000) } : {}),
    };
  }
  if (item.type === "file_change") {
    return {
      id: item.id,
      type: item.type,
      status: item.status,
      title: clamp(item.changes.map((change) => `${change.kind}: ${change.path}`).join("\n"), 8_000),
    };
  }
  if (item.type === "mcp_tool_call") {
    return {
      id: item.id,
      type: item.type,
      status: item.status,
      title: `${item.server}/${item.tool}`,
      ...(item.error?.message ? { detail: clamp(item.error.message, 32_000) } : {}),
    };
  }
  if (item.type === "web_search") {
    return { id: item.id, type: item.type, status: "completed", title: clamp(item.query, 4_000) };
  }
  if (item.type === "todo_list") {
    const completed = item.items.filter((todo) => todo.completed).length;
    return {
      id: item.id,
      type: item.type,
      status: completed === item.items.length ? "completed" : "in_progress",
      title: `任务进度 ${completed}/${item.items.length}`,
      detail: clamp(item.items.map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`).join("\n"), 16_000),
    };
  }
  if (item.type === "reasoning") {
    return { id: item.id, type: item.type, status: "in_progress", title: "正在思考", detail: clamp(item.text, 16_000) };
  }
  return { id: item.id, type: item.type, status: "failed", title: clamp(item.message, 8_000) };
}

function clamp(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}\n...`;
}

function clampTail(value: string, length: number): string {
  return value.length <= length ? value : `...\n${value.slice(-length)}`;
}

function fixtureDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

function buildPrompt(prompt: string, context?: string, browserMcpServer?: string): string {
  const selectedContext = context?.trim();
  const sections = browserMcpServer ? [
    `You are embedded in the visible Ego desktop browser. For browser work, use the ${browserMcpServer} MCP server and its ego_desktop_* tools to operate the page the user can currently see.`,
    "Inspect status or page info when needed, take a fresh snapshot before using @refs, and report browser actions through the tool activity stream. Do not use a different browser backend or create/claim another task space.",
  ] : [];
  if (selectedContext) sections.push(
    "The following context was explicitly selected in the Ego browser. Use it as task context.",
    selectedContext,
  );
  if (!sections.length) return prompt;
  return [
    ...sections,
    "<user-message>",
    prompt,
    "</user-message>",
  ].join("\n\n");
}

function summarizeActivities(items: ThreadItem[]): string[] {
  const activities: string[] = [];
  for (const item of items) {
    if (item.type === "command_execution") {
      activities.push(`${item.status === "completed" ? "已运行" : "命令失败"}：${item.command}`);
    } else if (item.type === "file_change") {
      const files = item.changes.map((change) => change.path).join("、");
      activities.push(`${item.status === "completed" ? "已修改" : "修改失败"}：${files}`);
    } else if (item.type === "mcp_tool_call") {
      activities.push(`${item.status === "completed" ? "已调用" : "调用失败"}：${item.server}/${item.tool}`);
    } else if (item.type === "web_search") {
      activities.push(`已搜索：${item.query}`);
    } else if (item.type === "todo_list") {
      const completed = item.items.filter((todo) => todo.completed).length;
      activities.push(`任务进度：${completed}/${item.items.length}`);
    }
  }
  return activities.slice(-8);
}
