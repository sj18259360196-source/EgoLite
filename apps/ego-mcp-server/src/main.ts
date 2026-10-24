#!/usr/bin/env node
import { runEgoMcpServer } from "./server.ts";

await runEgoMcpServer({
  pipeName: process.env.EGO_COMPAT_PIPE || "\\\\.\\pipe\\ego-compat-desktop-broker",
  autoStartDesktop: process.env.EGO_DESKTOP_AUTOSTART === "1",
});
