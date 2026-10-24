import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const edge =
  process.env.EGO_EDGE_PATH ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = join(process.env.TEMP || "C:\\tmp", `ego-edge-probe-${process.pid}`);
await mkdir(profile, { recursive: true });

const child = spawn(
  edge,
  [
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "--headless=new",
    "--no-first-run",
    "--disable-default-apps",
    "about:blank",
  ],
  {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    windowsHide: true,
  },
);

const cdpInput = child.stdio[3];
const cdpOutput = child.stdio[4];
if (!cdpInput || !cdpOutput) throw new Error("Edge CDP handles were not created");

let buffer = Buffer.alloc(0);
const response = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Edge CDP probe timed out")), 10_000);
  cdpOutput.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const terminator = buffer.indexOf(0);
    if (terminator < 0) return;
    clearTimeout(timeout);
    resolve(JSON.parse(buffer.subarray(0, terminator).toString("utf8")));
  });
  child.once("exit", (code) => reject(new Error(`Edge exited early with ${code}`)));
});

cdpInput.write(`${JSON.stringify({ id: 1, method: "Browser.getVersion" })}\0`);

try {
  console.log(JSON.stringify(await response, null, 2));
} finally {
  child.kill();
}
