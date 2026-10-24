"""EgoLite browser bridge for ScanSci PDF.

The bridge uses EgoLite's managed ``ego-browser nodejs`` runtime instead of
launching another Chromium process.  Secrets are exchanged through short-lived
local files so cookie values never appear in command lines or logs.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .config import DATA_DIR

logger = logging.getLogger(__name__)


class EgoLiteError(RuntimeError):
    """Raised when the EgoLite desktop bridge cannot complete an operation."""


_LOCK = threading.RLock()
_AVAILABLE: bool | None = None


def _install_roots() -> list[Path]:
    roots = [Path(r"C:\Program Files\EgoLite")]
    local = os.environ.get("LOCALAPPDATA", "").strip()
    if local:
        roots.append(Path(local) / "Programs" / "EgoLite")
    return roots


def _native_install() -> tuple[Path, Path] | None:
    for root in _install_roots():
        exe = root / "EgoLite.exe"
        runtime = root / "resources" / "runtime" / "ego-browser.mjs"
        if exe.exists() and runtime.exists():
            return exe, runtime
    return None


@contextmanager
def _process_lock(config: dict[str, Any] | None = None):
    """Serialize the shared Task Space with ScanSci Find and other workers."""
    cfg = config or {}
    configured = str(cfg.get("egolite_lock_path", "") or os.environ.get("SCANSCI_EGOLITE_LOCK_PATH", "")).strip()
    path = Path(configured) if configured else Path(tempfile.gettempdir()) / "scansci-egolite-shared.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    try:
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def _command(config: dict[str, Any] | None = None) -> tuple[list[str], dict[str, str]]:
    cfg = config or {}
    configured = str(cfg.get("egolite_command", "") or "").strip()
    env = os.environ.copy()
    if configured:
        return [configured, "nodejs"], env

    if os.name == "nt":
        native = _native_install()
        if native:
            exe, runtime = native
            env["ELECTRON_RUN_AS_NODE"] = "1"
            return [str(exe), str(runtime), "nodejs"], env

    launcher = shutil.which("ego-browser")
    if not launcher:
        raise EgoLiteError("ego-browser command was not found")
    return [launcher, "nodejs"], env


def _desktop_running() -> bool:
    if os.name != "nt":
        return True
    try:
        completed = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq EgoLite.exe", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return "EgoLite.exe" in completed.stdout
    except Exception:
        return False


def is_installed(config: dict[str, Any] | None = None) -> bool:
    """Return whether an EgoLite command/runtime can be resolved locally."""
    try:
        _command(config)
        return True
    except EgoLiteError:
        return False


def _start_desktop(config: dict[str, Any] | None = None, *, force: bool = False) -> bool:
    """Start EgoLite quietly when the managed desktop broker is offline."""
    cfg = config or {}
    if not bool(cfg.get("egolite_auto_start", True)):
        return False
    if _desktop_running() and not force:
        return True
    if os.name != "nt":
        return False
    native = _native_install()
    if not native:
        return False
    exe, _ = native
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.Popen(
            [str(exe)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
            close_fds=True,
        )
        return True
    except OSError:
        return False


def _bridge_dir(config: dict[str, Any] | None = None) -> Path:
    cfg = config or {}
    cache = Path(cfg.get("cache_dir", str(DATA_DIR / "cache")))
    path = cache / "egolite_bridge"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _task_space(config: dict[str, Any] | None = None) -> str:
    cfg = config or {}
    return str(cfg.get("egolite_task_space", "paper download") or "paper download")


def _timeout(config: dict[str, Any] | None, value: float | None = None) -> float:
    if value is not None:
        return value
    cfg = config or {}
    return float(cfg.get("egolite_timeout_seconds", 90) or 90)


def _invoke(
    body: str,
    payload: dict[str, Any],
    config: dict[str, Any] | None = None,
    *,
    timeout: float | None = None,
) -> dict[str, Any]:
    """Run one EgoLite operation and return its JSON result."""
    work = _bridge_dir(config)
    token = uuid.uuid4().hex
    payload_path = work / f"payload-{token}.json"
    result_path = work / f"result-{token}.json"
    payload = dict(payload)
    payload.setdefault("taskSpace", _task_space(config))
    payload["resultPath"] = str(result_path)
    payload_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    payload_js = json.dumps(str(payload_path))
    script = f"""
