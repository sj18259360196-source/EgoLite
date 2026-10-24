import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import test from "node:test";

import { CodexSdkAgentProvider, type CodexAgentEvent, type CodexAgentProvider } from "./codex-agent.ts";

test("Codex agent response preserves a resumable thread and activities", async () => {
  const provider: CodexAgentProvider = {
    async send(request) {
      assert.equal(request.threadId, "thread-existing");
      assert.match(request.context ?? "", /Selected page/);
      return {
        text: "Completed",
        model: "Codex fixture",
        threadId: "thread-existing",
        activities: ["已修改：README.md"],
      };
    },
  };
  const response = await provider.send({
    prompt: "Update it",
    context: "Selected page",
    threadId: "thread-existing",
  });
  assert.equal(response.threadId, "thread-existing");
  assert.deepEqual(response.activities, ["已修改：README.md"]);
});

test("Codex SDK stream publishes thread, message, and normalized activity events before completion", async () => {
  let receivedInput = "";
  const sdkEvents = [
    { type: "thread.started", thread_id: "thread-stream" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } },
    { type: "item.updated", item: { id: "cmd-1", type: "command_execution", command: "npm test", aggregated_output: "passing", status: "in_progress" } },
    { type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "npm test", aggregated_output: "passing", exit_code: 0, status: "completed" } },
    { type: "item.updated", item: { id: "msg-1", type: "agent_message", text: "Done" } },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
  ];
  const thread = {
    id: null,
    async runStreamed(input: unknown, options: { signal?: AbortSignal }) {
      receivedInput = String(input);
      assert.ok(options.signal);
      return {
        events: (async function* () {
          for (const event of sdkEvents) yield event;
        })(),
      };
    },
  };
  const codex = { startThread: () => thread, resumeThread: () => thread };
  const provider = new CodexSdkAgentProvider({
    workingDirectory: "C:\\workspace",
    browserMcpServer: "ego_browser_desktop",
    codex: codex as never,
  });
  const events: CodexAgentEvent[] = [];
  const response = await provider.stream(
    { prompt: "Run tests", conversationKey: "task-1" },
    { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
  );

  assert.deepEqual(events[0], { type: "thread", threadId: "thread-stream" });
  assert.match(receivedInput, /visible Ego desktop browser/);
  assert.match(receivedInput, /ego_browser_desktop/);
  assert.match(receivedInput, /ego_desktop_\*/);
  const commands = events.filter(
    (event): event is Extract<CodexAgentEvent, { type: "activity" }> =>
      event.type === "activity" && event.activity.id === "cmd-1",
  );
  assert.equal(commands.length, 3);
  assert.equal(commands.at(-1)?.activity.status, "completed");
  assert.equal(events.some((event) => event.type === "message" && event.text === "Done"), true);
  assert.equal(response.text, "Done");
  assert.equal(response.threadId, "thread-stream");
  assert.deepEqual(response.activities, ["已运行：npm test"]);
});

test("Codex SDK provider rejects a concurrent turn on the same thread", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const thread = {
    id: "thread-busy",
    async runStreamed() {
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread-busy" };
          await gate;
          yield { type: "item.completed", item: { id: "msg", type: "agent_message", text: "Finished" } };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
        })(),
      };
    },
  };
  const codex = { startThread: () => thread, resumeThread: () => thread };
  const provider = new CodexSdkAgentProvider({ workingDirectory: "C:\\workspace", codex: codex as never });
  let started!: () => void;
  const firstEvent = new Promise<void>((resolve) => { started = resolve; });
  const first = provider.stream(
    { prompt: "First", threadId: "thread-busy", conversationKey: "task-1" },
    { onEvent: (event) => { if (event.type === "thread") started(); } },
  );
  await firstEvent;
  await assert.rejects(
    provider.stream(
      { prompt: "Second", threadId: "thread-busy", conversationKey: "task-1" },
      { onEvent: () => undefined },
    ),
    /already has a running turn/,
  );
  release();
  assert.equal((await first).text, "Finished");
});

test("Codex SDK materializes local_image input for the full turn and cleans it after completion", async () => {
  let imagePath = "";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const thread = {
    id: "thread-image",
    async runStreamed(input: unknown) {
      assert.ok(Array.isArray(input));
      assert.equal(input[0]?.type, "text");
      assert.equal(input[1]?.type, "local_image");
      imagePath = input[1].path;
      assert.equal(isAbsolute(imagePath), true);
      assert.equal(existsSync(imagePath), true);
      assert.deepEqual(readFileSync(imagePath), png);
      return {
        events: (async function* () {
          assert.equal(existsSync(imagePath), true);
          yield { type: "thread.started", thread_id: "thread-image" };
          yield { type: "item.completed", item: { id: "msg", type: "agent_message", text: "Image received" } };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
        })(),
      };
    },
  };
  const provider = new CodexSdkAgentProvider({ workingDirectory: "C:\\workspace", codex: { startThread: () => thread, resumeThread: () => thread } as never });
  const response = await provider.send({
    prompt: "Describe it",
    attachments: [{ kind: "image", id: "image-1", name: "screen.png", mimeType: "image/png", size: png.length, source: "page-screenshot", dataBase64: png.toString("base64") }],
  });
  assert.equal(response.text, "Image received");
  assert.equal(existsSync(imagePath), false);
});

test("Codex SDK cleans materialized images when the turn fails", async () => {
  let imagePath = "";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const thread = {
    id: "thread-image-failure",
    async runStreamed(input: unknown) {
      imagePath = (input as Array<{ path?: string }>)[1]?.path ?? "";
      return { events: (async function* () { throw new Error("fixture failure"); })() };
    },
  };
  const provider = new CodexSdkAgentProvider({ workingDirectory: "C:\\workspace", codex: { startThread: () => thread, resumeThread: () => thread } as never });
  await assert.rejects(provider.send({
    prompt: "Fail",
    attachments: [{ kind: "image", id: "image-1", name: "screen.png", mimeType: "image/png", size: png.length, source: "page-screenshot", dataBase64: png.toString("base64") }],
  }), /fixture failure/);
  assert.equal(existsSync(imagePath), false);
});

test("Codex SDK keeps images until abort finishes and then cleans them", async () => {
  let imagePath = "";
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const thread = {
    id: "thread-image-abort",
    async runStreamed(input: unknown, options: { signal?: AbortSignal }) {
      imagePath = (input as Array<{ path?: string }>)[1]?.path ?? "";
      return {
        events: (async function* () {
          started();
          await new Promise<void>((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
          yield { type: "turn.started" };
        })(),
      };
    },
  };
  const provider = new CodexSdkAgentProvider({ workingDirectory: "C:\\workspace", codex: { startThread: () => thread, resumeThread: () => thread } as never });
  const controller = new AbortController();
  const turn = provider.stream({
    prompt: "Wait",
    threadId: "thread-image-abort",
    attachments: [{ kind: "image", id: "image-1", name: "screen.png", mimeType: "image/png", size: png.length, source: "page-screenshot", dataBase64: png.toString("base64") }],
  }, { signal: controller.signal, onEvent: () => undefined });
  await entered;
  assert.equal(existsSync(imagePath), true);
  controller.abort();
  await assert.rejects(turn, /aborted/);
  assert.equal(existsSync(imagePath), false);
});
