"""FastAPI web interface for ScanSci PDF."""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from .config import get_config_safe, load_config, mask_config_value, update_config
from .identifiers import is_arxiv_identifier, normalize_doi
from .log import get_logger
from .search import search_papers
from .sources import download

log = get_logger()

_TEMPLATE_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(_TEMPLATE_DIR))
templates.env.cache_size = 0

app = FastAPI(title="ScanSci PDF", description="Academic paper downloader web UI")


# --- Request/Response models ---

class DownloadRequest(BaseModel):
    identifier: str


class SearchRequest(BaseModel):
    query: str
    limit: int = 10


class ConfigUpdateRequest(BaseModel):
    key: str
    value: str


class ChannelActionRequest(BaseModel):
    channel: str
    action: str = "check"
    doi: str = ""
    publisher: str = "sciencedirect"
    use_bridges: bool = False


# --- Helper ---

_DOI_PATTERN = re.compile(r"^10\.\d{4,}/")
_DOI_URL_PATTERN = re.compile(r"https?://doi\.org/")


def _is_doi_or_arxiv(text: str) -> bool:
    """Check if input looks like a DOI or arXiv ID (not a title)."""
    text = text.strip()
    if is_arxiv_identifier(text):
        return True
    if _DOI_URL_PATTERN.match(text):
        return True
    if _DOI_PATTERN.match(text):
        return True
    return False


def _check_sources(config: dict[str, Any]) -> dict[str, Any]:
    """Check availability of key download sources."""
    sources: dict[str, bool | str] = {}

    # CloakBrowser
    try:
        from .browser_engine import is_available
        cb_available = is_available(config)
        sources["cloakbrowser"] = cb_available
    except Exception:
        sources["cloakbrowser"] = False

    # Tor
    try:
        from .tor import check_tor_circuit
        tor_ok = check_tor_circuit(config)
        sources["tor"] = tor_ok
    except Exception:
        sources["tor"] = False

    # WebVPN
    sources["webvpn"] = bool(config.get("webvpn_cookies"))

    # CARSI
    sources["carsi"] = bool(config.get("carsi_cookies"))

    sources["scihub"] = config.get("scihub_enabled", False)
    sources["libgen"] = config.get("libgen_enabled", False)
    sources["scibban"] = config.get("scibban_enabled", False)

    return sources


_EDITABLE_CONFIG = {
    "email",
    "output_dir",
    "download_strategy",
    "batch_workers",
    "connect_timeout",
    "read_timeout",
    "download_si",
    "auto_relogin",
    "browser_backend",
    "egolite_auto_start",
    "egolite_task_space",
    "vpnsci_enabled",
    "vpnsci_school",
    "vpnsci_base_url",
    "carsi_enabled",
    "carsi_idp_name",
    "ezproxy_enabled",
    "ezproxy_login_url",
    "elsevier_api_key",
    "scihub_enabled",
    "libgen_enabled",
    "scibban_enabled",
    "use_tor_for_scihub",
    "tor_use_bridges",
}


def _json_call(fn: Any, *args: Any, **kwargs: Any) -> dict[str, Any]:
    try:
        value = fn(*args, **kwargs)
        if isinstance(value, str):
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {"result": parsed}
        return value if isinstance(value, dict) else {"result": value}
    except Exception as exc:
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def _cookie_summary(payload: dict[str, Any]) -> dict[str, Any]:
    """Keep session diagnostics useful without exposing cookie file paths."""
    cleaned = dict(payload)
    cleaned.pop("cookie_file", None)
    publishers = cleaned.get("publishers")
    if isinstance(publishers, dict):
        cleaned["publishers"] = {
            key: {"has_cookies": bool(value.get("has_cookies"))}
            for key, value in publishers.items()
            if isinstance(value, dict)
        }
    return cleaned