const fs = await import('node:fs')
const payload = JSON.parse(fs.readFileSync({payload_js}, 'utf8'))
const writeResult = (value) => fs.writeFileSync(payload.resultPath, JSON.stringify(value), 'utf8')
try {{
  const spaces = (await taskSpaces.list())
    .filter(space => space.name === payload.taskSpace)
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))
  let task = null
  for (const candidate of spaces) {{
    try {{
      task = await taskSpaces.useOrCreate(candidate.id)
      break
    }} catch (error) {{
      if (!/Task is unavailable in the desktop UI/i.test(String(error))) throw error
    }}
  }}
  if (!task) task = await taskSpaces.new(payload.taskSpace)
  const tabs = await browser.listTabs()
  if (!tabs.length) await browser.openOrReuseTab('about:blank', {{ wait: true, timeout: 10000 }})
  {body}
}} catch (error) {{
  writeResult({{ ok: false, error: String(error && error.stack || error) }})
  process.exitCode = 1
}}
"""

    command, env = _command(config)
    try:
        cfg = config or {}
        startup_timeout = float(cfg.get("egolite_startup_timeout_seconds", 20) or 20)
        if not _desktop_running():
            _start_desktop(config)
        deadline = time.monotonic() + startup_timeout
        completed = None
        wake_signaled = False
        with _process_lock(config):
            while True:
                with _LOCK:
                    completed = subprocess.run(
                        command,
                        input=script,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        capture_output=True,
                        timeout=_timeout(config, timeout),
                        env=env,
                    )
                if result_path.exists():
                    break
                detail = (completed.stderr or completed.stdout or "").strip()
                broker_offline = "ego-compat-desktop-broker" in detail and (
                    "ENOENT" in detail or "connect" in detail.lower() or "pipe" in detail.lower()
                )
                if not broker_offline or time.monotonic() >= deadline:
                    break
                # Launching the desktop executable again also wakes an existing
                # single-instance process whose compatibility broker is not ready.
                if not wake_signaled:
                    _start_desktop(config, force=True)
                    wake_signaled = True
                time.sleep(1)
        if not result_path.exists():
            detail = ((completed.stderr or completed.stdout) if completed else "").strip()
            raise EgoLiteError(detail[-1200:] or "EgoLite did not return a result")
        result = json.loads(result_path.read_text(encoding="utf-8"))
        if not result.get("ok", False):
            raise EgoLiteError(str(result.get("error", "EgoLite operation failed")))
        return result
    except subprocess.TimeoutExpired as exc:
        raise EgoLiteError(f"EgoLite operation timed out after {_timeout(config, timeout):g}s") from exc
    finally:
        for path in (payload_path, result_path):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass


def is_available(config: dict[str, Any] | None = None, *, refresh: bool = False) -> bool:
    global _AVAILABLE
    cfg = config or {}
    if _AVAILABLE is True and not refresh:
        return _AVAILABLE
    if _AVAILABLE is False and not refresh and not bool(cfg.get("egolite_auto_start", True)):
        return False
    try:
        result = _invoke(
            "writeResult({ ok: true, taskSpaceId: task.id })",
            {},
            config,
            timeout=15,
        )
        _AVAILABLE = bool(result.get("ok"))
    except Exception:
        _AVAILABLE = False
    return _AVAILABLE


def _cookie_input(cookies: list[dict[str, Any]], config: dict[str, Any] | None) -> Path:
    path = _bridge_dir(config) / f"cookies-in-{uuid.uuid4().hex}.json"
    path.write_text(json.dumps(cookies, ensure_ascii=False), encoding="utf-8")
    return path


def export_cookies(
    config: dict[str, Any] | None = None,
    *,
    url: str = "",
    domain_suffix: str | None = None,
) -> list[dict[str, Any]]:
    cookie_path = _bridge_dir(config) / f"cookies-out-{uuid.uuid4().hex}.json"
    body = """
