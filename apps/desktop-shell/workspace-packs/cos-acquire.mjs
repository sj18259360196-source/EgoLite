import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { downloadCosFile, extractCosSource, publishCosDirectory } from "./cos-download.mjs";

const version = "24.15.0";
const nodeHashes = {
  x64: "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62",
  arm64: "c9eb7402eda26e2ba7e44b6727fc85a8de56c5095b1f71ebd3062892211aa116",
};

export async function prepareCosNode(installRoot, work, { signal, onProgress = () => {} } = {}) {
  if (process.platform !== "win32" || !nodeHashes[process.arch]) throw new Error("CoS preset currently requires Windows x64 or arm64");
  const prefix = `node-v${version}-win-${process.arch}`;
  const destination = join(installRoot, ".tools", prefix);
  const executable = join(destination, "node.exe");
  try {
    const receipt = JSON.parse(await readFile(join(destination, "ego-download.json"), "utf8"));
    if (receipt.sha256 !== nodeHashes[process.arch]) throw new Error("CoS Node cache does not match the preset");
    await stat(executable);
    await stat(join(destination, "node_modules/npm/bin/npm-cli.js"));
    return executable;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  onProgress({ phase: "runtime" });
  const archive = join(work, "node.zip");
  const receipt = await downloadCosFile(`https://nodejs.org/dist/v${version}/${prefix}.zip`, archive, {
    signal, sha256: nodeHashes[process.arch], onProgress: progress => onProgress({ phase: "runtime", ...progress }),
  });
  const extracted = join(work, "node");
  await extractCosSource(archive, extracted, prefix, { signal });
  await writeFile(join(extracted, "ego-download.json"), JSON.stringify(receipt, null, 2));
  signal?.throwIfAborted();
  await mkdir(dirname(destination), { recursive: true });
  await publishCosDirectory(extracted, destination, { signal });
  return executable;
}

export async function acquireCosPreset({
  builderRoot, installRoot, workRoot, signal, onProgress = () => {}, onLog = () => {},
}) {
  const base = resolve(workRoot), root = resolve(installRoot);
  const work = join(base, `acquire-${randomUUID()}`);
  await mkdir(work, { recursive: true });
  try {
    signal?.throwIfAborted();
    await mkdir(root, { recursive: true });
    const executable = await prepareCosNode(root, work, { signal, onProgress });
    signal?.throwIfAborted();
    const entry = join(builderRoot, "tools/acquire-cos-pack.mjs");
    await stat(entry);
    return await new Promise((resolveBuild, reject) => {
      const env = { ...process.env, npm_config_cache: join(root, ".tools/npm-cache") };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.npm_execpath;
      const child = spawn(executable, [entry, "--install-root", root, "--work-root", base], {
        cwd: builderRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let result, failure, stopTimer;
      const cancel = () => {
        if (child.connected) child.send({ type: "cancel" }, () => {});
        stopTimer ??= setTimeout(() => {
          if (!child.pid || child.exitCode !== null) return;
          const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32/taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", error => onLog(error.message));
        }, 30000);
      };
      const finish = () => { clearTimeout(stopTimer); signal?.removeEventListener("abort", cancel); };
      signal?.addEventListener("abort", cancel, { once: true });
      child.stdout.on("data", chunk => onLog(String(chunk)));
      child.stderr.on("data", chunk => onLog(String(chunk)));
      child.on("message", message => {
        if (message?.type === "progress" && !signal?.aborted) onProgress(message.progress);
        if (message?.type === "result") result = message.result;
        if (message?.type === "failure") failure = message.error;
      });
      child.once("error", error => { finish(); reject(error); });
      child.once("exit", code => {
        finish();
        if (signal?.aborted) reject(signal.reason);
        else if (code === 0 && result?.directory) resolveBuild(result);
        else reject(new Error(failure || `CoS preset build exited (${code})`));
      });
      if (signal?.aborted) cancel();
    });
  } finally {
    if (dirname(work) !== base) throw new Error("Invalid CoS acquisition directory");
    await rm(work, { recursive: true, force: true });
  }
}
