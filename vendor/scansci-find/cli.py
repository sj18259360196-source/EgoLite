from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from scansci_find.audit import build_human_queue, coverage_report, prisma_counts
from scansci_find.browser_discovery import doctor as browser_doctor
from scansci_find.dedupe import dedupe_candidates, dedupe_with_clusters
from scansci_find.evidence import attach_evidence_dimensions
from scansci_find.journal_scout import FixtureJournalScoutGateway
from scansci_find.outputs import enrich_download_metadata, write_outputs
from scansci_find.protocol import build_protocol
from scansci_find.quality import apply_quality
from scansci_find.service import CHINESE_SOURCES, ScanSciFindService
from scansci_find.source_registry import DEPTH_PROFILES, DOMAIN_PROFILES

DEFAULT_QUALITY = "high_quality_broad"


def _load_fixture(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="scansci-find")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("browser-doctor", help="Report the shared browser runtime ScanSci Find can reuse.")
    handoff = sub.add_parser("browser-handoff", help="Open an EgoLite source page for shared login or CAPTCHA.")
    handoff.add_argument("source", choices=["google-scholar", "cnki"])
    sub.add_parser("sources", help="List source capabilities and domain profiles.")
    plan = sub.add_parser("plan", help="Build a domain-neutral, auditable search protocol without running a search.")
    plan.add_argument("query")
    plan.add_argument("--domain", choices=sorted(DOMAIN_PROFILES), default="general")
    plan.add_argument("--depth", choices=sorted(DEPTH_PROFILES), default="standard")
    plan.add_argument("--source", action="append", dest="sources")
    plan.add_argument("--question", default="")
    plan.add_argument("--year-from", type=int)
    plan.add_argument("--year-to", type=int)
    plan.add_argument("--language", action="append", dest="languages")
    estimate = sub.add_parser("estimate", help="Estimate result volume before spending a full search budget.")
    estimate.add_argument("query")
    estimate.add_argument("--domain", choices=sorted(DOMAIN_PROFILES), default="general")
    estimate.add_argument("--depth", choices=sorted(DEPTH_PROFILES), default="standard")
    estimate.add_argument("--source", action="append", dest="sources")
    estimate.add_argument("--question", default="")
    estimate.add_argument("--year-from", type=int)
    estimate.add_argument("--year-to", type=int)
    estimate.add_argument("--language", action="append", dest="languages")
    estimate.add_argument("--out", help="Optional JSON report path.")
    smoke = sub.add_parser("smoke", help="Fetch four records per source and validate the candidate contract.")
    smoke.add_argument("query")
    smoke.add_argument("--domain", choices=sorted(DOMAIN_PROFILES), default="general")
    smoke.add_argument("--source", action="append", dest="sources")
    smoke.add_argument("--question", default="")
    smoke.add_argument("--year-from", type=int)
    smoke.add_argument("--year-to", type=int)
    smoke.add_argument("--language", action="append", dest="languages")
    smoke.add_argument("--records-per-source", type=int, default=4)
    smoke.add_argument("--out", help="Optional JSON report path.")
    calibrate = sub.add_parser("calibrate", help="Run a bounded calibration sample before a high-recall search.")
    calibrate.add_argument("query")
    calibrate.add_argument("--domain", choices=sorted(DOMAIN_PROFILES), default="general")
    calibrate.add_argument("--depth", choices=sorted(DEPTH_PROFILES), default="standard")
    calibrate.add_argument("--source", action="append", dest="sources")
    calibrate.add_argument("--question", default="")
    calibrate.add_argument("--year-from", type=int)
    calibrate.add_argument("--year-to", type=int)
    calibrate.add_argument("--language", action="append", dest="languages")
    calibrate.add_argument("--sample-size", type=int, default=100)
    calibrate.add_argument("--human-queue-threshold", type=float, default=0.15)
    calibrate.add_argument("--out", help="Optional JSON report path.")
    verify = sub.add_parser("verify", help="Verify DOI, PMID, and arXiv identifiers in a candidate JSON file.")
    verify.add_argument("input")
    verify.add_argument("--out")
    verify.add_argument("--limit", type=int)
    oa = sub.add_parser("resolve-oa", help="Resolve DOI open-access locations through Unpaywall.")
    oa.add_argument("input")
    oa.add_argument("--out")
    oa.add_argument("--limit", type=int)
    preprints = sub.add_parser("preprints", help="Find lawful preprint copies (arXiv, bioRxiv, medRxiv, SSRN) of paywalled candidates.")
    preprints.add_argument("input")
    preprints.add_argument("--out")
    preprints.add_argument("--limit", type=int)
    codes = sub.add_parser("codes", help="Attach Papers with Code code-availability metadata to candidates.")
    codes.add_argument("input")
    codes.add_argument("--out")
    codes.add_argument("--limit", type=int)
    benchmark = sub.add_parser("benchmark", help="Sample sources and measure abstract coverage per source and publisher (reproducible).")
    benchmark.add_argument("query")
    benchmark.add_argument("--domain", choices=sorted(DOMAIN_PROFILES), default="general")
    benchmark.add_argument("--source", action="append", dest="sources")
    benchmark.add_argument("--sample-size", type=int, default=100)
    benchmark.add_argument("--out", required=True)
    reconcile = sub.add_parser("reconcile", help="Write actual download outcomes (download_results.json from scansci-pdf) back into a find run's candidates.")
    reconcile.add_argument("runs_dir")
    explore = sub.add_parser("explore", help="Pass 1: quick search with a lightweight summary table before deep work.")
    explore.add_argument("query")
    explore.add_argument("--domain", choices=sorted(DOMAIN_PROFILES), default="general")
    explore.add_argument("--limit", type=int, default=30)
    explore.add_argument("--sort", choices=["relevance", "recency", "citations"], default="recency")
    explore.add_argument("--out")
    deep_fetch = sub.add_parser("deep-fetch", help="Pass 2: run verification/OA/preprint/code enrichment on confirmed candidates.")
    deep_fetch.add_argument("input")
    deep_fetch.add_argument("--no-verify", action="store_true")
    deep_fetch.add_argument("--no-oa", action="store_true")
    deep_fetch.add_argument("--no-preprints", action="store_true")
    deep_fetch.add_argument("--no-code", action="store_true")
    deep_fetch.add_argument("--no-bibtex", action="store_true")
    deep_fetch.add_argument("--out")
    search = sub.add_parser("search", help="Search science sources and write ScanSci Find artifacts.")
    search.add_argument("query")
    search.add_argument("--quality")
    search.add_argument("--mode", choices=["boost", "hard"])
    search.add_argument("--sort", choices=["relevance", "recency", "citations"], default="relevance", help="Order results: relevance score, recency-first (last 6 months flagged [new]), or citation count.")
    search.add_argument("--profile", choices=["paper", "research_data"], default="paper")
    search.add_argument("--domain", choices=sorted(DOMAIN_PROFILES))
    search.add_argument("--depth", choices=sorted(DEPTH_PROFILES), default="standard")
    search.add_argument("--question", default="")
    search.add_argument("--language", action="append", dest="languages")
    search.add_argument("--year-from", type=int)
    search.add_argument("--year-to", type=int)
    search.add_argument("--citation-rounds", type=int)
    search.add_argument("--expand-citations", action="store_true", help="Execute the planned backward/forward citation rounds.")
    search.add_argument("--citation-source", choices=["semantic", "opencitations", "both"], default="semantic")
    search.add_argument("--verify-identifiers", action="store_true", help="Verify DOI, PMID, or arXiv identifiers against authoritative metadata APIs.")
    search.add_argument("--resolve-oa", action="store_true", help="Resolve DOI open-access locations through Unpaywall.")
    search.add_argument("--find-preprints", action="store_true", help="Find lawful preprint copies (arXiv, bioRxiv, medRxiv, SSRN) of paywalled candidates.")
    search.add_argument("--code-links", action="store_true", help="Attach Papers with Code code-availability metadata to candidates.")
    search.add_argument("--out", required=True)
    search.add_argument("--limit", type=int, default=10)
    search.add_argument("--source", action="append", dest="sources")
    search.add_argument("--cn", action="store_true", help="Prefer Chinese literature discovery/database sources.")
    search.add_argument("--doc-type", choices=["journal", "thesis", "conference", "newspaper", "standard", "patent", "book"])
    search.add_argument("--field", choices=["subject", "title", "keyword", "author", "affiliation", "journal", "fund"])
    search.add_argument("--year", help="Year range such as 2020:2026.")
    search.add_argument("--access", choices=["all", "public", "institution", "oa", "paid"], default="all")
    search.add_argument("--exclude-warning", action="store_true", help="Ask Journal Scout to exclude warning-listed journals.")
    search.add_argument("--fixture", help="Use a deterministic fixture instead of live providers and Journal Scout MCP.")
    return parser