if (payload.url) await browser.openOrReuseTab(payload.url, { wait: true, timeout: payload.timeoutMs })
const response = await cdp('Network.getAllCookies')
let cookies = Array.isArray(response.cookies) ? response.cookies : []
if (payload.domainSuffix) {
  const suffix = payload.domainSuffix.replace(/^\./, '').toLowerCase()
  cookies = cookies.filter(c => String(c.domain || '').replace(/^\./, '').toLowerCase().endsWith(suffix))
}
const normalized = cookies.map(c => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path || '/',
  expires: c.session ? 0 : Number(c.expires || 0),
  httpOnly: Boolean(c.httpOnly),
  secure: Boolean(c.secure),
  sameSite: c.sameSite || 'Lax'
}))
fs.writeFileSync(payload.cookiePath, JSON.stringify(normalized), 'utf8')
writeResult({ ok: true, count: normalized.length, url: await page.url() })
"""
    try:
        _invoke(
            body,
            {
                "url": url,
                "domainSuffix": domain_suffix or "",
                "cookiePath": str(cookie_path),
                "timeoutMs": int(_timeout(config) * 1000),
            },
            config,
        )
        if not cookie_path.exists():
            return []
        data = json.loads(cookie_path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    finally:
        try:
            cookie_path.unlink(missing_ok=True)
        except OSError:
            pass


def import_cookies(cookies: list[dict[str, Any]], config: dict[str, Any] | None = None) -> int:
    if not cookies:
        return 0
    cookie_path = _cookie_input(cookies, config)
    body = """
const raw = JSON.parse(fs.readFileSync(payload.cookiePath, 'utf8'))
const cookies = raw.map(c => {
  const item = {
    name: String(c.name || ''), value: String(c.value || ''),
    domain: String(c.domain || ''), path: String(c.path || '/'),
    secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly),
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax'
  }
  if (Number(c.expires || 0) > 0) item.expires = Number(c.expires)
  return item
}).filter(c => c.name && c.domain)
if (cookies.length) await cdp('Network.setCookies', { cookies })
writeResult({ ok: true, count: cookies.length })
"""
    try:
        result = _invoke(body, {"cookiePath": str(cookie_path)}, config)
        return int(result.get("count", 0))
    finally:
        try:
            cookie_path.unlink(missing_ok=True)
        except OSError:
            pass


def navigate(url: str, config: dict[str, Any] | None = None, *, timeout: float | None = None) -> dict[str, Any]:
    body = """
await page.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: payload.timeoutMs })
writeResult({ ok: true, url: await page.url(), title: await page.title() })
"""
    return _invoke(
        body,
        {"url": url, "timeoutMs": int(_timeout(config, timeout) * 1000)},
        config,
        timeout=timeout,
    )


def snapshot(config: dict[str, Any] | None = None) -> dict[str, Any]:
    body = """
const data = await page.evaluate(() => ({
  html: document.documentElement ? document.documentElement.outerHTML : '',
  text: document.body ? document.body.innerText : '',
  contentType: document.contentType || ''
}))
writeResult({ ok: true, url: await page.url(), title: await page.title(), ...data })
"""
    return _invoke(body, {}, config)


def evaluate(expression: str, arg: Any = None, config: dict[str, Any] | None = None) -> Any:
    body = """
