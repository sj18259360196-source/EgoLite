"""Loopback-only Ego host for the retained settings UI."""

from __future__ import annotations

import argparse
import hmac
import os
import secrets
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn
from fastapi.responses import JSONResponse

from .web import app
from . import server as _core_server

TOKEN = os.environ.get("SCANSCI_EGO_TOKEN") or secrets.token_urlsafe(32)
INSTANCE = os.environ.get("SCANSCI_EGO_INSTANCE", "standalone")


@app.middleware("http")
async def local_access(request, call_next):
    host = request.headers.get("host", "")
    if urlsplit("http://" + host).hostname not in {"127.0.0.1", "localhost"}:
        return JSONResponse({"error": "Invalid local host"}, status_code=403)
    origin = request.headers.get("origin")
    expected = "http://" + host
    if origin and origin != expected:
        return JSONResponse({"error": "Cross-origin access denied"}, status_code=403)
    if request.method not in {"GET", "HEAD"}:
        header = request.headers.get("x-ego-scansci-token", "")
        cookie = request.cookies.get("ego_scansci", "")
        header_ok = hmac.compare_digest(header, TOKEN)
        browser_ok = origin == expected and hmac.compare_digest(cookie, TOKEN)
        if not (header_ok or browser_ok):
            return JSONResponse({"error": "Local authorization required"}, status_code=403)
    if request.url.path == "/api/ping":
        response = JSONResponse({
            "status": "ok", "service": "scansci-pdf", "version": "1.19.0",
            "protocol": "ego-scansci-v1", "instance": INSTANCE,
            "project": {"name": "ScanSci PDF", "root": str(Path(__file__).resolve().parents[2])},
        })
    else:
        response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
    if request.url.path in {"/", "/settings"}:
        response.set_cookie("ego_scansci", TOKEN, httponly=True, samesite="strict", path="/")
    return response


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", choices=["127.0.0.1"], default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
