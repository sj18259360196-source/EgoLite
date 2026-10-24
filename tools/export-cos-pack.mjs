import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { readCosPack } from "../apps/desktop-shell/workspace-packs/cos-archive.mjs";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(process.argv[2] || join(root, "packs/cos/versions/2.1.20-ego.1"));
const manifest = await readCosPack(directory);
const output = resolve(process.argv[3] || join(root, "packs/cos/exports", `CoS-${manifest.packVersion}-${process.platform}-${process.arch}.egopack`));
const temporary = join(root, ".tmp/codex/cos-integration", `export-${randomUUID()}.egopack`);
if (relative(directory, output) && !relative(directory, output).startsWith("..")) throw new Error("Export must be outside the source package");
await mkdir(dirname(output), { recursive: true });
await mkdir(dirname(temporary), { recursive: true });
const zip = new yazl.ZipFile();
let files = 0;
const stream = createWriteStream(temporary, { flags: "wx" });
const done = pipeline(zip.outputStream, stream);
// Retain rejection while directory traversal is still adding files.
void done.catch(() => {});
async function add(folder, prefix = "") {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === ".git" || name === "source/node_modules/.cache" || name === "source/resources/packaging"
      || entry.name === ".env" || entry.name.startsWith(".env.") && !entry.name.endsWith(".example")) continue;
    if (entry.isSymbolicLink()) throw new Error(`CoS export requires regular files: ${name}`);
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await add(path, name);
    else if (entry.isFile()) {
      zip.addFile(path, name, { compressionLevel: 3 });
      if (++files % 5000 === 0) console.log(`CoS export: ${files} files queued`);
    }
  }
}
try {
  await add(directory);
  zip.end();
  await done;
  await rename(temporary, output);
  console.log(JSON.stringify({ output, files, packVersion: manifest.packVersion }, null, 2));
} catch (error) {
  zip.outputStream.destroy(error);
  await done.catch(() => {});
  await rm(temporary, { force: true });
  throw error;
}