const value = await page.evaluate(({ source, hasArg, arg }) => {
  const candidate = (0, eval)(source)
  if (typeof candidate === 'function') return hasArg ? candidate(arg) : candidate()
  return candidate
}, { source: payload.expression, hasArg: payload.hasArg, arg: payload.arg })
writeResult({ ok: true, value: value === undefined ? null : value })
"""
    result = _invoke(
        body,
        {"expression": expression, "arg": arg, "hasArg": arg is not None},
        config,
    )
    return result.get("value")


def locator_action(
    selector: str,
    action: str,
    config: dict[str, Any] | None = None,
    *,
    position: str = "",
    index: int | None = None,
    value: Any = None,
    name: str = "",
    timeout_ms: int = 10000,
) -> Any:
    body = """
let loc = page.locator(payload.selector)
if (payload.position === 'first') loc = loc.first()
if (payload.position === 'last') loc = loc.last()
if (Number.isInteger(payload.index)) loc = loc.nth(payload.index)
let value = null
switch (payload.action) {
  case 'count': value = await loc.count(); break
  case 'click': value = await loc.click({ timeout: payload.timeoutMs }); break
  case 'fill': value = await loc.fill(String(payload.value ?? '')); break
  case 'press': value = await loc.press(String(payload.value ?? '')); break
  case 'innerText': value = await loc.innerText(); break
  case 'textContent': value = await loc.textContent(); break
  case 'innerHTML': value = await loc.innerHTML(); break
  case 'isVisible': value = await loc.isVisible(); break
  case 'isEnabled': value = await loc.isEnabled(); break
  case 'getAttribute': value = await loc.getAttribute(payload.name); break
  case 'waitFor': value = await loc.waitFor({ timeout: payload.timeoutMs }); break
  default: throw new Error('Unsupported locator action: ' + payload.action)
}
writeResult({ ok: true, value: value === undefined ? null : value })
"""
    result = _invoke(
        body,
        {
            "selector": selector,
            "action": action,
            "position": position,
            "index": index,
            "value": value,
            "name": name,
            "timeoutMs": timeout_ms,
        },
        config,
        timeout=max(_timeout(config), timeout_ms / 1000 + 10),
    )
    return result.get("value")


def screenshot(path: str | Path, config: dict[str, Any] | None = None, *, full_page: bool = True) -> str:
    body = """
await page.screenshot({ path: payload.path, fullPage: payload.fullPage })
writeResult({ ok: true, path: payload.path })
"""
    result = _invoke(body, {"path": str(path), "fullPage": full_page}, config)
    return str(result.get("path", path))


def download_pdf(
    url: str,
    output_path: str | Path,
    config: dict[str, Any] | None = None,
    *,
    timeout: float = 90,
) -> bool:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    pending = output.with_name(f"{output.name}.{uuid.uuid4().hex}.part")
    body = """
const target = new URL(payload.url)
await browser.openOrReuseTab(target.origin + '/', { wait: true, timeout: payload.timeoutMs })

async function fetchBinary(url) {
  return await page.evaluate(async ({ url, maxBytes }) => {
    const response = await fetch(url, { credentials: 'include', redirect: 'follow' })
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maxBytes) throw new Error('response exceeds egolite_max_pdf_mb')
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      finalUrl: response.url,
      base64: btoa(binary)
    }
  }, { url, maxBytes: payload.maxBytes })
}

