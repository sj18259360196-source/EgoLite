"""Native EgoLite runtime for browser-backed academic sources."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

MAX_SEARCHES_PER_SESSION = 20


class EgoLiteError(RuntimeError):
    """An EgoLite desktop or task-space operation failed."""


_LOCK = threading.RLock()


def _install_roots(env: Optional[Dict[str, str]] = None) -> List[Path]:
    runtime_env = dict(os.environ if env is None else env)
    roots = [Path(r"C:\Program Files\EgoLite")]
    local = runtime_env.get("LOCALAPPDATA", "").strip()
    if local:
        roots.append(Path(local) / "Programs" / "EgoLite")
    return roots


def _native_install(env: Optional[Dict[str, str]] = None) -> Optional[tuple[Path, Path]]:
    for root in _install_roots(env):
        exe = root / "EgoLite.exe"
        runtime = root / "resources" / "runtime" / "ego-browser.mjs"
        if exe.exists() and runtime.exists():
            return exe, runtime
    return None


def _startup_error(detail: str) -> bool:
    lower = detail.lower()
    return (
        "ego-compat-desktop-broker" in detail
        and ("enoent" in lower or "connect" in lower or "pipe" in lower)
    ) or "webview must be attached" in lower or "dom-ready" in lower or "unknown desktop session" in lower


@contextmanager
def _process_lock(work: Path, env: Optional[Dict[str, str]] = None):
    """Serialize access to the shared EgoLite Task Space across processes."""
    runtime_env = dict(os.environ if env is None else env)
    configured = runtime_env.get("SCANSCI_EGOLITE_LOCK_PATH", "").strip()
    if configured:
        path = Path(configured)
    elif runtime_env.get("SCANSCI_FIND_EGOLITE_CACHE", "").strip():
        path = work / "scansci-find-egolite.lock"
    else:
        path = Path(tempfile.gettempdir()) / "scansci-egolite-shared.lock"
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


def _command(env: Optional[Dict[str, str]] = None) -> tuple[List[str], Dict[str, str]]:
    runtime_env = dict(os.environ if env is None else env)
    configured = runtime_env.get("SCANSCI_FIND_EGOLITE_COMMAND", "").strip()
    if configured:
        return [configured, "nodejs"], runtime_env
    if os.name == "nt":
        native = _native_install(runtime_env)
        if native:
            exe, runtime = native
            runtime_env["ELECTRON_RUN_AS_NODE"] = "1"
            return [str(exe), str(runtime), "nodejs"], runtime_env
    launcher = shutil.which("ego-browser")
    if launcher:
        return [launcher, "nodejs"], runtime_env
    raise EgoLiteError("EgoLite runtime was not found")


def installed(env: Optional[Dict[str, str]] = None) -> bool:
    try:
        _command(env)
        return True
    except EgoLiteError:
        return False


def _desktop_running() -> bool:
    if os.name != "nt":
        return True
    try:
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq EgoLite.exe", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return "EgoLite.exe" in result.stdout
    except Exception:
        return False


def _start_desktop(env: Optional[Dict[str, str]] = None, *, force: bool = False) -> bool:
    runtime_env = dict(os.environ if env is None else env)
    if runtime_env.get("SCANSCI_FIND_EGOLITE_AUTO_START", "1").lower() in {"0", "false", "no"}:
        return False
    if _desktop_running() and not force:
        return True
    if os.name != "nt":
        return False
    native = _native_install(runtime_env)
    if not native:
        return False
    exe, _ = native
    try:
        subprocess.Popen(
            [str(exe)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            close_fds=True,
        )
        return True
    except OSError:
        return False


def _invoke(
    body: str,
    payload: Dict[str, Any],
    *,
    env: Optional[Dict[str, str]] = None,
    timeout: float = 90.0,
) -> Dict[str, Any]:
    runtime_env = dict(os.environ if env is None else env)
    work = Path(runtime_env.get("SCANSCI_FIND_EGOLITE_CACHE", "") or tempfile.gettempdir())
    work.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    payload_path = work / f"scansci-find-egolite-{token}.json"
    result_path = work / f"scansci-find-egolite-result-{token}.json"
    request = dict(payload)
    request["taskSpace"] = runtime_env.get("SCANSCI_FIND_EGOLITE_TASK_SPACE", "paper download")
    request["resultPath"] = str(result_path)
    payload_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    script = f"""
