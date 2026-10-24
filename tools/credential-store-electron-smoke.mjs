import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const root = join(toolDirectory, "..");
const electronPath = join(root, "node_modules", "electron", "dist", "electron.exe");
const electronAppPath = join(toolDirectory, "credential-store-electron-app");

await runController();

async function runController() {
  if (!existsSync(electronPath)) throw new Error("Electron is not installed; run npm install first");
  const work = mkdtempSync(join(tmpdir(), "ego-credential-electron-smoke-"));
  try {
    await runPhase("write", work);
    const writeResult = JSON.parse(readFileSync(join(work, "write-result.json"), "utf8"));
    if (!writeResult.passed) throw new Error(`Credential write smoke failed: ${JSON.stringify(writeResult)}`);

    await runPhase("read", work);
    const readResult = JSON.parse(readFileSync(join(work, "read-result.json"), "utf8"));
    if (!readResult.passed) throw new Error(`Credential read smoke failed: ${JSON.stringify(readResult)}`);

    console.log(JSON.stringify({ write: writeResult, read: readResult }, null, 2));
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function runPhase(phase, work) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [electronAppPath], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        EGO_CREDENTIAL_SMOKE_PHASE: phase,
        EGO_CREDENTIAL_SMOKE_ROOT: work,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Credential ${phase} phase timed out${output.trim() ? `\n${output.trim()}` : ""}`));
    }, 20_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const resultPath = join(work, `${phase}-result.json`);
        const result = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "";
        reject(new Error(`Credential ${phase} phase exited with ${code}${result ? `\n${result}` : output.trim() ? `\n${output.trim()}` : ""}`));
      }
    });
  });
}