let fetched = await fetchBinary(payload.url)
let bytes = Buffer.from(fetched.base64, 'base64')
let handoffUrl = ''
let handoffUserAgent = ''
let handoffReferer = payload.url
if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
  await page.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: payload.timeoutMs })
  let candidates = []
  for (let attempt = 0; attempt < 10 && candidates.length === 0; attempt++) {
    candidates = await page.evaluate(() => {
      const values = []
      for (const el of document.querySelectorAll('embed[src], iframe[src], object[data], a[href]')) {
        const raw = el.getAttribute('src') || el.getAttribute('data') || el.getAttribute('href') || ''
        if (/\.pdf(?:$|[?#])|\/pdfft(?:$|[?#])|pdf\/download|pdfdirect|downloadPdf|showPdf/i.test(raw)) {
          try { values.push(new URL(raw, location.href).href) } catch {}
        }
      }
      return [...new Set(values)].slice(0, 12)
    })
    if (candidates.length === 0) await new Promise(resolve => setTimeout(resolve, 1000))
  }
  let found = null
  for (const candidate of candidates) {
    try {
      try {
        await page.goto(candidate, { waitUntil: 'commit', timeout: payload.timeoutMs })
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 3000))
      const landed = await page.url()
      if (/pdf\.sciencedirectassets\.com|\.pdf(?:$|[?#])/i.test(landed)) {
        handoffUrl = landed
        try { handoffUserAgent = await page.evaluate(() => navigator.userAgent) } catch {}
        break
      }
      const origin = new URL(candidate).origin
      await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: payload.timeoutMs })
      const attempt = await fetchBinary(candidate)
      const candidateBytes = Buffer.from(attempt.base64, 'base64')
      if (candidateBytes.subarray(0, 5).toString('ascii') === '%PDF-') {
        found = { fetched: attempt, bytes: candidateBytes }
        break
      }
    } catch {}
  }
  if (!found && !handoffUrl) throw new Error('EgoLite did not receive a valid PDF response')
  if (found) {
    fetched = found.fetched
    bytes = found.bytes
  }
}
if (handoffUrl) {
  writeResult({
    ok: true,
    path: payload.outputPath,
    signedUrl: handoffUrl,
    userAgent: handoffUserAgent,
    referer: handoffReferer
  })
} else {
  if (bytes.length < payload.minBytes) throw new Error('PDF response is smaller than min_pdf_size_bytes')
  fs.writeFileSync(payload.outputPath, bytes)
  writeResult({ ok: true, path: payload.outputPath, bytes: bytes.length, finalUrl: fetched.finalUrl, contentType: fetched.contentType })
}
"""
    cfg = config or {}
    try:
        result = _invoke(
            body,
            {
                "url": url,
                "outputPath": str(pending),
                "timeoutMs": int(timeout * 1000),
                "minBytes": 1,
                "maxBytes": int(float(cfg.get("egolite_max_pdf_mb", 100)) * 1024 * 1024),
            },
            config,
            timeout=timeout + 20,
        )
        signed_url = str(result.get("signedUrl", "") or "")
        if signed_url:
            import requests
            with requests.Session() as session:
                session.trust_env = False
                headers = {
                    "User-Agent": str(result.get("userAgent", "") or "Mozilla/5.0"),
                    "Referer": str(result.get("referer", "") or url),
                }
                with session.get(
                    signed_url, headers=headers, timeout=(20, timeout), stream=True
                ) as response:
                    response.raise_for_status()
                    total = 0
                    deadline = time.monotonic() + timeout
                    with pending.open("wb") as handle:
                        for chunk in response.iter_content(chunk_size=1024 * 256):
                            if chunk:
                                total += len(chunk)
                                if total > int(float(cfg.get("egolite_max_pdf_mb", 100)) * 1024 * 1024):
                                    raise ValueError("PDF exceeds configured size limit")
                                if time.monotonic() > deadline:
                                    raise TimeoutError("PDF stream deadline exceeded")
                                handle.write(chunk)
        from .pdf_utils import is_readable_pdf
        if not is_readable_pdf(pending):
            raise ValueError("Response is not a readable PDF")
        pending.replace(output)
        return True
    except Exception as exc:
        logger.warning(
            "EgoLite PDF download failed for %s: %s",
            urlparse(url).netloc or url,
            type(exc).__name__,
        )
        try:
            pending.unlink(missing_ok=True)
        except OSError:
            pass
        return False


def interactive_login(
    url: str,
    config: dict[str, Any] | None = None,
    *,
    max_wait: int = 300,
) -> list[dict[str, Any]]:
    cookie_path = _bridge_dir(config) / f"login-cookies-{uuid.uuid4().hex}.json"
    body = """
