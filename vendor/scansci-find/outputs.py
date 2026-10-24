from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from scansci_find import __version__
from scansci_find.adapters import normalize_arxiv_id
from scansci_find.audit import (
    build_human_queue,
    coverage_report,
    prisma_counts,
    render_coverage_markdown,
    render_prisma_markdown,
)


def download_entry(candidate: Dict[str, Any], strategy: str = "oa_first") -> Dict[str, Any]:
    identifier = candidate.get("doi") or candidate.get("arxiv_id") or ""
    if not identifier:
        return {}
    entry: Dict[str, Any] = {
        "identifier": identifier,
        "identifier_type": "doi" if candidate.get("doi") else "arxiv",
        "title": candidate.get("title") or "",
        "doi": candidate.get("doi") or "",
        "arxiv_id": candidate.get("arxiv_id") or "",
        "recommended_strategy": strategy,
        "queue": True,
    }
    preprint_identifiers = []
    for version in candidate.get("preprint_versions") or []:
        arxiv_id = normalize_arxiv_id(version.get("arxiv_id"))
        if arxiv_id and not any(item.get("value") == arxiv_id for item in preprint_identifiers):
            preprint_identifiers.append({"type": "arxiv", "value": arxiv_id, "url": version.get("url") or ""})
    if preprint_identifiers:
        entry["preprint_identifiers"] = preprint_identifiers
    return entry


def enrich_download_metadata(candidates: Iterable[Dict[str, Any]], strategy: str = "oa_first") -> List[Dict[str, Any]]:
    rows = list(candidates)
    for candidate in rows:
        entry = download_entry(candidate, strategy=strategy)
        if entry:
            candidate["download"] = entry
        else:
            candidate.setdefault("download", {})
    return rows


