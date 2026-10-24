from __future__ import annotations

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from scansci_find.adapters import ArxivProvider, EuropePMCProvider, executor_workers, normalize_arxiv_id
from scansci_find.dedupe import normalize_person
from scansci_find.verification import _title_similarity

PREPRINT_TITLE_THRESHOLD = 0.85
PREPRINT_YEAR_WINDOW = 2


def _query_fragment(title: str) -> str:
    """Quote a title for a phrase query, stripping characters that break it."""
    return str(title or "").replace('"', " ").strip()[:200]


class PreprintFinder:
    """Find lawful open versions (preprints) of a paywalled paper.

    Searches arXiv directly and the Europe PMC Preprint Citation Index
    (``SRC:"PPR"`` covers bioRxiv, medRxiv, SSRN, Research Square, and
    Preprints.org). Matching is conservative: title similarity above a
    threshold plus either a first-author match or a publication year within
    a small window, to avoid attributing a different paper to a candidate.
    """

    def __init__(
        self,
        *,
        arxiv: Optional[Any] = None,
        europe_pmc: Optional[Any] = None,
        title_threshold: float = PREPRINT_TITLE_THRESHOLD,
        year_window: int = PREPRINT_YEAR_WINDOW,
    ) -> None:
        self.arxiv = arxiv or ArxivProvider()
        self.europe_pmc = europe_pmc or EuropePMCProvider()
        self.title_threshold = float(title_threshold)
        self.year_window = max(0, int(year_window))

    def find(
        self,
        candidate: Dict[str, Any],
        per_source_limit: int = 5,
    ) -> tuple[List[Dict[str, Any]], Dict[str, Dict[str, int]]]:
        """Search preprint sources for an open version of ``candidate``.

        Returns ``(versions, provider_status)``. ``provider_status`` counts
        per provider how many candidates it searched and how many failed, so
        failures are reported instead of being hidden.
        """
        title = str(candidate.get("title") or "").strip()
        versions: List[Dict[str, Any]] = []
        status: Dict[str, Dict[str, int]] = {}
        if not title:
            return versions, status
        for provider_name, run in (
            ("arxiv", lambda: self._search_arxiv(candidate, title, per_source_limit)),
            ("europe-pmc", lambda: self._search_europe_pmc(candidate, title, per_source_limit)),
        ):
            try:
                found = run()
                status[provider_name] = {"searched": 1, "errored": 0}
                versions.extend(found)
            except Exception:
                status[provider_name] = {"searched": 0, "errored": 1}
        return versions, status

    def _search_arxiv(self, candidate: Dict[str, Any], title: str, limit: int) -> List[Dict[str, Any]]:
        rows = self.arxiv.search(f'ti:"{_query_fragment(title)}"', limit)
        return [self._version(candidate, row, source="arXiv") for row in rows]

    def _search_europe_pmc(self, candidate: Dict[str, Any], title: str, limit: int) -> List[Dict[str, Any]]:
        rows = self.europe_pmc.search(f'(TITLE:"{_query_fragment(title)}") AND (SRC:"PPR")', limit)
        return [self._version(candidate, row, source="Europe PMC") for row in rows]

    def _version(self, candidate: Dict[str, Any], row: Dict[str, Any], *, source: str) -> Dict[str, Any]:
        similarity = _title_similarity(candidate.get("title"), row.get("title"))
        candidate_authors = [normalize_person(item) for item in candidate.get("authors") or []]
        row_authors = [normalize_person(item) for item in row.get("authors") or []]
        first_author_match = bool(candidate_authors and row_authors and candidate_authors[0] == row_authors[0])
        candidate_year = candidate.get("year")
        row_year = row.get("year")
        year_match: Optional[bool] = None
        if candidate_year is not None and row_year is not None:
            year_match = abs(int(candidate_year) - int(row_year)) <= self.year_window
        match = (
            similarity is not None
            and similarity >= self.title_threshold
            and (first_author_match or year_match is True)
        )
        links = row.get("links") or {}
        return {
            "source": source,
            "server": str(row.get("journal") or "").strip() or source,
            "title": row.get("title") or "",
            "url": links.get("fulltext") or links.get("paper") or "",
            "pdf_url": links.get("pdf") or "",
            "arxiv_id": normalize_arxiv_id(row.get("arxiv_id")),
            "doi": row.get("doi") or "",
            "pmcid": row.get("pmcid") or "",
            "year": row_year,
            "title_similarity": similarity,
            "first_author_match": first_author_match,
            "year_match": year_match,
            "match": bool(match),
        }

    def _candidate_skippable(self, candidate: Dict[str, Any]) -> bool:
        if normalize_arxiv_id(candidate.get("arxiv_id")):
            return True
        access = candidate.get("access") or {}
        return str(access.get("fulltext_hint") or "unknown") == "oa"


def _apply_preprint(candidate: Dict[str, Any], matched: List[Dict[str, Any]]) -> None:
    best = max(matched, key=lambda version: (version["title_similarity"] or 0.0))
    links = dict(candidate.get("links") or {})
    if best.get("pdf_url") and not links.get("pdf"):
        links["pdf"] = best["pdf_url"]
    if best.get("url") and not links.get("preprint"):
        links["preprint"] = best["url"]
    candidate["links"] = links
    access = dict(candidate.get("access") or {})
    if str(access.get("fulltext_hint") or "unknown") not in ("oa", "preprint"):
        access["fulltext_hint"] = "preprint"
    access["access_status"] = "preprint"
    candidate["access"] = access
    candidate["preprint_versions"] = matched


def find_preprints(
    candidates: Iterable[Dict[str, Any]],
    *,
    finder: Optional[Any] = None,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    """Find lawful preprint copies for candidates, enriching them in place.

    Mirrors ``resolve_open_access``: returns the candidates plus a report of
    how many were matched, skipped (already OA), searched without a match, or
    failed, and per-provider searched/error counts. Preprint-only matches
    keep the original identity fields untouched.
    """
    finder = finder or PreprintFinder()
    rows = [dict(candidate) for candidate in candidates]
    selected = rows if limit is None else rows[: max(0, int(limit))]
    counts: Counter[str] = Counter()
    provider_status: Dict[str, Counter[str]] = {}

    def run_one(candidate: Dict[str, Any]) -> str:
        title = str(candidate.get("title") or "").strip()
        if not title:
            return "unsupported"
        if finder._candidate_skippable(candidate):
            return "skipped"
        versions, per_provider = finder.find(candidate)
        for provider, counts_by_state in per_provider.items():
            bucket = provider_status.setdefault(provider, Counter())
            bucket.update(counts_by_state)
        matched = [version for version in versions if version.get("match")]
        if matched:
            matched = sorted(matched, key=lambda version: version["title_similarity"] or 0.0, reverse=True)[:3]
            candidate["preprint_search"] = {
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "found": True,
                "versions": versions,
            }
            _apply_preprint(candidate, matched)
            return "matched"
        candidate["preprint_search"] = {"checked_at": datetime.now(timezone.utc).isoformat(), "found": False, "versions": []}
        if per_provider and all(
            (state.get("searched") or 0) == 0 and (state.get("errored") or 0) > 0 for state in per_provider.values()
        ):
            return "error"
        return "not_found"

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
        "provider_status": {name: dict(bucket) for name, bucket in sorted(provider_status.items())},
    }