await browser.openOrReuseTab(payload.url, { wait: true, timeout: 60000 })
for (const selector of ['#onetrust-accept-btn-handler', '.onetrust-close-btn-handler']) {
  try { const loc = page.locator(selector); if (await loc.count()) await loc.first().click({ timeout: 2000 }) } catch {}
}
const loginState = async () => await page.evaluate(() => {
  const selectors = [
    'input[type="password"]', 'form[action*="login" i]', 'form[id*="login" i]',
    '[class*="login" i] input', '[id*="login" i] input'
  ]
  return {
    url: location.href,
    hasLoginForm: selectors.some(selector => Boolean(document.querySelector(selector)))
  }
})
const initial = await loginState()
const initialCookies = (await cdp('Network.getAllCookies')).cookies || []
const cookieKey = cookies => cookies.map(c => `${c.name}\u0000${c.domain}\u0000${c.value}`).sort().join('\u0001')
const initialCookieKey = cookieKey(initialCookies)
const looksLikeLoginUrl = value => /(?:login|signin|sign-in|auth|sso|cas)/i.test(value)
let completed = !initial.hasLoginForm && !looksLikeLoginUrl(initial.url)
let stableChecks = 0
for (let elapsed = 0; !completed && elapsed < payload.maxWait; elapsed++) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  const state = await loginState()
  const cookies = (await cdp('Network.getAllCookies')).cookies || []
  const changed = cookieKey(cookies) !== initialCookieKey
  const navigated = state.url !== initial.url
  if (!state.hasLoginForm && (navigated || changed) && !looksLikeLoginUrl(state.url)) {
    stableChecks += 1
    completed = stableChecks >= 2
  } else {
    stableChecks = 0
  }
}
if (!completed) throw new Error('Timed out waiting for login in the shared EgoLite window')
const response = await cdp('Network.getAllCookies')
const cookies = (response.cookies || []).map(c => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
  expires: c.session ? 0 : Number(c.expires || 0), httpOnly: Boolean(c.httpOnly),
  secure: Boolean(c.secure), sameSite: c.sameSite || 'Lax'
}))
fs.writeFileSync(payload.cookiePath, JSON.stringify(cookies), 'utf8')
writeResult({ ok: true, count: cookies.length, url: await page.url(), title: await page.title(), shared: true })
"""
    try:
        _invoke(
            body,
            {"url": url, "maxWait": max_wait, "cookiePath": str(cookie_path)},
            config,
            timeout=max_wait + 45,
        )
        if not cookie_path.exists():
            return []
        data = json.loads(cookie_path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    finally:
        try:
            cookie_path.unlink(missing_ok=True)
        except OSError:
            pass


class EgoLiteLocator:
    def __init__(self, selector: str, config: dict[str, Any] | None, *, position: str = "", index: int | None = None):
        self.selector = selector
        self.config = config
        self.position = position
        self.index = index

    @property
    def first(self) -> "EgoLiteLocator":
        return EgoLiteLocator(self.selector, self.config, position="first")

    @property
    def last(self) -> "EgoLiteLocator":
        return EgoLiteLocator(self.selector, self.config, position="last")

    def nth(self, index: int) -> "EgoLiteLocator":
        return EgoLiteLocator(self.selector, self.config, index=index)

    def _call(self, action: str, **kwargs: Any) -> Any:
        return locator_action(
            self.selector,
            action,
            self.config,
            position=self.position,
            index=self.index,
            **kwargs,
        )

    def count(self) -> int:
        return int(self._call("count") or 0)

    def click(self, timeout: int = 10000, **_: Any) -> Any:
        return self._call("click", timeout_ms=timeout)

    def fill(self, value: str, **_: Any) -> Any:
        return self._call("fill", value=value)

    def type(self, value: str, **_: Any) -> Any:
        return self._call("fill", value=value)

    def press(self, value: str, **_: Any) -> Any:
        return self._call("press", value=value)

    def inner_text(self, timeout: int = 10000) -> str:
        return str(self._call("innerText", timeout_ms=timeout) or "")

    def text_content(self) -> str | None:
        value = self._call("textContent")
        return None if value is None else str(value)

    def inner_html(self) -> str:
        return str(self._call("innerHTML") or "")

    def is_visible(self, **_: Any) -> bool:
        return bool(self._call("isVisible"))

    def is_enabled(self, **_: Any) -> bool:
        return bool(self._call("isEnabled"))

    def get_attribute(self, name: str, **_: Any) -> str | None:
        value = self._call("getAttribute", name=name)
        return None if value is None else str(value)

    def wait_for(self, timeout: int = 10000, **_: Any) -> Any:
        return self._call("waitFor", timeout_ms=timeout)


class EgoLitePage:
    def __init__(self, config: dict[str, Any] | None = None):
        self.config = config or {}
        self._default_timeout = 30000

    @property
    def url(self) -> str:
        return str(snapshot(self.config).get("url", ""))

    def goto(self, url: str, timeout: int | None = None, **_: Any) -> None:
        navigate(url, self.config, timeout=(timeout or self._default_timeout) / 1000)
        return None

    def title(self) -> str:
        return str(snapshot(self.config).get("title", ""))

    def content(self) -> str:
        return str(snapshot(self.config).get("html", ""))

    def evaluate(self, expression: str, arg: Any = None) -> Any:
        return evaluate(expression, arg, self.config)

    def locator(self, selector: str) -> EgoLiteLocator:
        return EgoLiteLocator(selector, self.config)

    def query_selector(self, selector: str) -> EgoLiteLocator | None:
        loc = self.locator(selector)
        return loc.first if loc.count() else None

    def screenshot(self, path: str, full_page: bool = True, **_: Any) -> None:
        screenshot(path, self.config, full_page=full_page)

    def set_default_timeout(self, timeout: int) -> None:
        self._default_timeout = timeout

    def wait_for_timeout(self, timeout: int) -> None:
        time.sleep(max(0, timeout) / 1000)

    def wait_for_load_state(self, *_: Any, timeout: int = 10000, **__: Any) -> None:
        time.sleep(min(max(0, timeout), 1000) / 1000)

    def on(self, *_: Any, **__: Any) -> None:
        return None

    def remove_listener(self, *_: Any, **__: Any) -> None:
        return None

    def close(self) -> None:
        return None


class EgoLiteContext:
    def __init__(self, config: dict[str, Any] | None = None):
        self.config = config or {}
        self._page = EgoLitePage(self.config)

    @property
    def pages(self) -> list[EgoLitePage]:
        return [self._page]

    def new_page(self) -> EgoLitePage:
        return self._page

    def cookies(self, *_: Any) -> list[dict[str, Any]]:
        return export_cookies(self.config)

    def add_cookies(self, cookies: list[dict[str, Any]]) -> None:
        import_cookies(cookies, self.config)

    def close(self) -> None:
        return None


class EgoLiteBrowser:
    def __init__(self, config: dict[str, Any] | None = None):
        self.config = config or {}
        self._context = EgoLiteContext(self.config)

    def new_context(self, **_: Any) -> EgoLiteContext:
        return self._context

    def is_connected(self) -> bool:
        return is_available(self.config)

    def close(self) -> None:
        return None


def launch(config: dict[str, Any] | None = None) -> EgoLiteBrowser:
    if not is_available(config, refresh=True):
        raise EgoLiteError("EgoLite desktop broker is unavailable")
    return EgoLiteBrowser(config)


def launch_persistent_context(config: dict[str, Any] | None = None) -> EgoLiteContext:
    return launch(config).new_context()
