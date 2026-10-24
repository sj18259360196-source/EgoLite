from __future__ import annotations

from typing import Any, Dict, Iterable, List


def _access_status(candidate: Dict[str, Any], access: Dict[str, Any]) -> str:
    """Derive the full-text status enum (open_pdf/preprint/needs_institution/
    no_open_pdf/unknown), preferring an explicitly recorded status.

    The enum is additive: the legacy ``fulltext_hint`` values remain
    untouched, and ``availability.status`` is the normalized view that
    download manifests and evidence tables consume.
    """
    explicit = str(access.get("access_status") or "").strip()
    if explicit:
        return explicit
    fulltext_hint = str(access.get("fulltext_hint") or "").strip()
    if fulltext_hint == "oa" or (candidate.get("links") or {}).get("pdf"):
        return "open_pdf"
    if fulltext_hint == "preprint":
        return "preprint"
    if fulltext_hint in ("institution_required",) or access.get("requires_institution"):
        return "needs_institution"
    return "unknown"


def evidence_dimensions(candidate: Dict[str, Any]) -> Dict[str, Any]:
    identifiers = candidate.get("identifiers") or {}
    canonical_identifier = bool(
        candidate.get("doi")
        or candidate.get("arxiv_id")
        or candidate.get("pmid")
        or candidate.get("pmcid")
        or candidate.get("dblp_id")
        or identifiers
    )
    source_hits = list(candidate.get("source_hits") or [])
    access = candidate.get("access") or {}
    quality = candidate.get("quality") or {}
    metrics = candidate.get("metrics") or {}
    citation_count = candidate.get("citation_count")
    verification = candidate.get("identifier_verification") or {}
    if citation_count is None:
        citation_count = metrics.get("citation_count")

    warnings = []
    if not canonical_identifier:
        warnings.append("no_canonical_identifier")
    if len(source_hits) < 2:
        warnings.append("single_source_only")
    if candidate.get("field_conflicts"):
        warnings.append("metadata_conflict")
    if not candidate.get("abstract"):
        warnings.append("abstract_unavailable")
    if verification and verification.get("status") != "verified":
        warnings.append("identifier_not_verified")

    return {
        "identity": {
            "canonical_identifier": canonical_identifier,
            "identifiers": identifiers,
            "verification_status": verification.get("status") or "not_checked",
            "verification_source": verification.get("source") or "",
            "verified": verification.get("status") == "verified",
        },
        "corroboration": {
            "source_count": len(source_hits),
            "sources": source_hits,
        },
        "availability": {
            "fulltext_hint": access.get("fulltext_hint") or ("oa" if (candidate.get("links") or {}).get("pdf") else "unknown"),
            "status": _access_status(candidate, access),
            "requires_login": bool(access.get("requires_login")),
            "requires_institution": bool(access.get("requires_institution")),
        },
        "venue": {
            "journal_level_only": True,
            "passed_policy": quality.get("passed"),
            "policy": quality.get("policy") or "",
            "evidence": quality.get("evidence") or [],
            "jif_latest": quality.get("jif_latest") or {},
        },
        "citation_signal": {
            "citation_count": citation_count,
            "interpretation": "discovery_signal_not_validity_proof",
        },
        "warnings": warnings,
    }


def attach_evidence_dimensions(candidates: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = list(candidates)
    for candidate in rows:
        candidate["evidence_dimensions"] = evidence_dimensions(candidate)
    return rows
