import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runElectronChild } from "./desktop-frame-router-smoke.mjs";

console.error(`[frame-router-smoke] electron-entry version=${process.versions.electron || "missing"}`);
app.commandLine.appendSwitch("host-resolver-rules", "MAP root.test 127.0.0.1, MAP cross.test 127.0.0.1");
app.commandLine.appendSwitch("no-proxy-server");
app.commandLine.appendSwitch("force-device-scale-factor", "2");

async function main() {
  await app.whenReady();
  console.error("[frame-router-smoke] app-ready");
  await runElectronChild({ app, BrowserWindow });
  app.quit();
}

void main().catch(async (error) => {
  const outputDir = process.env.FRAME_ROUTER_SMOKE_OUTPUT;
  if (outputDir) {
    await mkdir(outputDir, { recursive: true }).catch(() => {});
    await writeFile(
      join(outputDir, "desktop-frame-router-smoke-error.txt"),
      error?.stack || String(error),
      "utf8",
    ).catch(() => {});
  }
  console.error(error);
  app.exit(1);
});
