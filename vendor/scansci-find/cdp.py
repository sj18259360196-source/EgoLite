"""Chrome DevTools Protocol (CDP) browser access for login-gated sources.

Drives the user's own Chrome with remote debugging enabled (via
``chrome://inspect/#remote-debugging``), so Google Scholar, CNKI, and
institutional login state carry over automatically — no credentials, cookies,
or tokens are ever handled by this module.

The dependency is optional: ``pip install scansci-find[cdp]``
(``websocket-client``). Every capability degrades gracefully — when the
dependency or a debuggable Chrome is missing, providers surface a
``blocked_configuration`` error instead of crashing.

Operational constraints: one background tab per operation (user tabs are
never touched), 5-10 s pacing between pages, at most 20 searches per session,
and an explicit stop on CAPTCHA pages.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

DISCOVERY_PORTS = (9222, 9229, 9333)
MAX_SEARCHES_PER_SESSION = 20
PAGE_PACING_SECONDS = (5.0, 10.0)


class CdpError(RuntimeError):
    """A CDP command failed (or the browser is unreachable)."""


def _tcp_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


def _devtools_active_port_files() -> List[Path]:
    candidates: List[Path] = []
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", "")
        for vendor in (("Google", "Chrome"), ("Chromium",), ("Microsoft", "Edge")):
            candidates.append(Path(local, *vendor, "User Data", "DevToolsActivePort"))
    elif sys.platform == "darwin":
        home = Path.home()
        for vendor in ("Google", "Chromium"):
            candidates.append(home / "Library" / "Application Support" / vendor / "Chrome" / "DevToolsActivePort")
    else:
        home = Path.home()
        for vendor in ("google-chrome", "chromium"):
            candidates.append(home / ".config" / vendor / "DevToolsActivePort")
    return candidates


def discover_chrome(*, port_scan: bool = True) -> Optional[Dict[str, Any]]:
    """Locate a Chrome instance with remote debugging enabled.

    Returns ``{"port", "ws_url", "source"}`` where ``source`` is
    ``"DevToolsActivePort"`` or ``"port_scan"``, or ``None`` when no
    debuggable browser is found.
    """
    for path in _devtools_active_port_files():
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        if len(lines) < 2 or not lines[0].strip().isdigit():
            continue
        port = int(lines[0].strip())
        if not _tcp_open("127.0.0.1", port):
            continue
        ws_path = lines[1].strip()
        ws_url = f"ws://127.0.0.1:{port}{ws_path}" if ws_path else f"ws://127.0.0.1:{port}/devtools/browser"
        return {"port": port, "ws_url": ws_url, "source": "DevToolsActivePort"}
    if port_scan:
        for port in DISCOVERY_PORTS:
            if not _tcp_open("127.0.0.1", port):
                continue
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as response:
                    payload = json.loads(response.read().decode("utf-8"))
            except (OSError, ValueError, urllib.error.URLError):
                continue
            ws_url = str(payload.get("webSocketDebuggerUrl") or f"ws://127.0.0.1:{port}/devtools/browser")
            return {"port": port, "ws_url": ws_url, "source": "port_scan"}
    return None


def cdp_available() -> bool:
    try:
        import websocket  # noqa: F401
    except ImportError:
        return False
    return True


class CdpSession:
    """Minimal CDP client: one browser-level WebSocket, per-tab sessions.

    Each page operation runs in its own background tab created with
    ``Target.createTarget``; the session map is updated from
    ``Target.attachedToTarget`` responses. User tabs are never modified.
    """

    def __init__(self, ws_url: str, timeout: float = 30.0) -> None:
        if not cdp_available():
            raise CdpError("CDP requires the optional dependency: pip install scansci-find[cdp]")
        import websocket  # lazy import keeps the core package dependency-free

        self._ws = websocket.create_connection(ws_url, timeout=timeout)
        self._command_id = 0
        self._sessions: Dict[str, str] = {}

    def _command(self, method: str, params: Optional[Dict[str, Any]] = None, *, session_id: Optional[str] = None) -> Dict[str, Any]:
        self._command_id += 1
        message: Dict[str, Any] = {"id": self._command_id, "method": method, "params": params or {}}
        if session_id:
            message["sessionId"] = session_id
        self._ws.send(json.dumps(message))
        while True:
            payload = json.loads(self._ws.recv())
            if payload.get("id") == self._command_id:
                if payload.get("error"):
                    raise CdpError(str(payload["error"].get("message") or payload["error"]))
                return payload.get("result") or {}
            if payload.get("method") == "Target.attachedToTarget":
                info = payload.get("params") or {}
                if info.get("targetId") and info.get("sessionId"):
                    self._sessions[info["targetId"]] = info["sessionId"]

    def new_tab(self, url: str = "about:blank") -> str:
        result = self._command("Target.createTarget", {"url": "about:blank", "background": True})
        target_id = str(result.get("targetId") or "")
        if not target_id:
            raise CdpError("CDP did not return a targetId")
        attach = self._command("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        if attach.get("sessionId"):
            self._sessions[target_id] = attach["sessionId"]
        if url != "about:blank":
            self.navigate(target_id, url)
        return target_id

    def _session_id(self, target_id: str) -> str:
        session_id = self._sessions.get(target_id)
        if not session_id:
            raise CdpError(f"no session for target {target_id}")
        return session_id

    def evaluate(self, target_id: str, expression: str) -> Any:
        result = self._command(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
            session_id=self._session_id(target_id),
        )
        if result.get("exceptionDetails"):
            raise CdpError(str(result["exceptionDetails"].get("text") or "page evaluation failed"))
        return (result.get("result") or {}).get("value")

    def evaluate_json(self, target_id: str, expression: str) -> Any:
        value = self.evaluate(target_id, expression)
        if isinstance(value, str):
            return json.loads(value)
        return value

    def navigate(self, target_id: str, url: str) -> None:
        self._command("Page.navigate", {"url": url}, session_id=self._session_id(target_id))
        self.wait_ready(target_id)

    def wait_ready(self, target_id: str, timeout: float = 15.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if self.evaluate(target_id, "document.readyState") == "complete":
                    return
            except CdpError:
                pass
            time.sleep(0.5)

    def close_tab(self, target_id: str) -> None:
        try:
            self._command("Target.closeTarget", {"targetId": target_id})
        except CdpError:
            pass
        self._sessions.pop(target_id, None)

    def close(self) -> None:
        try:
            self._ws.close()
        except Exception:
            pass


class CdpBrowser:
    """Cached connection to a debuggable Chrome, with session accounting.

    ``search_count`` enforces the per-session search budget; providers call
    ``acquire_search()`` before each site search and stop at the cap.
    """

    def __init__(self, info: Optional[Dict[str, Any]] = None) -> None:
        self.info = info or discover_chrome()
        if not self.info:
            raise CdpError(
                "no Chrome with remote debugging found; enable it via chrome://inspect/#remote-debugging "
                "or install scansci-find[cdp] for the CDP sources"
            )
        if not cdp_available():
            raise CdpError("CDP requires the optional dependency: pip install scansci-find[cdp]")
        self._session = CdpSession(str(self.info["ws_url"]))
        self.search_count = 0

    def acquire_search(self) -> None:
        if self.search_count >= MAX_SEARCHES_PER_SESSION:
            raise CdpError(
                f"reached the per-session search budget ({MAX_SEARCHES_PER_SESSION}); "
                "start a new scan or reduce the query variants"
            )
        self.search_count += 1
        time.sleep(PAGE_PACING_SECONDS[0] + (PAGE_PACING_SECONDS[1] - PAGE_PACING_SECONDS[0]) * 0.5)

    def close(self) -> None:
        self._session.close()
