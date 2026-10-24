import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { CosRuntime } from "../../apps/desktop-shell/workspace-packs/cos-runtime.mjs";
import { readCosPack } from "../../apps/desktop-shell/workspace-packs/cos-archive.mjs";
import { downloadCosFile, extractCosSource, publishCosDirectory } from "../../apps/desktop-shell/workspace-packs/cos-download.mjs";

const root = resolve(import.meta.dirname, "../..");
async function run(command, args, cwd, capture = false, signal) {
  signal?.throwIfAborted();
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd, windowsHide: true, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ""}` },
    });
    let output = "";
    const cancel = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" });
        killer.on("error", error => console.error(error.message));
      } else child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout?.on("data", chunk => { output += chunk; });
    child.once("error", error => { signal?.removeEventListener("abort", cancel); reject(error); });
    child.once("exit", code => {
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolveRun(output.trim());
      else reject(new Error(`CoS build command failed (${code}): ${command} ${args[0]}`));
    });
    if (signal?.aborted) cancel();
  });
}

export async function buildCosCandidate(ref, {
  installRoot = join(root, "packs/cos"), workRoot = join(root, ".tmp/codex/cos-integration"),
  sourceMode = "git", sourceDirectory, sourceArchive, tunnelArchive, signal, onProgress = () => {},
} = {}) {
  if (typeof ref !== "string" || !/^[a-z0-9][a-z0-9._/-]*$/i.test(ref) || ref.includes("..")) throw new Error("Invalid upstream ref");
  const pinned = JSON.parse(await readFile(join(root, "integrations/cos/upstream.json"), "utf8"));
  const base = resolve(workRoot);
  const work = join(base, `build-${randomUUID()}`);
  const pack = join(work, "pack");
  const source = join(pack, "source");
  await mkdir(source, { recursive: true });
  let runtime;
  try {
    let commit, sourceReceipt;
    onProgress({ phase: "source" });
    if (sourceMode === "local") {
      const cached = await readCosPack(sourceDirectory);
      if (cached.commit !== ref) throw new Error("Local CoS source commit does not match requested ref");
      commit = cached.commit;
      await cp(join(sourceDirectory, "source"), source, { recursive: true });
    } else if (sourceMode === "archive") {
      if (!/^[0-9a-f]{40}$/i.test(ref)) throw new Error("CoS preset requires a full upstream commit");
      commit = ref.toLowerCase();
      const archive = join(work, "source.zip");
      const url = `https://codeload.github.com/totec448-spec/chat-on-steroids/zip/${commit}`;
      if (sourceArchive) {
        await cp(resolve(sourceArchive), archive, { errorOnExist: true, force: false });
        const bytes = await readFile(archive);
        sourceReceipt = { url, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, cached: true };
      } else sourceReceipt = await downloadCosFile(url, archive, { signal,
        onProgress: progress => onProgress({ phase: "source", ...progress }) });
      await extractCosSource(archive, source, `chat-on-steroids-${commit}`, { signal });
    } else {
      await run("git", ["init", "--quiet"], source, false, signal);
      await run("git", ["remote", "add", "origin", pinned.repository], source, false, signal);
      await run("git", ["fetch", "--depth=1", "origin", ref], source, false, signal);
      await run("git", ["checkout", "--detach", "--quiet", "FETCH_HEAD"], source, false, signal);
      commit = await run("git", ["rev-parse", "HEAD"], source, true, signal);
    }
    const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    if (metadata.name !== "chat-on-steroids" || !/^[a-z0-9][a-z0-9._-]*$/i.test(metadata.version)) throw new Error("Unexpected upstream CoS package");
    const hash = createHash("sha256");
    for (const file of ["integrations/cos/adapt-source.mjs", "integrations/cos/hosted-runtime.ts", "integrations/cos/hosted-execution.ts",
      "integrations/cos/hosted-browser.ts", "integrations/cos/hosted-preload-prefix.ts", "integrations/cos/hosted-renderer.ts",
      "apps/desktop-shell/workspace-packs/cos-wire.cjs", "apps/desktop-shell/workspace-packs/cos-wire.d.cts",
      "tools/prepare-cos-pack.mjs", "integrations/cos/build-candidate.mjs"]) hash.update(await readFile(join(root, file)));
    const adapterDigest = hash.digest("hex");
    const packVersion = `${metadata.version}-ego.${pinned.adapterVersion}-${commit.slice(0, 12)}-${adapterDigest.slice(0, 8)}`;
    const destination = join(resolve(installRoot), "versions", packVersion);
    try {
      await stat(destination);
      const cached = await readCosPack(destination);
      if (cached.commit !== commit || cached.adapterDigest !== adapterDigest) throw new Error("CoS cached version identity does not match");
      return { directory: destination, commit, packVersion, reused: true };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const selected = { ...pinned, commit, upstreamVersion: metadata.version, packVersion, adapterDigest };
    if (sourceReceipt) await writeFile(join(pack, "source-download.json"), JSON.stringify(sourceReceipt, null, 2));
    const lockPath = join(pack, "upstream.json");
    await writeFile(lockPath, JSON.stringify(selected, null, 2));
    const npm = process.env.npm_execpath || join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    await stat(npm);
    onProgress({ phase: "dependencies" });
    if (sourceMode !== "local") await run(process.execPath, [npm, "ci", "--no-audit", "--no-fund"], source, false, signal);
    if (tunnelArchive) {
      const cache = join(source, 'node_modules/.cache/tunnel-client');
      await mkdir(cache, { recursive: true });
      await cp(resolve(tunnelArchive), join(cache, basename(tunnelArchive)), { errorOnExist: true, force: false });
    }
    await run(process.execPath, [join(source, "node_modules/electron/install.js")], source, false, signal);
    onProgress({ phase: "build" });
    await run(process.execPath, [join(root, "tools/prepare-cos-pack.mjs"), pack, lockPath], root, false, signal);
    onProgress({ phase: "check" });
    await run(process.execPath, [npm, "run", "typecheck"], source, false, signal);
    await readCosPack(pack);
    runtime = new CosRuntime({ directory: pack, dataDirectory: join(work, "probe-state"), probeOnly: true });
    signal?.throwIfAborted();
    await runtime.start();
    const state = await runtime.invoke("state:get");
    if (!state?.ok) throw new Error(state?.error || "CoS candidate startup failed");
    await runtime.stop();
    signal?.throwIfAborted();
    await mkdir(dirname(destination), { recursive: true });
    await publishCosDirectory(pack, destination, { signal });
    return { directory: destination, commit, packVersion, reused: false };
  } finally {
    await runtime?.stop();
    if (dirname(work) !== base) throw new Error("Invalid CoS build directory");
    await rm(work, { recursive: true, force: true });
  }
}
