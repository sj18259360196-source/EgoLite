"""Two-pass interactive exploration.

Pass 1 (``explore``) runs a quick search and returns a lightweight summary
table — title, year, venue, citations, PDF hint, ``[new]`` flag — so the user
can confirm the core papers before any deep work. Pass 2 (``deep_fetch``)
runs the full enrichment chain (identifier verification, OA resolution,
preprint matching, code links) on the confirmed subset and renders BibTeX.

The venue annotation stays honest: without bundling the commercially
licensed CCF/JCR data, labels are limited to ``[预印本]``/``[未收录]`` plus
whatever Journal Scout already attached.
"""

from __future__ import annotations

from typing import Any, Dict, List

_RECENT_MARK = "[新]"
_PREPRINT_VENUE_MARK = "[预印本]"


def summarize_candidates(candidates: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Pass-1 summary rows: lightweight, no abstracts."""
    rows = []
    for candidate in candidates:
        recency = candidate.get("recency") or {}
        access = candidate.get("access") or {}
        rows.append(
            {
                "title": str(candidate.get("title") or ""),
                "year": candidate.get("year"),
                "venue": str(candidate.get("journal") or ""),
                "citation_count": int(candidate.get("citation_count") or 0),
                "is_recent": bool(recency.get("is_recent")),
                "fulltext_hint": str(access.get("fulltext_hint") or "unknown"),
                "doi": candidate.get("doi") or "",
                "arxiv_id": candidate.get("arxiv_id") or "",
            }
        )
    return {"total": len(rows), "rows": rows}


def _venue_label(row: Dict[str, Any]) -> str:
    venue = str(row.get("venue") or "")
    if not venue:
        return _PREPRINT_VENUE_MARK
    if "arxiv" in venue.casefold():
        return f"{venue} {_PREPRINT_VENUE_MARK}"
    return venue


def render_summary_markdown(summary: Dict[str, Any]) -> str:
    lines = ["# Pass 1 — candidate summary", "", "| # | Title | Year | Venue | Citations | PDF |", "|---|---|---:|---|---:|---|"]
    for index, row in enumerate(summary.get("rows") or [], 1):
        title = str(row.get("title") or "")
        if len(title) > 68:
            title = title[:65] + "..."
        recent = _RECENT_MARK if row.get("is_recent") else ""
        lines.append(
            f"| {index} | {title} {recent} | {row.get('year') or '-'} | {_venue_label(row)} | "
            f"{row.get('citation_count') or 0} | {row.get('fulltext_hint') or 'unknown'} |"
        )
    return "\n".join(lines) + "\n"
