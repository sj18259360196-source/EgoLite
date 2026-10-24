"""Population estimation and coverage measurements.

Implements the Chapman capture-recapture estimator over the PubMed/OpenAlex
overlap (the two independent keyword-search backbones). The result is
explicitly labeled a two-source overlap diagnostic, not pipeline recall: it
answers "how much of the literature did we probably miss" when two
independent sources agree on what exists.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, Optional

CAPTURE_PAIR = ("PubMed", "OpenAlex")


def estimate_population(candidates: Iterable[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Chapman capture-recapture estimate from PubMed/OpenAlex overlap.

    Returns ``None`` when either source is absent or no record is shared
    (no overlap means the estimator is undefined).
    """
    rows = list(candidates)
    first, second = CAPTURE_PAIR
    seen_a = sum(1 for item in rows if first in (item.get("source_hits") or []))
    seen_b = sum(1 for item in rows if second in (item.get("source_hits") or []))
    seen_both = sum(1 for item in rows if first in (item.get("source_hits") or []) and second in (item.get("source_hits") or []))
    if seen_a <= 0 or seen_b <= 0 or seen_both <= 0:
        return None
    estimate = ((seen_a + 1) * (seen_b + 1)) / (seen_both + 1) - 1
    variance = ((seen_a + 1) * (seen_b + 1) * (seen_a - seen_both) * (seen_b - seen_both)) / (
        (seen_both + 1) ** 2 * (seen_both + 2)
    )
    standard_error = max(0.0, variance) ** 0.5
    return {
        "method": "chapman_capture_recapture",
        "sources": [first, second],
        "seen_a": seen_a,
        "seen_b": seen_b,
        "seen_both": seen_both,
        "estimated_total": round(estimate, 2),
        "ci95_low": max(0.0, round(estimate - 1.96 * standard_error, 2)),
        "ci95_high": round(estimate + 1.96 * standard_error, 2),
        "note": "two-source overlap diagnostic, not pipeline recall",
    }


def abstract_coverage(candidates: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Per-source abstract coverage: how many records carry an abstract."""
    rows = list(candidates)
    per_source: Dict[str, Dict[str, int]] = {}
    for item in rows:
        for source in dict.fromkeys(item.get("source_hits") or []):
            bucket = per_source.setdefault(str(source), {"total": 0, "with_abstract": 0})
            bucket["total"] += 1
            if str(item.get("abstract") or "").strip():
                bucket["with_abstract"] += 1
    return {
        "per_source": [
            {
                "source": source,
                "total": bucket["total"],
                "with_abstract": bucket["with_abstract"],
                "coverage": round(bucket["with_abstract"] / bucket["total"], 4) if bucket["total"] else None,
            }
            for source, bucket in sorted(per_source.items())
        ],
        "overall": (
            round(sum(1 for item in rows if str(item.get("abstract") or "").strip()) / max(1, len(rows)), 4)
            if rows
            else None
        ),
    }
