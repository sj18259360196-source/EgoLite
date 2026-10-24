from __future__ import annotations

import os
import re
import time
import urllib.parse
from typing import Any, Dict, Iterable, List, Optional

from scansci_find.adapters import HttpProvider, _candidate, normalize_doi, normalize_semantic_paper
from scansci_find.dedupe import dedupe_with_clusters


class SemanticScholarCitationProvider(HttpProvider):
    name = "semantic"

    def __init__(self, api_key: Optional[str] = None) -> None:
        super().__init__()
        self.api_key = api_key or os.environ.get("SEMANTIC_SCHOLAR_API_KEY") or ""

    def expand(self, candidate: Dict[str, Any], direction: str, limit: int) -> List[Dict[str, Any]]:
        paper_id = self._paper_id(candidate)
        if not paper_id:
            return []
        direction = str(direction or "both").casefold()
        endpoints = []
        if direction in {"backward", "both"}:
            endpoints.append(("references", "citedPaper"))
        if direction in {"forward", "both"}:
            endpoints.append(("citations", "citingPaper"))
        out = []
        for endpoint, row_key in endpoints:
            fields = "title,year,authors,externalIds,journal,openAccessPdf,url,citationCount,abstract"
            url = (
                f"https://api.semanticscholar.org/graph/v1/paper/{urllib.parse.quote(paper_id, safe=':')}/{endpoint}?"
                + urllib.parse.urlencode({"limit": min(max(1, limit), 1000), "fields": fields})
            )
            headers = {"x-api-key": self.api_key} if self.api_key else None
            for row in self._json(url, headers=headers).get("data") or []:
                paper = row.get(row_key) or {}
                if paper.get("title"):
                    normalized = normalize_semantic_paper(paper)
                    normalized["discovery"] = {
                        "method": "citation_chasing",
                        "direction": direction if direction != "both" else endpoint,
                        "seed": candidate.get("canonical_id") or paper_id,
                    }
                    out.append(normalized)
        return out

    def _paper_id(self, candidate: Dict[str, Any]) -> str:
        if candidate.get("doi"):
            return "DOI:" + str(candidate["doi"])
        if candidate.get("arxiv_id"):
            return "ARXIV:" + str(candidate["arxiv_id"])
        if candidate.get("pmid"):
            return "PMID:" + str(candidate["pmid"])
        return ""


def _pid_tokens(value: Any) -> List[tuple[str, str]]:
    tokens = []
    for kind, raw in re.findall(r"\b(doi|pmid|pmcid):([^\s;]+)", str(value or ""), flags=re.I):
        normalized = normalize_doi(raw) if kind.casefold() == "doi" else str(raw).strip()
        if normalized:
            tokens.append((kind.casefold(), normalized))
    return tokens


def _mapping_rows(payload: Any) -> Iterable[Dict[str, Any]]:
    if isinstance(payload, dict):
        yield payload
        return
    for item in payload or []:
        if isinstance(item, dict):
            yield item
        elif isinstance(item, list):
            yield from _mapping_rows(item)


def _opencitations_candidate(record: Dict[str, Any]) -> Dict[str, Any]:
    identifiers = _pid_tokens(record.get("id"))
    doi = next((value for kind, value in identifiers if kind == "doi"), "")
    pmid = next((value for kind, value in identifiers if kind == "pmid"), "")
    pmcid = next((value for kind, value in identifiers if kind == "pmcid"), "")
    authors = []
    for value in str(record.get("author") or "").split(";"):
        name = re.sub(r"\s*\[[^]]*]\s*$", "", value).strip()
        if name:
            authors.append(name)
    venue = re.sub(r"\s*\[[^]]*]\s*$", "", str(record.get("venue") or "")).strip()
    date = str(record.get("pub_date") or "")
    return _candidate(
        title=str(record.get("title") or ""),
        authors=authors,
        year=int(date[:4]) if date[:4].isdigit() else None,
        doi=doi,
        pmid=pmid,
        pmcid=pmcid,
        journal=venue,
        article_type=str(record.get("type") or "journal"),
        source_platform="opencitations-meta",
        source_record_id=str(record.get("id") or ""),
        source_url=f"https://doi.org/{doi}" if doi else "",
        source="OpenCitations",
        links={"paper": f"https://doi.org/{doi}" if doi else ""},
    )


