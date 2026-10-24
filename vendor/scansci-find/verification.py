from __future__ import annotations

import difflib
import os
import re
import unicodedata
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from scansci_find.adapters import (
    ArxivProvider,
    CrossrefProvider,
    ProviderNotFoundError,
    PubMedProvider,
    normalize_arxiv_id,
    normalize_doi,
)


def _title_key(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return " ".join(re.findall(r"[\w]+", text, flags=re.UNICODE))


def _title_similarity(left: Any, right: Any) -> Optional[float]:
    first = _title_key(left)
    second = _title_key(right)
    if not first or not second:
        return None
    return round(difflib.SequenceMatcher(None, first, second).ratio(), 6)


class IdentifierVerifier:
    def __init__(
        self,
        *,
        crossref: Optional[Any] = None,
        pubmed: Optional[Any] = None,
        arxiv: Optional[Any] = None,
        title_threshold: float = 0.85,
    ) -> None:
        self.crossref = crossref or CrossrefProvider()
        self.pubmed = pubmed or PubMedProvider()
        self.arxiv = arxiv or ArxivProvider()
        self.title_threshold = float(title_threshold)

    def verify(self, candidate: Dict[str, Any]) -> Dict[str, Any]:
        checked_at = datetime.now(timezone.utc).isoformat()
        identifiers = self._available_identifiers(candidate)
        if not identifiers:
            return {
                "status": "unsupported",
                "identifier_type": "",
                "identifier": "",
                "source": "",
                "checked_at": checked_at,
                "message": "candidate has no DOI, PMID, or arXiv identifier",
                "checks": [],
            }
        checks = [self._verify_one(candidate, kind, value, checked_at) for kind, value in identifiers]
        if len(checks) == 1:
            return {**checks[0], "checks": checks}

        statuses = [str(check.get("status") or "error") for check in checks]
        if all(status == "verified" for status in statuses):
            status = "verified"
            message = "all available identifiers were verified"
        elif "verified" in statuses:
            status = "partial"
            message = "some but not all available identifiers were verified"
        elif "metadata_mismatch" in statuses:
            status = "metadata_mismatch"
            message = "one or more identifiers resolved with conflicting metadata"
        elif all(item == "not_found" for item in statuses):
            status = "not_found"
            message = "none of the available identifiers were found"
        else:
            status = statuses[0]
            message = "identifier verification did not complete"
        return {
            "status": status,
            "identifier_type": "multiple",
            "identifier": "",
            "source": ", ".join(dict.fromkeys(str(check.get("source") or "") for check in checks)),
            "checked_at": checked_at,
            "message": message,
            "checks": checks,
        }

    def _verify_one(
        self,
        candidate: Dict[str, Any],
        identifier_type: str,
        identifier_value: str,
        checked_at: str,
    ) -> Dict[str, Any]:
        source = {"doi": "Crossref", "pmid": "PubMed", "arxiv": "arXiv"}[identifier_type]
        try:
            if identifier_type == "doi":
                matched = self.crossref.lookup_doi(identifier_value)
                matched_identifier = normalize_doi(matched.get("doi"))
            elif identifier_type == "pmid":
                matched = self.pubmed.lookup_pmid(identifier_value)
                matched_identifier = str(matched.get("pmid") or "").strip()
            else:
                matched = self.arxiv.lookup_arxiv(identifier_value)
                matched_identifier = normalize_arxiv_id(matched.get("arxiv_id"))
            similarity = _title_similarity(candidate.get("title"), matched.get("title"))
            identifier_match = matched_identifier.casefold() == identifier_value.casefold()
            metadata_match = similarity is None or similarity >= self.title_threshold
            status = "verified" if identifier_match and metadata_match else "metadata_mismatch"
            return {
                "status": status,
                "identifier_type": identifier_type,
                "identifier": identifier_value,
                "source": source,
                "checked_at": checked_at,
                "identifier_match": identifier_match,
                "title_similarity": similarity,
                "matched_title": matched.get("title") or "",
                "matched_year": matched.get("year"),
                "matched_identifiers": matched.get("identifiers") or {},
                "message": "" if status == "verified" else "identifier resolved but candidate metadata did not match",
            }
        except ProviderNotFoundError as exc:
            return {
                "status": "not_found",
                "identifier_type": identifier_type,
                "identifier": identifier_value,
                "source": source,
                "checked_at": checked_at,
                "message": str(exc),
            }
        except Exception as exc:
            return {
                "status": getattr(exc, "status", "error"),
                "identifier_type": identifier_type,
                "identifier": identifier_value,
                "source": source,
                "checked_at": checked_at,
                "error_type": type(exc).__name__,
                "message": str(exc),
            }

    def _available_identifiers(self, candidate: Dict[str, Any]) -> List[tuple[str, str]]:
        out: List[tuple[str, str]] = []
        doi = normalize_doi(candidate.get("doi"))
        if doi:
            out.append(("doi", doi))
        pmid = str(candidate.get("pmid") or "").strip()
        if pmid:
            out.append(("pmid", pmid))
        arxiv_id = normalize_arxiv_id(candidate.get("arxiv_id"))
        if arxiv_id:
            out.append(("arxiv", arxiv_id))
        return out


def _verification_workers(items: int) -> int:
    """Resolve the thread pool size for per-candidate verification.

    Shares SCANSCI_FIND_SEARCH_WORKERS with the source loops; a value of 1
    forces the serial path. Lookup providers are stateless per call, so a
    shared verifier instance is safe across threads.
    """
    raw = str(os.environ.get("SCANSCI_FIND_SEARCH_WORKERS") or "").strip()
    try:
        requested = int(raw) if raw else 0
    except ValueError:
        requested = 0
    if requested:
        return max(1, min(requested, max(1, items)))
    return min(8, max(1, items))


def verify_identifiers(
    candidates: Iterable[Dict[str, Any]],
    *,
    verifier: Optional[Any] = None,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    verifier = verifier or IdentifierVerifier()
    rows = [dict(candidate) for candidate in candidates]
    selected = rows if limit is None else rows[: max(0, int(limit))]
    counts: Counter[str] = Counter()

    def run_one(candidate: Dict[str, Any]) -> str:
        report = verifier.verify(candidate)
        candidate["identifier_verification"] = report
        return str(report.get("status") or "unknown")

    workers = _verification_workers(len(selected))
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
        "status_counts": dict(sorted(counts.items())),
        "all_verified": bool(selected) and counts.get("verified", 0) == len(selected),
    }