def resolve_quality_and_mode(args: argparse.Namespace) -> tuple[str, str]:
    quality = args.quality or DEFAULT_QUALITY
    if args.mode:
        return quality, args.mode
    if args.quality:
        return quality, "hard"
    return quality, "boost"


def resolve_sources(args: argparse.Namespace) -> Optional[List[str]]:
    if args.sources:
        out: List[str] = []
        for item in args.sources:
            out.extend(part.strip() for part in str(item).split(",") if part.strip())
        aliases = {"baidu_scholar": "baidu-scholar", "baidu-scholar-search": "baidu-scholar", "vip": "cqvip"}
        return [aliases.get(item, item) for item in out]
    if getattr(args, "cn", False):
        return list(CHINESE_SOURCES)
    return None


def resolve_filters(args: argparse.Namespace) -> Dict[str, Any]:
    filters: Dict[str, Any] = {}
    if args.doc_type:
        filters["doc_type"] = args.doc_type
    if args.field:
        filters["field"] = args.field
    if args.year:
        filters["year"] = args.year
    if args.access and args.access != "all":
        filters["access"] = args.access
    if args.exclude_warning:
        filters["exclude_warning"] = True
    return filters


def resolve_years(args: argparse.Namespace) -> tuple[Optional[int], Optional[int]]:
    year_from = getattr(args, "year_from", None)
    year_to = getattr(args, "year_to", None)
    legacy = getattr(args, "year", None)
    if legacy and ":" in legacy:
        left, right = legacy.split(":", 1)
        year_from = year_from or (int(left) if left.strip().isdigit() else None)
        year_to = year_to or (int(right) if right.strip().isdigit() else None)
    elif legacy and legacy.strip().isdigit():
        year_from = year_from or int(legacy)
        year_to = year_to or int(legacy)
    return year_from, year_to