class OpenCitationsCitationProvider(HttpProvider):
    name = "opencitations"

    def __init__(self, access_token: str = "") -> None:
        super().__init__()
        self.access_token = access_token or os.environ.get("OPENCITATIONS_ACCESS_TOKEN") or ""
        self._last_request_at = 0.0
        self._failures: List[Dict[str, Any]] = []

    def _json(self, url: str, *, headers: Optional[Dict[str, str]] = None) -> Any:
        minimum_interval = max(0.0, float(os.environ.get("OPENCITATIONS_MIN_INTERVAL_SECONDS") or 0.34))
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < minimum_interval:
            time.sleep(minimum_interval - elapsed)
        payload = super()._json(url, headers=headers)
        self._last_request_at = time.monotonic()
        return payload

    def expand(self, candidate: Dict[str, Any], direction: str, limit: int) -> List[Dict[str, Any]]:
        seed_id = self._seed_id(candidate)
        if not seed_id:
            return []
        direction = str(direction or "both").casefold()
        endpoints = []
        if direction in {"backward", "both"}:
            endpoints.append(("references", "cited", "backward"))
        if direction in {"forward", "both"}:
            endpoints.append(("citations", "citing", "forward"))
        headers = {"authorization": self.access_token} if self.access_token else None
        relations = []
        per_direction = max(1, int(limit))
        for endpoint, target_field, direction_name in endpoints:
            url = "https://api.opencitations.net/index/v2/" + endpoint + "/" + urllib.parse.quote(seed_id, safe=":/")
            payload = self._json(url, headers=headers)
            for relation in list(_mapping_rows(payload))[:per_direction]:
                target = self._preferred_pid(relation.get(target_field))
                if target:
                    relations.append((target, direction_name, relation))
        try:
            metadata = self._metadata([target for target, _, _ in relations], headers=headers)
        except Exception as exc:
            metadata = {}
            self._failures.append(
                {
                    "provider": "opencitations-meta",
                    "error_type": type(exc).__name__,
                    "message": str(exc),
                }
            )
        out = []
        for target, direction_name, relation in relations:
            normalized = dict(metadata.get(target) or self._minimal_candidate(target))
            normalized["discovery"] = {
                "method": "citation_chasing",
                "direction": direction_name,
                "seed": candidate.get("canonical_id") or seed_id,
                "source": "OpenCitations",
            }
            normalized["citation_relation"] = {
                "oci": relation.get("oci") or "",
                "creation": relation.get("creation") or "",
                "timespan": relation.get("timespan") or "",
                "journal_self_citation": relation.get("journal_sc") or "",
                "author_self_citation": relation.get("author_sc") or "",
            }
            out.append(normalized)
        return out

    def drain_failures(self) -> List[Dict[str, Any]]:
        failures = list(self._failures)
        self._failures.clear()
        return failures

    def _seed_id(self, candidate: Dict[str, Any]) -> str:
        doi = normalize_doi(candidate.get("doi"))
        if doi:
            return "doi:" + doi
        pmid = str(candidate.get("pmid") or "").strip()
        return "pmid:" + pmid if pmid else ""

    def _preferred_pid(self, value: Any) -> str:
        tokens = _pid_tokens(value)
        for preferred in ("doi", "pmid", "pmcid"):
            found = next((item for item in tokens if item[0] == preferred), None)
            if found:
                return f"{found[0]}:{found[1]}"
        return ""

    def _metadata(self, identifiers: Iterable[str], *, headers: Optional[Dict[str, str]]) -> Dict[str, Dict[str, Any]]:
        unique = list(dict.fromkeys(identifier for identifier in identifiers if identifier))
        by_identifier: Dict[str, Dict[str, Any]] = {}
        for start in range(0, len(unique), 20):
            chunk = unique[start : start + 20]
            joined = "__".join(chunk)
            url = "https://api.opencitations.net/meta/v1/metadata/" + urllib.parse.quote(joined, safe=":/_")
            for record in _mapping_rows(self._json(url, headers=headers)):
                candidate = _opencitations_candidate(record)
                for kind, value in _pid_tokens(record.get("id")):
                    by_identifier[f"{kind}:{value}"] = candidate
        return by_identifier

    def _minimal_candidate(self, identifier: str) -> Dict[str, Any]:
        kind, value = identifier.split(":", 1)
        return _candidate(
            title="",
            doi=value if kind == "doi" else "",
            pmid=value if kind == "pmid" else "",
            pmcid=value if kind == "pmcid" else "",
            source_platform="opencitations-index",
            source_record_id=identifier,
            source_url=f"https://doi.org/{value}" if kind == "doi" else "",
            source="OpenCitations",
        )


