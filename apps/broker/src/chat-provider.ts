export interface ChatRequest {
  prompt: string;
  context?: string;
  attachments?: ChatAttachment[];
}

export type ChatAttachment =
  | { kind: "text"; id: string; name: string; mimeType: string; size: number; source: string; text: string }
  | { kind: "image"; id: string; name: string; mimeType: string; size: number; source: string; dataBase64: string };

export interface ChatResponse {
  text: string;
  model: string;
}

export interface ChatStreamOptions {
  signal?: AbortSignal;
  onDelta(delta: string): void;
}

export interface ChatProvider {
  send(request: ChatRequest): Promise<ChatResponse>;
  stream?(request: ChatRequest, options: ChatStreamOptions): Promise<ChatResponse>;
}

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

export class OpenAICompatibleChatProvider implements ChatProvider {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #model: string;

  constructor(options: OpenAICompatibleOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? "gpt-5.6-terra";
  }

  async send(request: ChatRequest): Promise<ChatResponse> {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error("Chat prompt must not be empty");
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.#model,
        messages: messagesFor(request),
        stream: false,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throwProviderHttpError(response, hasImageAttachments(request));
    const payload = await response.json() as {
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("Chat provider returned an empty response");
    }
    return {
      text: text.trim(),
      model: typeof payload.model === "string" ? payload.model : this.#model,
    };
  }

  async stream(request: ChatRequest, options: ChatStreamOptions): Promise<ChatResponse> {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error("Chat prompt must not be empty");
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(90_000)])
      : AbortSignal.timeout(90_000);
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.#model,
        messages: messagesFor(request),
        stream: true,
      }),
      signal,
    });
    if (!response.ok) throwProviderHttpError(response, hasImageAttachments(request));
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      const payload = await response.json() as ChatCompletionPayload;
      const text = completionText(payload);
      options.onDelta(text);
      return { text, model: typeof payload.model === "string" ? payload.model : this.#model };
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let model = this.#model;
    const consumeEvent = (event: string): boolean => {
      const data = event.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data) return false;
      if (data === "[DONE]") return true;
      const payload = JSON.parse(data) as ChatStreamPayload;
      if (payload.error?.message) throw new Error(payload.error.message);
      if (typeof payload.model === "string") model = payload.model;
      const delta = streamText(payload.choices?.[0]?.delta?.content);
      if (delta) {
        text += delta;
        options.onDelta(delta);
      }
      return false;
    };
    const reader = response.body.getReader();
    let completed = false;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const event = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (consumeEvent(event)) { completed = true; break; }
      }
      if (completed) break;
    }
    buffer += decoder.decode();
    if (!completed && buffer.trim()) consumeEvent(buffer);
    if (completed) await reader.cancel().catch(() => {});
    if (!text.trim()) throw new Error("Chat provider returned an empty response");
    return { text: text.trim(), model };
  }
}

interface ChatCompletionPayload {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
}

interface ChatStreamPayload {
  model?: unknown;
  choices?: Array<{ delta?: { content?: unknown } }>;
  error?: { message?: string };
}

function messagesFor(request: ChatRequest) {
  validateAttachments(request.attachments || []);
  const text = combinedUserText(request);
  const images = (request.attachments || []).filter((attachment): attachment is Extract<ChatAttachment, { kind: "image" }> => attachment.kind === "image");
  return [
    {
      role: "system",
      content:
        "You are the Ego browser assistant. Use only the user-selected browser context when context is supplied. Distinguish facts from inference and answer in the user's language.",
    },
    {
      role: "user",
      content: images.length
        ? [
            { type: "text", text },
            ...images.map((image) => ({
              type: "image_url",
              image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}`, detail: "auto" },
            })),
          ]
        : text,
    },
  ];
}

function combinedUserText(request: ChatRequest): string {
  const blocks: string[] = [];
  if (request.context?.trim()) blocks.push(request.context.trim());
  for (const attachment of request.attachments || []) {
    if (attachment.kind !== "text") continue;
    blocks.push(`<file name="${escapeAttribute(attachment.name)}" mime="${escapeAttribute(attachment.mimeType)}">\n${attachment.text}\n</file>`);
  }
  blocks.push(`<user-message>\n${request.prompt.trim()}\n</user-message>`);
  return blocks.join("\n\n");
}

function validateAttachments(attachments: ChatAttachment[]): void {
  if (attachments.length > 8) throw new Error("Chat supports at most 8 attachments");
  let totalBytes = 0;
  let totalText = 0;
  for (const attachment of attachments) {
    if (!attachment.id || !attachment.name || !Number.isFinite(attachment.size) || attachment.size < 0) {
      throw new Error("Chat attachment metadata is invalid");
    }
    totalBytes += attachment.size;
    if (attachment.kind === "image") {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(attachment.mimeType)) throw new Error(`Unsupported image type: ${attachment.mimeType}`);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.dataBase64)) throw new Error("Image attachment is not valid base64");
    } else {
      totalText += attachment.text.length;
      if (attachment.text.length > 2_000_000) throw new Error(`${attachment.name} exceeds the text attachment limit`);
    }
  }
  if (totalBytes > 20 * 1024 * 1024) throw new Error("Chat attachments exceed the 20 MB total limit");
  if (totalText > 400_000) throw new Error("Text attachments exceed the 400,000 character limit");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function completionText(payload: ChatCompletionPayload): string {
  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("Chat provider returned an empty response");
  return text.trim();
}

function streamText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => part && typeof part === "object" && typeof part.text === "string" ? [part.text] : []).join("");
}

function hasImageAttachments(request: ChatRequest): boolean {
  return Boolean(request.attachments?.some((attachment) => attachment.kind === "image"));
}

function throwProviderHttpError(response: Response, hasImages: boolean): never {
  if (hasImages && [400, 415, 422].includes(response.status)) {
    throw new Error(`当前模型或兼容代理不支持图片附件（HTTP ${response.status}）`);
  }
  throw new Error(`Chat provider returned HTTP ${response.status}`);
}
