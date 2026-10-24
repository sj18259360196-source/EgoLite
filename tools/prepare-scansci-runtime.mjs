import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function prepareScanSciRuntime(root, runtime) {
  const source = join(root, "vendor", "scansci-pdf");
  const adapter = join(root, "integrations", "scansci");
  const interpreter = process.env.SCANSCI_BUILD_PYTHON || join(adapter, ".venv", "Scripts", "python.exe");
  const { stdout } = await run(interpreter, ["-c", "import sys; print(sys.base_prefix)"], { windowsHide: true });
  const pythonRoot = stdout.trim();
  const destination = join(runtime, "scansci");
  const python = join(destination, "python");
  const filter = path => !["__pycache__", ".git", ".env", "Scripts", "site-packages"].includes(basename(path));
  await mkdir(destination, { recursive: true });
  await cp(pythonRoot, python, { recursive: true, filter, dereference: true });
  const pythonExe = join(python, "python.exe");
  // Install locked dependencies, never the developer's site-packages.
  await run("uv", ["pip", "install", "--python", pythonExe, "--target", join(python, "Lib", "site-packages"),
    "--require-hashes", "-r", join(adapter, "requirements.lock")], {
    windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, UV_CACHE_DIR: join(runtime, "..", "uv-cache") },
  });
  for (const name of ["src", "LICENSE", "pyproject.toml", "skill", "skills", ".codex-plugin"]) {
    await cp(join(source, name), join(destination, name), { recursive: true, filter });
  }
  await run(pythonExe, [join(adapter, "adapt_source.py"), destination], { windowsHide: true });
  await cp(join(root, "vendor", "scansci-find"), join(destination, "src", "scansci_find"), { recursive: true, filter });
  const torSource = resolve(process.env.SCANSCI_PACKAGE_TOR || join(homedir(), ".scansci-pdf", "tor"));
  for (const name of ["tor", "docs"]) {
    await cp(join(torSource, name), join(destination, "tor", name), { recursive: true, filter });
  }
  await mkdir(join(destination, "bin"), { recursive: true });
  await writeFile(join(destination, "bin", "scansci-find.cmd"), '@echo off\r\n"%~dp0..\\python\\python.exe" -m scansci_find.cli %*\r\n', "ascii");
  await writeFile(join(runtime, "start-scansci-mcp.cmd"), '@echo off\r\nset PYTHONPATH=%~dp0scansci\\src\r\nset PYTHONNOUSERSITE=1\r\nset PYTHONDONTWRITEBYTECODE=1\r\nset SCANSCI_EGO_HOSTED=1\r\nset EGOLITE_INSTALL_ROOT=%~dp0..\\..\r\nif not defined SCANSCI_PDF_DATA_DIR set SCANSCI_PDF_DATA_DIR=%LOCALAPPDATA%\\EgoCompat\\scansci\r\nset PATH=%~dp0scansci\\bin;%~dp0scansci\\tor\\tor;%~dp0;%PATH%\r\n"%~dp0scansci\\python\\python.exe" -m scansci_pdf.main run %*\r\n', "ascii");
  const validationDirectory = join(runtime, "..", "python-validation");
  await mkdir(validationDirectory, { recursive: true });
  const env = { ...process.env, PYTHONPATH: join(destination, "src"), PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", SCANSCI_PDF_DATA_DIR: validationDirectory, TEMP: validationDirectory, TMP: validationDirectory };
  delete env.PYTHONHOME;
  await run(pythonExe, ["-c", "import scansci_pdf.ego_host, scansci_pdf.server, scansci_find.cli, fitz, openpyxl, Crypto, websocket, lxml; print('ScanSci runtime imports OK')"], { env, windowsHide: true });
  const pin = JSON.parse(await readFile(join(adapter, "upstream.json"), "utf8"));
  const lockSha256 = createHash("sha256").update(await readFile(join(adapter, "requirements.lock"))).digest("hex");
  await writeFile(join(destination, "bundle-info.json"), JSON.stringify({ ...pin, lockSha256, python: basename(pythonRoot), builtAt: new Date().toISOString() }, null, 2));
}
