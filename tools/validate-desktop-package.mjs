import { build } from "esbuild";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { extractAll } from "@electron/asar";

export async function validateDesktopImports(directory) {
  const result = await build({ entryPoints: [join(directory, "main.mjs")], bundle: true,
    packages: "external", platform: "node", format: "esm", write: false, metafile: true, logLevel: "silent" });
  const missing = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const entry of output.imports) {
      if (entry.external && !isBuiltin(entry.path) && !["electron", "original-fs"].includes(entry.path)) missing.add(entry.path);
    }
  }
  if (missing.size) throw new Error(`Desktop shell has unbundled package imports: ${[...missing].join(", ")}`);
}

export async function validateDesktopArchive(archive, temporaryRoot) {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "dependency-audit-"));
  try { extractAll(archive, directory); await validateDesktopImports(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

export default async function afterPack(context) {
  await validateDesktopArchive(join(context.appOutDir, "resources", "app.asar"),
    join(context.packager.projectDir, "..", "validation"));
}
