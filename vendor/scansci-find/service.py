from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from scansci_find import __version__
from scansci_find.adapters import (
    all_providers,
    chinese_providers,
    default_providers,
    estimate_sources_with_status,
    research_data_providers,
    search_query_variants_with_status,
)
from scansci_find.audit import build_human_queue, coverage_report, gold_set_report, prisma_counts
from scansci_find.browser_discovery import doctor as browser_discovery_doctor
from scansci_find.citation_graph import build_citation_provider, expand_citations as expand_citation_graph
from scansci_find.dedupe import dedupe_candidates, dedupe_with_clusters
from scansci_find.evidence import attach_evidence_dimensions
from scansci_find.journal_scout import OptionalJournalScoutGateway
from scansci_find.outputs import build_download_queue, enrich_download_metadata
from scansci_find.preprint import PreprintFinder, find_preprints as find_preprints_batch
from scansci_find.protocol import build_protocol
from scansci_find.pwc import PwcProvider, enrich_code_availability as enrich_code_batch
from scansci_find.quality import apply_quality
from scansci_find.source_registry import DEPTH_PROFILES, SUPPORT_SOURCE_ROUTES, list_domains, list_sources as registry_sources
from scansci_find.support_sources import UnpaywallProvider, resolve_open_access as resolve_oa_batch
from scansci_find.verification import IdentifierVerifier, verify_identifiers as verify_identifier_batch

DEFAULT_SOURCES = ["openalex", "crossref", "semantic", "arxiv"]
RESEARCH_DATA_SOURCES = ["kaggle", "zenodo", "datacite", "openml", "huggingface"]
CHINESE_SOURCES = ["baidu-scholar", "cnki"]

OPTIONAL_UPSTREAMS = [
    {
        "name": "anysearch",
        "type": "ai_agent_search_infrastructure",
        "enabled_by_default": False,
        "positioning": "Search everything for agents.",
        "borrowed_strengths": [
            "vertical_domain_routing",
            "batch_search",
            "url_content_extraction",
            "multi_runtime_cli",
        ],
        "limitations": [
            "external_api_dependency",
            "no_local_journal_quality_database",
            "not_science_specific",
        ],
    }
]

REQUIRED_CANDIDATE_FIELDS = {
    "title",
    "authors",
    "year",
    "doi",
    "arxiv_id",
    "identifiers",
    "source_hits",
    "source_records",
    "links",
    "artifact_type",
}


