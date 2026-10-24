from __future__ import annotations

import os
import urllib.parse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Optional

from scansci_find.adapters import HttpProvider, ProviderConfigurationError, normalize_doi


class UnpaywallProvider(HttpProvider):
    name = "unpaywall"

    def __init__(self, email: str = "") -> None:
        super().__init__()
        self.email = email

    def resolve_doi(self, doi: str) -> Dict[str, Any]:
        normalized = normalize_doi(doi)
        if not normalized:
            raise ValueError("doi must not be empty")
        email = (
            self.email
            or os.environ.get("UNPAYWALL_EMAIL")
            or os.environ.get("SCANSCI_FIND_CONTACT_EMAIL")
            or ""
        ).strip()
        if not email:
            raise ProviderConfigurationError("Unpaywall requires UNPAYWALL_EMAIL or SCANSCI_FIND_CONTACT_EMAIL")
        url = "https://api.unpaywall.org/v2/" + urllib.parse.quote(normalized, safe="") + "?" + urllib.parse.urlencode({"email": email})
        payload = self._json(url)
        best = payload.get("best_oa_location") or {}
        return {
            "status": "resolved",
            "source": "Unpaywall",
            "doi": normalized,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "is_oa": bool(payload.get("is_oa")),
            "oa_status": payload.get("oa_status") or "unknown",
            "pdf_url": best.get("url_for_pdf") or "",
            "landing_page_url": best.get("url_for_landing_page") or best.get("url") or "",
            "license": best.get("license") or "",
            "version": best.get("version") or "",
            "host_type": best.get("host_type") or "",
            "repository_institution": best.get("repository_institution") or "",
            "location_count": len(payload.get("oa_locations") or []),
            "data_standard": payload.get("data_standard"),
        }


_RESOLVER_SOURCE_KEYS = {
    "openalex": ("openalex",),
    "semantic": ("semantic scholar",),
    "europepmc": ("europe pmc", "europepmc"),
}


def _oa_workers(items: int) -> int:
    """Resolve the thread pool size for per-DOI OA resolution.

    SCANSCI_FIND_OA_WORKERS overrides the default (parallel up to 8 workers);
    a value of 1 forces the serial path. Unpaywall has no batch API, so
    parallel per-DOI lookups are the only way to resolve a queue quickly.
    """
    raw = str(os.environ.get("SCANSCI_FIND_OA_WORKERS") or "").strip()
    try:
        requested = int(raw) if raw else 0
    except ValueError:
        requested = 0
    if requested:
        return max(1, min(requested, max(1, items)))
    return min(8, max(1, items))


def _candidate_oa_hint(candidate: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Detect an OA copy already carried by the candidate, without any HTTP.

    Normalizers already attach OpenAlex ``oa_url``, Semantic Scholar
    ``openAccessPdf``, and Europe PMC fulltext URLs to ``links``; surfacing
    those avoids spending Unpaywall quota on records that are already OA.
    """
    links = candidate.get("links") or {}
    pdf = str(links.get("pdf") or "").strip()
    fulltext = str(links.get("fulltext") or "").strip()
    if not pdf and not fulltext:
        return None
    hits = [str(item).casefold() for item in (candidate.get("source_hits") or [])]
    resolver = "candidate_links"
    for key, names in _RESOLVER_SOURCE_KEYS.items():
        if any(any(name in hit for name in names) for hit in hits):
            resolver = key
            break
    return {
        "status": "resolved",
        "source": resolver,
        "doi": normalize_doi(candidate.get("doi")),
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "is_oa": True,
        "oa_status": "aggregated",
        "pdf_url": pdf,
        "landing_page_url": fulltext,
        "license": "",
    }


def _apply_oa_report(candidate: Dict[str, Any], report: Dict[str, Any]) -> None:
    if report.get("status") != "resolved":
        return
    links = dict(candidate.get("links") or {})
    if report.get("pdf_url") and not links.get("pdf"):
        links["pdf"] = report["pdf_url"]
    if report.get("landing_page_url") and not links.get("fulltext"):
        links["fulltext"] = report["landing_page_url"]
    candidate["links"] = links
    access = dict(candidate.get("access") or {})
    if report.get("is_oa"):
        access.update({"fulltext_hint": "oa", "requires_login": False, "requires_institution": False})
        access["access_status"] = "open_pdf"
    else:
        publisher_page = bool((candidate.get("links") or {}).get("paper") or candidate.get("source_url"))
        access["access_status"] = "needs_institution" if (publisher_page or access.get("requires_institution")) else "no_open_pdf"
    access["oa_status"] = report.get("oa_status") or "unknown"
    access["license"] = report.get("license") or ""
    candidate["access"] = access
    support_records = list(candidate.get("support_records") or [])
    support_records.append(
        {"source": report.get("source") or "Unpaywall", "doi": normalize_doi(candidate.get("doi")), "status": report.get("status")}
    )
    candidate["support_records"] = support_records


def resolve_open_access(
    candidates: Iterable[Dict[str, Any]],
    *,
    provider: Optional[Any] = None,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    provider = provider or UnpaywallProvider()
    rows = [dict(candidate) for candidate in candidates]
    selected = rows if limit is None else rows[: max(0, int(limit))]
    counts: Counter[str] = Counter()
    resolvers_used: Counter[str] = Counter()
    pending: List[Dict[str, Any]] = []

    for candidate in selected:
        doi = normalize_doi(candidate.get("doi"))
        hint = _candidate_oa_hint(candidate)
        if hint:
            report = hint
            resolvers_used[str(report.get("source") or "candidate_links")] += 1
        elif doi:
            pending.append(candidate)
            continue
        else:
            report = {"status": "unsupported", "source": "Unpaywall", "message": "candidate has no DOI"}
        candidate["oa_resolution"] = report
        counts[str(report.get("status") or "unknown")] += 1
        _apply_oa_report(candidate, report)

    if pending:

        def run_one(candidate: Dict[str, Any]) -> Dict[str, Any]:
            try:
                return provider.resolve_doi(candidate["doi"])
            except Exception as exc:
                return {
                    "status": getattr(exc, "status", "error"),
                    "source": "Unpaywall",
                    "doi": candidate["doi"],
                    "error_type": type(exc).__name__,
                    "message": str(exc),
                }

        workers = _oa_workers(len(pending))
        if workers <= 1:
            reports = [run_one(candidate) for candidate in pending]
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                reports = list(pool.map(run_one, pending))
        for candidate, report in zip(pending, reports):
            resolvers_used[str(report.get("source") or "unknown").casefold()] += 1
            candidate["oa_resolution"] = report
            counts[str(report.get("status") or "unknown")] += 1
            _apply_oa_report(candidate, report)
    return {
        "candidates": rows,
        "checked": len(selected),
        "unchecked": len(rows) - len(selected),
        "status_counts": dict(sorted(counts.items())),
        "oa_found": sum(1 for item in selected if (item.get("oa_resolution") or {}).get("is_oa")),
        "resolvers_used": dict(sorted(resolvers_used.items())),
    }