def build_download_queue(candidates: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    queue = []
    for candidate in candidates:
        entry = candidate.get("download") or download_entry(candidate)
        if entry:
            queue.append(entry)
    return queue


def build_data_queue(candidates: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    queue = []
    for candidate in candidates:
        artifact_type = candidate.get("artifact_type") or "paper"
        if artifact_type == "paper":
            continue
        identifier = candidate.get("doi") or candidate.get("links", {}).get("paper") or candidate.get("title") or ""
        if not identifier:
            continue
        queue.append(
            {
                "identifier": identifier,
                "identifier_type": "doi" if candidate.get("doi") else "url_or_title",
                "title": candidate.get("title") or "",
                "artifact_type": artifact_type,
                "source_hits": candidate.get("source_hits") or [],
                "links": candidate.get("links") or {},
                "queue": True,
            }
        )
    return queue


def build_oa_manifest(candidates: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Build the open-access download manifest consumed by the retrieval layer.

    Records with an open full text (``open_pdf``/``preprint``) and a PDF URL
    are ``eligible`` for direct download; everything else is labeled with its
    status so the retrieval layer can route it (institutional phase, or skip).
    """
    entries = []
    for candidate in candidates:
        identifier = candidate.get("doi") or candidate.get("arxiv_id") or ""
        if not identifier:
            continue
        access = candidate.get("access") or {}
        status = str(access.get("access_status") or "unknown")
        pdf_url = str((candidate.get("links") or {}).get("pdf") or "")
        if status in ("open_pdf", "preprint") and pdf_url:
            download_status = "eligible"
            reason = ""
        else:
            download_status = "skipped"
            reason = f"fulltext_status={status}"
        entries.append(
            {
                "identifier": identifier,
                "identifier_type": "doi" if candidate.get("doi") else "arxiv",
                "title": candidate.get("title") or "",
                "fulltext_status": status,
                "pdf_url": pdf_url,
                "download_status": download_status,
                "reason": reason,
            }
        )
    return {
        "entries": entries,
        "total": len(entries),
        "eligible": sum(1 for entry in entries if entry["download_status"] == "eligible"),
    }


def render_papers_md(candidates: Iterable[Dict[str, Any]], query: str) -> str:
    lines = [f"# ScanSci Find Results", "", f"Query: {query}", ""]
    for idx, candidate in enumerate(candidates, 1):
        quality = candidate.get("quality") or {}
        jif = quality.get("jif_latest") or {}
        status = "PASS" if quality.get("passed") else "REVIEW"
        evidence = "; ".join(quality.get("evidence") or [])
        if jif.get("value") is not None:
            evidence = (evidence + "; " if evidence else "") + f"IF {jif['value']:g} ({jif.get('year', '')})"
        lines.extend(
            [
                f"## {idx}. {status} - {candidate.get('title', '')}",
                "",
                f"- Journal: {candidate.get('journal') or quality.get('matched_journal') or '-'}",
                f"- Year: {candidate.get('year') or '-'}",
                f"- DOI: {candidate.get('doi') or '-'}",
                f"- arXiv: {candidate.get('arxiv_id') or '-'}",
                f"- Preprint: {(candidate.get('links') or {}).get('preprint') or '-'}",
                f"- Code: {(candidate.get('code') or {}).get('url') or '-'}",
                f"- Sources: {', '.join(candidate.get('source_hits') or [])}",
                f"- Evidence: {evidence or '-'}",
                "",
            ]
        )
    return "\n".join(lines)


def _bib_key(candidate: Dict[str, Any]) -> str:
    title = re.sub(r"[^A-Za-z0-9]+", "", str(candidate.get("title") or "paper"))[:20] or "paper"
    year = candidate.get("year") or "nd"
    return f"{title}{year}"


def render_refs_bib(candidates: Iterable[Dict[str, Any]]) -> str:
    entries = []
    for candidate in candidates:
        entries.append(
            "\n".join(
                [
                    f"@article{{{_bib_key(candidate)},",
                    f"  title = {{{candidate.get('title') or ''}}},",
                    f"  author = {{{' and '.join(candidate.get('authors') or [])}}},",
                    f"  journal = {{{candidate.get('journal') or ''}}},",
                    f"  year = {{{candidate.get('year') or ''}}},",
                    f"  doi = {{{candidate.get('doi') or ''}}}",
                    "}",
                ]
            )
        )
    return "\n\n".join(entries) + ("\n" if entries else "")


def build_zotero_items(candidates: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    items = []
    for candidate in candidates:
        creators = [{"creatorType": "author", "name": str(author)} for author in candidate.get("authors") or []]
        links = candidate.get("links") or {}
        items.append(
            {
                "itemType": "journalArticle" if (candidate.get("artifact_type") or "paper") == "paper" else "document",
                "title": candidate.get("title") or "",
                "creators": creators,
                "date": str(candidate.get("year") or ""),
                "publicationTitle": candidate.get("journal") or "",
                "DOI": candidate.get("doi") or "",
                "url": links.get("paper") or candidate.get("source_url") or "",
                "abstractNote": candidate.get("abstract") or "",
                "language": candidate.get("language") or "",
                "tags": [{"tag": str(tag)} for tag in candidate.get("keywords") or []],
                "extra": "\n".join(
                    part
                    for part in [
                        f"Canonical ID: {candidate.get('canonical_id')}" if candidate.get("canonical_id") else "",
                        f"Sources: {', '.join(candidate.get('source_hits') or [])}" if candidate.get("source_hits") else "",
                    ]
                    if part
                ),
            }
        )
    return items


def render_dois(candidates: Iterable[Dict[str, Any]]) -> str:
    values = list(dict.fromkeys(str(item.get("doi") or "").strip() for item in candidates if str(item.get("doi") or "").strip()))
    return "# DOI List\n\n" + ("\n".join(f"- {value}" for value in values) + "\n" if values else "No verified DOI records.\n")


def render_references_md(candidates: Iterable[Dict[str, Any]]) -> str:
    lines = ["# References", ""]
    for index, candidate in enumerate(candidates, 1):
        authors = ", ".join(candidate.get("authors") or []) or "Unknown author"
        year = candidate.get("year") or "n.d."
        venue = candidate.get("journal") or ""
        doi = candidate.get("doi") or ""
        suffix = f" https://doi.org/{doi}" if doi else ""
        lines.append(f"{index}. {authors} ({year}). {candidate.get('title') or ''}. {venue}.{suffix}".strip())
    return "\n".join(lines) + "\n"


def write_evidence_table(candidates: Iterable[Dict[str, Any]], path: Path) -> None:
    fields = [
        "canonical_id",
        "title",
        "year",
        "doi",
        "journal",
        "source_count",
        "sources",
        "canonical_identifier",
        "identifier_verification_status",
        "fulltext_hint",
        "oa_status",
        "license",
        "journal_policy_passed",
        "warnings",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for candidate in candidates:
            evidence = candidate.get("evidence_dimensions") or {}
            corroboration = evidence.get("corroboration") or {}
            identity = evidence.get("identity") or {}
            availability = evidence.get("availability") or {}
            venue = evidence.get("venue") or {}
            writer.writerow(
                {
                    "canonical_id": candidate.get("canonical_id") or "",
                    "title": candidate.get("title") or "",
                    "year": candidate.get("year") or "",
                    "doi": candidate.get("doi") or "",
                    "journal": candidate.get("journal") or "",
                    "source_count": corroboration.get("source_count") or len(candidate.get("source_hits") or []),
                    "sources": ";".join(corroboration.get("sources") or candidate.get("source_hits") or []),
                    "canonical_identifier": identity.get("canonical_identifier"),
                    "identifier_verification_status": identity.get("verification_status") or "not_checked",
                    "fulltext_hint": availability.get("fulltext_hint") or "unknown",
                    "oa_status": (candidate.get("access") or {}).get("oa_status") or "unknown",
                    "license": (candidate.get("access") or {}).get("license") or "",
                    "journal_policy_passed": venue.get("passed_policy"),
                    "warnings": ";".join(evidence.get("warnings") or []),
                }
            )


def quality_report(candidates: Iterable[Dict[str, Any]], policy: str, mode: str) -> Dict[str, Any]:
    rows = list(candidates)
    return {
        "policy": policy,
        "mode": mode,
        "total": len(rows),
        "passed": sum(1 for item in rows if (item.get("quality") or {}).get("passed")),
        "data_sha256": next(((item.get("quality") or {}).get("data_sha256") for item in rows if (item.get("quality") or {}).get("data_sha256")), ""),
        "journal_scout_version": next(((item.get("quality") or {}).get("journal_scout_version") for item in rows if (item.get("quality") or {}).get("journal_scout_version")), ""),
    }


def write_outputs(
    candidates: List[Dict[str, Any]],
    out_dir: Path,
    query: str,
    policy: str,
    mode: str,
    source_status: Optional[List[Dict[str, Any]]] = None,
    profile: str = "paper",
    protocol: Optional[Dict[str, Any]] = None,
    audit: Optional[Dict[str, Any]] = None,
    prisma: Optional[Dict[str, Any]] = None,
    human_queue: Optional[List[Dict[str, Any]]] = None,
    dedupe_clusters: Optional[List[Dict[str, Any]]] = None,
    filter_report: Optional[Dict[str, Any]] = None,
    raw_count: Optional[int] = None,
    deduplicated_count: Optional[int] = None,
    citation_report: Optional[Dict[str, Any]] = None,
    verification_report: Optional[Dict[str, Any]] = None,
    oa_report: Optional[Dict[str, Any]] = None,
    preprint_report: Optional[Dict[str, Any]] = None,
    code_report: Optional[Dict[str, Any]] = None,
    estimate_report: Optional[Dict[str, Any]] = None,
    smoke_report: Optional[Dict[str, Any]] = None,
    calibration_report: Optional[Dict[str, Any]] = None,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    enrich_download_metadata(candidates, strategy="record_first" if profile == "research_data" else "oa_first")
    source_status = list(source_status or [])
    protocol = dict(
        protocol
        or {
            "protocol_id": "legacy-fixture",
            "query": query,
            "depth": "quick",
            "planned_sources": [str(item.get("name")) for item in source_status],
            "gold_set": [],
            "citation_rounds": 0,
        }
    )
    raw_count = len(candidates) if raw_count is None else int(raw_count)
    deduplicated_count = len(candidates) if deduplicated_count is None else int(deduplicated_count)
    human_queue = list(build_human_queue(candidates) if human_queue is None else human_queue)
    audit = dict(
        audit
        or coverage_report(
            protocol=protocol,
            source_status=source_status,
            raw_count=raw_count,
            deduplicated_count=deduplicated_count,
            candidates=candidates,
            pagination_complete=False,
        )
    )
    prisma = dict(
        prisma
        or prisma_counts(
            raw_count=raw_count,
            deduplicated_count=deduplicated_count,
            candidates=candidates,
            human_queue_count=len(human_queue),
        )
    )

    (out_dir / "candidates.json").write_text(json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "candidates.jsonl").write_text(
        "".join(json.dumps(candidate, ensure_ascii=False) + "\n" for candidate in candidates),
        encoding="utf-8",
    )
    (out_dir / "download_queue.json").write_text(json.dumps(build_download_queue(candidates), ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "oa_manifest.json").write_text(json.dumps(build_oa_manifest(candidates), ensure_ascii=False, indent=2), encoding="utf-8")
    data_queue = build_data_queue(candidates)
    if data_queue:
        (out_dir / "data_queue.json").write_text(json.dumps(data_queue, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "source_report.json").write_text(json.dumps({"sources": source_status}, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "papers.md").write_text(render_papers_md(candidates, query), encoding="utf-8")
    refs_bib = render_refs_bib(candidates)
    (out_dir / "refs.bib").write_text(refs_bib, encoding="utf-8")
    (out_dir / "references.bib").write_text(refs_bib, encoding="utf-8")
    (out_dir / "references.md").write_text(render_references_md(candidates), encoding="utf-8")
    (out_dir / "dois.md").write_text(render_dois(candidates), encoding="utf-8")
    (out_dir / "zotero_items.json").write_text(json.dumps(build_zotero_items(candidates), ensure_ascii=False, indent=2), encoding="utf-8")
    write_evidence_table(candidates, out_dir / "evidence_table.csv")
    (out_dir / "quality_report.json").write_text(json.dumps(quality_report(candidates, policy, mode), ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "protocol.json").write_text(json.dumps(protocol, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "coverage_report.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "coverage_report.md").write_text(render_coverage_markdown(audit), encoding="utf-8")
    (out_dir / "prisma.json").write_text(json.dumps(prisma, ensure_ascii=False, indent=2), encoding="utf-8")
    if prisma.get("consistent", True):
        (out_dir / "PRISMA.md").write_text(render_prisma_markdown(prisma), encoding="utf-8")
    else:
        # Refuse to render an inconsistent PRISMA diagram; record why instead.
        (out_dir / "prisma_inconsistency.md").write_text(
            "# PRISMA counts are inconsistent — diagram not rendered\n\n"
            + "\n".join(f"- {reason}" for reason in prisma.get("consistency_reasons") or [])
            + "\n",
            encoding="utf-8",
        )
    (out_dir / "dedupe_clusters.json").write_text(json.dumps(dedupe_clusters or [], ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "filter_report.json").write_text(json.dumps(filter_report or {}, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "citation_rounds.json").write_text(json.dumps(citation_report or {}, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "identifier_verification.json").write_text(json.dumps(verification_report or {}, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "oa_report.json").write_text(json.dumps(oa_report or {}, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "preprint_report.json").write_text(json.dumps(preprint_report or {}, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "code_report.json").write_text(json.dumps(code_report or {}, ensure_ascii=False, indent=2), encoding="utf-8")
    if estimate_report is not None:
        (out_dir / "estimate_report.json").write_text(json.dumps(estimate_report, ensure_ascii=False, indent=2), encoding="utf-8")
    if smoke_report is not None:
        (out_dir / "smoke_report.json").write_text(json.dumps(smoke_report, ensure_ascii=False, indent=2), encoding="utf-8")
    if calibration_report is not None:
        (out_dir / "calibration_report.json").write_text(json.dumps(calibration_report, ensure_ascii=False, indent=2), encoding="utf-8")
    with (out_dir / "human_queue.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["canonical_id", "title", "doi", "reasons"])
        writer.writeheader()
        for row in human_queue:
            writer.writerow({**row, "reasons": ";".join(row.get("reasons") or [])})
    artifacts = sorted({path.name for path in out_dir.iterdir() if path.is_file()} | {"run_manifest.json"})
    manifest = {
        "service": "scansci-find",
        "version": __version__,
        "protocol_id": protocol.get("protocol_id") or "",
        "query": query,
        "profile": profile,
        "method_status": audit.get("method_status") or "bounded_search",
        "artifacts": artifacts,
    }
    (out_dir / "run_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
