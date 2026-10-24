import assert from "node:assert/strict";
import test from "node:test";

import { OpenAICompatibleChatProvider } from "./chat-provider.ts";

test("OpenAI-compatible provider sends only explicit prompt and selected context", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, any> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      model: "test-model",
      choices: [{ message: { content: "A grounded answer" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = new OpenAICompatibleChatProvider({
    baseUrl: "https://provider.test/v1/",
    apiKey: "test-secret",
    model: "test-model",
  });
  const result = await provider.send({
    prompt: "Summarize",
    context: '<context source="https://example.test">Selected only</context>',
  });

  assert.equal(result.text, "A grounded answer");
  assert.equal(requestBody?.model, "test-model");
  assert.match(requestBody?.messages[1].content, /Selected only/);
  assert.match(requestBody?.messages[1].content, /Summarize/);
});

test("OpenAI-compatible provider emits streamed deltas", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, any> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"model":"stream-model","choices":[{"delta":{"content":"Hello "}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"world"}}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const deltas: string[] = [];
  const provider = new OpenAICompatibleChatProvider({
    baseUrl: "https://provider.test/v1",
    apiKey: "test-secret",
    model: "test-model",
  });
  const result = await provider.stream({ prompt: "Stream it" }, {
    onDelta: (delta) => deltas.push(delta),
  });

  assert.equal(requestBody?.stream, true);
  assert.deepEqual(deltas, ["Hello ", "world"]);
  assert.deepEqual(result, { text: "Hello world", model: "stream-model" });
});

test("OpenAI-compatible provider keeps text files in string content", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, any> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "Read" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const provider = new OpenAICompatibleChatProvider({ baseUrl: "https://provider.test/v1", apiKey: "secret" });
  await provider.send({
    prompt: "Review",
    attachments: [{ kind: "text", id: "text-1", name: 'notes & "todo".md', mimeType: "text/markdown", size: 8, source: "file", text: "Selected file body" }],
  });
  const content = requestBody?.messages?.[1]?.content;
  assert.equal(typeof content, "string");
  assert.match(content, /<file name="notes &amp; &quot;todo&quot;\.md"/);
  assert.match(content, /Selected file body/);
});

test("OpenAI-compatible provider emits image_url parts for images", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, any> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "Seen" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const provider = new OpenAICompatibleChatProvider({ baseUrl: "https://provider.test/v1", apiKey: "secret" });
  await provider.send({
    prompt: "Describe",
    attachments: [{ kind: "image", id: "image-1", name: "screen.png", mimeType: "image/png", size: 3, source: "page-screenshot", dataBase64: "YWJj" }],
  });
  const content = requestBody?.messages?.[1]?.content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0]?.type, "text");
  assert.equal(content[1]?.type, "image_url");
  assert.equal(content[1]?.image_url?.url, "data:image/png;base64,YWJj");
});