const fs = await import('node:fs')
const payload = JSON.parse(fs.readFileSync({json.dumps(str(payload_path))}, 'utf8'))
const writeResult = value => fs.writeFileSync(payload.resultPath, JSON.stringify(value), 'utf8')
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
  const tabs = await browser.listTabs({{ includeChrome: false }})
  if (!tabs.length) await browser.openOrReuseTab('about:blank', {{ wait: true, timeout: 10000 }})
  {body}
}} catch (error) {{
  writeResult({{ ok: false, error: String(error && error.stack || error) }})
  process.exitCode = 1
}}
"""
    command, command_env = _command(runtime_env)
    startup_timeout = float(runtime_env.get("SCANSCI_FIND_EGOLITE_STARTUP_TIMEOUT", "25"))
    try:
        if not _desktop_running():
            _start_desktop(runtime_env)
        deadline = time.monotonic() + startup_timeout
        wake_signaled = False
        completed = None
        with _process_lock(work, runtime_env):
            while True:
                with _LOCK:
                    completed = subprocess.run(
                        command,
                        input=script,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        capture_output=True,
                        timeout=timeout,
                        env=command_env,
                    )
                if result_path.exists():
                    candidate = json.loads(result_path.read_text(encoding="utf-8"))
                    if candidate.get("ok"):
                        break
                    detail = str(candidate.get("error") or "")
                    if not _startup_error(detail) or time.monotonic() >= deadline:
                        break
                    result_path.unlink(missing_ok=True)
                    if not wake_signaled:
                        _start_desktop(runtime_env, force=True)
                        wake_signaled = True
                    time.sleep(1)
                    continue
                detail = (completed.stderr or completed.stdout or "").strip()
                if not _startup_error(detail) or time.monotonic() >= deadline:
                    raise EgoLiteError(detail[-1200:] or "EgoLite returned no result")
                if not wake_signaled:
                    _start_desktop(runtime_env, force=True)
                    wake_signaled = True
                time.sleep(1)
        result = json.loads(result_path.read_text(encoding="utf-8"))
        if not result.get("ok"):
            raise EgoLiteError(str(result.get("error") or "EgoLite operation failed"))
        return result
    except subprocess.TimeoutExpired as exc:
        raise EgoLiteError(f"EgoLite operation timed out after {timeout:g}s") from exc
    finally:
        payload_path.unlink(missing_ok=True)
        result_path.unlink(missing_ok=True)


def probe(env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    result = _invoke(
        "writeResult({ ok: true, taskSpaceId: task.id, url: await page.url() })",
        {},
        env=env,
        timeout=20,
    )
    return {"available": True, "task_space_id": result.get("taskSpaceId", "")}


def handoff(source: str, env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    urls = {
        "google-scholar": "https://scholar.google.com/",
        "cnki": "https://kns.cnki.net/kns8/defaultresult/index",
    }
    if source not in urls:
        raise EgoLiteError(f"unsupported browser handoff source: {source}")
    return _invoke(
        """
await browser.openOrReuseTab(payload.url, { wait: true, timeout: 60000 })
writeResult({
  ok: true, source: payload.source, url: await page.url(), taskSpaceId: task.id,
  shared: true, handedOff: false
})
""",
        {"source": source, "url": urls[source]},
        env=env,
        timeout=75,
    )


_GS_SCRIPT = r"""
await browser.openOrReuseTab('https://scholar.google.com/', { wait: true, timeout: payload.timeoutMs })
const captcha = async () => await page.evaluate(() =>
  location.href.includes('sorry') || Boolean(document.querySelector('#captcha-form')))
if (await captcha()) {
  writeResult({ ok: true, status: 'captcha', items: [], url: await page.url() })
} else {
  const input = page.locator('input[name="q"]').first()
  if (!(await input.count())) throw new Error('Google Scholar search form not found')
  await page.evaluate(query => {
    const input = document.querySelector('input[name="q"]')
    if (!input || !input.form) throw new Error('Google Scholar search form not found')
    input.value = query
    input.dispatchEvent(new Event('input', { bubbles: true }))
    if (input.form.requestSubmit) input.form.requestSubmit()
    else input.form.submit()
  }, payload.query)
  let scholarReady = false
  for (let i = 0; i < payload.pollCount; i++) {
    await new Promise(resolve => setTimeout(resolve, payload.pollIntervalMs))
    if (await captcha() || await page.locator('.gs_ri').count()) { scholarReady = true; break }
  }
  if (!scholarReady) throw new Error('Google Scholar search timed out before results or CAPTCHA appeared')
  const items = []
  while (items.length < payload.limit && !(await captcha())) {
    const batch = await page.evaluate(() => Array.from(document.querySelectorAll('.gs_ri')).map(r => {
      const link = r.querySelector('.gs_rt a')
      const meta = r.querySelector('.gs_a')
      const snippet = r.querySelector('.gs_rs')
      const cites = Array.from(r.querySelectorAll('.gs_fl a')).find(a => /cites/i.test(a.href || ''))
      const pdf = r.querySelector('.gs_or_ggsm a, [data-clat-atid]')
      return {
        title: link ? link.textContent.replace(/^(\[[^\]]*\]\s*)+/, '').trim() : '',
        url: link ? link.href : '', meta: meta ? meta.textContent.trim() : '',
        snippet: snippet ? snippet.textContent.trim() : '',
        cited: cites ? parseInt((cites.textContent.match(/\d+/) || ['0'])[0], 10) : 0,
        pdf: pdf ? pdf.href : ''
      }
    }))
    for (const item of batch) {
      if (item.title && !items.some(x => x.title === item.title && x.meta === item.meta)) items.push(item)
      if (items.length >= payload.limit) break
    }
    if (!batch.length) {
      if (!(await captcha())) throw new Error('Google Scholar returned no recognizable result rows')
      break
    }
    if (items.length >= payload.limit) break
    const nextUrl = await page.evaluate(() => document.querySelector('#gs_n td:last-child a')?.href || '')
    if (!nextUrl) break
    await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: payload.timeoutMs })
    await new Promise(resolve => setTimeout(resolve, payload.pageDelayMs))
  }
  writeResult({ ok: true, status: await captcha() ? 'captcha' : 'ok', items: items.slice(0, payload.limit), url: await page.url() })
}
"""


_CNKI_SCRIPT = r"""
await browser.openOrReuseTab('https://kns.cnki.net/kns8/defaultresult/index', { wait: true, timeout: payload.timeoutMs })
const captcha = async () => await page.evaluate(() =>
  location.href.includes('verify') || /验证|安全检测/.test(document.title))
