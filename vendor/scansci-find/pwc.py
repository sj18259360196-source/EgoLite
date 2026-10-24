"""Papers with Code code-availability enrichment.

The Papers with Code REST API needs no API key. For each candidate with an
arXiv ID (preferred) or a title, we look up the paper and its official code
repositories, then attach ``candidate["code"]`` with the best repository
(official first, then highest star count). Enrichment is opt-in and never
blocks retrieval when the API is unreachable.
"""

from __future__ import annotations

import urllib.parse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Iterable, List, Optional

from scansci_find.adapters import HttpProvider, ProviderError, executor_workers, normalize_arxiv_id


class PwcProvider(HttpProvider):
    name = "pwc"

    def lookup(self, *, arxiv_id: str = "", title: str = "") -> Optional[Dict[str, Any]]:
        """Resolve a paper record; returns the PwC paper dict or None."""
        if arxiv_id:
            url = "https://paperswithcode.com/api/v1/papers/?" + urllib.parse.urlencode({"arxiv_id": normalize_arxiv_id(arxiv_id)})
            payload = self._json(url)
            results = payload.get("results") or []
            if results:
                return results[0]
        if title:
            url = "https://paperswithcode.com/api/v1/papers/?" + urllib.parse.urlencode(
                {"q": str(title).strip()[:200], "items_per_page": 5}
            )
            payload = self._json(url)
            results = payload.get("results") or []
            if results:
                return results[0]
        return None

    def repositories(self, paper_id: str) -> List[Dict[str, Any]]:
        url = "https://paperswithcode.com/api/v1/papers/" + urllib.parse.quote(paper_id, safe="") + "/repositories/"
        payload = self._json(url)
        return list(payload.get("repositories") or [])


def _best_repository(repositories: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    ranked = sorted(
        (item for item in repositories if item.get("url")),
        key=lambda item: (not bool(item.get("is_official")), -int(item.get("stars") or 0)),
    )
    return ranked[0] if ranked else None


def _enrich_one(candidate: Dict[str, Any], provider: PwcProvider) -> Dict[str, Any]:
    """Attach code availability to a candidate; returns the status label."""
    try:
        paper = provider.lookup(arxiv_id=candidate.get("arxiv_id") or "", title=candidate.get("title") or "")
        if not paper:
            return "not_found"
        repositories = provider.repositories(str(paper.get("id") or ""))
        best = _best_repository(repositories)
        candidate["code"] = {
            "pwc_id": str(paper.get("id") or ""),
            "paper_url": str(paper.get("url") or "") or str(paper.get("url_pdf") or ""),
            "url": best.get("url") if best else "",
            "stars": int(best.get("stars") or 0) if best else 0,
            "framework": str(best.get("framework") or "") if best else "",
            "is_official": bool(best.get("is_official")) if best else False,
        }
        return "matched" if best else "no_code"
    except Exception:
        return "error"


def enrich_code_availability(
    candidates: Iterable[Dict[str, Any]],
    *,
    provider: Optional[Any] = None,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    provider = provider or PwcProvider()
    rows = [dict(candidate) for candidate in candidates]
    selected = rows if limit is None else rows[: max(0, int(limit))]
    counts: Counter[str] = Counter()

    def run_one(candidate: Dict[str, Any]) -> str:
        if not (candidate.get("arxiv_id") or candidate.get("title")):
            return "unsupported"
        return _enrich_one(candidate, provider)

    workers = executor_workers(len(selected))
    if workers <= 1:
        statuses = [run_one(candidate) for candidate in selected]
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            statuses = list(pool.map(run_one, selected))
    counts.update(statuses)
    return {
        "candidates": rows,
        "checked": len(selected),
        "unchecked": len(rows) - len(selected),
        "matched": counts.get("matched", 0),
        "status_counts": dict(sorted(counts.items())),
    }