class CompositeCitationProvider:
    name = "both"

    def __init__(self, providers: Iterable[Any]) -> None:
        self.providers = list(providers)
        self._failures: List[Dict[str, Any]] = []

    def expand(self, candidate: Dict[str, Any], direction: str, limit: int) -> List[Dict[str, Any]]:
        out = []
        for provider in self.providers:
            try:
                out.extend(provider.expand(candidate, direction, limit))
            except Exception as exc:
                self._failures.append(
                    {
                        "provider": getattr(provider, "name", type(provider).__name__),
                        "error_type": type(exc).__name__,
                        "message": str(exc),
                    }
                )
        return out

    def drain_failures(self) -> List[Dict[str, Any]]:
        failures = list(self._failures)
        self._failures.clear()
        return failures


def build_citation_provider(source: str = "semantic") -> Any:
    source = str(source or "semantic").casefold()
    if source == "semantic":
        return SemanticScholarCitationProvider()
    if source == "opencitations":
        return OpenCitationsCitationProvider()
    if source == "both":
        return CompositeCitationProvider([SemanticScholarCitationProvider(), OpenCitationsCitationProvider()])
    raise ValueError("citation source must be semantic, opencitations, or both")


def expand_citations(
    seeds: Iterable[Dict[str, Any]],
    *,
    rounds: int = 1,
    direction: str = "both",
    per_seed_limit: int = 20,
    saturation_threshold: float = 0.01,
    saturation_consecutive_rounds: int = 2,
    provider: Optional[Any] = None,
) -> Dict[str, Any]:
    if rounds < 0 or rounds > 5:
        raise ValueError("rounds must be between 0 and 5")
    if direction not in {"backward", "forward", "both"}:
        raise ValueError("direction must be backward, forward, or both")
    if not 0 <= saturation_threshold <= 1:
        raise ValueError("saturation_threshold must be between 0 and 1")
    if saturation_consecutive_rounds < 1:
        raise ValueError("saturation_consecutive_rounds must be at least 1")

    provider = provider or SemanticScholarCitationProvider()
    initial = dedupe_with_clusters(seeds)
    accumulated = list(initial["candidates"])
    frontier = list(accumulated)
    round_reports = []
    failures = []
    below_threshold_streak = 0
    for round_number in range(1, rounds + 1):
        fetched = []
        attempted = 0
        for seed in frontier:
            attempted += 1
            try:
                fetched.extend(provider.expand(seed, direction, per_seed_limit))
                for provider_failure in getattr(provider, "drain_failures", lambda: [])():
                    failures.append(
                        {
                            "round": round_number,
                            "seed": seed.get("canonical_id") or seed.get("doi") or seed.get("title") or "",
                            **provider_failure,
                        }
                    )
            except Exception as exc:
                failures.append(
                    {
                        "round": round_number,
                        "seed": seed.get("canonical_id") or seed.get("doi") or seed.get("title") or "",
                        "provider": getattr(provider, "name", type(provider).__name__),
                        "error_type": type(exc).__name__,
                        "message": str(exc),
                    }
                )
        before_ids = {item.get("canonical_id") for item in dedupe_with_clusters(accumulated)["candidates"]}
        merged = dedupe_with_clusters(accumulated + fetched)
        new_rows = [item for item in merged["candidates"] if item.get("canonical_id") not in before_ids]
        novelty = len(new_rows) / max(1, len(fetched))
        round_reports.append(
            {
                "round": round_number,
                "seeds_attempted": attempted,
                "records_fetched": len(fetched),
                "new_unique_records": len(new_rows),
                "novelty_ratio": round(novelty, 6),
            }
        )
        accumulated = merged["candidates"]
        frontier = new_rows
        # Saturation requires consecutive below-threshold rounds, so a single
        # quiet round cannot prematurely end the closure.
        below_threshold_streak = below_threshold_streak + 1 if novelty <= saturation_threshold else 0
        if not frontier or below_threshold_streak >= saturation_consecutive_rounds:
            break
    final = dedupe_with_clusters(accumulated)
    return {
        "candidates": final["candidates"],
        "dedupe_clusters": final["clusters"],
        "rounds": round_reports,
        "failures": failures,
        "citation_source": getattr(provider, "name", type(provider).__name__),
        "saturated": bool(
            round_reports
            and (not frontier or below_threshold_streak >= saturation_consecutive_rounds)
        ),
    }
