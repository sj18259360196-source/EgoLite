"""Browser-backed source adapters (Google Scholar, CNKI) via CDP.

These adapters drive the user's own Chrome (remote debugging enabled), so
login state carries over without any credential handling. Scholar is searched
through the form (never constructed ``/scholar?q=`` URLs), paced 5-10 s
between pages, capped at 20 searches per session, and stopped on CAPTCHA
pages. CNKI uses the KNS8 search UI; full text remains institution-gated
(never bypassed).
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Dict, List, Optional

from scansci_find.adapters import (
    Candidate,
    HttpProvider,
    ProviderConfigurationError,
    ProviderError,
    _article_type,
    _candidate,
    _list_from_any,
    _year_from_text,
)

# --- Google Scholar extraction -------------------------------------------------

_GS_EXTRACT_JS = """(() => {
  const rows = Array.from(document.querySelectorAll('.gs_ri'));
  return rows.map(r => {
    const link = r.querySelector('.gs_rt a');
    const meta = r.querySelector('.gs_a');
    const snippet = r.querySelector('.gs_rs');
    const cites = Array.from(r.querySelectorAll('.gs_fl a')).find(a => /cites/i.test(a.href || ''));
    const pdf = r.querySelector('.gs_or_ggsm a, [data-clat-atid]');
    return {
      title: link ? link.textContent.replace(/^(\\[[^\\]]*\\]\\s*)+/, '').trim() : '',
      url: link ? link.href : '',
      meta: meta ? meta.textContent.trim() : '',
      snippet: snippet ? snippet.textContent.trim() : '',
      cited: cites ? parseInt((cites.textContent.match(/\\d+/) || ['0'])[0], 10) : 0,
      pdf: pdf ? pdf.href : '',
    };
  });
})()"""

_GS_STATUS_JS = (
    "(location.href.includes('sorry') || !!document.querySelector('#captcha-form')) ? 'captcha' : 'ok'"
)

_GS_NEXT_JS = (
    "(() => { const a = document.querySelector('#gs_n td:last-child a'); return a ? a.href : ''; })()"
)

_GS_FILL_JS = (
    '(() => { const input = document.querySelector("input[name=q]"); '
    'const form = input && input.closest("form"); return !!input && !!form; })()'
)


def _parse_gs_meta(meta: str) -> tuple[str, str, Optional[int]]:
    parts = [part.strip() for part in meta.split(" - ") if part.strip()]
    author = parts[0] if parts else ""
    journal = parts[1] if len(parts) > 1 else ""
    match = re.search(r"\b(19|20)\d{2}\b", meta)
    year = int(match.group(0)) if match else None
    return author, journal, year


class GoogleScholarCdpProvider(HttpProvider):
    name = "google-scholar"

    def __init__(self, browser: Optional[Any] = None) -> None:
        super().__init__()
        self._browser = browser

    def search(self, query: str, limit: int) -> List[Candidate]:
        try:
            return self._search(query, int(limit))
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(f"Google Scholar CDP search failed: {exc}") from exc

    def _search(self, query: str, limit: int) -> List[Candidate]:
        from scansci_find.cdp import CdpError
        from scansci_find.egolite import EgoLiteError, create_browser

        if self._browser is None:
            try:
                self._browser = create_browser()
            except (CdpError, EgoLiteError) as exc:
                raise ProviderConfigurationError(str(exc)) from exc
        browser = self._browser
        if hasattr(browser, "search_google_scholar"):
            try:
                result = browser.search_google_scholar(query, limit)
            except EgoLiteError as exc:
                raise ProviderConfigurationError(str(exc)) from exc
            if result.get("status") == "captcha":
                raise ProviderConfigurationError(
                    "Google Scholar requires verification in EgoLite; run "
                    "scansci-find browser-handoff google-scholar, complete it in the shared window, and retry"
                )
            return [self._normalize(query, item) for item in result.get("items", []) if item.get("title")]
        try:
            browser.acquire_search()
        except CdpError as exc:
            raise ProviderConfigurationError(str(exc)) from exc
        session = browser._session
        target = session.new_tab("https://scholar.google.com")
        try:
            session.wait_ready(target, timeout=20)
            ready = session.evaluate(target, _GS_FILL_JS)
            if not ready:
                raise ProviderError("Google Scholar search form not found")
            session.evaluate(target, f'document.querySelector("input[name=q]").value = {json.dumps(query)}')
            session.evaluate(target, 'document.querySelector("input[name=q]").closest("form").submit()')
            time.sleep(2)
            rows: List[Candidate] = []
            while len(rows) < limit:
                if session.evaluate(target, _GS_STATUS_JS) == "captcha":
                    break
                for item in session.evaluate_json(target, _GS_EXTRACT_JS):
                    candidate = self._normalize(query, item)
                    if candidate and not any(
                        existing.get("title") == candidate["title"] and existing.get("year") == candidate["year"]
                        for existing in rows
                    ):
                        rows.append(candidate)
                if len(rows) >= limit or not rows:
                    break
                next_url = session.evaluate(target, _GS_NEXT_JS)
                if not next_url:
                    break
                session.navigate(target, str(next_url))
                time.sleep(2)
            return rows[:limit]
        finally:
            session.close_tab(target)

    def _normalize(self, query: str, item: Dict[str, Any]) -> Candidate:
        title = str(item.get("title") or "").strip()
        if not title:
            return _candidate(source="Google Scholar", title="")
        author, journal, year = _parse_gs_meta(str(item.get("meta") or ""))
        links = {"paper": str(item.get("url") or "")}
        if item.get("pdf"):
            links["pdf"] = str(item["pdf"])
        return _candidate(
            title=title,
            authors=[author] if author else [],
            year=year,
            journal=journal,
            abstract=str(item.get("snippet") or ""),
            source="Google Scholar",
            citation_count=int(item.get("cited") or 0),
            links=links,
        )


# --- CNKI (KNS8) extraction ------------------------------------------------------

_CNKI_EXTRACT_JS = """(() => {
  const rows = Array.from(document.querySelectorAll('.result-table-list tbody tr'));
  return rows.map(r => {
    const name = r.querySelector('td.name a');
    const author = r.querySelector('td.author');
    const source = r.querySelector('td.source a');
    const date = r.querySelector('td.date');
    const quote = r.querySelector('td.quote a');
    return {
      title: name ? name.textContent.trim() : '',
      url: name ? name.href : '',
      authors: author ? author.textContent.trim() : '',
      journal: source ? source.textContent.trim() : '',
      year: date ? (date.textContent.match(/\\d{4}/) || [''])[0] : '',
      cited: quote ? parseInt((quote.textContent.match(/\\d+/) || ['0'])[0], 10) : 0,
    };
  });
})()"""

_CNKI_STATUS_JS = (
    "(location.href.includes('verify') || /验证|安全检测/.test(document.title)) ? 'captcha' : 'ok'"
)


class CNKICdpProvider(HttpProvider):
    name = "cnki"

    def __init__(self, browser: Optional[Any] = None) -> None:
        super().__init__()
        self._browser = browser

    def search(self, query: str, limit: int) -> List[Candidate]:
        try:
            return self._search(query, int(limit))
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(f"CNKI CDP search failed: {exc}") from exc

    def _search(self, query: str, limit: int) -> List[Candidate]:
        from scansci_find.cdp import CdpError
        from scansci_find.egolite import EgoLiteError, create_browser

        if self._browser is None:
            try:
                self._browser = create_browser()
            except (CdpError, EgoLiteError) as exc:
                raise ProviderConfigurationError(
                    f"{exc}; alternatively configure SCANSCI_FIND_CNKI_MCP_COMMAND for the MCP adapter"
                ) from exc
        browser = self._browser
        if hasattr(browser, "search_cnki"):
            try:
                result = browser.search_cnki(query, limit)
            except EgoLiteError as exc:
                raise ProviderConfigurationError(str(exc)) from exc
            if result.get("status") == "captcha":
                raise ProviderConfigurationError(
                    "CNKI requires verification in EgoLite; run scansci-find browser-handoff cnki, "
                    "complete it in the shared window, and retry"
                )
            return [self._normalize(item) for item in result.get("items", []) if item.get("title")]
        try:
            browser.acquire_search()
        except CdpError as exc:
            raise ProviderConfigurationError(str(exc)) from exc
        session = browser._session
        target = session.new_tab("https://kns.cnki.net/kns8/defaultresult/index")
        try:
            session.wait_ready(target, timeout=20)
            time.sleep(3)
            if session.evaluate(target, _CNKI_STATUS_JS) == "captcha":
                return []
            session.evaluate(target, f'document.querySelector("#txt_SearchText").value = {json.dumps(query)}')
            session.evaluate(target, 'document.querySelector("#btnSearch").click()')
            time.sleep(3)
            rows: List[Candidate] = []
            for item in session.evaluate_json(target, _CNKI_EXTRACT_JS):
                candidate = self._normalize(item)
                if candidate:
                    rows.append(candidate)
            return rows[:limit]
        finally:
            session.close_tab(target)

    def _normalize(self, item: Dict[str, Any]) -> Candidate:
        title = str(item.get("title") or "").strip()
        if not title:
            return _candidate(source="CNKI", title="")
        return _candidate(
            title=title,
            title_zh=title,
            authors=_list_from_any(item.get("authors")),
            year=_year_from_text(item.get("year")) if item.get("year") else None,
            journal=str(item.get("journal") or ""),
            article_type=_article_type("journal"),
            source_platform="cnki",
            source_record_id=str(item.get("url") or ""),
            source_url=str(item.get("url") or ""),
            source="CNKI",
            citation_count=int(item.get("cited") or 0),
            links={"paper": str(item.get("url") or "")},
            access={"fulltext_hint": "institution_required", "requires_login": False, "requires_institution": True},
        )
