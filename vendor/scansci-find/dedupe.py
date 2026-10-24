from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Any, Dict, Iterable, List

from scansci_find.adapters import normalize_arxiv_id, normalize_doi


_DECISION_DOI_RE = re.compile(r"^(10\.\d{4,9}/[^/]+)/v\d+/decision\d+", re.IGNORECASE)


def normalize_article_doi(value: Any) -> str:
    """Strip peer-review decision-letter DOI variants down to the parent article DOI.

    Wiley registers decision letters as ``10.1111/.../vN/decisionM``. Deduplicating
    on the full DOI would keep four review-letter records for one article, so the
    variant suffix is removed before keying.
    """
    doi = normalize_doi(value)
    match = _DECISION_DOI_RE.match(doi)
    return match.group(1) if match else doi


def normalize_title(title: Any) -> str:
    text = unicodedata.normalize("NFKC", str(title or "")).casefold()
    return "".join(ch for ch in text if ch.isalnum())


def normalize_person(value: Any) -> str:
    return normalize_title(value)


def dedupe_key(candidate: Dict[str, Any]) -> str:
    doi = normalize_article_doi(candidate.get("doi"))
    if doi:
        return f"doi:{doi}"
    arxiv_id = normalize_arxiv_id(candidate.get("arxiv_id"))
    if arxiv_id:
        return f"arxiv:{arxiv_id}"
    for field in ("pmid", "pmcid", "dblp_id"):
        value = str(candidate.get(field) or "").strip().casefold()
        if value:
            return f"{field}:{value}"
    title = normalize_title(candidate.get("title"))
    authors = candidate.get("authors") or []
    first_author = normalize_person(authors[0]) if authors else ""
    year = str(candidate.get("year") or "").strip()
    journal = normalize_title(candidate.get("journal"))
    if title and first_author and year:
        return f"title-author-year:{title}:{first_author}:{year}"
    if title and journal and year:
        return f"title-journal-year:{title}:{journal}:{year}"
    platform = str(candidate.get("source_platform") or "").strip().casefold()
    record_id = str(candidate.get("source_record_id") or "").strip().casefold()
    if platform and record_id:
        return f"source:{platform}:{record_id}"
    return f"title:{title or str(candidate)}"


def merge_candidate(base: Dict[str, Any], incoming: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(base)
    for key in (
        "title",
        "title_zh",
        "title_en",
        "journal",
        "article_type",
        "source_platform",
        "source_record_id",
        "source_url",
        "abstract",
        "issn",
        "eissn",
        "doi",
        "arxiv_id",
        "pmid",
        "pmcid",
        "dblp_id",
        "language",
    ):
        if not merged.get(key) and incoming.get(key):
            merged[key] = incoming[key]
    if not merged.get("keywords") and incoming.get("keywords"):
        merged["keywords"] = list(incoming.get("keywords") or [])
    merged["retrieval_queries"] = list(
        dict.fromkeys((merged.get("retrieval_queries") or []) + (incoming.get("retrieval_queries") or []))
    )
    if not merged.get("access") and incoming.get("access"):
        merged["access"] = dict(incoming.get("access") or {})
    if len(incoming.get("authors") or []) > len(merged.get("authors") or []):
        merged["authors"] = list(incoming.get("authors") or [])
    if not merged.get("year") and incoming.get("year"):
        merged["year"] = incoming["year"]
    if not merged.get("published_date") and incoming.get("published_date"):
        merged["published_date"] = incoming["published_date"]
    merged["citation_count"] = max(int(merged.get("citation_count") or 0), int(incoming.get("citation_count") or 0))
    merged["doi"] = normalize_article_doi(merged.get("doi"))
    merged["arxiv_id"] = normalize_arxiv_id(merged.get("arxiv_id"))
    identifiers = dict(merged.get("identifiers") or {})
    identifiers.update({key: value for key, value in (incoming.get("identifiers") or {}).items() if value and not identifiers.get(key)})
    for key, field in (("doi", "doi"), ("arxiv", "arxiv_id"), ("pmid", "pmid"), ("pmcid", "pmcid"), ("dblp", "dblp_id")):
        if merged.get(field):
            identifiers.setdefault(key, str(merged[field]))
    if identifiers.get("doi"):
        identifiers["doi"] = normalize_article_doi(identifiers["doi"])
    merged["identifiers"] = identifiers
    merged["source_hits"] = sorted(set((merged.get("source_hits") or []) + (incoming.get("source_hits") or [])))
    merged["relevance_score"] = max(float(merged.get("relevance_score") or 0.0), float(incoming.get("relevance_score") or 0.0))
    links = dict(merged.get("links") or {})
    links.update({k: v for k, v in (incoming.get("links") or {}).items() if v and not links.get(k)})
    merged["links"] = links
    source_records = []
    seen_records = set()
    for record in (merged.get("source_records") or []) + (incoming.get("source_records") or []):
        marker = (record.get("source"), record.get("source_record_id"), record.get("source_url"))
        if marker not in seen_records:
            source_records.append(dict(record))
            seen_records.add(marker)
    if source_records:
        merged["source_records"] = source_records
    return merged


def _canonical_id(key: str) -> str:
    if key.startswith(("doi:", "arxiv:", "pmid:", "pmcid:", "dblp_id:")):
        return key
    return "paper:" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def dedupe_with_clusters(candidates: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    keyed: Dict[str, Dict[str, Any]] = {}
    members: Dict[str, List[Dict[str, Any]]] = {}
    order: List[str] = []
    for raw in candidates:
        candidate = dict(raw)
        candidate["doi"] = normalize_article_doi(candidate.get("doi"))
        candidate["arxiv_id"] = normalize_arxiv_id(candidate.get("arxiv_id"))
        key = dedupe_key(candidate)
        if key in keyed:
            keyed[key] = merge_candidate(keyed[key], candidate)
            members[key].append(candidate)
        else:
            keyed[key] = candidate
            members[key] = [candidate]
            order.append(key)
    for key in order:
        keyed[key]["canonical_id"] = _canonical_id(key)
    rows = sorted(
        (keyed[key] for key in order),
        key=lambda item: (-len(item.get("source_hits") or []), -float(item.get("relevance_score") or 0.0), str(item.get("title") or "")),
    )
    clusters = [
        {
            "canonical_id": keyed[key]["canonical_id"],
            "dedupe_key": key,
            "member_count": len(members[key]),
            "sources": sorted(set(source for item in members[key] for source in (item.get("source_hits") or []))),
            "member_identifiers": [
                {
                    "doi": normalize_doi(item.get("doi")),
                    "arxiv_id": normalize_arxiv_id(item.get("arxiv_id")),
                    "pmid": str(item.get("pmid") or ""),
                    "source_record_id": str(item.get("source_record_id") or ""),
                }
                for item in members[key]
            ],
        }
        for key in order
    ]
    return {"candidates": rows, "clusters": clusters, "raw_count": sum(len(items) for items in members.values())}


def dedupe_candidates(candidates: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return dedupe_with_clusters(candidates)["candidates"]