def _dashboard_payload() -> dict[str, Any]:
    from .browser_backend import browser_info
    from .server import (
        scansci_pdf_carsi_status,
        scansci_pdf_ezproxy_status,
        scansci_pdf_vpnsci_status,
    )
    from .tor import check_tor_circuit

    config = load_config()
    safe = get_config_safe()
    browser = browser_info(config)
    if browser.get("backend") == "egolite" and os.name == "nt":
        try:
            probe = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq EgoLite.exe", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
            browser["available"] = "EgoLite.exe" in probe.stdout
        except Exception:
            browser["available"] = False
    else:
        browser["available"] = browser.get("backend") == "egolite"
    browser["strict_egolite"] = bool(
        browser.get("backend") == "egolite" and not config.get("egolite_external_browser_fallback", False)
    )

    channels = {
        "egolite": browser,
        "webvpn": _cookie_summary(_json_call(scansci_pdf_vpnsci_status, sync_egolite=False)),
        "carsi": _cookie_summary(_json_call(scansci_pdf_carsi_status)),
        "ezproxy": _cookie_summary(_json_call(scansci_pdf_ezproxy_status)),
        "elsevier": {
            "status": "configured" if config.get("elsevier_api_key") else "not_configured",
            "message": "Elsevier API Key 已配置。" if config.get("elsevier_api_key") else "Elsevier API Key 未配置。",
        },
        "oa": {
            "configured": bool(config.get("email") and config.get("email") != "scansci-pdf@example.invalid"),
            "email": safe.get("email", ""),
        },
        "grey": {
            "enabled": any(bool(config.get(key, False)) for key in ("scihub_enabled", "libgen_enabled", "scibban_enabled")),
            "sources": {
                "Sci-Hub": bool(config.get("scihub_enabled", False)),
                "LibGen": bool(config.get("libgen_enabled", False)),
                "SciBban": bool(config.get("scibban_enabled", False)),
            },
            "policy": "explicit_opt_in",
        },
        "tor": {
            "running": bool(check_tor_circuit(config)),
            "enabled_for_grey": bool(config.get("use_tor_for_scihub", False)),
            "use_bridges": bool(config.get("tor_use_bridges", False)),
        },
    }
    return {
        "status": "ok",
        "checked_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "project": {"name": "ScanSci PDF", "root": str(Path.cwd())},
        "priority": ["cache", "open_access", "elsevier_api", "institution", "grey_opt_in"],
        "channels": channels,
        "settings": {key: safe.get(key) for key in sorted(_EDITABLE_CONFIG) if key != "elsevier_api_key"},
        "secrets": {"elsevier_api_key_configured": bool(config.get("elsevier_api_key"))},
    }


# --- Routes ---

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html", context={})


@app.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request):
    return templates.TemplateResponse(request=request, name="settings.html", context={})


@app.get("/api/ping")
async def api_ping():
    return JSONResponse({
        "status": "ok",
        "service": "scansci-pdf",
        "project": {"name": "ScanSci PDF", "root": str(Path.cwd())},
    })


@app.get("/api/dashboard")
async def api_dashboard():
    return JSONResponse(await asyncio.to_thread(_dashboard_payload))


@app.post("/api/config")
async def api_config_update(req: ConfigUpdateRequest):
    key = req.key.strip()
    if key not in _EDITABLE_CONFIG:
        return JSONResponse({"success": False, "error": "Setting is not editable from the dashboard."}, status_code=400)
    if key == "browser_backend" and req.value.strip().lower() != "egolite":
        return JSONResponse({"success": False, "error": "This installation is locked to the EgoLite browser backend."}, status_code=400)
    if key == "elsevier_api_key" and not req.value.strip():
        return JSONResponse({"success": True, "key": key, "unchanged": True})
    try:
        config = await asyncio.to_thread(update_config, key, req.value)
    except Exception as exc:
        return JSONResponse({"success": False, "error": str(exc)}, status_code=400)
    return JSONResponse({"success": True, "key": key, "value": mask_config_value(key, config.get(key))})


@app.post("/api/channel/action")
async def api_channel_action(req: ChannelActionRequest):
    from .server import (
        scansci_pdf_carsi_login,
        scansci_pdf_carsi_status,
        scansci_pdf_elsevier_setup,
        scansci_pdf_ezproxy_login,
        scansci_pdf_ezproxy_status,
        scansci_pdf_health_check,
        scansci_pdf_tor_install,
        scansci_pdf_tor_start,
        scansci_pdf_tor_stop,
        scansci_pdf_vpnsci_login,
        scansci_pdf_vpnsci_status,
        scansci_pdf_vpnsci_test,
    )

    channel = req.channel.strip().lower()
    action = req.action.strip().lower()

    def run() -> dict[str, Any]:
        if channel == "egolite":
            from .browser_backend import browser_info
            from .egolite_bridge import is_available
            config = load_config()
            return {**browser_info(config), "available": bool(is_available(config, refresh=True))}
        if channel == "webvpn":
            if action == "login":
                return _json_call(scansci_pdf_vpnsci_login)
            if action == "test":
                return _json_call(scansci_pdf_vpnsci_test, doi=req.doi or None)
            return _cookie_summary(_json_call(scansci_pdf_vpnsci_status))
        if channel == "carsi":
            if action == "login":
                return _json_call(scansci_pdf_carsi_login, publisher=req.publisher)
            return _cookie_summary(_json_call(scansci_pdf_carsi_status))
        if channel == "ezproxy":
            if action == "login":
                return _json_call(scansci_pdf_ezproxy_login)
            return _cookie_summary(_json_call(scansci_pdf_ezproxy_status))
        if channel == "elsevier":
            config = load_config()
            api_key = config.get("elsevier_api_key")
            if not api_key:
                return {"status": "not_configured", "success": False, "error": "请先在设置页填写 Elsevier API Key。"}
            key_check = _json_call(scansci_pdf_elsevier_setup, test=action == "test")
            key_check.pop("key_preview", None)
            if action != "test":
                return key_check
            from .sources.elsevier_api import fetch_pdf, get_last_error
            test_doi = req.doi or "10.1016/s0969-806x(02)00351-1"
            pdf = fetch_pdf(test_doi, api_key, config.get("elsevier_insttoken", ""))
            retrieval = {"status": "passed", "doi": test_doi} if pdf and pdf[:4] == b"%PDF" else {
                "status": "blocked",
                "doi": test_doi,
                **get_last_error(),
            }
            return {
                "status": "configured",
                "key_test": key_check.get("test", "unknown"),
                "retrieval": retrieval,
                "message": "API Key 基础验证与全文 Retrieval 权限已分别检查。",
            }
        if channel == "oa":
            report = _json_call(scansci_pdf_health_check, detailed=False)
            checks = report.get("checks", {})
            oa_checks = {k: v for k, v in checks.items() if k not in {"tor", "browser"}}
            overall = "ok" if oa_checks and all(v.get("status") == "ok" for v in oa_checks.values()) else "degraded"
            return {"overall": overall, "checks": oa_checks}
        if channel == "tor":
            if action == "install":
                return _json_call(scansci_pdf_tor_install)
            if action == "start":
                return _json_call(scansci_pdf_tor_start, use_bridges=req.use_bridges)
            if action == "stop":
                return _json_call(scansci_pdf_tor_stop)
            from .tor import check_tor_circuit
            config = load_config()
            return {"running": bool(check_tor_circuit(config)), "enabled_for_grey": bool(config.get("use_tor_for_scihub", False))}
        if channel == "grey":
            config = load_config()
            return {
                "enabled": any(bool(config.get(key, False)) for key in ("scihub_enabled", "libgen_enabled", "scibban_enabled")),
                "sources": {
                    "Sci-Hub": bool(config.get("scihub_enabled", False)),
                    "LibGen": bool(config.get("libgen_enabled", False)),
                    "SciBban": bool(config.get("scibban_enabled", False)),
                },
                "message": "Grey sources are never probed unless explicitly enabled.",
            }
        return {"success": False, "error": f"Unknown channel: {channel}"}

    result = await asyncio.to_thread(run)
    if result.get("error_type") in {"needs_configuration", "not_applicable"}:
        status_code = 409
    else:
        status_code = 400 if result.get("success") is False and result.get("error") else 200
    return JSONResponse(result, status_code=status_code)


