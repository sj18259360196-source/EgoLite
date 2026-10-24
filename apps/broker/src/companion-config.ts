import { spawnSync } from "node:child_process";
import { join } from "node:path";

export interface CompanionConfig {
  pipeName: string;
  authSecret: Buffer;
  hostPath: string;
}

export function loadCompanionConfig(): CompanionConfig {
  const hostPath =
    process.env.EGO_NATIVE_HOST_PATH ??
    join(process.cwd(), "apps", "native-host", "publish", "ego-native-host.exe");
  const result = spawnSync(hostPath, ["--broker-config"], {
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Unable to load Companion DPAPI config: ${result.stderr || result.error}`);
  }
  const value = JSON.parse(result.stdout) as { pipeName?: unknown; authSecret?: unknown };
  if (typeof value.pipeName !== "string" || typeof value.authSecret !== "string") {
    throw new Error("Native Host returned invalid Companion config");
  }
  return {
    pipeName: value.pipeName,
    authSecret: Buffer.from(value.authSecret, "base64"),
    hostPath,
  };
}
