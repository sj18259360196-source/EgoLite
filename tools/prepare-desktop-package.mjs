import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { prepareScanSciRuntime } from "./prepare-scansci-runtime.mjs";
import { syncAutomationDocs } from "./sync-automation-docs.mjs";
import { prepareCosBuilder } from "./prepare-cos-builder.mjs";
import { readCosPack } from "../apps/desktop-shell/workspace-packs/cos-archive.mjs";
import { validateDesktopImports } from "./validate-desktop-package.mjs";

await syncAutomationDocs({ check: true });

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stagingRoot = resolve(process.env.EGO_PACKAGE_STAGING_ROOT || join(root, ".tmp", "codex", "package-win"));
if (!stagingRoot.startsWith(resolve(root, ".tmp", "codex") + (process.platform === "win32" ? "\\" : "/"))) {
  throw new Error("Package staging must stay inside this project's task temporary directory");
}
const runtimeDirectory = join(stagingRoot, "runtime");
const appDirectory = join(stagingRoot, "app");
const vendorDirectory = join(root, "apps", "desktop-shell", "public", "vendor");
const execFileAsync = promisify(execFile);

for (const directory of [runtimeDirectory, appDirectory]) {
  if (dirname(resolve(directory)) !== stagingRoot) throw new Error("Package staging path escaped its workspace");
  await rm(directory, { recursive: true, force: true });
}
await mkdir(runtimeDirectory, { recursive: true });
await mkdir(vendorDirectory, { recursive: true });

await Promise.all([
  bundle("apps/broker/src/main.ts", "broker.mjs"),
  bundle("apps/desktop-mcp-server/src/main.ts", "desktop-mcp.mjs"),
  bundle("apps/ego-browser/src/main.ts", "ego-browser.mjs"),
  bundle("apps/ego-mcp-server/src/main.ts", "ego-mcp.mjs"),
  copy("node_modules/lucide/dist/umd/lucide.js", "apps/desktop-shell/public/vendor/lucide.js"),
  copy("node_modules/marked/lib/marked.umd.js", "apps/desktop-shell/public/vendor/marked.umd.js"),
  copy("node_modules/dompurify/dist/purify.min.js", "apps/desktop-shell/public/vendor/purify.min.js"),
]);
await cp(join(root, "vendor", "ego-browser", "skill"), join(runtimeDirectory, "skills", "ego-browser"), { recursive: true });
await cp(join(root, "vendor", "web-access-ego", "skill"), join(runtimeDirectory, "skills", "web-access-ego"), { recursive: true });
await prepareCompanionRuntime();
await prepareScanSciRuntime(root, runtimeDirectory);
await prepareCosBuilder(root, join(runtimeDirectory, "cos-builder"));
const builtin = JSON.parse(await readFile(join(root, "integrations/cos/builtin.json"), "utf8"));
const cosSource = resolve(process.env.EGO_COS_BUILTIN_SOURCE || join(root, builtin.directory));
await readCosPack(cosSource);
// The SDK resolves native binaries relative to its package; retain that layout.
for (const name of ["codex-sdk", "codex", "codex-win32-x64"]) {
  await cp(join(root, "node_modules", "@openai", name), join(runtimeDirectory, "node_modules", "@openai", name), { recursive: true });
}
const sdkPath = join(runtimeDirectory, "node_modules", "@openai", "codex-sdk", "dist", "index.js");
const sdkSource = await readFile(sdkPath, "utf8");
await writeFile(sdkPath, sdkSource.replace("spawn(this.executablePath, commandArgs, {", "spawn(this.executablePath, commandArgs, { windowsHide: true,"));

await writeFile(
  join(runtimeDirectory, "start-desktop-mcp.cmd"),
  "@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n\"%~dp0..\\..\\EgoLite.exe\" \"%~dp0desktop-mcp.mjs\"\r\n",
  "ascii",
);
await Promise.all([
  writeFile(
    join(runtimeDirectory, "ego-browser.cmd"),
    "@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nif not defined EGO_COMPAT_PIPE set EGO_COMPAT_PIPE=\\\\.\\pipe\\ego-compat-desktop-broker\r\n\"%~dp0..\\..\\EgoLite.exe\" \"%~dp0ego-browser.mjs\" %*\r\n",
    "ascii",
  ),
  writeFile(
    join(runtimeDirectory, "start-ego-mcp.cmd"),
    "@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset EGO_COMPAT_PIPE=\\\\.\\pipe\\ego-compat-desktop-broker\r\nset EGO_DESKTOP_PIPE=\\\\.\\pipe\\ego-compat-desktop-broker\r\nset EGO_DESKTOP_AUTOMATION_PIPE=\\\\.\\pipe\\ego-compat-desktop\r\nset EGO_DESKTOP_AUTOSTART=1\r\nset EGO_DESKTOP_EXECUTABLE=%~dp0..\\..\\EgoLite.exe\r\n\"%~dp0..\\..\\EgoLite.exe\" \"%~dp0ego-mcp.mjs\"\r\n",
    "ascii",
  ),
]);

