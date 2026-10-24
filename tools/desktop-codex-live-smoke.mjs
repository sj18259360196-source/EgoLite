import { randomUUID } from "node:crypto";
import { connect } from "node:net";

const pipeName = process.env.EGO_DESKTOP_PIPE || "\\\\.\\pipe\\ego-compat-desktop-broker";
const timeoutMs = Number(process.env.EGO_CODEX_LIVE_TIMEOUT_MS || 180_000);
const clientId = `desktop-codex-live-${randomUUID()}`;
const requestId = randomUUID();
const socket = connect(pipeName);
socket.setEncoding("utf8");

let buffer = "";
let createdTask;
const pending = new Map();
const activities = [];
let streamResolve;
let streamReject;

socket.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      continue;
    }
    if (message.params?.requestId !== requestId) continue;
    if (message.method === "codex.stream.event") {
      const event = message.params.event;
      if (event?.type === "activity") activities.push(event.activity);
    } else if (message.method === "codex.stream.complete") {
      streamResolve?.(message.params);
    } else if (message.method === "codex.stream.error") {
      streamReject?.(new Error(message.params.message));
    } else if (message.method === "codex.stream.cancelled") {
      streamReject?.(new Error("Live Codex smoke was cancelled"));
    }
  }
});

try {
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  createdTask = await request("space.create", { clientId, name: `Codex live ${Date.now()}` });
  await request("tab.create", {
    clientId,
    leaseEpoch: createdTask.leaseEpoch,
    url: "data:text/html,<title>Embedded Codex Live</title><h1>Embedded Codex Live</h1>",
  });
  await delay(500);

  const completed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Live Codex smoke timed out after ${timeoutMs} ms`)), timeoutMs);
    streamResolve = (value) => { clearTimeout(timer); resolve(value); };
    streamReject = (error) => { clearTimeout(timer); reject(error); };
    void request("codex.stream.start", {
      clientId,
      requestId,
      prompt: [
        "Use the embedded Ego desktop browser MCP to inspect the current visible page.",
        "Call ego_desktop_status and ego_desktop_page_info. Do not navigate, click, fill, or modify anything.",
        "Then reply with exactly EGO_DESKTOP_MCP_OK followed by the page title and URL.",
      ].join(" "),
      workingDirectory: process.cwd(),
    }).catch(streamReject);
  });

  const completedMcpCalls = activities.filter((activity) =>
    activity?.type === "mcp_tool_call" &&
    activity.status === "completed" &&
    String(activity.title).startsWith("ego_browser_desktop/ego_desktop_"),
  );
  if (completedMcpCalls.length < 2) {
    throw new Error(`Expected two completed Ego desktop MCP calls, received ${JSON.stringify(activities, null, 2)}`);
  }
  if (!String(completed.text || "").includes("EGO_DESKTOP_MCP_OK")) {
    throw new Error(`Codex response did not include the completion marker: ${JSON.stringify(completed.text)}`);
  }
  console.log(JSON.stringify({
    passed: true,
    threadId: completed.threadId,
    mcpCalls: completedMcpCalls.map((activity) => activity.title),
    response: completed.text,
  }, null, 2));
} finally {
  if (createdTask) {
    await request("space.select", { clientId, id: createdTask.id }).catch(() => null);
    await request("space.close", { clientId }).catch(() => null);
  }
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("Live Codex smoke closed"));
  }
  socket.destroy();
}

function request(method, params = {}) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Broker RPC timed out: ${method}`));
    }, 20_000);
    pending.set(id, { resolve, reject, timer });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
