from __future__ import annotations

import json
from typing import Any, Dict, List, Optional


def _schema(properties: Optional[Dict[str, Any]] = None, required: Optional[List[str]] = None) -> Dict[str, Any]:
    return {"type": "object", "properties": properties or {}, "required": required or []}


def list_tools() -> List[Dict[str, Any]]:
    candidate_schema = {"type": "object", "additionalProperties": True}
    return [
        {
            "name": "health_check",
            "description": "Report ScanSci Find health, layer boundaries, sources, and Journal Scout status.",
            "inputSchema": _schema(),
            "outputSchema": _schema(),
        },
        {
            "name": "list_sources",
            "description": "List the full academic source catalog, capabilities, implementation status, and domain profiles.",
            "inputSchema": _schema(),
            "outputSchema": _schema(),
        },
        {
            "name": "plan_search",
            "description": "Create a domain-neutral, auditable academic search protocol without executing network searches.",
            "inputSchema": _schema(
                {
                    "query": {"type": "string"},
                    "research_question": {"type": "string"},
                    "domain": {"type": "string", "default": "general"},
                    "depth": {"type": "string", "enum": ["quick", "standard", "systematic"], "default": "standard"},
                    "sources": {"type": "array", "items": {"type": "string"}},
                    "concept_blocks": {"type": "array", "items": {"type": "object"}},
                    "inclusion_criteria": {"type": "array", "items": {"type": "string"}},
                    "exclusion_criteria": {"type": "array", "items": {"type": "string"}},
                    "languages": {"type": "array", "items": {"type": "string"}},
                    "year_from": {"type": "integer"},
                    "year_to": {"type": "integer"},
                    "document_types": {"type": "array", "items": {"type": "string"}},
                    "gold_set": {"type": "array", "items": {"type": "object"}},
                },
                ["query"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "estimate_search",
            "description": "Estimate source result volumes before spending a full retrieval budget.",
            "inputSchema": _schema(
                {
                    "query": {"type": "string"},
                    "domain": {"type": "string", "default": "general"},
                    "depth": {"type": "string", "enum": ["quick", "standard", "systematic"], "default": "standard"},
                    "sources": {"type": "array", "items": {"type": "string"}},
                    "research_question": {"type": "string"},
                    "languages": {"type": "array", "items": {"type": "string"}},
                    "year_from": {"type": "integer"},
                    "year_to": {"type": "integer"},
                },
                ["query"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "smoke_search",
            "description": "Fetch a four-record sample per source and validate source availability and the candidate contract.",
            "inputSchema": _schema(
                {
                    "query": {"type": "string"},
                    "domain": {"type": "string", "default": "general"},
                    "sources": {"type": "array", "items": {"type": "string"}},
                    "records_per_source": {"type": "integer", "minimum": 1, "maximum": 20, "default": 4},
                    "research_question": {"type": "string"},
                    "languages": {"type": "array", "items": {"type": "string"}},
                    "year_from": {"type": "integer"},
                    "year_to": {"type": "integer"},
                },
                ["query"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "calibrate_search",
            "description": "Run a bounded sample, deduplicate it, measure ambiguity and gold-set recall, and recommend proceed or revise.",
            "inputSchema": _schema(
                {
                    "query": {"type": "string"},
                    "domain": {"type": "string", "default": "general"},
                    "depth": {"type": "string", "enum": ["quick", "standard", "systematic"], "default": "standard"},
                    "sources": {"type": "array", "items": {"type": "string"}},
                    "sample_size": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 100},
                    "human_queue_threshold": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.15},
                    "research_question": {"type": "string"},
                    "languages": {"type": "array", "items": {"type": "string"}},
                    "year_from": {"type": "integer"},
                    "year_to": {"type": "integer"},
                    "gold_set": {"type": "array", "items": {"type": "object"}},
                },
                ["query"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "search_academic",
            "description": "Run an auditable multi-source academic search with domain routing, deduplication, quality evidence, and coverage artifacts.",
            "inputSchema": _schema(
                {
                    "query": {"type": "string"},
                    "research_question": {"type": "string"},
                    "domain": {"type": "string", "default": "general"},
                    "depth": {"type": "string", "enum": ["quick", "standard", "systematic"], "default": "standard"},
                    "quality": {"type": "string", "default": "high_quality_broad"},
                    "mode": {"type": "string", "enum": ["boost", "hard"], "default": "boost"},
                    "profile": {"type": "string", "enum": ["paper", "research_data"], "default": "paper"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 100},
                    "sources": {"type": "array", "items": {"type": "string"}},
                    "filters": {"type": "object"},
                    "concept_blocks": {"type": "array", "items": {"type": "object"}},
                    "inclusion_criteria": {"type": "array", "items": {"type": "string"}},
                    "exclusion_criteria": {"type": "array", "items": {"type": "string"}},
                    "languages": {"type": "array", "items": {"type": "string"}},
                    "year_from": {"type": "integer"},
                    "year_to": {"type": "integer"},
                    "document_types": {"type": "array", "items": {"type": "string"}},
                    "gold_set": {"type": "array", "items": {"type": "object"}},
                    "citation_rounds": {"type": "integer", "minimum": 0, "maximum": 5},
                    "execute_citation_chasing": {"type": "boolean", "default": False},
                    "citation_source": {"type": "string", "enum": ["semantic", "opencitations", "both"], "default": "semantic"},
                    "verify_candidate_identifiers": {"type": "boolean", "default": False},
                    "resolve_oa": {"type": "boolean", "default": False},
                    "find_preprints": {"type": "boolean", "default": False},
                    "code_links": {"type": "boolean", "default": False},
                    "sort": {"type": "string", "enum": ["relevance", "recency", "citations"], "default": "relevance"},
                },
                ["query"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "search_science",
            "description": "Backward-compatible ScanSci Find search entrypoint; prefer search_academic for new workflows.",
            "inputSchema": _schema(
                {
                    "query": {"type": "string"},
                    "quality": {"type": "string", "default": "high_quality_broad"},
                    "mode": {"type": "string", "enum": ["boost", "hard"], "default": "boost"},
                    "profile": {"type": "string", "enum": ["paper", "research_data"], "default": "paper"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 10},
                    "sources": {"type": "array", "items": {"type": "string"}},
                    "filters": {"type": "object"},
                },
                ["query"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "verify_identifiers",
            "description": "Verify candidate DOI, PMID, and arXiv identifiers against authoritative metadata services.",
            "inputSchema": _schema(
                {
                    "candidates": {"type": "array", "items": candidate_schema},
                    "limit": {"type": "integer", "minimum": 0},
                },
                ["candidates"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "resolve_open_access",
            "description": "Resolve DOI open-access locations and licenses through Unpaywall without replacing existing PDF links.",
            "inputSchema": _schema(
                {
                    "candidates": {"type": "array", "items": candidate_schema},
                    "limit": {"type": "integer", "minimum": 0},
                },
                ["candidates"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "find_preprints",
            "description": "Find lawful preprint copies (arXiv, bioRxiv, medRxiv, SSRN via Europe PMC) of paywalled papers by conservative title and author matching.",
            "inputSchema": _schema(
                {
                    "candidates": {"type": "array", "items": candidate_schema},
                    "limit": {"type": "integer", "minimum": 0},
                },
                ["candidates"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "enrich_code_links",
            "description": "Attach Papers with Code code-availability metadata (repository URL, stars, framework, official flag) to candidates.",
            "inputSchema": _schema(
                {
                    "candidates": {"type": "array", "items": candidate_schema},
                    "limit": {"type": "integer", "minimum": 0},
                },
                ["candidates"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "explore",
            "description": "Pass 1 of the two-pass flow: quick search returning a lightweight summary table (title, year, venue, citations, PDF hint, recency flag) before deep work.",
            "inputSchema": _schema(
                {
                    "query": {"type": "string"},
                    "domain": {"type": "string", "default": "general"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 30},
                    "sort": {"type": "string", "enum": ["relevance", "recency", "citations"], "default": "recency"},
                    "sources": {"type": "array", "items": {"type": "string"}},
                },
                ["query"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "deep_fetch",
            "description": "Pass 2 of the two-pass flow: run identifier verification, OA resolution, preprint matching, and code links on confirmed candidates, with optional BibTeX.",
            "inputSchema": _schema(
                {
                    "candidates": {"type": "array", "items": candidate_schema},
                    "verify": {"type": "boolean", "default": True},
                    "resolve_oa": {"type": "boolean", "default": True},
                    "find_preprints": {"type": "boolean", "default": True},
                    "code_links": {"type": "boolean", "default": True},
                    "bibtex": {"type": "boolean", "default": True},
                },
                ["candidates"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "screen_candidates",
            "description": "Screen already-collected candidates through Journal Scout quality policies.",
            "inputSchema": _schema(
                {
                    "candidates": {"type": "array", "items": candidate_schema},
                    "quality": {"type": "string", "default": "high_quality_broad"},
                    "mode": {"type": "string", "enum": ["boost", "hard"], "default": "boost"},
                    "filters": {"type": "object"},
                },
                ["candidates"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "explain_candidate",
            "description": "Explain the Journal Scout evidence for one candidate journal.",
            "inputSchema": _schema({"candidate": candidate_schema, "quality": {"type": "string"}, "filters": {"type": "object"}}, ["candidate"]),
            "outputSchema": _schema(),
        },
        {
            "name": "build_download_queue",
            "description": "Build a ScanSci PDF-ready download queue from screened candidates.",
            "inputSchema": _schema({"candidates": {"type": "array", "items": candidate_schema}}, ["candidates"]),
            "outputSchema": _schema(),
        },
        {
            "name": "expand_citations",
            "description": "Expand seed papers through backward and/or forward citation chasing with per-round novelty and saturation reporting.",
            "inputSchema": _schema(
                {
                    "candidates": {"type": "array", "items": candidate_schema},
                    "rounds": {"type": "integer", "minimum": 0, "maximum": 5, "default": 1},
                    "direction": {"type": "string", "enum": ["backward", "forward", "both"], "default": "both"},
                    "per_seed_limit": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 20},
                    "saturation_threshold": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.01},
                    "saturation_consecutive_rounds": {"type": "integer", "minimum": 1, "maximum": 5, "default": 2},
                    "source": {"type": "string", "enum": ["semantic", "opencitations", "both"], "default": "semantic"},
                },
                ["candidates"],
            ),
            "outputSchema": _schema(),
        },
        {
            "name": "browser_doctor",
            "description": "Report the shared browser runtime ScanSci Find can reuse before suggesting any install.",
            "inputSchema": _schema(),
            "outputSchema": _schema(),
        },
        {
            "name": "browser_handoff",
            "description": "Hand the EgoLite Scholar or CNKI page to the user for login or CAPTCHA, preserving the Task Space session.",
            "inputSchema": _schema(
                {"source": {"type": "string", "enum": ["google-scholar", "cnki"]}},
                ["source"],
            ),
            "outputSchema": _schema(),
        },
    ]


def _tool_result(payload: Dict[str, Any], is_error: bool = False) -> Dict[str, Any]:
    return {
        "isError": is_error,
        "structuredContent": payload,
        "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}],
    }


def handle_tool_call(name: str, arguments: Dict[str, Any], service: Any) -> Dict[str, Any]:
    try:
        if name == "health_check":
            payload = service.health_check()
        elif name == "list_sources":
            payload = service.list_sources()
        elif name == "plan_search":
            payload = service.plan_search(
                query=arguments.get("query", ""),
                research_question=arguments.get("research_question") or "",
                domain=arguments.get("domain") or "general",
                depth=arguments.get("depth") or "standard",
                sources=arguments.get("sources"),
                concept_blocks=arguments.get("concept_blocks"),
                inclusion_criteria=arguments.get("inclusion_criteria"),
                exclusion_criteria=arguments.get("exclusion_criteria"),
                languages=arguments.get("languages"),
                year_from=arguments.get("year_from"),
                year_to=arguments.get("year_to"),
                document_types=arguments.get("document_types"),
                gold_set=arguments.get("gold_set"),
            )
        elif name == "estimate_search":
            payload = service.estimate_search(
                query=arguments.get("query", ""),
                research_question=arguments.get("research_question") or "",
                domain=arguments.get("domain") or "general",
                depth=arguments.get("depth") or "standard",
                sources=arguments.get("sources"),
                languages=arguments.get("languages"),
                year_from=arguments.get("year_from"),
                year_to=arguments.get("year_to"),
            )
        elif name == "smoke_search":
            payload = service.smoke_search(
                query=arguments.get("query", ""),
                research_question=arguments.get("research_question") or "",
                domain=arguments.get("domain") or "general",
                sources=arguments.get("sources"),
                records_per_source=int(arguments.get("records_per_source") or 4),
                languages=arguments.get("languages"),
                year_from=arguments.get("year_from"),
                year_to=arguments.get("year_to"),
            )
        elif name == "calibrate_search":
            payload = service.calibrate_search(
                query=arguments.get("query", ""),
                research_question=arguments.get("research_question") or "",
                domain=arguments.get("domain") or "general",
                depth=arguments.get("depth") or "standard",
                sources=arguments.get("sources"),
                sample_size=int(arguments.get("sample_size") or 100),
                human_queue_threshold=float(
                    arguments.get("human_queue_threshold")
                    if arguments.get("human_queue_threshold") is not None
                    else 0.15
                ),
                languages=arguments.get("languages"),
                year_from=arguments.get("year_from"),
                year_to=arguments.get("year_to"),
                gold_set=arguments.get("gold_set"),
            )
        elif name == "search_academic":
            payload = service.search_academic(
                query=arguments.get("query", ""),
                research_question=arguments.get("research_question") or "",
                domain=arguments.get("domain") or "general",
                depth=arguments.get("depth") or "standard",
                quality=arguments.get("quality") or "high_quality_broad",
                mode=arguments.get("mode") or "boost",
                profile=arguments.get("profile") or "paper",
                limit=int(arguments.get("limit") or 100),
                sources=arguments.get("sources"),
                filters=arguments.get("filters"),
                concept_blocks=arguments.get("concept_blocks"),
                inclusion_criteria=arguments.get("inclusion_criteria"),
                exclusion_criteria=arguments.get("exclusion_criteria"),
                languages=arguments.get("languages"),
                year_from=arguments.get("year_from"),
                year_to=arguments.get("year_to"),
                document_types=arguments.get("document_types"),
                gold_set=arguments.get("gold_set"),
                citation_rounds=arguments.get("citation_rounds"),
                execute_citation_chasing=bool(arguments.get("execute_citation_chasing", False)),
                citation_source=arguments.get("citation_source") or "semantic",
                verify_candidate_identifiers=bool(arguments.get("verify_candidate_identifiers", False)),
                resolve_oa=bool(arguments.get("resolve_oa", False)),
                find_preprints=bool(arguments.get("find_preprints", False)),
                code_links=bool(arguments.get("code_links", False)),
                sort=arguments.get("sort") or "relevance",
            )
        elif name == "search_science":
            payload = service.search_science(
                query=arguments.get("query", ""),
                quality=arguments.get("quality") or "high_quality_broad",
                mode=arguments.get("mode") or "boost",
                limit=int(arguments.get("limit") or 10),
                sources=arguments.get("sources"),
                filters=arguments.get("filters"),
                profile=arguments.get("profile") or "paper",
            )
        elif name == "verify_identifiers":
            payload = service.verify_identifiers(
                arguments.get("candidates") or [],
                limit=arguments.get("limit"),
            )
        elif name == "resolve_open_access":
            payload = service.resolve_open_access(
                arguments.get("candidates") or [],
                limit=arguments.get("limit"),
            )
        elif name == "find_preprints":
            payload = service.find_preprints(
                arguments.get("candidates") or [],
                limit=arguments.get("limit"),
            )
        elif name == "enrich_code_links":
            payload = service.enrich_code_links(
                arguments.get("candidates") or [],
                limit=arguments.get("limit"),
            )
        elif name == "explore":
            payload = service.explore(
                query=arguments.get("query", ""),
                domain=arguments.get("domain") or "general",
                limit=int(arguments.get("limit") or 30),
                sort=arguments.get("sort") or "recency",
                sources=arguments.get("sources"),
            )
        elif name == "deep_fetch":
            payload = service.deep_fetch(
                arguments.get("candidates") or [],
                verify=bool(arguments.get("verify", True)),
                resolve_oa=bool(arguments.get("resolve_oa", True)),
                find_preprints=bool(arguments.get("find_preprints", True)),
                code_links=bool(arguments.get("code_links", True)),
                bibtex=bool(arguments.get("bibtex", True)),
            )
        elif name == "screen_candidates":
            payload = service.screen_candidates(
                candidates=arguments.get("candidates") or [],
                quality=arguments.get("quality") or "high_quality_broad",
                mode=arguments.get("mode") or "boost",
                filters=arguments.get("filters"),
            )
        elif name == "explain_candidate":
            payload = service.explain_candidate(
                candidate=arguments.get("candidate") or {},
                quality=arguments.get("quality") or "high_quality_broad",
                filters=arguments.get("filters"),
            )
        elif name == "build_download_queue":
            payload = service.build_download_queue(arguments.get("candidates") or [])
        elif name == "expand_citations":
            payload = service.expand_citations(
                arguments.get("candidates") or [],
                rounds=int(arguments.get("rounds") if arguments.get("rounds") is not None else 1),
                direction=arguments.get("direction") or "both",
                per_seed_limit=int(arguments.get("per_seed_limit") or 20),
                saturation_threshold=float(arguments.get("saturation_threshold") if arguments.get("saturation_threshold") is not None else 0.01),
                saturation_consecutive_rounds=int(
                    arguments.get("saturation_consecutive_rounds")
                    if arguments.get("saturation_consecutive_rounds") is not None
                    else 2
                ),
                source=arguments.get("source") or "semantic",
            )
        elif name == "browser_doctor":
            payload = service.browser_doctor()
        elif name == "browser_handoff":
            payload = service.browser_handoff(arguments.get("source") or "")
        else:
            return _tool_result({"error_code": "UNKNOWN_TOOL", "message": f"Unknown tool: {name}", "tool": name, "details": {}}, True)
        return _tool_result(payload)
    except Exception as exc:
        return _tool_result({"error_code": "TOOL_ERROR", "message": str(exc), "tool": name, "details": {}}, True)
