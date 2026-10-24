import { execFile } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export async function prepareScanSciSource(root, destination, python) {
  const source = join(root, "vendor", "scansci-pdf");
  await mkdir(destination, { recursive: true });
  for (const name of ["src", "LICENSE", "pyproject.toml", "skill", "skills", ".codex-plugin"]) {
    await cp(join(source, name), join(destination, name), {
      recursive: true, filter: path => !path.split(/[\\/]/).includes("__pycache__"),
    });
  }
  await promisify(execFile)(python, [join(root, "integrations/scansci/adapt_source.py"), destination], { windowsHide: true });
  await cp(join(root, "vendor/scansci-find"), join(destination, "src/scansci_find"), { recursive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const python = process.env.SCANSCI_BUILD_PYTHON || join(root, "integrations/scansci/.venv/Scripts/python.exe");
  await prepareScanSciSource(root, join(root, "integrations/scansci/runtime"), python);
}
