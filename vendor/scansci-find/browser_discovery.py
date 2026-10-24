from __future__ import annotations

import importlib.util
import json
import os
import shlex
import shutil
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional

PROFILE_DIR = "D:/Dev/browser-profiles/scansci"
CACHE_DIR = "D:/Dev/cache/browser"


def _default_system_browser_paths() -> List[str]:
    return [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ]


def _default_scansci_pdf_roots(env: Dict[str, str]) -> List[str]:
    roots = []
    if env.get("SCANSCI_PDF_REPO"):
        roots.append(env["SCANSCI_PDF_REPO"])
    roots.extend([r"A:\Project\ScanSci PDF", r"D:\scansci-pdf", r"D:\VSP\scansci-pdf"])
    return roots


def _split_command(value: str) -> List[str]:
    value = value.strip()
    if not value:
        return []
    if value.startswith("["):
        parsed = json.loads(value)
        return [str(item) for item in parsed]
    return shlex.split(value, posix=os.name != "nt")


class BrowserRuntimeResolver:
    def __init__(
        self,
        *,
        env: Optional[Dict[str, str]] = None,
        path_lookup: Optional[Callable[[str], Optional[str]]] = None,
        import_exists: Optional[Callable[[str], bool]] = None,
        path_exists: Optional[Callable[[str], bool]] = None,
        default_system_browser_paths: Optional[Iterable[str]] = None,
        scansci_pdf_roots: Optional[Iterable[str]] = None,
        cdp_discover: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
        egolite_probe: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
    ) -> None:
        self.env = dict(os.environ if env is None else env)
        self.path_lookup = path_lookup or shutil.which
        self.import_exists = import_exists or (lambda name: importlib.util.find_spec(name) is not None)
        self.path_exists = path_exists or (lambda path: Path(path).exists())
        self.system_browser_paths = list(
            _default_system_browser_paths() if default_system_browser_paths is None else default_system_browser_paths
        )
        self.scansci_pdf_roots = list(
            _default_scansci_pdf_roots(self.env) if scansci_pdf_roots is None else scansci_pdf_roots
        )
        # The CDP probe is intentionally not run during construction: the
        # resolver stays pure for tests, and the module-level doctor() injects
        # the real probe.
        self.cdp_discover = cdp_discover
        self.egolite_probe = egolite_probe

    @staticmethod
    def _default_cdp_discover() -> Optional[Dict[str, Any]]:
        try:
            from scansci_find.cdp import cdp_available, discover_chrome

            if not cdp_available():
                return None
            return discover_chrome()
        except Exception:
            return None

    def doctor(self) -> Dict[str, Any]:
        candidates = self._candidates()
        selected = next((item for item in candidates if item.get("available")), None)
        if selected:
            result = dict(selected)
            result["install_needed"] = False
            result["install_hint"] = ""
        else:
            result = {
                "selected": "",
                "source": "",
                "available": False,
                "install_needed": True,
                "install_hint": "No reusable browser runtime found. Suggested explicit install: pip install cloakbrowser, or configure SCANSCI_BROWSER_COMMAND.",
            }
        result["profile_dir"] = PROFILE_DIR
        result["cache_dir"] = CACHE_DIR
        result["candidates"] = candidates
        return result

    def _candidates(self) -> List[Dict[str, Any]]:
        candidates: List[Dict[str, Any]] = []
        configured = self.env.get("SCANSCI_BROWSER_COMMAND", "").strip()
        if configured:
            candidates.append(
                {
                    "selected": "configured_command",
                    "source": "SCANSCI_BROWSER_COMMAND",
                    "available": True,
                    "command": _split_command(configured),
                }
            )
        if self.egolite_probe is not None:
            try:
                egolite = self.egolite_probe()
            except Exception as exc:
                egolite = {"available": False, "error": str(exc)}
            candidates.append(
                {
                    "selected": "egolite",
                    "source": "egolite_task_space",
                    "available": bool(egolite and egolite.get("available")),
                    "task_space": self.env.get("SCANSCI_FIND_EGOLITE_TASK_SPACE", "paper download"),
                    "auto_start": self.env.get("SCANSCI_FIND_EGOLITE_AUTO_START", "1").lower() not in {"0", "false", "no"},
                    "error": str((egolite or {}).get("error") or ""),
                }
            )
        command_path = self.path_lookup("scansci-browser")
        candidates.append(
            {
                "selected": "scansci_browser_command",
                "source": "PATH",
                "available": bool(command_path),
                "path": command_path or "",
            }
        )
        candidates.append(
            {
                "selected": "scansci_browser_package",
                "source": "python_package",
                "available": bool(self.import_exists("scansci_browser")),
                "package": "scansci_browser",
            }
        )
        candidates.append(self._scan_scansci_pdf())
        if self.cdp_discover is not None:
            cdp_browser = self.cdp_discover()
            candidates.append(
                {
                    "selected": "cdp_chrome",
                    "source": "cdp_remote_debugging",
                    "available": bool(cdp_browser),
                    "port": cdp_browser.get("port") if cdp_browser else None,
                    "ws_url": cdp_browser.get("ws_url") if cdp_browser else "",
                }
            )
        for package in ("cloakbrowser", "playwright"):
            candidates.append(
                {
                    "selected": f"{package}_package",
                    "source": "python_package",
                    "available": bool(self.import_exists(package)),
                    "package": package,
                }
            )
        system_browser = self._system_browser()
        candidates.append(
            {
                "selected": "system_browser",
                "source": "system_browser",
                "available": bool(system_browser),
                "browser_binary": system_browser or "",
            }
        )
        return candidates

    def _scan_scansci_pdf(self) -> Dict[str, Any]:
        for root in self.scansci_pdf_roots:
            base = Path(root)
            module_paths = [
                base / "src" / "scansci_pdf" / "browser_engine.py",
                base / "src" / "scansci_pdf" / "browser_cookies.py",
            ]
            for module_path in module_paths:
                if self.path_exists(str(module_path)):
                    return {
                        "selected": "scansci_pdf_browser",
                        "source": "existing_scansci_pdf",
                        "available": True,
                        "repo": str(base),
                        "module": str(module_path),
                    }
        return {
            "selected": "scansci_pdf_browser",
            "source": "existing_scansci_pdf",
            "available": False,
            "repo": "",
            "module": "",
        }

    def _system_browser(self) -> str:
        for path in self.system_browser_paths:
            if self.path_exists(path):
                return path.replace("\\", "/")
        for name in ("chrome", "chrome.exe", "msedge", "msedge.exe"):
            found = self.path_lookup(name)
            if found:
                return found.replace("\\", "/")
        return ""


def doctor() -> Dict[str, Any]:
    from scansci_find.egolite import probe

    return BrowserRuntimeResolver(
        cdp_discover=BrowserRuntimeResolver._default_cdp_discover,
        egolite_probe=probe,
    ).doctor()


def main(argv: Optional[List[str]] = None) -> int:
    print(json.dumps(doctor(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