if (await captcha()) {
  writeResult({ ok: true, status: 'captcha', items: [], url: await page.url() })
} else {
  const input = page.locator('#txt_SearchText, input[name="txt_SearchText"], input.search-input').first()
  if (!(await input.count())) throw new Error('CNKI search form not found')
  await input.fill(payload.query)
  const button = page.locator('#btnSearch, input[type="submit"], button.search-btn').first()
  if (await button.count()) await button.click({ timeout: 10000 })
  else await input.press('Enter')
  let cnkiReady = false
  for (let i = 0; i < payload.pollCount; i++) {
    await new Promise(resolve => setTimeout(resolve, payload.pollIntervalMs))
    if (await captcha() || await page.locator('.result-table-list tbody tr, .result-item').count()) {
      cnkiReady = true
      break
    }
  }
  if (!cnkiReady) throw new Error('CNKI search timed out before results or CAPTCHA appeared')
  const items = await page.evaluate(limit => Array.from(document.querySelectorAll(
    '.result-table-list tbody tr, table.result-table-list tbody tr, .result-item'
  )).map(r => {
    const name = r.querySelector('td.name a, .name a, .result-title a, a.fz14')
    const author = r.querySelector('td.author, .author')
    const source = r.querySelector('td.source a, .source a, .source')
    const date = r.querySelector('td.date, .date')
    const quote = r.querySelector('td.quote a, .quote a, .quote')
    return {
      title: name ? name.textContent.trim() : '', url: name ? name.href : '',
      authors: author ? author.textContent.trim() : '', journal: source ? source.textContent.trim() : '',
      year: date ? (date.textContent.match(/\d{4}/) || [''])[0] : '',
      cited: quote ? parseInt((quote.textContent.match(/\d+/) || ['0'])[0], 10) : 0
    }
  }).filter(x => x.title).slice(0, limit), payload.limit)
  writeResult({ ok: true, status: await captcha() ? 'captcha' : 'ok', items, url: await page.url() })
}
"""


class EgoLiteBrowser:
    """Search-budgeted EgoLite browser with composite source operations."""

    backend = "egolite"

    def __init__(self, env: Optional[Dict[str, str]] = None, *, verify: bool = True) -> None:
        self.env = dict(os.environ if env is None else env)
        self.search_count = 0
        if verify:
            probe(self.env)

    def acquire_search(self) -> None:
        if self.search_count >= MAX_SEARCHES_PER_SESSION:
            raise EgoLiteError(f"reached the per-session search budget ({MAX_SEARCHES_PER_SESSION})")
        self.search_count += 1

    def _search(self, script: str, query: str, limit: int) -> Dict[str, Any]:
        self.acquire_search()
        timeout = float(self.env.get("SCANSCI_FIND_EGOLITE_TIMEOUT", "90"))
        return _invoke(
            script,
            {
                "query": query,
                "limit": limit,
                "timeoutMs": int(timeout * 1000),
                "pageDelayMs": int(float(self.env.get("SCANSCI_FIND_BROWSER_PAGE_DELAY", "2")) * 1000),
                "pollCount": int(self.env.get("SCANSCI_FIND_BROWSER_POLL_COUNT", "30")),
                "pollIntervalMs": int(float(self.env.get("SCANSCI_FIND_BROWSER_POLL_INTERVAL", "1")) * 1000),
            },
            env=self.env,
            timeout=timeout + 15,
        )

    def search_google_scholar(self, query: str, limit: int) -> Dict[str, Any]:
        return self._search(_GS_SCRIPT, query, limit)

    def search_cnki(self, query: str, limit: int) -> Dict[str, Any]:
        return self._search(_CNKI_SCRIPT, query, limit)

    def close(self) -> None:
        return None


def create_browser(env: Optional[Dict[str, str]] = None) -> Any:
    runtime_env = dict(os.environ if env is None else env)
    backend = runtime_env.get("SCANSCI_FIND_BROWSER_BACKEND", "auto").strip().lower()
    if backend not in {"auto", "egolite", "cdp"}:
        raise EgoLiteError(f"unknown SCANSCI_FIND_BROWSER_BACKEND: {backend}")
    if backend in {"auto", "egolite"}:
        try:
            return EgoLiteBrowser(runtime_env)
        except EgoLiteError:
            if backend == "egolite":
                raise
    from scansci_find.cdp import CdpBrowser

    return CdpBrowser()
