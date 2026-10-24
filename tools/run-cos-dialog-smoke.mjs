import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
const root = resolve(import.meta.dirname, "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const started = Date.now();
const child = spawn(join(root, "node_modules/electron/dist/electron.exe"), [join(root, "tools/cos-dialog-smoke.mjs"), resolve(process.argv[2])],
  { cwd: root, env, stdio: "inherit", windowsHide: true });
const timer = setTimeout(() => {
  if (child.pid) spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}, 90000);
const [code] = await once(child, "exit").finally(() => clearTimeout(timer));
const result = JSON.parse(await readFile(join(root, "docs/cos-workspace-pack/evidence/cos-native-dialogs.json"), "utf8"));
if (Date.parse(result.checkedAt) < started) throw new Error("Native dialog fixture did not produce fresh evidence");
const inside = relative(join(root, ".tmp/codex/cos-dialog-smoke"), result.testDataDirectory);
if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Invalid dialog fixture cleanup path");
await rm(result.testDataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exitCode = code || (result.passed ? 0 : 1);
