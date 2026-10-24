import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { applyCosAdapter } from "../integrations/cos/adapt-source.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(process.argv[3] || join(root, "integrations/cos/upstream.json"), "utf8"));
const directory = resolve(process.argv[2] || join(root, "packs/cos/versions", lock.packVersion));
const source = join(directory, "source");
const { build: bundle } = createRequire(join(source, "package.json"))("esbuild");
const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
if (metadata.name !== "chat-on-steroids" || metadata.version !== lock.upstreamVersion) {
  throw new Error("CoS source does not match the pinned version");
}
const tunnel = spawnSync(process.execPath, [
  join(source, "scripts/fetch-tunnel-client.mjs"), "--platform", process.platform, "--arch", process.arch,
], { cwd: source, env: process.env, windowsHide: true, stdio: "inherit" });
if (tunnel.error) throw tunnel.error;
if (tunnel.status !== 0) throw new Error(`CoS tunnel dependency preparation failed (${tunnel.status})`);
const patches = await applyCosAdapter(source);
const cliPackage = JSON.parse(await readFile(join(source, "node_modules/electron-vite/package.json"), "utf8"));
const cli = typeof cliPackage.bin === "string" ? cliPackage.bin : cliPackage.bin["electron-vite"];
const build = spawnSync(process.execPath, [join(source, "node_modules/electron-vite", cli), "build"], {
  cwd: source, env: process.env, windowsHide: true, stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) throw new Error(`CoS build failed (${build.status}); active version unchanged`);
await bundle({
  entryPoints: [join(source, "extension/background.js")],
  outfile: join(source, "out/ego/browser-worker.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22",
});
await mkdir(directory, { recursive: true });
const manifest = {
  schemaVersion: 1, id: "cos", name: "Chat On Steroids", ...lock,
  ipcEncoding: "cos-json-v1",
  features: { executionGate: 1, maintenanceProbe: 1 },
  entries: {
    main: "source/out/main/index.js",
    renderer: "source/out/renderer/index.html",
    preload: "source/out/preload/ego-hosted.js",
    companion: "source/out/ego/browser-worker.mjs",
    electron: process.platform === "win32" ? "source/node_modules/electron/dist/electron.exe" : "source/node_modules/electron/dist/electron",
  },
};
await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ directory, patches: patches.length, manifest }, null, 2));