await cp(join(root, "apps", "desktop-shell"), appDirectory, {
  recursive: true,
  filter: (source) => !source.endsWith(".test.mjs"),
});
const stagedPackagePath = join(appDirectory, "package.json");
await build({ entryPoints: [join(root, "apps/desktop-shell/workspace-packs/cos-archive.mjs")], outfile: join(appDirectory, "workspace-packs/cos-archive.mjs"), bundle: true, platform: "node", target: "node24", format: "esm", banner: { js: 'import { createRequire as __egoCreateRequire } from "node:module"; const require = __egoCreateRequire(import.meta.url);' } });
await build({ entryPoints: [join(root, "apps/desktop-shell/workspace-packs/cos-acquire.mjs")], outfile: join(appDirectory, "workspace-packs/cos-acquire.mjs"), bundle: true, platform: "node", target: "node24", format: "esm", banner: { js: 'import { createRequire as __egoCreateRequire } from "node:module"; const require = __egoCreateRequire(import.meta.url);' } });
const archiveLicenses = join(appDirectory, "workspace-packs", "licenses");
await mkdir(archiveLicenses, { recursive: true });
for (const name of ["yauzl", "pend"]) {
  await copyFile(join(root, "node_modules", name, "LICENSE"), join(archiveLicenses, `${name}.txt`));
}
await build({ entryPoints: [join(root, "apps/desktop-shell/agent-integrations.mjs")], outfile: join(appDirectory, "agent-integrations.mjs"), bundle: true, platform: "node", target: "node24", format: "esm", banner: { js: 'import { createRequire as __egoCreateRequire } from "node:module"; const require = __egoCreateRequire(import.meta.url);' } });
const stagedPackage = JSON.parse(await readFile(stagedPackagePath, "utf8"));
await validateDesktopImports(appDirectory);
stagedPackage.build.afterPack = join(root, "tools", "validate-desktop-package.mjs");
stagedPackage.build.npmRebuild = false;
stagedPackage.build.directories.output = join(root, "release");
stagedPackage.build.electronDist = join(root, "node_modules", "electron", "dist");
stagedPackage.build.extraResources = [
  { from: cosSource, to: "components/cos", filter: ["**/*", "!.git/**"] },
  { from: runtimeDirectory, to: "runtime", filter: ["**/*", "!node_modules/**"] },
  { from: join(runtimeDirectory, "node_modules"), to: "runtime/node_modules", filter: ["**/*"] },
];
stagedPackage.build.files.push("!node_modules/**");
await writeFile(stagedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`, "utf8");
await writeFile(
  join(appDirectory, "package-lock.json"),
  `${JSON.stringify({
    name: "@ego-compat/desktop-shell",
    version: stagedPackage.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "@ego-compat/desktop-shell",
        version: stagedPackage.version,
      },
    },
  }, null, 2)}\n`,
  "utf8",
);

async function bundle(entry, output) {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(runtimeDirectory, output),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    sourcemap: false,
    legalComments: "none",
    external: ["@openai/codex-sdk"],
  });
}

async function copy(source, destination) {
  await mkdir(dirname(join(root, destination)), { recursive: true });
  await copyFile(join(root, source), join(root, destination));
}

async function prepareCompanionRuntime() {
  const companionDirectory = join(runtimeDirectory, "companion");
  const nativePublishDirectory = join(companionDirectory, "native", "publish");
  await execFileAsync("dotnet", [
    "publish",
    join(root, "apps", "native-host", "EgoCompat.NativeHost.csproj"),
    "-c", "Release",
    "-r", "win-x64",
    "--self-contained", "true",
    "-p:PublishSingleFile=true",
    "-o", nativePublishDirectory,
  ], { cwd: root, windowsHide: true });
  await mkdir(join(companionDirectory, "native"), { recursive: true });
  await Promise.all([
    cp(join(root, "apps", "companion-extension"), join(companionDirectory, "extension"), { recursive: true }),
    copyFile(join(root, "apps", "native-host", "install.ps1"), join(companionDirectory, "native", "install.ps1")),
  ]);
}
