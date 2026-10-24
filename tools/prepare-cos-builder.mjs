import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";

export async function prepareCosBuilder(root, destination) {
  const files = [
    "integrations/cos/upstream.json", "integrations/cos/build-candidate.mjs", "integrations/cos/adapt-source.mjs",
    "integrations/cos/hosted-runtime.ts", "integrations/cos/hosted-execution.ts",
    "integrations/cos/hosted-browser.ts", "integrations/cos/hosted-preload-prefix.ts", "integrations/cos/hosted-renderer.ts",
    "tools/prepare-cos-pack.mjs", "tools/acquire-cos-pack.mjs",
    "apps/desktop-shell/workspace-packs/cos-runtime.mjs",
    "apps/desktop-shell/workspace-packs/cos-dialogs.mjs",
    "apps/desktop-shell/workspace-packs/cos-wire.cjs", "apps/desktop-shell/workspace-packs/cos-wire.d.cts",
  ];
  for (const file of files) {
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await copyFile(join(root, file), join(destination, file));
  }
  for (const file of ["cos-archive.mjs", "cos-download.mjs"]) {
    await build({
      entryPoints: [join(root, "apps/desktop-shell/workspace-packs", file)],
      outfile: join(destination, "apps/desktop-shell/workspace-packs", file),
      bundle: true, platform: "node", target: "node24", format: "esm",
      banner: { js: 'import { createRequire as __egoCreateRequire } from "node:module"; const require = __egoCreateRequire(import.meta.url);' },
    });
  }
  const licenses = join(destination, "licenses");
  await mkdir(licenses, { recursive: true });
  for (const name of ["yauzl", "pend"]) await copyFile(join(root, "node_modules", name, "LICENSE"), join(licenses, `${name}.txt`));
}
