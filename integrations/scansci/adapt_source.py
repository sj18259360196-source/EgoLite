"""Build the Ego overlay without replacing upstream download implementations."""

from __future__ import annotations

import ast
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def replace_once(text: str, before: str, after: str) -> str:
    if text.count(before) != 1:
        raise ValueError(f"Upstream adapter anchor changed: {before[:90]!r}")
    return text.replace(before, after, 1)


def ego_branch(text: str, name: str) -> tuple[ast.FunctionDef, ast.If]:
    fn = next(n for n in ast.parse(text).body if isinstance(n, ast.FunctionDef) and n.name == name)
    branch = next(n for n in fn.body if isinstance(n, ast.If) and "BACKEND_EGOLITE" in ast.unparse(n.test))
    return fn, branch


def graft(target: Path, legacy: Path, names: list[str]) -> None:
    text = target.read_text(encoding="utf-8")
    old = legacy.read_text(encoding="utf-8")
    for name in names:
        _, branch = ego_branch(old, name)
        fn = next(n for n in ast.parse(text).body if isinstance(n, ast.FunctionDef) and n.name == name)
        # The first expression is the docstring; retain upstream's signature/body.
        anchor = fn.body[0].end_lineno
        lines = text.splitlines(keepends=True)
        code = "\n".join(old.splitlines()[branch.lineno - 1:branch.end_lineno]) + "\n"
        lines.insert(anchor, code)
        text = "".join(lines)
    text += "\nfrom .browser_backend import BACKEND_EGOLITE, resolve_backend\n"
    ast.parse(text)
    target.write_text(text, encoding="utf-8")


