from __future__ import annotations

import re
import unicodedata
from collections import Counter
from typing import Any, Dict, Iterable, List, Optional

from scansci_find.adapters import normalize_arxiv_id, normalize_doi
from scansci_find.measure import estimate_population


def _title_key(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return "".join(ch for ch in text if ch.isalnum())


def _candidate_identifiers(candidate: Dict[str, Any]) -> set[str]:
    values = set()
    doi = normalize_doi(candidate.get("doi"))
    if doi:
        values.add("doi:" + doi)
    arxiv_id = normalize_arxiv_id(candidate.get("arxiv_id"))
    if arxiv_id:
        values.add("arxiv:" + arxiv_id)
    for key in ("pmid", "pmcid", "dblp_id"):
        value = str(candidate.get(key) or "").strip().casefold()
        if value:
            values.add(f"{key}:{value}")
    title = _title_key(candidate.get("title"))
    if title:
        values.add("title:" + title)
    return values


def gold_set_report(
    gold_set: Iterable[Dict[str, str]],
    candidates: Iterable[Dict[str, Any]],
    *,
    year_from: Optional[int] = None,
    year_to: Optional[int] = None,
) -> Dict[str, Any]:
    candidate_ids = set().union(*(_candidate_identifiers(item) for item in candidates)) if candidates else set()
    rows = []
    buckets: Counter[str] = Counter()
    for gold in gold_set:
        probes = _candidate_identifiers(gold)
        found = bool(probes & candidate_ids)
        if found:
            matched = next((item for item in candidates if probes & _candidate_identifiers(item)), None)
            year = matched.get("year") if matched else None
            if year is None:
                bucket = "found_undated"
            elif (year_from is not None and int(year) < int(year_from)) or (year_to is not None and int(year) > int(year_to)):
                bucket = "found_out_of_window"
            else:
                bucket = "found_in_window"
        else:
            bucket = "missing"
        buckets[bucket] += 1
        rows.append({"gold": dict(gold), "found": found, "bucket": bucket, "matched_keys": sorted(probes & candidate_ids)})
    total = len(rows)
    found_count = buckets["found_in_window"] + buckets["found_out_of_window"] + buckets["found_undated"]
    return {
        "total": total,
        "found": found_count,
        "recall": (found_count / total) if total else None,
        "buckets": dict(sorted(buckets.items())),
        "items": rows,
    }


def source_contribution(candidates: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    total = Counter()
    unique = Counter()
    overlap_histogram = Counter()
    for candidate in candidates:
        hits = list(dict.fromkeys(str(value) for value in (candidate.get("source_hits") or []) if str(value)))
        overlap_histogram[str(len(hits))] += 1
        for source in hits:
            total[source] += 1
        if len(hits) == 1:
            unique[hits[0]] += 1
    return {
        "per_source": [
            {"source": source, "total_records": total[source], "unique_records": unique[source]}
            for source in sorted(total)
        ],
        "source_overlap_histogram": dict(sorted(overlap_histogram.items(), key=lambda item: int(item[0]))),
    }


def prisma_counts(
    *,
    raw_count: int,
    deduplicated_count: int,
    candidates: Iterable[Dict[str, Any]],
    human_queue_count: int = 0,
) -> Dict[str, Any]:
    rows = list(candidates)
    explicit_excluded = sum(1 for item in rows if (item.get("screening") or {}).get("decision") == "exclude")
    explicit_included = sum(1 for item in rows if (item.get("screening") or {}).get("decision") == "include")
    unscreened = max(0, len(rows) - explicit_excluded - explicit_included)
    raw = max(0, int(raw_count))
    deduplicated = max(0, int(deduplicated_count))
    reasons = []
    if deduplicated > raw:
        reasons.append("deduplicated_exceeds_identified")
    if len(rows) > deduplicated:
        reasons.append("retained_exceeds_deduplicated")
    if explicit_excluded + explicit_included > len(rows):
        reasons.append("screening_decisions_exceed_candidates")
    return {
        "identified": raw,
        "duplicates_removed": max(0, raw - deduplicated),
        "screened": deduplicated,
        "excluded": explicit_excluded,
        "included": explicit_included,
        "awaiting_screening": unscreened,
        "human_queue": max(0, int(human_queue_count)),
        #: Inconsistency gate: when false, PRISMA.md is not rendered so a
        #: broken pipeline cannot masquerade as a completed one.
        "consistent": not reasons,
        "consistency_reasons": reasons,
    }


def build_human_queue(candidates: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    queue = []
    for candidate in candidates:
        reasons = []
        if not normalize_doi(candidate.get("doi")) and not normalize_arxiv_id(candidate.get("arxiv_id")) and not candidate.get("pmid"):
            reasons.append("no_canonical_identifier")
        if len(candidate.get("source_hits") or []) < 2:
            reasons.append("single_source_only")
        if candidate.get("field_conflicts"):
            reasons.append("metadata_conflict")
        if reasons:
            queue.append(
                {
                    "canonical_id": candidate.get("canonical_id") or "",
                    "title": candidate.get("title") or "",
                    "doi": candidate.get("doi") or "",
                    "reasons": reasons,
                }
            )
    return queue


def coverage_report(
    *,
    protocol: Dict[str, Any],
    source_status: Iterable[Dict[str, Any]],
    raw_count: int,
    deduplicated_count: int,
    candidates: Iterable[Dict[str, Any]],
    citation_rounds: Optional[Iterable[Dict[str, Any]]] = None,
    citation_saturated: bool = False,
    pagination_complete: bool = False,
) -> Dict[str, Any]:
    rows = list(candidates)
    statuses = [dict(item) for item in source_status]
    status_map = {str(item.get("name")): item for item in statuses}
    planned = list(protocol.get("planned_sources") or [])
    unconsulted = []
    for source in planned:
        state = status_map.get(source)
        if not state or state.get("status") != "ok":
            unconsulted.append(
                {
                    "source": source,
                    "reason": (state or {}).get("message") or (state or {}).get("status") or "not_executed",
                }
            )

    rounds = [dict(item) for item in (citation_rounds or [])]
    expected_rounds = int(protocol.get("citation_rounds") or 0)
    citation_complete = len(rounds) >= expected_rounds or bool(citation_saturated)
    depth = protocol.get("depth") or "standard"
    systematic_complete = bool(
        depth == "systematic"
        and pagination_complete
        and citation_complete
        and not unconsulted
        and protocol.get("gold_set")
    )
    limitations = []
    if not pagination_complete:
        limitations.append("full_pagination_not_verified")
    if not citation_complete:
        limitations.append("citation_closure_incomplete")
    if unconsulted:
        limitations.append("planned_sources_not_consulted")
    if not protocol.get("gold_set"):
        limitations.append("gold_set_not_provided")

    return {
        "protocol_id": protocol.get("protocol_id") or "",
        "depth": depth,
        "method_status": "systematic_complete" if systematic_complete else "bounded_search",
        "systematic_complete": systematic_complete,
        "pagination_complete": bool(pagination_complete),
        "source_status": statuses,
        "unconsulted_sources": unconsulted,
        "record_counts": {"raw": int(raw_count), "deduplicated": int(deduplicated_count), "retained": len(rows)},
        "gold_set": gold_set_report(
            protocol.get("gold_set") or [],
            rows,
            year_from=protocol.get("year_from"),
            year_to=protocol.get("year_to"),
        ),
        "population_estimate": estimate_population(rows),
        "source_contribution": source_contribution(rows),
        "citation_rounds": rounds,
        "citation_saturated": bool(citation_saturated),
        "limitations": limitations,
    }


def render_coverage_markdown(report: Dict[str, Any]) -> str:
    counts = report.get("record_counts") or {}
    lines = [
        "# Coverage Report",
        "",
        f"- Method status: {report.get('method_status', '')}",
        f"- Systematic complete: {str(bool(report.get('systematic_complete'))).lower()}",
        f"- Raw records: {counts.get('raw', 0)}",
        f"- Deduplicated records: {counts.get('deduplicated', 0)}",
        f"- Retained records: {counts.get('retained', 0)}",
        "",
        "## Sources not consulted",
        "",
    ]
    missing = report.get("unconsulted_sources") or []
    lines.extend([f"- {item.get('source')}: {item.get('reason')}" for item in missing] or ["- None"])
    population = report.get("population_estimate")
    lines.extend(["", "## Population estimate", ""])
    if population:
        lines.append(
            f"- Chapman capture-recapture (PubMed/OpenAlex): {population['estimated_total']} "
            f"(95% CI {population['ci95_low']} - {population['ci95_high']}, seen {population['seen_a']}+{population['seen_b']}, "
            f"overlap {population['seen_both']})"
        )
    else:
        lines.append("- Not estimable (both PubMed and OpenAlex records required for the overlap diagnostic)")
    lines.extend(["", "## Limitations", ""])
    lines.extend([f"- {item}" for item in report.get("limitations") or []] or ["- None recorded"])
    return "\n".join(lines) + "\n"


def render_prisma_markdown(counts: Dict[str, Any]) -> str:
    labels = [
        ("Identified", "identified"),
        ("Duplicates removed", "duplicates_removed"),
        ("Screened", "screened"),
        ("Excluded", "excluded"),
        ("Included", "included"),
        ("Awaiting screening", "awaiting_screening"),
        ("Human queue", "human_queue"),
    ]
    return "# PRISMA Counts\n\n" + "\n".join(f"- {label}: {counts.get(key, 0)}" for label, key in labels) + "\n"
