import { join } from "node:path";

import {
  AgentRegistry,
  type BrowserBackend,
  BrokerCore,
  CollectionService,
  FakeBrowserBackend,
  TaskSpaceService,
} from "@ego-compat/broker-core";
import { CompanionBackend } from "@ego-compat/companion-backend";
import { ElectronDesktopBackend } from "@ego-compat/electron-desktop-backend";
import { ManagedEdgeBackend } from "@ego-compat/managed-edge";

import { BrokerPipeServer, DEFAULT_PIPE_NAME } from "./server.ts";
import { SqliteTaskSpaceStore } from "./sqlite-task-store.ts";
import { loadCompanionConfig } from "./companion-config.ts";
import { OpenAICompatibleChatProvider } from "./chat-provider.ts";

try {
  process.loadEnvFile(process.env.EGO_ENV_FILE ?? ".env.local");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const pipeName = process.env.EGO_COMPAT_PIPE || DEFAULT_PIPE_NAME;
const backendMode = process.env.EGO_COMPAT_BACKEND ?? "fake";
const companionConfig = backendMode === "companion" ? loadCompanionConfig() : undefined;
const stateStore = new SqliteTaskSpaceStore(
  process.env.EGO_STATE_DB ??
    join(process.env.LOCALAPPDATA ?? process.cwd(), "EgoCompat", `state-${backendMode}.db`),
);
const backend: BrowserBackend =
  backendMode === "managed"
    ? new ManagedEdgeBackend({
        ...(process.env.EGO_EDGE_PATH
          ? { executablePath: process.env.EGO_EDGE_PATH }
          : {}),
        profilePath:
          process.env.EGO_EDGE_PROFILE ??
          join(process.env.LOCALAPPDATA ?? process.cwd(), "EgoCompat", "Profiles", "dev"),
        headless: process.env.EGO_EDGE_HEADLESS === "1",
      })
    : backendMode === "desktop"
      ? new ElectronDesktopBackend(process.env.EGO_DESKTOP_AUTOMATION_PIPE)
    : backendMode === "companion"
      ? new CompanionBackend(
          process.env.EGO_COMPANION_PIPE ?? companionConfig!.pipeName,
          companionConfig!.authSecret,
          companionConfig!.hostPath,
        )
      : new FakeBrowserBackend();
const chatProvider = process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY
  ? new OpenAICompatibleChatProvider({
      baseUrl: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.EGO_CHAT_MODEL ?? "gpt-5.6-terra",
    })
  : undefined;
const initialControlHandoffEnabled = process.env.EGO_CONTROL_HANDOFF_ENABLED !== "0";
const server = new BrokerPipeServer(
  new BrokerCore(
    new TaskSpaceService({
      backend:
        backendMode === "managed"
          ? "managed"
          : backendMode === "companion"
            ? "companion"
            : backendMode === "desktop"
              ? "desktop"
            : "fake",
      store: stateStore,
    }),
    backend,
    new CollectionService(stateStore),
    new AgentRegistry(),
    { controlHandoffEnabled: initialControlHandoffEnabled },
  ),
  chatProvider,
  undefined,
  stateStore,
  {
    ...(process.env.EGO_DESKTOP_CONTROL_TOKEN
      ? { desktopControlToken: process.env.EGO_DESKTOP_CONTROL_TOKEN }
      : {}),
  },
);
const spaces = server.broker.spaces;
spaces.recoverAfterRestart();
if (!initialControlHandoffEnabled) spaces.clearControlHandoffs();
await backend.start?.();
if (backendMode === "desktop") {
  for (const space of spaces.list()) {
    await backend.createSpace(spaces.recordByTaskId(space.taskId));
    await backend.updateSpaceState?.(spaces.recordByTaskId(space.taskId));
  }
}
await server.listen(pipeName);
console.log(`ego-compat broker listening on ${pipeName} (${backendMode})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await server.close();
    stateStore.close();
    process.exit(0);
  });
}