def adapt(source: Path) -> None:
    package = source / "src" / "scansci_pdf"
    init = package / "__init__.py"
    text = init.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    lines.insert(ast.parse(text).body[0].end_lineno,
                 '\nimport sys\nimport pymupdf\nsys.modules.setdefault("fitz", pymupdf)\n')
    init.write_text("".join(lines), encoding="utf-8")
    shutil.copy2(HERE / "ego_host.py", package / "ego_host.py")
    shutil.copy2(HERE / "pdf_validation.py", package / "ego_pdf_validation.py")
    shutil.copy2(HERE / "atomic_pdf.py", package / "ego_atomic_pdf.py")
    shutil.copy2(HERE / "browser_actions.py", package / "ego_browser_actions.py")
    shutil.copy2(HERE / "config_state.py", package / "ego_config_state.py")
    shutil.copy2(HERE / "setup_assistant.py", package / "ego_setup.py")
    for name in ("server.py", "main.py"):
        path = package / name
        text = path.read_text(encoding="utf-8")
        if "webbrowser.open(" not in text:
            raise ValueError(f"Browser setup entry changed in {name}")
        text = text.replace("webbrowser.open(", "ego_open_url(")
        future = next(n for n in ast.parse(text).body if isinstance(n, ast.ImportFrom) and n.module == "__future__")
        lines = text.splitlines(keepends=True)
        lines.insert(future.end_lineno, "\nfrom .ego_browser_actions import open_url as ego_open_url\n")
        path.write_text("".join(lines), encoding="utf-8")
    for name in ("egolite_bridge.py", "web.py", "templates"):
        src, dst = HERE / "legacy" / name, package / name
        if src.is_dir():
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)

    config = package / "config.py"
    text = config.read_text(encoding="utf-8")
    text = replace_once(text, '"browser_backend": "patchright",', '''"browser_backend": "egolite",
    "egolite_task_space": "paper download",
    "egolite_auto_start": True,
    "egolite_command": "",
    "egolite_timeout_seconds": 90,
    "egolite_startup_timeout_seconds": 20,
    "egolite_max_pdf_mb": 100,
    "egolite_native_fallback": True,
    "egolite_external_browser_fallback": False,''')
    for key in ("scihub_enabled", "libgen_enabled", "scibban_enabled", "use_tor_for_scihub"):
        text = text.replace(f'"{key}": True,', f'"{key}": False,')
    text += '\nimport sys as _sys\nfrom .ego_config_state import install as _install_ego_config\n_install_ego_config(_sys.modules[__name__])\n'
    config.write_text(text, encoding="utf-8")

    backend = package / "browser_backend.py"
    text = backend.read_text(encoding="utf-8")
    text = replace_once(text, 'BACKEND_PATCHRIGHT = "patchright"', 'BACKEND_EGOLITE = "egolite"\nBACKEND_PATCHRIGHT = "patchright"')
    text = replace_once(text, 'DEFAULT_BACKEND = BACKEND_PATCHRIGHT', 'DEFAULT_BACKEND = BACKEND_EGOLITE')
    text = replace_once(text, '    cfg = config or {}\n    requested =', '''    cfg = config or {}
    if os.environ.get("SCANSCI_EGO_HOSTED") == "1" or cfg.get("browser_backend", DEFAULT_BACKEND) == BACKEND_EGOLITE:
        return BACKEND_EGOLITE
    requested =''')
    text = replace_once(text, '    try:\n        if name == BACKEND_PATCHRIGHT:', '''    try:
        if name == BACKEND_EGOLITE:
            from .egolite_bridge import is_installed
            return is_installed()
        if name == BACKEND_PATCHRIGHT:''')
    # Both launch functions and diagnostics contain this structural anchor.
    for fn in ("launch", "launch_persistent_context", "browser_info"):
        node = next(n for n in ast.parse(text).body if isinstance(n, ast.FunctionDef) and n.name == fn)
        lines = text.splitlines(keepends=True)
        call = 'launch_persistent_context' if fn == 'launch_persistent_context' else 'launch'
        result = ('return {"backend": BACKEND_EGOLITE, "binary": "EgoLite", "version": "hosted"}'
                  if fn == "browser_info" else f'from .egolite_bridge import {call} as ego_launch\n        return ego_launch(config)')
        lines.insert(node.body[0].end_lineno, f'    if resolve_backend(config) == BACKEND_EGOLITE:\n        {result}\n')
        text = "".join(lines)
    ast.parse(text)
    backend.write_text(text, encoding="utf-8")

    engine = package / "browser_engine.py"
    text = engine.read_text(encoding="utf-8")
    text = replace_once(text, '    backend = resolve_backend(config)\n    if backend ==', '''    backend = resolve_backend(config)
    if backend == "egolite":
        from .egolite_bridge import is_available as ego_available
        return ego_available(config)
    if backend ==''')
    engine.write_text(text, encoding="utf-8")
    graft(engine, HERE / "legacy/browser_engine.py", ["solve_url", "download_pdf_via_browser", "fetch_url"])
    with engine.open("a", encoding="utf-8") as stream:
        stream.write("\nimport tempfile\n")
    graft(package / "browser_login.py", HERE / "legacy/browser_login.py", ["open_login_browser"])
    login = package / "browser_login.py"
    text = login.read_text(encoding="utf-8")
    text = replace_once(text, '        if not _HAS_CLOAKBROWSER:', '''        if resolve_backend(config) == BACKEND_EGOLITE:
            from .egolite_bridge import launch as ego_launch
            self._browser = ego_launch(config)
            self._context = self._browser.new_context()
            self._page = self._context.new_page()
            return self._context, self._page
        if not _HAS_CLOAKBROWSER:''')
    text = replace_once(text, '        """Explicitly close the browser."""', '''        """Explicitly close the browser."""
        if self._browser is None:
            return''')
    login.write_text(text, encoding="utf-8")
    cookies = package / "browser_cookies.py"
    text = cookies.read_text(encoding="utf-8")
    # Preserve cookie path setup before the transplanted Ego login branch.
    _, branch = ego_branch((HERE / "legacy/browser_cookies.py").read_text(encoding="utf-8"), "extract_via_browser")
    old = (HERE / "legacy/browser_cookies.py").read_text(encoding="utf-8")
    block = "\n".join(old.splitlines()[branch.lineno - 1:branch.end_lineno]) + "\n"
    text = replace_once(text, '    try:\n        from .browser_backend import launch', block + '    try:\n        from .browser_backend import launch')
    text += "\nfrom .browser_backend import BACKEND_EGOLITE, resolve_backend\n"
    cookies.write_text(text, encoding="utf-8")

    pdf = package / "pdf_utils.py"
    text = pdf.read_text(encoding="utf-8")
    text += "\nfrom .ego_pdf_validation import is_readable_pdf\nis_pdf_file = is_readable_pdf\n"
    pdf.write_text(text, encoding="utf-8")

    publishers = package / "sources" / "publishers.py"
    text = publishers.read_text(encoding="utf-8")
    text += "\nfrom ..ego_atomic_pdf import write_pdf_atomic as _write_pdf_atomic\n"
    publishers.write_text(text, encoding="utf-8")
    arxiv = package / "sources" / "arxiv.py"
    text = arxiv.read_text(encoding="utf-8")
    text = replace_once(text, '    return download_arxiv_pdf(url, output_path, config)', '    return download_arxiv_pdf(url, output_path, config) or download_arxiv_pdf(url[:-4], output_path, config)')
    arxiv.write_text(text, encoding="utf-8")

    bridge = package / "egolite_bridge.py"
    text = bridge.read_text(encoding="utf-8")
    text = replace_once(text, '    roots = [Path(r"C:\\Program Files\\EgoLite")]', '    roots = ([Path(os.environ["EGOLITE_INSTALL_ROOT"])] if os.environ.get("EGOLITE_INSTALL_ROOT") else []) + [Path(r"C:\\Program Files\\EgoLite")]')
    start = text.index('  const spaces = (await taskSpaces.list())')
    end = text.index('  const tabs = await browser.listTabs()', start)
    text = text[:start] + '''  if (payload.readOnlyProbe) {{
    const spaces = await taskSpaces.list()
    writeResult({{ ok: true, spaceCount: spaces.length }})
  }} else {{
  const task = await taskSpaces.useOrCreate(payload.taskSpace)
''' + text[end:]
    text = replace_once(text, '  {body}\n}} catch (error)', '  {body}\n  }}\n}} catch (error)')
    text = replace_once(text, '"writeResult({ ok: true, taskSpaceId: task.id })",\n            {},', '"",\n            {"readOnlyProbe": True},')
    text = text.replace('body = """', 'body = r"""')
    bridge.write_text(text, encoding="utf-8")

    web = package / "web.py"
    text = web.read_text(encoding="utf-8").replace('_json_call(scansci_pdf_vpnsci_status, sync_egolite=False)', '_json_call(scansci_pdf_vpnsci_status)')
    text = text.replace('bool(check_tor_circuit(config))', 'bool(config.get("use_tor_for_scihub", False)) and bool(check_tor_circuit(config))')
    text = text.replace('    results = search_papers(query, limit=req.limit)', '    results = await asyncio.to_thread(search_papers, query, limit=req.limit)')
    text = replace_once(text, 'class DownloadRequest(BaseModel):\n    identifier: str', 'class DownloadRequest(BaseModel):\n    identifier: str\n    rename: bool = False')
    text = replace_once(text, 'await asyncio.to_thread(download, identifier)', 'await asyncio.to_thread(download, identifier, rename=req.rename)')
    text = text.replace('CloakBrowser is not running. Start it to enable browser-based downloads for paywalled papers.', 'Ego browser connection is unavailable. Check that EgoLite is running and browser control is enabled.')
    text = text.replace('    if not sources.get("tor"):', '    if config.get("use_tor_for_scihub", False) and not sources.get("tor"):')
    text += '''

def main():
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1"])
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
'''
    web.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    adapt(Path(sys.argv[1]).resolve())
