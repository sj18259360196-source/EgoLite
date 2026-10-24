from __future__ import annotations

import hashlib
import itertools
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from scansci_find.source_registry import DEPTH_PROFILES, DOMAIN_PROFILES, SUPPORT_SOURCE_ROUTES, route_sources
from scansci_find.vocab import expand_terms


PROTOCOL_VERSION = "1.0"


@dataclass
class ConceptBlock:
    name: str
    terms: List[str] = field(default_factory=list)
    required: bool = True


@dataclass
class SearchProtocol:
    protocol_id: str
    query: str
    research_question: str
    domain: str
    framework: str
    optional_frameworks: List[str]
    depth: str
    concept_blocks: List[ConceptBlock]
    boolean_query: str
    query_variants: List[str]
    inclusion_criteria: List[str]
    exclusion_criteria: List[str]
    languages: List[str]
    year_from: Optional[int]
    year_to: Optional[int]
    document_types: List[str]
    gold_set: List[Dict[str, str]]
    planned_sources: List[str]
    executable_sources: List[str]
    conditional_sources: List[str]
    unknown_sources: List[str]
    support_sources: Dict[str, List[str]]
    max_records_per_source: int
    citation_rounds: int
    saturation_threshold: float
    generated_at: str
    saturation_consecutive_rounds: int = 2
    version: str = PROTOCOL_VERSION

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _clean_strings(values: Optional[Iterable[Any]]) -> List[str]:
    return list(dict.fromkeys(str(value).strip() for value in (values or []) if str(value).strip()))


def _concept_blocks(query: str, blocks: Optional[Iterable[Dict[str, Any]]]) -> List[ConceptBlock]:
    if blocks:
        out = []
        for index, block in enumerate(blocks, 1):
            out.append(
                ConceptBlock(
                    name=str(block.get("name") or f"concept-{index}"),
                    terms=_clean_strings(block.get("terms")),
                    required=bool(block.get("required", True)),
                )
            )
        return out
    return [ConceptBlock(name="topic", terms=[query], required=True)]


def _protocol_id(payload: Dict[str, Any]) -> str:
    stable = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sp-" + hashlib.sha256(stable.encode("utf-8")).hexdigest()[:12]


def _compile_queries(query: str, blocks: List[ConceptBlock], domain: str = "general") -> tuple[str, List[str]]:
    parts = []
    term_sets = []
    for block in blocks:
        terms = expand_terms(_clean_strings(block.terms), domain=domain)
        if not terms:
            continue
        quoted = [f'"{term}"' if " " in term else term for term in terms]
        expression = " OR ".join(quoted)
        parts.append(f"({expression})" if len(quoted) > 1 else expression)
        term_sets.append(terms[:3])
    boolean_query = " AND ".join(parts) or query
    variants = [query]
    if len(term_sets) > 1:
        for combination in itertools.islice(itertools.product(*term_sets), 8):
            variants.append(" ".join(combination))
    variants.append(boolean_query)
    return boolean_query, list(dict.fromkeys(value for value in variants if value.strip()))


def build_protocol(
    query: str,
    *,
    research_question: str = "",
    domain: str = "general",
    depth: str = "standard",
    concept_blocks: Optional[Iterable[Dict[str, Any]]] = None,
    inclusion_criteria: Optional[Iterable[str]] = None,
    exclusion_criteria: Optional[Iterable[str]] = None,
    languages: Optional[Iterable[str]] = None,
    year_from: Optional[int] = None,
    year_to: Optional[int] = None,
    document_types: Optional[Iterable[str]] = None,
    gold_set: Optional[Iterable[Dict[str, str]]] = None,
    sources: Optional[Iterable[str]] = None,
    citation_rounds: Optional[int] = None,
    saturation_threshold: float = 0.01,
    saturation_consecutive_rounds: int = 2,
) -> SearchProtocol:
    query = str(query or "").strip()
    if not query:
        raise ValueError("query must not be empty")
    domain_key = str(domain or "general").casefold()
    depth_key = str(depth or "standard").casefold()
    if domain_key not in DOMAIN_PROFILES:
        raise ValueError(f"Unknown domain profile: {domain}")
    if depth_key not in DEPTH_PROFILES:
        raise ValueError(f"Unknown search depth: {depth}")
    if year_from and year_to and year_from > year_to:
        raise ValueError("year_from must be less than or equal to year_to")
    if not 0 <= float(saturation_threshold) <= 1:
        raise ValueError("saturation_threshold must be between 0 and 1")
    if int(saturation_consecutive_rounds) < 1:
        raise ValueError("saturation_consecutive_rounds must be at least 1")

    profile = DOMAIN_PROFILES[domain_key]
    depth_profile = DEPTH_PROFILES[depth_key]
    routed = route_sources(domain_key, depth_key, requested=sources)
    rounds = int(depth_profile["citation_rounds"] if citation_rounds is None else citation_rounds)
    if rounds < 0:
        raise ValueError("citation_rounds must be non-negative")

    blocks = _concept_blocks(query, concept_blocks)
    boolean_query, query_variants = _compile_queries(query, blocks, domain=domain_key)
    cleaned_inclusion = _clean_strings(inclusion_criteria)
    cleaned_exclusion = _clean_strings(exclusion_criteria)
    cleaned_languages = _clean_strings(languages)
    cleaned_document_types = _clean_strings(document_types)
    normalized_gold_set = [dict(item) for item in (gold_set or [])]
    stable_payload = {
        "query": query,
        "research_question": research_question,
        "domain": domain_key,
        "depth": depth_key,
        "sources": routed["planned"],
        "support_sources": SUPPORT_SOURCE_ROUTES,
        "years": [year_from, year_to],
        "languages": cleaned_languages,
        "concept_blocks": [asdict(block) for block in blocks],
        "inclusion_criteria": cleaned_inclusion,
        "exclusion_criteria": cleaned_exclusion,
        "document_types": cleaned_document_types,
        "gold_set": normalized_gold_set,
        "citation_rounds": rounds,
        "saturation_threshold": float(saturation_threshold),
        "saturation_consecutive_rounds": int(saturation_consecutive_rounds),
    }
    return SearchProtocol(
        protocol_id=_protocol_id(stable_payload),
        query=query,
        research_question=str(research_question or "").strip(),
        domain=domain_key,
        framework=str(profile.get("framework") or "concept-blocks"),
        optional_frameworks=list(profile.get("optional_frameworks") or []),
        depth=depth_key,
        concept_blocks=blocks,
        boolean_query=boolean_query,
        query_variants=query_variants,
        inclusion_criteria=cleaned_inclusion,
        exclusion_criteria=cleaned_exclusion,
        languages=cleaned_languages,
        year_from=year_from,
        year_to=year_to,
        document_types=cleaned_document_types,
        gold_set=normalized_gold_set,
        planned_sources=routed["planned"],
        executable_sources=routed["executable"],
        conditional_sources=routed["conditional"],
        unknown_sources=routed["unknown"],
        support_sources={key: list(value) for key, value in SUPPORT_SOURCE_ROUTES.items()},
        max_records_per_source=int(depth_profile["max_records_per_source"]),
        citation_rounds=rounds,
        saturation_threshold=float(saturation_threshold),
        saturation_consecutive_rounds=int(saturation_consecutive_rounds),
        generated_at=datetime.now(timezone.utc).isoformat(),
    )