@app.post("/api/download")
async def api_download(req: DownloadRequest):
    """Download a paper by DOI or arXiv ID. Returns PDF file or error JSON."""
    import asyncio

    identifier = req.identifier.strip()
    if not identifier:
        return JSONResponse({"success": False, "error": "Empty identifier"}, status_code=400)

    # Normalize DOI URL to bare DOI
    if _DOI_URL_PATTERN.match(identifier):
        identifier = _DOI_URL_PATTERN.sub("", identifier)

    # If input looks like a title (not DOI/arXiv), try to resolve first
    if not _is_doi_or_arxiv(identifier):
        from .resolver import resolve_title_to_doi
        config = load_config()
        doi = resolve_title_to_doi(identifier, config)
        if doi:
            identifier = doi
        else:
            return JSONResponse(
                {"success": False, "error": f"Could not resolve title to DOI: {identifier}"},
                status_code=404,
            )

    # Run download in a worker thread to avoid blocking the event loop.
    # asyncio.to_thread is the modern replacement for run_in_executor(None, fn)
    # and avoids deprecation warnings around get_event_loop() in async context.
    result = await asyncio.to_thread(download, identifier)

    if result.get("success"):
        file_path = result.get("file", "")
        source = result.get("source", "unknown")
        if file_path and Path(file_path).exists():
            filename = Path(file_path).name
            return FileResponse(
                file_path,
                media_type="application/pdf",
                filename=filename,
                headers={"X-ScanSci-Source": source},
            )
        return JSONResponse(
            {"success": False, "error": "PDF file not found on disk after download"},
            status_code=500,
        )

    # Enhance error response with actionable guidance
    error_response = dict(result)
    config = load_config()
    sources = _check_sources(config)
    error_response["sources"] = sources

    # Add specific guidance based on what's available
    guidance = error_response.get("guidance", [])
    if not sources.get("cloakbrowser"):
        guidance.insert(0, "CloakBrowser is not running. Start it to enable browser-based downloads for paywalled papers.")
    if not sources.get("tor"):
        guidance.append("Tor is not running. Start Tor for anonymous Sci-Hub access.")

    error_response["guidance"] = guidance
    return JSONResponse(error_response, status_code=404)


@app.post("/api/search")
async def api_search(req: SearchRequest):
    """Search papers by keyword. Returns list of results."""
    query = req.query.strip()
    if not query:
        return JSONResponse([], status_code=400)

    # Normalize DOI URL
    if _DOI_URL_PATTERN.match(query):
        query = _DOI_URL_PATTERN.sub("", query)

    # If input is a DOI/arXiv, skip search and return a single-item result
    if _is_doi_or_arxiv(query):
        return JSONResponse([{"doi": normalize_doi(query) if not is_arxiv_identifier(query) else query, "title": "", "is_direct": True}])

    results = search_papers(query, limit=req.limit)
    return JSONResponse(results)


@app.get("/api/status")
async def api_status():
    """Health check with source availability."""
    config = load_config()
    sources = _check_sources(config)

    return JSONResponse({
        "status": "ok",
        "output_dir": config.get("output_dir", ""),
        "sources": sources,
    })
