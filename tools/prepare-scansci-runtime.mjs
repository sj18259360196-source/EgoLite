import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

// Copy the interpreter, never a venv launcher (which references the build machine).
export async function prepareScanSciRuntime(root, runtime) {
  const source = resolve(process.env.SCANSCI_PACKAGE_SOURCE || join(root, "..", "ScanSci PDF"));
  const venv = join(source, ".venv");
  const { stdout } = await run(join(venv, "Scripts", "python.exe"), ["-c", "import sys; print(sys.base_prefix)"], { windowsHide: true });
  const pythonRoot = stdout.trim();
  const destination = join(runtime, "scansci");
  const python = join(destination, "python");
  const filter = (path) => !["__pycache__", ".git", ".env", "Scripts", "site-packages"].includes(basename(path));
  await mkdir(destination, { recursive: true });
  await cp(pythonRoot, python, { recursive: true, filter, dereference: true });
  await cp(join(venv, "Lib", "site-packages"), join(python, "Lib", "site-packages"), {
    recursive: true,
    filter: (path) => !["__pycache__", "direct_url.json"].includes(basename(path)) && (!path.endsWith(".pth") || basename(path) === "pywin32.pth"),
  });
  await run("uv", ["pip", "install", "--python", join(python, "python.exe"), "--target", join(python, "Lib", "site-packages"), "--no-deps", "pycryptodome==3.23.0", "websocket-client==1.9.0", "lxml==6.0.2"], {
    windowsHide: true,
    env: { ...process.env, UV_CACHE_DIR: join(runtime, "..", "uv-cache") },
  });
  await cp(join(source, "src"), join(destination, "src"), { recursive: true, filter });
  const bridgePath = join(destination, "src", "scansci_pdf", "egolite_bridge.py");
  const bridge = await readFile(bridgePath, "utf8");
  const rootLine = '    roots = [Path(r"C:\\Program Files\\EgoLite")]';
  if (!bridge.includes(rootLine)) throw new Error("ScanSci bridge changed; review the relocatable installation adapter");
  await writeFile(bridgePath, bridge.replace(rootLine, '    roots = ([Path(os.environ["EGOLITE_INSTALL_ROOT"])] if os.environ.get("EGOLITE_INSTALL_ROOT") else []) + [Path(r"C:\\Program Files\\EgoLite")]'));
  await cp(join(source, "scansci-find", "scansci_find"), join(destination, "src", "scansci_find"), { recursive: true, filter });
  await cp(join(source, "LICENSE"), join(destination, "LICENSE"));
  await cp(join(source, "skill"), join(destination, "skill"), { recursive: true, filter });
  await cp(join(source, "skills"), join(destination, "skills"), { recursive: true, filter });
  await cp(join(source, ".codex-plugin"), join(destination, ".codex-plugin"), { recursive: true, filter });
  await cp(join(source, "pyproject.toml"), join(destination, "pyproject.toml"));
  const torSource = process.env.SCANSCI_PACKAGE_TOR || join(homedir(), ".scansci-pdf", "tor");
  for (const name of ["tor", "docs"]) {
    await cp(join(torSource, name), join(destination, "tor", name), { recursive: true, filter });
  }
  await mkdir(join(destination, "bin"), { recursive: true });
  await writeFile(join(destination, "bin", "scansci-find.cmd"), '@echo off\r\n"%~dp0..\\python\\python.exe" -m scansci_find.cli %*\r\n', "ascii");
  await writeFile(join(runtime, "start-scansci-mcp.cmd"), '@echo off\r\nset PYTHONPATH=%~dp0scansci\\src\r\nset PYTHONNOUSERSITE=1\r\nset PYTHONDONTWRITEBYTECODE=1\r\nset EGOLITE_INSTALL_ROOT=%~dp0..\\..\r\nif not defined SCANSCI_PDF_DATA_DIR set SCANSCI_PDF_DATA_DIR=%LOCALAPPDATA%\\EgoCompat\\scansci\r\nset PATH=%~dp0scansci\\bin;%~dp0scansci\\tor\\tor;%~dp0;%PATH%\r\n"%~dp0scansci\\python\\python.exe" -m scansci_pdf.main run %*\r\n', "ascii");
  const validationDirectory = join(runtime, "..", "python-validation");
  await mkdir(validationDirectory, { recursive: true });
  const env = { ...process.env, PYTHONPATH: join(destination, "src"), PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", SCANSCI_PDF_DATA_DIR: validationDirectory, TEMP: validationDirectory, TMP: validationDirectory };
  delete env.PYTHONHOME;
  await run(join(python, "python.exe"), ["-c", "import scansci_pdf.web, scansci_pdf.server, scansci_find.cli, fitz, openpyxl, Crypto, websocket, lxml; print('ScanSci runtime imports OK')"], { env, windowsHide: true });
  const metadata = await readFile(join(source, "pyproject.toml"), "utf8");
  await writeFile(join(destination, "bundle-info.json"), JSON.stringify({ version: metadata.match(/version = "([^"]+)"/)?.[1], python: basename(pythonRoot), builtAt: new Date().toISOString() }, null, 2));
}