def resolve_domain(args: argparse.Namespace) -> str:
    if getattr(args, "domain", None):
        return args.domain
    if getattr(args, "profile", "paper") == "research_data":
        return "research_data"
    if getattr(args, "cn", False):
        return "chinese_general"
    return "general"


def _split_values(values: Optional[List[str]]) -> List[str]:
    out = []
    for value in values or []:
        out.extend(part.strip() for part in str(value).split(",") if part.strip())
    return list(dict.fromkeys(out))


def _stage_kwargs(args: argparse.Namespace) -> Dict[str, Any]:
    return {
        "domain": args.domain,
        "sources": resolve_sources(args),
        "research_question": args.question,
        "languages": _split_values(args.languages),
        "year_from": args.year_from,
        "year_to": args.year_to,
    }


def _load_candidates(path: Path) -> List[Dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".jsonl":
        records = [json.loads(line) for line in text.splitlines() if line.strip()]
    else:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            # Tolerate line-delimited JSON regardless of the file extension.
            records = [json.loads(line) for line in text.splitlines() if line.strip()]
        else:
            records = payload if isinstance(payload, list) else payload.get("candidates", [])
    if not isinstance(records, list) or not all(isinstance(item, dict) for item in records):
        raise ValueError("input must be a JSON candidate list or an object with a candidates list")
    return [dict(item) for item in records]


def _emit_payload(payload: Dict[str, Any], out: Optional[str] = None) -> None:
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    if out:
        out_path = Path(out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)


def run_search(args: argparse.Namespace) -> int:
    quality, mode = resolve_quality_and_mode(args)
    year_from, year_to = resolve_years(args)
    selected_sources = resolve_sources(args)
    domain = resolve_domain(args)
    if args.fixture:
        fixture = _load_fixture(Path(args.fixture))
        raw_candidates = list(fixture.get("candidates") or [])
        gateway = FixtureJournalScoutGateway(fixture)
        dedupe_result = dedupe_with_clusters(raw_candidates)
        raw_count = len(raw_candidates)
        deduplicated_count = len(dedupe_result["candidates"])
        dedupe_clusters = dedupe_result["clusters"]
        candidates = dedupe_result["candidates"][: args.limit]
        screened = apply_quality(candidates, gateway, policy=quality, mode=mode)
        enrich_download_metadata(screened)
        attach_evidence_dimensions(screened)
        source_status = [{"name": "fixture", "status": "ok", "count": len(raw_candidates), "message": ""}]
        protocol = build_protocol(
            args.query,
            research_question=args.question,
            domain=domain,
            depth=args.depth,
            sources=selected_sources or ["fixture"],
            languages=_split_values(args.languages),
            year_from=year_from,
            year_to=year_to,
            document_types=[args.doc_type] if args.doc_type else None,
            citation_rounds=args.citation_rounds,
        ).to_dict()
        human_queue = build_human_queue(screened)
        audit = coverage_report(
            protocol=protocol,
            source_status=source_status,
            raw_count=raw_count,
            deduplicated_count=deduplicated_count,
            candidates=screened,
            pagination_complete=False,
        )
        prisma = prisma_counts(
            raw_count=raw_count,
            deduplicated_count=deduplicated_count,
            candidates=screened,
            human_queue_count=len(human_queue),
        )
        filter_report = {"kept": len(candidates), "excluded": 0, "excluded_records": []}
        verification_report = {}
        oa_report = {}
        preprint_report = {}
        code_report = {}
    else:
        service = ScanSciFindService()
        result = service.search_academic(
            query=args.query,
            domain=domain,
            depth=args.depth,
            quality=quality,
            mode=mode,
            limit=args.limit,
            sources=selected_sources,
            filters=resolve_filters(args),
            profile=args.profile,
            research_question=args.question,
            languages=_split_values(args.languages),
            year_from=year_from,
            year_to=year_to,
            document_types=[args.doc_type] if args.doc_type else None,
            citation_rounds=args.citation_rounds,
            execute_citation_chasing=args.expand_citations,
            citation_source=args.citation_source,
            verify_candidate_identifiers=args.verify_identifiers,
            resolve_oa=args.resolve_oa,
            find_preprints=args.find_preprints,
            code_links=args.code_links,
            sort=args.sort,
        )
        screened = result["candidates"]
        quality = result.get("quality") or quality
        mode = result.get("mode") or mode
        source_status = result.get("source_status") or []
        protocol = result.get("protocol") or {}
        audit = result.get("audit") or {}
        prisma = result.get("prisma") or {}
        human_queue = result.get("human_queue") or []
        dedupe_clusters = result.get("dedupe_clusters") or []
        raw_count = int(result.get("raw_total") or len(screened))
        deduplicated_count = int(result.get("deduplicated_total") or len(screened))
        filter_report = result.get("filter_report") or {}
        citation_report = result.get("citation_report") or {}
        verification_report = result.get("verification_report") or {}
        oa_report = result.get("oa_report") or {}
        preprint_report = result.get("preprint_report") or {}
        code_report = result.get("code_report") or {}
    if args.fixture:
        citation_report = {}
    write_outputs(
        screened,
        Path(args.out),
        args.query,
        quality,
        mode,
        source_status=source_status,
        profile=args.profile,
        protocol=protocol,
        audit=audit,
        prisma=prisma,
        human_queue=human_queue,
        dedupe_clusters=dedupe_clusters,
        filter_report=filter_report,
        raw_count=raw_count,
        deduplicated_count=deduplicated_count,
        citation_report=citation_report,
        verification_report=verification_report,
        oa_report=oa_report,
        preprint_report=preprint_report,
        code_report=code_report,
    )
    print(json.dumps({"out": str(Path(args.out)), "total": len(screened)}, ensure_ascii=False))
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "browser-doctor":
        print(json.dumps(browser_doctor(), ensure_ascii=False))
        return 0
    if args.command == "browser-handoff":
        print(json.dumps(ScanSciFindService().browser_handoff(args.source), ensure_ascii=False))
        return 0
    if args.command == "sources":
        print(json.dumps(ScanSciFindService().list_sources(), ensure_ascii=False))
        return 0
    if args.command == "plan":
        sources = []
        for item in args.sources or []:
            sources.extend(part.strip() for part in str(item).split(",") if part.strip())
        payload = ScanSciFindService().plan_search(
            args.query,
            domain=args.domain,
            depth=args.depth,
            sources=sources or None,
            research_question=args.question,
            languages=_split_values(args.languages),
            year_from=args.year_from,
            year_to=args.year_to,
        )
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    if args.command in {"estimate", "smoke", "calibrate"}:
        service = ScanSciFindService()
        kwargs = _stage_kwargs(args)
        if args.command == "estimate":
            payload = service.estimate_search(args.query, depth=args.depth, **kwargs)
        elif args.command == "smoke":
            payload = service.smoke_search(args.query, records_per_source=args.records_per_source, **kwargs)
        else:
            payload = service.calibrate_search(
                args.query,
                depth=args.depth,
                sample_size=args.sample_size,
                human_queue_threshold=args.human_queue_threshold,
                **kwargs,
            )
        _emit_payload(payload, args.out)
        return 0
    if args.command in {"verify", "resolve-oa", "preprints", "codes"}:
        candidates = _load_candidates(Path(args.input))
        service = ScanSciFindService()
        if args.command == "verify":
            payload = service.verify_identifiers(candidates, limit=args.limit)
        elif args.command == "resolve-oa":
            payload = service.resolve_open_access(candidates, limit=args.limit)
        elif args.command == "preprints":
            payload = service.find_preprints(candidates, limit=args.limit)
        else:
            payload = service.enrich_code_links(candidates, limit=args.limit)
        _emit_payload(payload, args.out)
        return 0
    if args.command == "benchmark":
        from scansci_find.benchmark import run_benchmark, write_benchmark

        sources = []
        for item in args.sources or []:
            sources.extend(part.strip() for part in str(item).split(",") if part.strip())
        report = run_benchmark(args.query, domain=args.domain, sources=sources or None, sample_size=args.sample_size)
        artifact = write_benchmark(report, Path(args.out))
        print(json.dumps({"out": str(artifact), "record_count": report.get("record_count", 0)}, ensure_ascii=False))
        return 0
    if args.command == "reconcile":
        from scansci_find.reconcile import reconcile

        report = reconcile(args.runs_dir)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    if args.command == "explore":
        payload = ScanSciFindService().explore(
            args.query,
            domain=args.domain,
            limit=args.limit,
            sort=args.sort,
        )
        print(payload["summary"].get("markdown") or "No candidates.")
        _emit_payload(payload, args.out)
        return 0
    if args.command == "deep-fetch":
        candidates = _load_candidates(Path(args.input))
        payload = ScanSciFindService().deep_fetch(
            candidates,
            verify=not args.no_verify,
            resolve_oa=not args.no_oa,
            find_preprints=not args.no_preprints,
            code_links=not args.no_code,
            bibtex=not args.no_bibtex,
        )
        _emit_payload(payload, args.out)
        return 0
    if args.command == "search":
        return run_search(args)
    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