class ScanSciFindService:
    def __init__(
        self,
        journal_gateway: Optional[Any] = None,
        providers: Optional[Dict[str, Any]] = None,
        identifier_verifier: Optional[Any] = None,
        oa_resolver: Optional[Any] = None,
        preprint_finder: Optional[Any] = None,
        pwc_provider: Optional[Any] = None,
    ) -> None:
        self.journal_gateway = journal_gateway or OptionalJournalScoutGateway()
        self.providers = providers
        self.identifier_verifier = identifier_verifier
        self.oa_resolver = oa_resolver
        self.preprint_finder = preprint_finder
        self.pwc_provider = pwc_provider

    def health_check(self) -> Dict[str, Any]:
        journal = self.journal_gateway.health_check()
        return {
            "service": "scansci-find",
            "version": __version__,
            "layers": {"capability": "MCP", "cognitive": "Skill", "human_entry": "CLI", "distribution": "Plugin"},
            "journal_scout": journal,
            "sources": self.list_sources(),
        }

    def list_sources(self) -> Dict[str, Any]:
        return {
            "catalog": registry_sources(),
            "domains": list_domains(),
            "depth_profiles": DEPTH_PROFILES,
            "support_source_routes": SUPPORT_SOURCE_ROUTES,
            "sources": [
                {"name": name, "enabled": True, "role": "metadata" if name != "arxiv" else "preprint"}
                for name in default_providers()
            ],
            "research_data_sources": [
                {"name": name, "enabled": False, "role": "research_data"} for name in research_data_providers()
            ],
            "chinese_sources": [
                {
                    "name": name,
                    "enabled": False,
                    "role": "cn_discovery" if name in {"baidu-scholar", "baidu_scholar"} else "cn_database",
                }
                for name in chinese_providers()
                if name != "baidu_scholar"
            ],
            "optional_upstreams": OPTIONAL_UPSTREAMS,
        }

    def plan_search(
        self,
        query: str,
        domain: str = "general",
        depth: str = "standard",
        sources: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        protocol = build_protocol(query, domain=domain, depth=depth, sources=sources, **kwargs)
        return {"protocol": protocol.to_dict(), "source_catalog": registry_sources()}

    def estimate_search(
        self,
        query: str,
        *,
        domain: str = "general",
        depth: str = "standard",
        sources: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        protocol = build_protocol(query, domain=domain, depth=depth, sources=sources, **kwargs)
        estimates = estimate_sources_with_status(query, protocol.planned_sources, providers=self.providers)
        known_total = int(estimates["known_source_total"])
        if not estimates["known_source_count"]:
            size_band = "unknown"
        elif known_total < 200:
            size_band = "narrow"
        elif known_total <= 20_000:
            size_band = "workable"
        elif known_total <= 50_000:
            size_band = "broad"
        else:
            size_band = "revise_query"
        return {"protocol": protocol.to_dict(), **estimates, "size_band": size_band}

    def smoke_search(
        self,
        query: str,
        *,
        domain: str = "general",
        sources: Optional[List[str]] = None,
        records_per_source: int = 4,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        protocol = build_protocol(query, domain=domain, depth="quick", sources=sources, citation_rounds=0, **kwargs)
        result = search_query_variants_with_status(
            [query],
            protocol.planned_sources,
            max(1, min(int(records_per_source), 20)),
            providers=self.providers,
        )
        contract_errors = self._candidate_contract_errors(result["candidates"])
        status_map = {str(item.get("name")): item for item in result["source_status"]}
        failed_executable = [
            source
            for source in protocol.executable_sources
            if (status_map.get(source) or {}).get("status") != "ok"
        ]
        return {
            "protocol": protocol.to_dict(),
            "stage": "smoke",
            "records_per_source": max(1, min(int(records_per_source), 20)),
            "source_status": result["source_status"],
            "sample_candidates": result["candidates"],
            "candidate_contract_errors": contract_errors,
            "failed_executable_sources": failed_executable,
            "contract_ok": not failed_executable and not contract_errors,
        }

    def calibrate_search(
        self,
        query: str,
        *,
        domain: str = "general",
        depth: str = "standard",
        sources: Optional[List[str]] = None,
        sample_size: int = 100,
        human_queue_threshold: float = 0.15,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        if not 1 <= int(sample_size) <= 1000:
            raise ValueError("sample_size must be between 1 and 1000")
        if not 0 <= float(human_queue_threshold) <= 1:
            raise ValueError("human_queue_threshold must be between 0 and 1")
        protocol = build_protocol(query, domain=domain, depth=depth, sources=sources, citation_rounds=0, **kwargs)
        executable_count = max(1, len(protocol.executable_sources))
        per_source = min(protocol.max_records_per_source, max(1, math.ceil(int(sample_size) / executable_count)))
        result = search_query_variants_with_status(
            protocol.query_variants,
            protocol.planned_sources,
            per_source,
            providers=self.providers,
        )
        dedupe_result = dedupe_with_clusters(result["candidates"])
        candidates = dedupe_result["candidates"][: int(sample_size)]
        attach_evidence_dimensions(candidates)
        human_queue = build_human_queue(candidates)
        queue_rate = len(human_queue) / max(1, len(candidates))
        contract_errors = self._candidate_contract_errors(candidates)
        source_failures = [item for item in result["source_status"] if item.get("status") != "ok"]
        reasons = []
        if not candidates:
            reasons.append("no_candidates")
        if queue_rate > float(human_queue_threshold):
            reasons.append("human_queue_over_threshold")
        if contract_errors:
            reasons.append("candidate_contract_errors")
        if source_failures:
            reasons.append("source_failures_or_unavailable_sources")
        return {
            "protocol": protocol.to_dict(),
            "stage": "calibration",
            "sample_size_requested": int(sample_size),
            "sample_size_observed": len(candidates),
            "per_source_budget": per_source,
            "source_status": result["source_status"],
            "candidates": candidates,
            "dedupe_clusters": dedupe_result["clusters"],
            "human_queue": human_queue,
            "human_queue_rate": round(queue_rate, 6),
            "human_queue_threshold": float(human_queue_threshold),
            "candidate_contract_errors": contract_errors,
            "gold_set": gold_set_report(protocol.gold_set, candidates),
            "calibration_status": "proceed" if not reasons else "revise_protocol",
            "reasons": reasons,
        }

    def browser_doctor(self) -> Dict[str, Any]:
        return browser_discovery_doctor()

    def browser_handoff(self, source: str) -> Dict[str, Any]:
        from scansci_find.egolite import handoff

        return handoff(source)

    def search_science(
        self,
        query: str,
        quality: str = "high_quality_broad",
        mode: str = "boost",
        limit: int = 10,
        sources: Optional[List[str]] = None,
        filters: Optional[Dict[str, Any]] = None,
        profile: str = "paper",
    ) -> Dict[str, Any]:
        profile = (profile or "paper").casefold()
        domain = "research_data" if profile == "research_data" else "general"
        selected_sources = sources or (RESEARCH_DATA_SOURCES if profile == "research_data" else DEFAULT_SOURCES)
        return self.search_academic(
            query=query,
            domain=domain,
            depth="quick",
            quality=quality,
            mode=mode,
            limit=limit,
            sources=selected_sources,
            filters=filters,
            profile=profile,
        )

    def search_academic(
        self,
        query: str,
        *,
        domain: str = "general",
        depth: str = "standard",
        quality: str = "high_quality_broad",
        mode: str = "boost",
        limit: int = 100,
        sources: Optional[List[str]] = None,
        filters: Optional[Dict[str, Any]] = None,
        profile: str = "paper",
        research_question: str = "",
        concept_blocks: Optional[List[Dict[str, Any]]] = None,
        inclusion_criteria: Optional[List[str]] = None,
        exclusion_criteria: Optional[List[str]] = None,
        languages: Optional[List[str]] = None,
        year_from: Optional[int] = None,
        year_to: Optional[int] = None,
        document_types: Optional[List[str]] = None,
        gold_set: Optional[List[Dict[str, str]]] = None,
        citation_rounds: Optional[int] = None,
        execute_citation_chasing: bool = False,
        citation_source: str = "semantic",
        verify_candidate_identifiers: bool = False,
        resolve_oa: bool = False,
        find_preprints: bool = False,
        code_links: bool = False,
        sort: str = "relevance",
    ) -> Dict[str, Any]:
        protocol = build_protocol(
            query,
            research_question=research_question,
            domain=domain,
            depth=depth,
            concept_blocks=concept_blocks,
            inclusion_criteria=inclusion_criteria,
            exclusion_criteria=exclusion_criteria,
            languages=languages,
            year_from=year_from,
            year_to=year_to,
            document_types=document_types,
            gold_set=gold_set,
            sources=sources,
            citation_rounds=citation_rounds,
        )
        per_source_limit = max(1, min(int(limit), protocol.max_records_per_source))
        queries = [query] if protocol.depth == "quick" else protocol.query_variants
        search_result = search_query_variants_with_status(
            queries,
            protocol.planned_sources,
            per_source_limit,
            providers=self.providers,
        )
        raw = search_result["candidates"]
        dedupe_result = dedupe_with_clusters(raw)
        filtered, filter_report = self._apply_protocol_filters(dedupe_result["candidates"], protocol.to_dict())
        deduped = filtered[:limit]
        if profile == "research_data":
            screened = self._mark_research_data_candidates(deduped)
            enrich_download_metadata(screened, strategy="record_first")
            result = {
                "query": query,
                "quality": "research_object",
                "mode": "research_data",
                "profile": profile,
                "total": len(screened),
                "candidates": screened,
                "source_status": search_result["source_status"],
            }
        else:
            screened = apply_quality(deduped, self.journal_gateway, policy=quality, mode=mode, filters=filters, sort=sort)
            enrich_download_metadata(screened)
            result = {
                "query": query,
                "quality": quality,
                "mode": mode,
                "profile": profile,
                "total": len(screened),
                "candidates": screened,
                "source_status": search_result["source_status"],
            }

        attach_evidence_dimensions(screened)
        citation_result: Dict[str, Any] = {"rounds": [], "failures": [], "saturated": False}
        if execute_citation_chasing and profile == "paper" and protocol.citation_rounds > 0 and screened:
            seed_ids = {item.get("canonical_id") for item in screened}
            citation_result = expand_citation_graph(
                screened,
                rounds=protocol.citation_rounds,
                direction="both",
                per_seed_limit=min(100, max(10, per_source_limit)),
                saturation_threshold=protocol.saturation_threshold,
                saturation_consecutive_rounds=protocol.saturation_consecutive_rounds,
                provider=build_citation_provider(citation_source),
            )
            additions = [item for item in citation_result["candidates"] if item.get("canonical_id") not in seed_ids]
            if additions:
                screened_additions = apply_quality(additions, self.journal_gateway, policy=quality, mode=mode, filters=filters, sort=sort)
                enrich_download_metadata(screened_additions)
                attach_evidence_dimensions(screened_additions)
                screened = dedupe_candidates(screened + screened_additions)[:limit]
                result["candidates"] = screened
                result["total"] = len(screened)

        verification_result: Dict[str, Any] = {"checked": 0, "unchecked": len(screened), "status_counts": {}, "all_verified": False}
        if verify_candidate_identifiers and screened:
            verification_result = verify_identifier_batch(screened, verifier=self.identifier_verifier or IdentifierVerifier())
            screened = verification_result.pop("candidates")
            result["candidates"] = screened

        oa_result: Dict[str, Any] = {"checked": 0, "unchecked": len(screened), "status_counts": {}, "oa_found": 0}
        if resolve_oa and profile == "paper" and screened:
            oa_result = resolve_oa_batch(screened, provider=self.oa_resolver or UnpaywallProvider())
            screened = oa_result.pop("candidates")
            result["candidates"] = screened

        preprint_result: Dict[str, Any] = {"checked": 0, "unchecked": len(screened), "matched": 0, "status_counts": {}}
        if find_preprints and profile == "paper" and screened:
            preprint_result = find_preprints_batch(screened, finder=self.preprint_finder or PreprintFinder())
            screened = preprint_result.pop("candidates")
            result["candidates"] = screened
            # Rebuild download entries so the queue carries preprint identifiers.
            enrich_download_metadata(screened)

        code_result: Dict[str, Any] = {"checked": 0, "unchecked": len(screened), "matched": 0, "status_counts": {}}
        if code_links and profile == "paper" and screened:
            code_result = enrich_code_batch(screened, provider=self.pwc_provider or PwcProvider())
            screened = code_result.pop("candidates")
            result["candidates"] = screened
        attach_evidence_dimensions(screened)

        human_queue = build_human_queue(screened)
        protocol_payload = protocol.to_dict()
        citation_raw_count = sum(int(item.get("records_fetched") or 0) for item in citation_result.get("rounds") or [])
        citation_unique_count = sum(int(item.get("new_unique_records") or 0) for item in citation_result.get("rounds") or [])
        audited_raw_count = len(raw) + citation_raw_count
        audited_deduplicated_count = len(dedupe_result["candidates"]) + citation_unique_count
        audit = coverage_report(
            protocol=protocol_payload,
            source_status=search_result["source_status"],
            raw_count=audited_raw_count,
            deduplicated_count=audited_deduplicated_count,
            candidates=screened,
            citation_rounds=citation_result.get("rounds") or [],
            citation_saturated=bool(citation_result.get("saturated")),
            pagination_complete=bool(search_result["source_status"]) and all(
                item.get("status") == "ok" and item.get("pagination_complete") is True
                for item in search_result["source_status"]
            ),
        )
        prisma = prisma_counts(
            raw_count=audited_raw_count,
            deduplicated_count=audited_deduplicated_count,
            candidates=screened,
            human_queue_count=len(human_queue),
        )
        result.update(
            {
                "protocol": protocol_payload,
                "audit": audit,
                "prisma": prisma,
                "human_queue": human_queue,
                "dedupe_clusters": dedupe_result["clusters"],
                "filter_report": filter_report,
                "query_variants": search_result.get("query_variants") or [query],
                "citation_report": citation_result,
                "verification_report": verification_result,
                "oa_report": oa_result,
                "preprint_report": preprint_result,
                "code_report": code_result,
                "raw_total": audited_raw_count,
                "deduplicated_total": audited_deduplicated_count,
            }
        )
        return result

    def screen_candidates(
        self,
        candidates: List[Dict[str, Any]],
        quality: str = "high_quality_broad",
        mode: str = "boost",
        filters: Optional[Dict[str, Any]] = None,
        sort: str = "relevance",
    ) -> Dict[str, Any]:
        screened = apply_quality(dedupe_candidates(candidates), self.journal_gateway, policy=quality, mode=mode, filters=filters, sort=sort)
        enrich_download_metadata(screened)
        return {"quality": quality, "mode": mode, "total": len(screened), "candidates": screened}

    def explain_candidate(
        self,
        candidate: Dict[str, Any],
        quality: str = "high_quality_broad",
        filters: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self.journal_gateway.explain_journal(candidate, policy=quality, filters=filters)

    def build_download_queue(self, candidates: List[Dict[str, Any]]) -> Dict[str, Any]:
        queue = build_download_queue(candidates)
        return {"total": len(queue), "download_queue": queue}

    def expand_citations(
        self,
        candidates: List[Dict[str, Any]],
        rounds: int = 1,
        direction: str = "both",
        per_seed_limit: int = 20,
        saturation_threshold: float = 0.01,
        saturation_consecutive_rounds: int = 2,
        source: str = "semantic",
    ) -> Dict[str, Any]:
        return expand_citation_graph(
            candidates,
            rounds=rounds,
            direction=direction,
            per_seed_limit=per_seed_limit,
            saturation_threshold=saturation_threshold,
            saturation_consecutive_rounds=saturation_consecutive_rounds,
            provider=build_citation_provider(source),
        )

    def verify_identifiers(self, candidates: List[Dict[str, Any]], limit: Optional[int] = None) -> Dict[str, Any]:
        result = verify_identifier_batch(
            candidates,
            verifier=self.identifier_verifier or IdentifierVerifier(),
            limit=limit,
        )
        attach_evidence_dimensions(result["candidates"])
        return result

    def resolve_open_access(self, candidates: List[Dict[str, Any]], limit: Optional[int] = None) -> Dict[str, Any]:
        result = resolve_oa_batch(
            candidates,
            provider=self.oa_resolver or UnpaywallProvider(),
            limit=limit,
        )
        attach_evidence_dimensions(result["candidates"])
        return result

    def find_preprints(self, candidates: List[Dict[str, Any]], limit: Optional[int] = None) -> Dict[str, Any]:
        result = find_preprints_batch(
            candidates,
            finder=self.preprint_finder or PreprintFinder(),
            limit=limit,
        )
        enrich_download_metadata(result["candidates"])
        attach_evidence_dimensions(result["candidates"])
        return result

    def enrich_code_links(self, candidates: List[Dict[str, Any]], limit: Optional[int] = None) -> Dict[str, Any]:
        result = enrich_code_batch(
            candidates,
            provider=self.pwc_provider or PwcProvider(),
            limit=limit,
        )
        attach_evidence_dimensions(result["candidates"])
        return result

    def explore(
        self,
        query: str,
        *,
        domain: str = "general",
        limit: int = 30,
        sort: str = "recency",
        sources: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Pass 1: quick search producing a lightweight summary table."""
        from scansci_find.two_pass import render_summary_markdown, summarize_candidates

        result = self.search_academic(
            query,
            domain=domain,
            depth="quick",
            sort=sort,
            limit=limit,
            sources=sources,
        )
        summary = summarize_candidates(result["candidates"])
        summary["markdown"] = render_summary_markdown(summary)
        return {
            "summary": summary,
            "candidates": result["candidates"],
            "source_status": result.get("source_status") or [],
        }

    def deep_fetch(
        self,
        candidates: List[Dict[str, Any]],
        *,
        verify: bool = True,
        resolve_oa: bool = True,
        find_preprints: bool = True,
        code_links: bool = True,
        bibtex: bool = True,
    ) -> Dict[str, Any]:
        """Pass 2: run the full enrichment chain on the confirmed subset."""
        from scansci_find.outputs import render_refs_bib

        rows = [dict(candidate) for candidate in candidates]
        reports: Dict[str, Any] = {}
        if verify and rows:
            reports["verification"] = self.verify_identifiers(rows)
            rows = reports["verification"].pop("candidates")
        if resolve_oa and rows:
            reports["oa"] = self.resolve_open_access(rows)
            rows = reports["oa"].pop("candidates")
        if find_preprints and rows:
            reports["preprints"] = self.find_preprints(rows)
            rows = reports["preprints"].pop("candidates")
        if code_links and rows:
            reports["code"] = self.enrich_code_links(rows)
            rows = reports["code"].pop("candidates")
        payload: Dict[str, Any] = {"candidates": rows, "reports": reports}
        if bibtex:
            payload["bibtex"] = render_refs_bib(rows)
        return payload

    def _mark_research_data_candidates(self, candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        out = []
        for candidate in candidates:
            row = dict(candidate)
            evidence = []
            if row.get("doi"):
                evidence.append("persistent DOI")
            if (row.get("links") or {}).get("dataset") or (row.get("links") or {}).get("paper"):
                evidence.append("record URL")
            evidence.extend(row.get("data_evidence") or [])
            row["quality"] = {
                "scope": "research_object_metadata_not_dataset_validity",
                "mode": "research_data",
                "policy": "research_object",
                "passed": bool(row.get("title")),
                "matched_journal": "",
                "evidence": evidence,
                "journal": {},
                "jif_latest": {"value": None, "year": "", "source": "", "raw_fields": {}},
                "jif_history": [],
                "data_sha256": "",
                "journal_scout_version": "",
                "artifact_type": row.get("artifact_type") or "record",
            }
            out.append(row)
        return out

    def _candidate_contract_errors(self, candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        errors = []
        for index, candidate in enumerate(candidates):
            missing = sorted(REQUIRED_CANDIDATE_FIELDS - set(candidate))
            if missing:
                errors.append({"index": index, "title": candidate.get("title") or "", "missing_fields": missing})
        return errors

    def _apply_protocol_filters(
        self,
        candidates: List[Dict[str, Any]],
        protocol: Dict[str, Any],
    ) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
        kept: List[Dict[str, Any]] = []
        excluded: List[Dict[str, Any]] = []
        languages = {str(item).casefold() for item in protocol.get("languages") or []}
        document_types = {str(item).casefold() for item in protocol.get("document_types") or []}
        year_from = protocol.get("year_from")
        year_to = protocol.get("year_to")
        for candidate in candidates:
            reasons = []
            year = candidate.get("year")
            if year is not None and year_from is not None and int(year) < int(year_from):
                reasons.append("before_year_from")
            if year is not None and year_to is not None and int(year) > int(year_to):
                reasons.append("after_year_to")
            language = str(candidate.get("language") or "").casefold()
            if languages and language and language not in languages:
                reasons.append("language_mismatch")
            document_type = str(candidate.get("article_type") or "").casefold()
            if document_types and document_type and document_type not in document_types:
                reasons.append("document_type_mismatch")
            if reasons:
                excluded.append({"canonical_id": candidate.get("canonical_id") or "", "title": candidate.get("title") or "", "reasons": reasons})
            else:
                kept.append(candidate)
        return kept, {"kept": len(kept), "excluded": len(excluded), "excluded_records": excluded}
