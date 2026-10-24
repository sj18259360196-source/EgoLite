from __future__ import annotations

from datetime import date
from typing import Any, Callable, Dict, Iterable, List, Optional

VALID_SORTS = ("relevance", "recency", "citations")
RECENT_WINDOW_DAYS = 183


def _number_or_none(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _recent_days(candidate: Dict[str, Any]) -> Optional[int]:
    """Days since publication (None when the date cannot be determined).

    Uses ``published_date`` (YYYY-MM-DD) when present, otherwise approximates
    from ``year`` so recency sorting still works for coarse records.
    """
    published_date = str(candidate.get("published_date") or "").strip()
    if len(published_date) >= 10:
        try:
            published = date.fromisoformat(published_date[:10])
            return max(0, (date.today() - published).days)
        except ValueError:
            pass
    year = candidate.get("year")
    if year:
        try:
            return max(0, (date.today() - date(int(year), 7, 1)).days)
        except (TypeError, ValueError):
            pass
    return None


def mark_recent(candidate: Dict[str, Any], recent_days: Optional[int] = None) -> Dict[str, Any]:
    """Attach the recency annotation used by the recency sort and summaries."""
    days = _recent_days(candidate) if recent_days is None else recent_days
    candidate["recency"] = {
        "is_recent": days is not None and days <= RECENT_WINDOW_DAYS,
        "days_since_publication": days,
    }
    return candidate


def _sort_key(mode: str) -> Callable[[Dict[str, Any]], tuple]:
    if mode == "recency":
        def key(item: Dict[str, Any]) -> tuple:
            recency = item.get("recency") or {}
            return (
                not bool(recency.get("is_recent")),
                -int(item.get("citation_count") or 0),
                -float(item.get("relevance_score") or 0.0),
                str(item.get("title") or ""),
            )

        return key
    if mode == "citations":
        def key(item: Dict[str, Any]) -> tuple:
            return (
                -int(item.get("citation_count") or 0),
                -float(item.get("relevance_score") or 0.0),
                str(item.get("title") or ""),
            )

        return key
    return lambda item: (-float(item.get("relevance_score") or 0.0), str(item.get("title") or ""))


def map_jif(journal: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    journal = journal or {}
    raw_value = journal.get("if_2023")
    value = _number_or_none(raw_value)
    year = str(journal.get("if_year") or "").strip()
    if not year:
        years = [str(item.get("year") or "").strip() for item in journal.get("if_history") or []]
        year = sorted([item for item in years if item], reverse=True)[0] if any(years) else ""
    return {
        "value": value,
        "year": year,
        "source": "JCR" if year or value is not None else "",
        "raw_fields": {
            "if_2023": raw_value,
            "if_year": journal.get("if_year"),
        },
    }


def map_jif_history(journal: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for item in (journal or {}).get("if_history") or []:
        out.append(
            {
                "year": str(item.get("year") or ""),
                "value": _number_or_none(item.get("if_value")),
                "quartile": str(item.get("quartile") or ""),
                "rank": str(item.get("rank") or ""),
                "source": "JCR",
            }
        )
    return out


def _screen_rows(screen_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = screen_result.get("papers")
    if rows is None:
        rows = screen_result.get("results")
    return list(rows or [])


def _row_journal(row: Dict[str, Any]) -> Dict[str, Any]:
    if isinstance(row.get("journal"), dict):
        return row["journal"]
    evidence = (row.get("policy_result") or {}).get("evidence")
    if isinstance(evidence, dict):
        return evidence
    return {}


def _row_passed(row: Dict[str, Any]) -> bool:
    if "passed" in row:
        return bool(row["passed"])
    return bool((row.get("policy_result") or {}).get("pass"))


def apply_quality(
    candidates: Iterable[Dict[str, Any]],
    gateway: Any,
    policy: str = "high_quality_broad",
    mode: str = "boost",
    filters: Optional[Dict[str, Any]] = None,
    sort: str = "relevance",
) -> List[Dict[str, Any]]:
    mode = (mode or "boost").casefold()
    sort = (sort or "relevance").casefold()
    if sort not in VALID_SORTS:
        raise ValueError(f"unknown sort mode: {sort}")
    candidate_rows = [dict(item) for item in candidates]
    if not candidate_rows:
        return []
    health = gateway.health_check()
    screen_result = gateway.screen_papers(candidate_rows, policy=policy, filters=filters)
    screen_rows = _screen_rows(screen_result)
    data = screen_result.get("data") or health.get("data") or {}
    data_sha256 = data.get("sha256") or data.get("data_sha256") or getattr(gateway, "data_sha256", "")
    journal_scout_version = health.get("server_version") or health.get("version") or getattr(gateway, "version", "")

    out: List[Dict[str, Any]] = []
    for index, candidate in enumerate(candidate_rows):
        row = screen_rows[index] if index < len(screen_rows) else {}
        journal = _row_journal(row)
        policy_result = row.get("policy_result") or {}
        passed = _row_passed(row)
        reasons = list(policy_result.get("reasons") or [])
        candidate["quality"] = {
            "scope": "journal_level_evidence_not_article_validity",
            "mode": mode,
            "policy": policy_result.get("policy") or policy or "custom_filters",
            "passed": passed,
            "matched_journal": row.get("matched_journal") or journal.get("title") or "",
            "evidence": reasons,
            "journal": journal,
            "jif_latest": map_jif(journal),
            "jif_history": map_jif_history(journal),
            "data_sha256": data_sha256,
            "journal_scout_version": journal_scout_version,
        }
        if passed and mode == "boost":
            candidate["relevance_score"] = round(float(candidate.get("relevance_score") or 0.0) + 0.25, 6)
        if mode == "hard" and not passed:
            continue
        if sort == "recency":
            mark_recent(candidate)
        out.append(candidate)
    return sorted(out, key=_sort_key(sort))
