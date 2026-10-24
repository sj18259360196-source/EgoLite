#!/usr/bin/env node

import {
  createEgoRuntime,
  PipeRuntimeTransport,
  PROTOCOL_VERSION,
  SCOPED_REFS_CAPABILITY,
  startRuntimeKeepalive,
} from "@ego-compat/runtime-adapter";

import { resolveAgentClientId } from "./identity.ts";
import { installCliOperationTracking } from "./operation-tracking.ts";
import { installPublicEgoSdk } from "./sdk.ts";

const pipeName = process.env.EGO_COMPAT_PIPE || "\\\\.\\pipe\\ego-compat-desktop-broker";
// Namespace only distinguishes temporary sessions without a Codex thread ID.
const clientId = resolveAgentClientId(process.env, { namespace: "cli" });
const transport = await PipeRuntimeTransport.connect(pipeName);
await transport.negotiateHello({
  protocolVersion: PROTOCOL_VERSION,
  clientId,
  pid: process.pid,
  sdkVersion: process.env.EGO_AGENT_VERSION || "ego-browser-cli",
  clientKind: validAgentKind(process.env.EGO_AGENT_KIND) ?? "codex",
  displayName: process.env.EGO_AGENT_NAME || "Codex",
  version: process.env.EGO_AGENT_VERSION || "ego-browser-cli",
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
  version: process.env.EGO_AGENT_VERSION || "ego-browser-cli",
});
const keepalive = startRuntimeKeepalive(runtime, transport, clientId);

try {
  await installPublicEgoSdk(runtime as unknown as Record<string, unknown>, globalThis as unknown as Record<string, unknown>, {
    recordOperation: record => transport.request("operation.record", { clientId, ...record }),
    ...(process.env.EGO_AUTOMATION_DIAGNOSTICS === "summary" ? {
      onAutomationResult: result => console.error("EGO_AUTOMATION_RESULT " + JSON.stringify({
        runId: result.runId, status: result.status, metrics: result.metrics,
      })),
    } : {}),
  });
  installCliOperationTracking(globalThis as unknown as Record<string, unknown>, (record) =>
    transport.request("operation.record", { clientId, ...record })
  );
  const source = await readStdin();
  if (!source.trim()) {
    console.error("Usage: ego-browser nodejs < script.js");
    process.exitCode = 2;
  } else {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction(source)();
  }
} finally {
  keepalive.stop();
  await transport.close();
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  return source;
}

function validAgentKind(value: string | undefined): "codex" | "claude" | "cursor" | "other" | undefined {
  return value === "codex" || value === "claude" || value === "cursor" || value === "other"
    ? value
    : undefined;
}
