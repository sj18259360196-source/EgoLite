"""Guided settings and persistent, explicitly dated session observations."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import config as settings
from .ego_config_state import atomic_bytes, transaction

_CHANNEL_KEYS = {
    "webvpn": ("vpnsci_enabled", "vpnsci_school", "vpnsci_base_url"),
    "carsi": ("carsi_enabled", "carsi_idp_name"),
    "ezproxy": ("ezproxy_enabled", "ezproxy_login_url"),
}
_GROUPS = {
    "basic": {"email", "output_dir"},
    "webvpn": {"vpnsci_enabled", "vpnsci_school", "vpnsci_base_url", "auto_relogin"},
    "carsi": {"carsi_enabled", "carsi_idp_name"},
    "ezproxy": {"ezproxy_enabled", "ezproxy_login_url"},
    "elsevier": {"elsevier_api_key"},
    "session": {"auto_relogin"},
}


def validate_setting(key, value):
    value = str(value).strip()
    if key == "email" and value and (not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value) or value.endswith(".invalid")):
        raise ValueError("请填写可用邮箱，不能使用示例地址")
    if key in {"vpnsci_base_url", "ezproxy_login_url"} and value:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("请填写学校提供的完整 http 或 https 入口")
    if key == "elsevier_api_key" and value and not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", value):
        raise ValueError("API Key 格式不完整，请复制完整密钥")
    return value


def _history_path():
    return settings.DATA_DIR / "ego-setup-state.json"


def _history():
    try:
        result = json.loads(_history_path().read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else {}
    except (OSError, ValueError):
        return {}


def _fingerprint(channel, cfg):
    return hashlib.sha256(json.dumps([cfg.get(key) for key in _CHANNEL_KEYS[channel]], ensure_ascii=False).encode()).hexdigest()


def record_check(channel, result, *, config=None):
    if channel not in _CHANNEL_KEYS:
        return
    cfg = config or settings.load_config()
    status = result.get("session_state")
    if not status:
        status = "valid" if result.get("session_valid") or result.get("success") is True else "unverified"
    with transaction(settings.DATA_DIR):
        history = _history()
        history[channel] = {"status": status, "at": time.time(), "fingerprint": _fingerprint(channel, cfg)}
        atomic_bytes(_history_path(), json.dumps(history).encode())


def session_summary(channel, cfg):
    from .sources.instsci import instsci_cookie_path, _get_webvpn_base
    from .sources.ezproxy import _ezproxy_cookie_path
    keys = _CHANNEL_KEYS[channel]
    enabled = bool(cfg.get(keys[0]))
    if channel == "webvpn":
        path = instsci_cookie_path(cfg)
        if not path.exists():
            path = Path(cfg.get("cache_dir", str(settings.DATA_DIR / "cache"))) / "instsci_cookies.json"
        base = _get_webvpn_base(cfg)
        payload = {"vpnsci_enabled": enabled, "vpnsci_school": cfg.get("vpnsci_school", ""), "vpnsci_base_url": base}
        configured = bool(base)
    elif channel == "ezproxy":
        path = _ezproxy_cookie_path(cfg)
        payload = {"ezproxy_enabled": enabled, "ezproxy_login_url": cfg.get("ezproxy_login_url", "")}
        configured = bool(payload["ezproxy_login_url"])
    else:
        path = Path(cfg.get("cache_dir", str(settings.DATA_DIR / "cache"))) / "carsi_cookies"
        payload = {"carsi_enabled": enabled, "carsi_idp_name": cfg.get("carsi_idp_name", "")}
        configured = bool(payload["carsi_idp_name"])
    def populated(candidate):
        try:
            return candidate.is_file() and candidate.stat().st_size > 2
        except OSError:
            return False
    has_cookies = any(populated(p) for p in path.glob("*.json")) if path.is_dir() else populated(path)
    saved = _history().get(channel, {})
    if not isinstance(saved, dict):
        saved = {}
    if saved.get("fingerprint") != _fingerprint(channel, cfg):
        saved = {}
    checked_at = saved.get("at", 0)
    if not isinstance(checked_at, (float, int)) or not math.isfinite(checked_at) or not 0 < checked_at <= time.time() + 60:
        saved = {}
    age = max(0, time.time() - saved.get("at", 0))
    status = saved.get("status", "unverified")
    if status == "valid" and age > 300:
        status = "unverified"
    if not enabled:
        status = "disabled"
    elif not configured:
        status = "needs_configuration"
    elif not has_cookies:
        status = "none"
    payload.update({"has_cookies": bool(has_cookies), "session_valid": status == "valid", "session_state": status,
                    "last_check": datetime.fromtimestamp(saved["at"], timezone.utc).isoformat() if saved.get("at") else None,
                    "configuration_state": "configured" if configured else "needs_configuration"})
    return payload


def setup_metadata():
    return {"config_saved": settings.CONFIG_FILE.exists(), "backup_available": settings.CONFIG_FILE.with_suffix(".json.bak").exists(),
            "data_directory": str(settings.DATA_DIR), "auto_relogin": bool(settings.load_config().get("auto_relogin", True))}


def verify_session(channel):
    cfg = settings.load_config()
    summary = session_summary(channel, cfg)
    if summary["session_state"] in {"disabled", "needs_configuration", "none"}:
        return summary
    if channel == "webvpn":
        from .sources.instsci import session_status
        status = session_status(cfg)
    elif channel == "ezproxy":
        from .sources.ezproxy import _validate_ezproxy_session
        status = "valid" if _validate_ezproxy_session(cfg) else "unverified"
    else:
        status = "unverified"  # CARSI cookie presence does not prove publisher access.
    record_check(channel, {"session_state": status}, config=cfg)
    return session_summary(channel, cfg)


class SetupRequest(BaseModel):
    channel: str
    values: dict[str, str | bool] = Field(default_factory=dict)
    school: str = ""


def apply_setup(req):
    allowed = _GROUPS.get(req.channel)
    if allowed is None or set(req.values) - allowed:
        raise ValueError("不支持的设置项")
    values = dict(req.values)
    if req.school:
        from .schools import list_schools
        school = next((entry for entry in list_schools() if entry.name == req.school and entry.school_type == "webvpn"), None)
        if req.channel != "webvpn" or school is None:
            raise ValueError("请从学校列表选择，或手动填写官方入口")
        values.update(vpnsci_school=school.name, vpnsci_base_url=school.host, vpnsci_enabled=True)
    with transaction(settings.DATA_DIR):
        cfg = settings.load_config()
        for key, raw in values.items():
            value = validate_setting(key, raw)
            if key == "elsevier_api_key" and not value:
                if not cfg.get(key):
                    raise ValueError("请先输入 API Key，也可以跳过此通道")
                continue
            if isinstance(settings.DEFAULT_CONFIG.get(key), bool):
                if value.lower() not in {"true", "false"}:
                    raise ValueError("开关值无效")
                cfg[key] = value.lower() == "true"
            else:
                cfg[key] = value
        if req.channel == "webvpn" and cfg.get("vpnsci_enabled") and not cfg.get("vpnsci_base_url"):
            raise ValueError("请选择学校，或填写学校提供的 WebVPN 入口")
        if req.channel == "carsi" and cfg.get("carsi_enabled") and not cfg.get("carsi_idp_name"):
            raise ValueError("请填写 CARSI 学校名称")
        if req.channel == "ezproxy" and cfg.get("ezproxy_enabled") and not cfg.get("ezproxy_login_url"):
            raise ValueError("请填写图书馆提供的 EZproxy 地址")
        settings.save_config(cfg)
    return {"success": True, "saved": sorted(values), "storage": setup_metadata()}


def install(app):
    router = APIRouter()

    @router.get("/api/setup/schools")
    async def schools(query: str = ""):
        from .schools import list_schools
        matches = [entry for entry in list_schools() if entry.school_type == "webvpn" and query.casefold() in f"{entry.name} {entry.province} {entry.host}".casefold()]
        return {"schools": [{"name": entry.name, "province": entry.province, "host": entry.host} for entry in matches[:50]], "total": len(matches)}

    @router.post("/api/setup")
    async def setup(req: SetupRequest):
        try:
            return await asyncio.to_thread(apply_setup, req)
        except ValueError as error:
            return JSONResponse({"success": False, "error": str(error)}, status_code=400)

    app.include_router(router)
