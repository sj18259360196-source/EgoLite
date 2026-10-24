"""Reproducible retrieval benchmarks.

Abstract-coverage measurement is a diagnostic of what the metadata backbone
can and cannot supply: ``run_benchmark`` samples each source against the same
query and reports abstract coverage per source and per publisher (by DOI
prefix), plus the raw source statuses. The numbers are reproducible artifacts
rather than one-off claims — e.g. Crossref search carries no abstracts, so
coverage there is expected to be near zero while OpenAlex and PubMed supply
the abstracts for closed-publisher records.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from scansci_find.adapters import search_query_variants_with_status, normalize_doi
from scansci_find.measure import abstract_coverage

#: DOI prefix -> publisher, for per-publisher coverage classification.
PUBLISHER_PREFIXES: List[tuple[str, str]] = [
    ("10.1016", "Elsevier"),
    ("10.1007", "Springer"),
    ("10.1109", "IEEE"),
    ("10.1038", "Nature"),
    ("10.1126", "Science"),
    ("10.1073", "PNAS"),
    ("10.1021", "ACS"),
    ("10.1145", "ACM"),
    ("10.1111", "Wiley"),
    ("10.1002", "Wiley"),
    ("10.1080", "Taylor & Francis"),
    ("10.3390", "MDPI"),
    ("10.1177", "SAGE"),
    ("10.48550", "arXiv"),
]

DEFAULT_BENCHMARK_SOURCES = ["openalex", "crossref", "arxiv", "pubmed", "europe-pmc"]


def publisher_from_doi(doi: Any) -> str:
    normalized = normalize_doi(doi)
    for prefix, name in PUBLISHER_PREFIXES:
        if normalized.startswith(prefix + "/") or normalized == prefix:
            return name
    return "other"


def run_benchmark(
    query: str,
    *,
    domain: str = "general",
    sources: Optional[Iterable[str]] = None,
    sample_size: int = 100,
    providers: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    source_list = list(dict.fromkeys(str(source).strip() for source in (sources or DEFAULT_BENCHMARK_SOURCES) if str(source).strip()))
    per_source = max(5, int(sample_size))
    retrieval = search_query_variants_with_status([str(query).strip()], source_list, per_source, providers=providers)
    candidates = retrieval["candidates"]
    publisher_buckets: Dict[str, Dict[str, int]] = {}
    for item in candidates:
        publisher = publisher_from_doi(item.get("doi"))
        bucket = publisher_buckets.setdefault(publisher, {"total": 0, "with_abstract": 0})
        bucket["total"] += 1
        if str(item.get("abstract") or "").strip():
            bucket["with_abstract"] += 1
    return {
        "query": str(query).strip(),
        "domain": domain,
        "sources": source_list,
        "sample_size": per_source,
        "record_count": len(candidates),
        "source_status": retrieval["source_status"],
        "abstract_coverage": abstract_coverage(candidates),
        "publisher_coverage": [
            {
                "publisher": publisher,
                "total": bucket["total"],
                "with_abstract": bucket["with_abstract"],
                "coverage": round(bucket["with_abstract"] / bucket["total"], 4) if bucket["total"] else None,
            }
            for publisher, bucket in sorted(publisher_buckets.items())
        ],
    }


def render_benchmark_markdown(report: Dict[str, Any]) -> str:
    lines = [
        "# Benchmark Report",
        "",
        f"- Query: {report.get('query', '')}",
        f"- Domain: {report.get('domain', '')}",
        f"- Sources: {', '.join(report.get('sources') or [])}",
        f"- Sample size per source: {report.get('sample_size', 0)}",
        f"- Records sampled: {report.get('record_count', 0)}",
        "",
        "## Abstract coverage per source",
        "",
        "| Source | Records | With abstract | Coverage |",
        "|---|---:|---:|---:|",
    ]
    for item in report.get("abstract_coverage", {}).get("per_source") or []:
        coverage = f"{item['coverage']:.1%}" if item.get("coverage") is not None else "-"
        lines.append(f"| {item['source']} | {item['total']} | {item['with_abstract']} | {coverage} |")
    lines.extend(["", "## Abstract coverage per publisher (by DOI prefix)", ""])
    publisher_coverage = report.get("publisher_coverage") or []
    lines.append("| Publisher | Records | With abstract | Coverage |")
    lines.append("|---|---:|---:|---:|")
    for item in publisher_coverage:
        coverage = f"{item['coverage']:.1%}" if item.get("coverage") is not None else "-"
        lines.append(f"| {item['publisher']} | {item['total']} | {item['with_abstract']} | {coverage} |")
    return "\n".join(lines) + "\n"


def write_benchmark(report: Dict[str, Any], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "benchmark_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "benchmark_report.md").write_text(render_benchmark_markdown(report), encoding="utf-8")
    return out_dir / "benchmark_report.json"
