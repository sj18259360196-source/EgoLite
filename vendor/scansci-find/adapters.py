from __future__ import annotations

import base64
import math
import json
import os
from concurrent.futures import ThreadPoolExecutor
import re
import shlex
import subprocess
import time
import urllib.parse
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from typing import Any, Dict, Iterable, List, Optional

from scansci_find import __version__

Candidate = Dict[str, Any]


class ProviderError(RuntimeError):
    """Base error carrying a machine-readable source status."""

    status = "error"


class ProviderConfigurationError(ProviderError):
    status = "blocked_configuration"


class ProviderAuthenticationError(ProviderError):
    status = "blocked_authentication"


class ProviderNotFoundError(ProviderError):
    status = "not_found"


class ProviderRateLimitError(ProviderError):
    status = "rate_limited"


def normalize_doi(value: Any) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^https?://(dx\.)?doi\.org/", "", text, flags=re.I)
    text = re.sub(r"^doi:\s*", "", text, flags=re.I)
    return text.strip().lower()


def normalize_arxiv_id(value: Any) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^https?://arxiv\.org/(abs|pdf)/", "", text, flags=re.I)
    text = text.removesuffix(".pdf")
    text = text.split("/")[-1]
    return re.sub(r"v\d+$", "", text, flags=re.I)


def _candidate(
    *,
    title: str = "",
    title_zh: str = "",
    title_en: str = "",
    authors: Optional[List[str]] = None,
    year: Optional[int] = None,
    doi: str = "",
    arxiv_id: str = "",
    pmid: str = "",
    pmcid: str = "",
    dblp_id: str = "",
    journal: str = "",
    article_type: str = "journal",
    source_platform: str = "",
    source_record_id: str = "",
    source_url: str = "",
    abstract: str = "",
    keywords: Optional[List[str]] = None,
    access: Optional[Dict[str, Any]] = None,
    issn: str = "",
    eissn: str = "",
    source: str,
    relevance_score: float = 0.0,
    citation_count: int = 0,
    published_date: str = "",
    links: Optional[Dict[str, str]] = None,
    artifact_type: str = "paper",
    language: str = "",
) -> Candidate:
    normalized_doi = normalize_doi(doi)
    normalized_arxiv = normalize_arxiv_id(arxiv_id)
    identifiers = {
        key: value
        for key, value in {
            "doi": normalized_doi,
            "arxiv": normalized_arxiv,
            "pmid": str(pmid or "").strip(),
            "pmcid": str(pmcid or "").strip(),
            "dblp": str(dblp_id or "").strip(),
        }.items()
        if value
    }
    source_url = source_url or str((links or {}).get("paper") or "")
    source_record_id = source_record_id or identifiers.get("doi") or identifiers.get("arxiv") or identifiers.get("pmid") or identifiers.get("dblp") or ""
    return {
        "artifact_type": artifact_type,
        "title": title.strip(),
        "title_zh": title_zh.strip(),
        "title_en": title_en.strip(),
        "authors": authors or [],
        "year": year,
        "doi": normalized_doi,
        "arxiv_id": normalized_arxiv,
        "pmid": str(pmid or "").strip(),
        "pmcid": str(pmcid or "").strip(),
        "dblp_id": str(dblp_id or "").strip(),
        "identifiers": identifiers,
        "journal": journal.strip(),
        "article_type": article_type or "journal",
        "source_platform": source_platform,
        "source_record_id": source_record_id,
        "source_url": source_url,
        "abstract": abstract.strip(),
        "keywords": keywords or [],
        "language": str(language or "").strip(),
        "access": access
        or {
            "fulltext_hint": "unknown",
            "requires_login": False,
            "requires_institution": False,
        },
        "issn": issn.strip(),
        "eissn": eissn.strip(),
        "source_hits": [source],
        "relevance_score": float(relevance_score or 0.0),
        "citation_count": int(citation_count or 0),
        "published_date": str(published_date or "").strip(),
        "quality": {},
        "download": {},
        "links": links or {},
        "source_records": [
            {
                "source": source,
                "source_record_id": source_record_id,
                "source_url": source_url,
            }
        ],
    }


def _first(value: Any) -> str:
    if isinstance(value, list):
        return str(value[0] if value else "").strip()
    return str(value or "").strip()


def _year_from_date_parts(value: Any) -> Optional[int]:
    try:
        return int(value["date-parts"][0][0])
    except (KeyError, IndexError, TypeError, ValueError):
        return None


def _date_from_date_parts(value: Any) -> str:
    """Render a Crossref date-parts value as YYYY-MM-DD (or the best partial)."""
    try:
        parts = [int(part) for part in value["date-parts"][0]]
    except (KeyError, IndexError, TypeError, ValueError):
        return ""
    if not parts:
        return ""
    if len(parts) == 1:
        return f"{parts[0]:04d}"
    if len(parts) == 2:
        return f"{parts[0]:04d}-{parts[1]:02d}"
    return f"{parts[0]:04d}-{parts[1]:02d}-{parts[2]:02d}"


def normalize_openalex_work(work: Dict[str, Any]) -> Candidate:
    source = ((work.get("primary_location") or {}).get("source") or {})
    issns = source.get("issn") or []
    return _candidate(
        title=str(work.get("title") or ""),
        authors=[
            str((authorship.get("author") or {}).get("display_name") or "").strip()
            for authorship in work.get("authorships") or []
            if str((authorship.get("author") or {}).get("display_name") or "").strip()
        ],
        year=work.get("publication_year"),
        doi=work.get("doi") or "",
        journal=str(source.get("display_name") or ""),
        issn=str(source.get("issn_l") or (issns[0] if issns else "")),
        eissn=str(issns[1] if len(issns) > 1 else ""),
        source="OpenAlex",
        relevance_score=float(work.get("relevance_score") or 0.0),
        citation_count=int(work.get("cited_by_count") or 0),
        published_date=str(work.get("publication_date") or "").strip(),
        links={
            "paper": str(work.get("id") or ""),
            "pdf": str((work.get("open_access") or {}).get("oa_url") or ""),
        },
    )


def normalize_crossref_work(work: Dict[str, Any]) -> Candidate:
    authors = []
    for author in work.get("author") or []:
        name = " ".join(str(author.get(part) or "").strip() for part in ("given", "family")).strip()
        if name:
            authors.append(name)
    issns = work.get("ISSN") or []
    return _candidate(
        title=_first(work.get("title")),
        authors=authors,
        year=_year_from_date_parts(work.get("issued")),
        doi=work.get("DOI") or "",
        journal=_first(work.get("container-title")),
        issn=str(issns[0] if issns else ""),
        eissn=str(issns[1] if len(issns) > 1 else ""),
        source="Crossref",
        relevance_score=float(work.get("score") or 0.0),
        citation_count=int(work.get("is-referenced-by-count") or 0),
        published_date=_date_from_date_parts(work.get("issued")),
        links={"paper": str(work.get("URL") or "")},
    )


def normalize_semantic_paper(paper: Dict[str, Any]) -> Candidate:
    external = paper.get("externalIds") or {}
    return _candidate(
        title=str(paper.get("title") or ""),
        authors=[str(a.get("name") or "").strip() for a in paper.get("authors") or [] if str(a.get("name") or "").strip()],
        year=paper.get("year"),
        doi=external.get("DOI") or "",
        arxiv_id=external.get("ArXiv") or "",
        journal=str((paper.get("journal") or {}).get("name") or ""),
        source="Semantic Scholar",
        relevance_score=float(paper.get("citationCount") or 0.0),
        citation_count=int(paper.get("citationCount") or 0),
        published_date=str(paper.get("publicationDate") or "").strip(),
        links={
            "paper": str(paper.get("url") or ""),
            "pdf": str((paper.get("openAccessPdf") or {}).get("url") or ""),
        },
    )


def normalize_arxiv_entry(entry: Dict[str, Any]) -> Candidate:
    return _candidate(
        title=str(entry.get("title") or ""),
        authors=[str(a).strip() for a in entry.get("authors") or [] if str(a).strip()],
        year=entry.get("year"),
        arxiv_id=entry.get("arxiv_id") or entry.get("id") or "",
        source="arXiv",
        relevance_score=float(entry.get("relevance_score") or 0.0),
        published_date=str(entry.get("published_date") or "").strip(),
        links={"paper": str(entry.get("url") or ""), "pdf": str(entry.get("pdf_url") or "")},
    )


def _article_id(record: Dict[str, Any], *kinds: str) -> str:
    wanted = {kind.casefold() for kind in kinds}
    for item in record.get("articleids") or record.get("articleIds") or []:
        kind = str(item.get("idtype") or item.get("idType") or "").casefold()
        if kind in wanted:
            return str(item.get("value") or item.get("id") or "").strip()
    return ""


def normalize_pubmed_record(record: Dict[str, Any]) -> Candidate:
    pmid = str(record.get("uid") or record.get("pmid") or "").strip()
    doi = str(record.get("doi") or _article_id(record, "doi") or "")
    pmcid = str(record.get("pmcid") or _article_id(record, "pmc", "pmcid") or "")
    authors = [
        str(item.get("name") or item.get("authtype") or "").strip()
        for item in record.get("authors") or []
        if str(item.get("name") or "").strip()
    ]
    return _candidate(
        title=str(record.get("title") or ""),
        authors=authors,
        year=_year_from_text(record.get("pubdate") or record.get("sortpubdate") or record.get("epubdate")),
        doi=doi,
        pmid=pmid,
        pmcid=pmcid,
        journal=str(record.get("fulljournalname") or record.get("source") or ""),
        article_type=_article_type(record.get("pubtype") or record.get("doctype")),
        source_platform="pubmed",
        source_record_id=pmid,
        source_url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/" if pmid else "",
        source="PubMed",
        relevance_score=float(record.get("sortfirstauthor") is not None),
        links={
            "paper": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/" if pmid else "",
            "fulltext": f"https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/" if pmcid else "",
        },
    )


def normalize_europe_pmc_record(record: Dict[str, Any]) -> Candidate:
    pmid = str(record.get("pmid") or "").strip()
    pmcid = str(record.get("pmcid") or "").strip()
    doi = str(record.get("doi") or "")
    record_id = pmcid or pmid or doi
    return _candidate(
        title=str(record.get("title") or ""),
        authors=_list_from_any(record.get("authorString") or record.get("authors")),
        year=_year_from_text(record.get("firstPublicationDate") or (record.get("journalInfo") or {}).get("printPublicationDate") or record.get("pubYear")),
        doi=doi,
        pmid=pmid,
        pmcid=pmcid,
        journal=str(record.get("journalTitle") or (record.get("journalInfo") or {}).get("journal", {}).get("title") or ""),
        article_type=_article_type(record.get("pubType") or record.get("documentType")),
        source_platform="europe_pmc",
        source_record_id=record_id,
        source_url=f"https://europepmc.org/article/{record.get('source') or 'MED'}/{pmid or pmcid}" if (pmid or pmcid) else "",
        abstract=str(record.get("abstractText") or ""),
        source="Europe PMC",
        relevance_score=float(record.get("citedByCount") or 0.0),
        citation_count=int(record.get("citedByCount") or 0),
        published_date=str(record.get("firstPublicationDate") or "").strip(),
        links={
            "paper": f"https://europepmc.org/article/{record.get('source') or 'MED'}/{pmid or pmcid}" if (pmid or pmcid) else "",
            "fulltext": f"https://europepmc.org/articles/{pmcid}" if pmcid else "",
        },
        access={
            "fulltext_hint": "oa" if str(record.get("isOpenAccess") or "").upper() == "Y" else "unknown",
            "requires_login": False,
            "requires_institution": False,
        },
    )


def normalize_dblp_record(record: Dict[str, Any]) -> Candidate:
    info = record.get("info") or record
    authors_raw = (info.get("authors") or {}).get("author") or []
    if isinstance(authors_raw, dict):
        authors_raw = [authors_raw]
    authors = [str(item.get("text") if isinstance(item, dict) else item).strip() for item in authors_raw]
    key = str(info.get("key") or "")
    return _candidate(
        title=str(info.get("title") or ""),
        authors=[name for name in authors if name],
        year=_year_from_text(info.get("year")),
        doi=str(info.get("doi") or ""),
        dblp_id=key,
        journal=str(info.get("venue") or ""),
        article_type=_article_type(info.get("type")),
        source_platform="dblp",
        source_record_id=key,
        source_url=str(info.get("url") or ""),
        source="DBLP",
        relevance_score=float(record.get("score") or 1.0),
        links={"paper": str(info.get("url") or ""), "electronic": str(info.get("ee") or "")},
    )


def _year_from_text(value: Any) -> Optional[int]:
    match = re.search(r"\b(19|20)\d{2}\b", str(value or ""))
    return int(match.group(0)) if match else None


def _list_from_any(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [item.strip() for item in re.split(r"[;,；、]", str(value)) if item.strip()]


def _article_type(value: Any) -> str:
    text = str(value or "").casefold()
    if any(word in text for word in ["thesis", "学位", "dissertation"]):
        return "thesis"
    if any(word in text for word in ["conference", "会议"]):
        return "conference"
    if any(word in text for word in ["newspaper", "报纸"]):
        return "newspaper"
    if any(word in text for word in ["standard", "标准"]):
        return "standard"
    if any(word in text for word in ["patent", "专利"]):
        return "patent"
    if any(word in text for word in ["book", "图书", "专著"]):
        return "book"
    return "journal"


def normalize_baidu_scholar_record(record: Dict[str, Any]) -> Candidate:
    title = str(record.get("title") or record.get("name") or "").strip()
    source_hint = str(record.get("source") or record.get("sourceName") or record.get("database") or "").strip()
    candidate = _candidate(
        title=title,
        title_zh=title,
        authors=_list_from_any(record.get("authors") or record.get("author")),
        year=_year_from_text(record.get("publishYear") or record.get("year") or record.get("date")),
        doi=record.get("doi") or record.get("DOI") or "",
        journal=str(record.get("journal") or record.get("venue") or record.get("publication") or ""),
        article_type=_article_type(record.get("article_type") or record.get("type") or record.get("docType")),
        source_platform="baidu_scholar",
        source_record_id=str(record.get("paperId") or record.get("paper_id") or record.get("id") or ""),
        source_url=str(record.get("url") or record.get("source_url") or ""),
        abstract=str(record.get("abstract") or record.get("summary") or ""),
        keywords=_list_from_any(record.get("keywords") or record.get("keyword")),
        source="Baidu Scholar",
        relevance_score=float(record.get("score") or record.get("relevance_score") or 1.0),
        links={"paper": str(record.get("url") or record.get("source_url") or "")},
    )
    if source_hint:
        candidate["source_hits"] = sorted(set(candidate["source_hits"] + [source_hint]))
    return candidate


def normalize_cnki_record(record: Dict[str, Any]) -> Candidate:
    title = str(record.get("title") or "").strip()
    url = str(record.get("url") or record.get("href") or "")
    source = str(record.get("source") or record.get("journal") or "").strip()
    return _candidate(
        title=title,
        title_zh=title,
        title_en=str(record.get("title_en") or ""),
        authors=_list_from_any(record.get("authors") or record.get("author")),
        year=_year_from_text(record.get("year") or record.get("date")),
        doi=record.get("doi") or record.get("DOI") or "",
        journal=source,
        article_type=_article_type(record.get("article_type") or record.get("type")),
        source_platform="cnki",
        source_record_id=str(record.get("id") or record.get("paper_id") or record.get("exportId") or url),
        source_url=url,
        abstract=str(record.get("abstract") or ""),
        keywords=_list_from_any(record.get("keywords")),
        source="CNKI",
        relevance_score=float(record.get("score") or record.get("relevance_score") or 1.0),
        links={"paper": url},
        access={
            "fulltext_hint": "institution_required",
            "requires_login": False,
            "requires_institution": True,
        },
    )


def normalize_zenodo_record(record: Dict[str, Any]) -> Candidate:
    metadata = record.get("metadata") or {}
    resource_type = metadata.get("resource_type") or {}
    files = record.get("files") or []
    file_url = ""
    if files:
        file_url = str(((files[0].get("links") or {}).get("self")) or files[0].get("download") or "")
    kind = str(resource_type.get("type") or metadata.get("upload_type") or "record").casefold()
    artifact_type = "dataset" if "dataset" in kind else "record"
    return _candidate(
        title=str(metadata.get("title") or ""),
        authors=[str(item.get("name") or "").strip() for item in metadata.get("creators") or [] if str(item.get("name") or "").strip()],
        year=_year_from_text(metadata.get("publication_date")),
        doi=metadata.get("doi") or record.get("doi") or "",
        source="Zenodo",
        relevance_score=1.0,
        links={"paper": str((record.get("links") or {}).get("html") or ""), "dataset": file_url},
        artifact_type=artifact_type,
    )


def normalize_datacite_work(work: Dict[str, Any]) -> Candidate:
    attrs = work.get("attributes") or {}
    titles = attrs.get("titles") or []
    creators = attrs.get("creators") or []
    resource_type = ((attrs.get("types") or {}).get("resourceTypeGeneral") or "record").casefold()
    artifact_type = "dataset" if resource_type == "dataset" else "record"
    return _candidate(
        title=str((titles[0] or {}).get("title") if titles else ""),
        authors=[str(item.get("name") or "").strip() for item in creators if str(item.get("name") or "").strip()],
        year=attrs.get("publicationYear"),
        doi=work.get("id") or attrs.get("doi") or "",
        source="DataCite",
        relevance_score=1.0,
        links={"paper": str(attrs.get("url") or "")},
        artifact_type=artifact_type,
    )


def normalize_openml_dataset(dataset: Dict[str, Any]) -> Candidate:
    did = dataset.get("did") or dataset.get("data_id") or dataset.get("id") or ""
    name = str(dataset.get("name") or dataset.get("data_name") or "")
    instances = dataset.get("NumberOfInstances") or dataset.get("number_of_instances")
    features = dataset.get("NumberOfFeatures") or dataset.get("number_of_features")
    evidence = [part for part in [f"{instances} instances" if instances else "", f"{features} features" if features else ""] if part]
    return _candidate(
        title=name,
        source="OpenML",
        relevance_score=float(dataset.get("version") or 1.0),
        links={"paper": f"https://www.openml.org/d/{did}" if did else ""},
        artifact_type="dataset",
    ) | {"data_evidence": evidence}


def normalize_huggingface_dataset(dataset: Dict[str, Any]) -> Candidate:
    dataset_id = str(dataset.get("id") or dataset.get("name") or "")
    tags = [str(item) for item in dataset.get("tags") or []]
    score = float(dataset.get("likes") or 0) + float(dataset.get("downloads") or 0) / 1000.0
    return _candidate(
        title=dataset_id,
        source="Hugging Face",
        relevance_score=score,
        links={"paper": f"https://huggingface.co/datasets/{dataset_id}" if dataset_id else ""},
        artifact_type="dataset",
    ) | {"data_evidence": tags}


def normalize_kaggle_dataset(dataset: Dict[str, Any]) -> Candidate:
    ref = str(dataset.get("ref") or dataset.get("id") or "")
    title = str(dataset.get("title") or ref)
    license_name = str(dataset.get("licenseName") or dataset.get("license") or "")
    evidence = [item for item in [license_name, f"{dataset.get('downloadCount')} downloads" if dataset.get("downloadCount") is not None else "", f"{dataset.get('voteCount')} votes" if dataset.get("voteCount") is not None else ""] if item]
    return _candidate(
        title=title,
        source="Kaggle",
        relevance_score=float(dataset.get("voteCount") or 0) + float(dataset.get("downloadCount") or 0) / 1000.0,
        links={"paper": f"https://www.kaggle.com/datasets/{ref}" if ref else ""},
        artifact_type="dataset",
    ) | {"data_evidence": evidence}


class HttpProvider:
    name = ""

    def __init__(self) -> None:
        self.last_search_metadata: Dict[str, Any] = {}

    def search(self, query: str, limit: int) -> List[Candidate]:
        raise NotImplementedError

    def _request_headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        contact = os.environ.get("SCANSCI_FIND_CONTACT_EMAIL") or os.environ.get("NCBI_EMAIL") or ""
        agent = "scansci-find/0.3"
        if contact:
            agent += f" (mailto:{contact})"
        headers = {"Accept": "application/json", "User-Agent": agent}
        headers.update(extra or {})
        return headers

    def _request_bytes(self, url: str, *, headers: Optional[Dict[str, str]] = None) -> bytes:
        request = urllib.request.Request(url, headers=self._request_headers(headers))
        attempts = max(1, int(os.environ.get("SCANSCI_FIND_HTTP_ATTEMPTS") or 3))
        timeout = max(1.0, float(os.environ.get("SCANSCI_FIND_HTTP_TIMEOUT") or 20))
        retryable = {429, 500, 502, 503, 504}
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    return response.read()
            except urllib.error.HTTPError as exc:
                if exc.code in {401, 403}:
                    raise ProviderAuthenticationError(f"{self.name or 'source'} authentication failed with HTTP {exc.code}") from exc
                if exc.code == 404:
                    raise ProviderNotFoundError(f"{self.name or 'source'} record was not found") from exc
                if exc.code not in retryable:
                    raise ProviderError(f"{self.name or 'source'} request failed with HTTP {exc.code}") from exc
                if attempt + 1 >= attempts:
                    if exc.code == 429:
                        raise ProviderRateLimitError(f"{self.name or 'source'} remained rate-limited after {attempts} attempts") from exc
                    raise ProviderError(f"{self.name or 'source'} remained unavailable with HTTP {exc.code} after {attempts} attempts") from exc
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                try:
                    delay = max(0.0, float(retry_after)) if retry_after is not None else 0.0
                except ValueError:
                    delay = 0.0
                time.sleep(min(30.0, delay or (0.5 * (2**attempt))))
            except urllib.error.URLError as exc:
                if attempt + 1 >= attempts:
                    raise ProviderError(f"{self.name or 'source'} network error after {attempts} attempts: {exc.reason}") from exc
                time.sleep(0.5 * (2**attempt))
        raise ProviderError(f"{self.name or 'source'} request failed")

    def _json(self, url: str, *, headers: Optional[Dict[str, str]] = None) -> Any:
        return json.loads(self._request_bytes(url, headers=headers).decode("utf-8"))

    def _record_search_metadata(
        self,
        *,
        returned: int,
        total_available: Optional[int] = None,
        next_cursor: str = "",
        pagination: str = "bounded_first_page",
    ) -> None:
        complete = total_available is not None and int(total_available) <= int(returned)
        self.last_search_metadata = {
            "returned": int(returned),
            "total_available": int(total_available) if total_available is not None else None,
            "next_cursor": str(next_cursor or ""),
            "pagination": pagination,
            "pagination_complete": bool(complete),
        }


class OpenAlexProvider(HttpProvider):
    name = "openalex"

    def search(self, query: str, limit: int) -> List[Candidate]:
        api_key = str(os.environ.get("OPENALEX_API_KEY") or "").strip()
        if not api_key:
            raise ProviderConfigurationError(
                "OpenAlex requires OPENALEX_API_KEY for every API request (required since 2026-02-13)"
            )
        requested = max(1, int(limit))
        cursor = "*"
        rows: List[Dict[str, Any]] = []
        total_available: Optional[int] = None
        next_cursor = ""
        while len(rows) < requested:
            params = {
                "search": query,
                "per_page": min(100, requested - len(rows)),
                "cursor": cursor,
                "api_key": api_key,
            }
            url = "https://api.openalex.org/works?" + urllib.parse.urlencode(params)
            payload = self._json(url)
            page_rows = payload.get("results") or []
            meta = payload.get("meta") or {}
            count_value = meta.get("count")
            if total_available is None and str(count_value).isdigit():
                total_available = int(count_value)
            rows.extend(page_rows)
            next_cursor = str(meta.get("next_cursor") or "")
            if not page_rows or not next_cursor or len(rows) >= requested:
                break
            cursor = next_cursor
        self._record_search_metadata(
            returned=len(rows),
            total_available=total_available,
            next_cursor=next_cursor if len(rows) < (total_available or len(rows)) else "",
            pagination="openalex_cursor",
        )
        return [normalize_openalex_work(item) for item in rows[:requested]]


class CrossrefProvider(HttpProvider):
    name = "crossref"

    def search(self, query: str, limit: int) -> List[Candidate]:
        requested = max(1, int(limit))
        params: Dict[str, Any] = {"query": query, "rows": min(requested, 1000), "cursor": "*"}
        contact = os.environ.get("CROSSREF_MAILTO") or os.environ.get("SCANSCI_FIND_CONTACT_EMAIL")
        if contact:
            params["mailto"] = contact
        url = "https://api.crossref.org/works?" + urllib.parse.urlencode(params)
        message = self._json(url).get("message") or {}
        rows = message.get("items") or []
        self._record_search_metadata(
            returned=len(rows),
            total_available=message.get("total-results"),
            next_cursor=str(message.get("next-cursor") or "") if len(rows) >= requested else "",
            pagination="crossref_cursor",
        )
        return [normalize_crossref_work(item) for item in rows[:requested]]

    def lookup_doi(self, doi: str) -> Candidate:
        normalized = normalize_doi(doi)
        if not normalized:
            raise ValueError("doi must not be empty")
        params = {}
        contact = os.environ.get("CROSSREF_MAILTO") or os.environ.get("SCANSCI_FIND_CONTACT_EMAIL")
        if contact:
            params["mailto"] = contact
        suffix = "?" + urllib.parse.urlencode(params) if params else ""
        url = "https://api.crossref.org/works/" + urllib.parse.quote(normalized, safe="") + suffix
        message = self._json(url).get("message") or {}
        if not message:
            raise ProviderNotFoundError(f"Crossref did not return metadata for DOI {normalized}")
        return normalize_crossref_work(message)


class SemanticScholarProvider(HttpProvider):
    name = "semantic"

    def search(self, query: str, limit: int) -> List[Candidate]:
        fields = "title,year,authors,externalIds,journal,openAccessPdf,url,citationCount,publicationDate"
        requested = max(1, int(limit))
        api_key = str(os.environ.get("SEMANTIC_SCHOLAR_API_KEY") or "").strip()
        rows: List[Dict[str, Any]] = []
        total_available: Optional[int] = None
        while len(rows) < requested:
            page_size = min(100, requested - len(rows))
            url = "https://api.semanticscholar.org/graph/v1/paper/search?" + urllib.parse.urlencode(
                {"query": query, "limit": page_size, "offset": len(rows), "fields": fields}
            )
            payload = self._json(url, headers={"x-api-key": api_key} if api_key else None)
            page_rows = payload.get("data") or []
            total_value = payload.get("total")
            if total_available is None and str(total_value).isdigit():
                total_available = int(total_value)
            rows.extend(page_rows)
            if not page_rows or len(page_rows) < page_size or len(rows) >= requested:
                break
        self._record_search_metadata(
            returned=len(rows),
            total_available=total_available,
            next_cursor=str(len(rows)) if total_available is not None and len(rows) < total_available else "",
            pagination="semantic_offset",
        )
        return [normalize_semantic_paper(item) for item in rows[:requested]]


class ArxivProvider(HttpProvider):
    name = "arxiv"

    def search(self, query: str, limit: int) -> List[Candidate]:
        params = {"search_query": f"all:{query}", "start": 0, "max_results": limit}
        url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(params)
        root = ET.fromstring(self._request_bytes(url, headers={"Accept": "application/atom+xml"}))
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        out: List[Candidate] = []
        for node in root.findall("atom:entry", ns):
            entry_id = (node.findtext("atom:id", default="", namespaces=ns) or "").strip()
            published = (node.findtext("atom:published", default="", namespaces=ns) or "").strip()
            links = node.findall("atom:link", ns)
            pdf_url = ""
            for link in links:
                if link.attrib.get("title") == "pdf" or link.attrib.get("type") == "application/pdf":
                    pdf_url = link.attrib.get("href", "")
            out.append(
                normalize_arxiv_entry(
                    {
                        "title": " ".join((node.findtext("atom:title", default="", namespaces=ns) or "").split()),
                        "authors": [
                            a.findtext("atom:name", default="", namespaces=ns) or ""
                            for a in node.findall("atom:author", ns)
                        ],
                        "year": int(published[:4]) if published[:4].isdigit() else None,
                        "arxiv_id": entry_id,
                        "url": entry_id,
                        "pdf_url": pdf_url,
                        "published_date": published[:10],
                    }
                )
            )
        total_text = root.findtext("{http://a9.com/-/spec/opensearch/1.1/}totalResults", default="") or ""
        self._record_search_metadata(
            returned=len(out),
            total_available=int(total_text) if str(total_text).isdigit() else None,
            pagination="arxiv_start_available",
        )
        return out

    def lookup_arxiv(self, arxiv_id: str) -> Candidate:
        normalized = normalize_arxiv_id(arxiv_id)
        if not normalized:
            raise ValueError("arxiv_id must not be empty")
        url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode({"id_list": normalized, "max_results": 1})
        root = ET.fromstring(self._request_bytes(url, headers={"Accept": "application/atom+xml"}))
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        node = root.find("atom:entry", ns)
        if node is None:
            raise ProviderNotFoundError(f"arXiv did not return metadata for {normalized}")
        entry_id = (node.findtext("atom:id", default="", namespaces=ns) or "").strip()
        published = (node.findtext("atom:published", default="", namespaces=ns) or "").strip()
        return normalize_arxiv_entry(
            {
                "title": " ".join((node.findtext("atom:title", default="", namespaces=ns) or "").split()),
                "authors": [
                    author.findtext("atom:name", default="", namespaces=ns) or ""
                    for author in node.findall("atom:author", ns)
                ],
                "year": int(published[:4]) if published[:4].isdigit() else None,
                "arxiv_id": entry_id,
                "url": entry_id,
            }
        )


class PubMedProvider(HttpProvider):
    name = "pubmed"

    def search(self, query: str, limit: int) -> List[Candidate]:
        params = {"db": "pubmed", "term": query, "retmax": limit, "retmode": "json", "tool": "scansci-find"}
        email = os.environ.get("NCBI_EMAIL")
        api_key = os.environ.get("NCBI_API_KEY")
        if email:
            params["email"] = email
        if api_key:
            params["api_key"] = api_key
        search_url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?" + urllib.parse.urlencode(params)
        search_result = self._json(search_url).get("esearchresult") or {}
        ids = list(search_result.get("idlist") or [])
        if not ids:
            count = search_result.get("count")
            self._record_search_metadata(returned=0, total_available=int(count) if str(count).isdigit() else 0, pagination="pubmed_retstart_available")
            return []
        summary_params = {"db": "pubmed", "id": ",".join(ids), "retmode": "json", "tool": "scansci-find"}
        if email:
            summary_params["email"] = email
        if api_key:
            summary_params["api_key"] = api_key
        summary_url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?" + urllib.parse.urlencode(summary_params)
        result = self._json(summary_url).get("result") or {}
        rows = [normalize_pubmed_record(result[pmid]) for pmid in ids if isinstance(result.get(pmid), dict)]
        count = search_result.get("count")
        self._record_search_metadata(
            returned=len(ids),
            total_available=int(count) if str(count).isdigit() else None,
            pagination="pubmed_retstart_available",
        )
        return rows

    def lookup_pmid(self, pmid: str) -> Candidate:
        normalized = str(pmid or "").strip()
        if not normalized:
            raise ValueError("pmid must not be empty")
        params = {"db": "pubmed", "id": normalized, "retmode": "json", "tool": "scansci-find"}
        email = os.environ.get("NCBI_EMAIL")
        api_key = os.environ.get("NCBI_API_KEY")
        if email:
            params["email"] = email
        if api_key:
            params["api_key"] = api_key
        url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?" + urllib.parse.urlencode(params)
        record = (self._json(url).get("result") or {}).get(normalized)
        if not isinstance(record, dict):
            raise ProviderNotFoundError(f"PubMed did not return metadata for PMID {normalized}")
        return normalize_pubmed_record(record)


class EuropePMCProvider(HttpProvider):
    name = "europe-pmc"

    def search(self, query: str, limit: int) -> List[Candidate]:
        params = {"query": query, "format": "json", "pageSize": min(max(1, limit), 1000), "resultType": "core", "cursorMark": "*"}
        contact = os.environ.get("EUROPE_PMC_EMAIL") or os.environ.get("SCANSCI_FIND_CONTACT_EMAIL")
        if contact:
            params["email"] = contact
        url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + urllib.parse.urlencode(params)
        payload = self._json(url)
        rows = ((payload.get("resultList") or {}).get("result") or [])
        self._record_search_metadata(
            returned=len(rows),
            total_available=payload.get("hitCount"),
            next_cursor=str(payload.get("nextCursorMark") or ""),
            pagination="europe_pmc_cursor_available",
        )
        return [normalize_europe_pmc_record(item) for item in rows[:limit]]


class DBLPProvider(HttpProvider):
    name = "dblp"

    def __init__(self) -> None:
        super().__init__()
        self._last_request_at = 0.0

    def search(self, query: str, limit: int) -> List[Candidate]:
        minimum_interval = max(0.0, float(os.environ.get("DBLP_MIN_INTERVAL_SECONDS") or 1.0))
        elapsed = time.monotonic() - self._last_request_at
        if self._last_request_at and elapsed < minimum_interval:
            time.sleep(minimum_interval - elapsed)
        url = "https://dblp.org/search/publ/api?" + urllib.parse.urlencode({"q": query, "h": min(max(1, limit), 1000), "f": 0, "format": "json"})
        payload = self._json(url)
        self._last_request_at = time.monotonic()
        hits = ((payload.get("result") or {}).get("hits") or {})
        rows = hits.get("hit") or []
        total = hits.get("@total")
        self._record_search_metadata(
            returned=len(rows),
            total_available=int(total) if str(total).isdigit() else None,
            pagination="dblp_offset_available",
        )
        return [normalize_dblp_record(item) for item in rows[:limit]]


class ZenodoProvider(HttpProvider):
    name = "zenodo"

    def search(self, query: str, limit: int) -> List[Candidate]:
        url = "https://zenodo.org/api/records?" + urllib.parse.urlencode({"q": query, "size": limit})
        return [normalize_zenodo_record(item) for item in self._json(url).get("hits", {}).get("hits", [])]


class DataCiteProvider(HttpProvider):
    name = "datacite"

    def search(self, query: str, limit: int) -> List[Candidate]:
        url = "https://api.datacite.org/dois?" + urllib.parse.urlencode({"query": query, "page[size]": limit})
        return [normalize_datacite_work(item) for item in self._json(url).get("data", [])]


class OpenMLProvider(HttpProvider):
    name = "openml"

    def search(self, query: str, limit: int) -> List[Candidate]:
        url = "https://www.openml.org/api/v1/json/data/list?" + urllib.parse.urlencode({"limit": max(limit, 25)})
        rows = ((self._json(url).get("data") or {}).get("dataset") or [])
        filtered = [item for item in rows if query.casefold() in str(item.get("name") or item.get("data_name") or "").casefold()]
        return [normalize_openml_dataset(item) for item in (filtered or rows)[:limit]]


class HuggingFaceDatasetProvider(HttpProvider):
    name = "huggingface"

    def search(self, query: str, limit: int) -> List[Candidate]:
        url = "https://huggingface.co/api/datasets?" + urllib.parse.urlencode({"search": query, "limit": limit})
        data = self._json(url)
        rows = data if isinstance(data, list) else data.get("datasets", [])
        return [normalize_huggingface_dataset(item) for item in rows[:limit]]


class KaggleProvider(HttpProvider):
    name = "kaggle"

    def search(self, query: str, limit: int) -> List[Candidate]:
        username = os.environ.get("KAGGLE_USERNAME")
        key = os.environ.get("KAGGLE_KEY")
        if not username or not key:
            raise ProviderConfigurationError("Kaggle API credentials are not configured")
        url = "https://www.kaggle.com/api/v1/datasets/list?" + urllib.parse.urlencode({"search": query, "pageSize": limit})
        token = base64.b64encode(f"{username}:{key}".encode("utf-8")).decode("ascii")
        data = self._json(url, headers={"Authorization": f"Basic {token}"})
        rows = data if isinstance(data, list) else data.get("datasets", [])
        return [normalize_kaggle_dataset(item) for item in rows[:limit]]


def _rows_from_baidu_payload(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    data = payload.get("data", payload)
    if isinstance(data, list):
        return data
    for key in ("results", "result", "papers", "items", "list"):
        value = data.get(key) if isinstance(data, dict) else None
        if isinstance(value, list):
            return value
    return []


class BaiduScholarProvider(HttpProvider):
    name = "baidu-scholar"

    def search(self, query: str, limit: int) -> List[Candidate]:
        api_key = os.environ.get("BAIDU_API_KEY")
        if not api_key:
            raise ProviderConfigurationError("BAIDU_API_KEY environment variable is not set")
        params = urllib.parse.urlencode({"wd": query, "pageNum": 0, "enable_abstract": "true"})
        url = "https://qianfan.baidubce.com/v2/tools/baidu_scholar/search?" + params
        payload = self._json(url, headers={"Authorization": f"Bearer {api_key}"})
        return [normalize_baidu_scholar_record(item) for item in _rows_from_baidu_payload(payload)[:limit]]


def _command_from_env(name: str) -> Optional[List[str]]:
    value = os.environ.get(name)
    if not value:
        return None
    value = value.strip()
    if value.startswith("["):
        parsed = json.loads(value)
        return [str(item) for item in parsed]
    return shlex.split(value, posix=os.name != "nt")


class CNKIMcpProvider(HttpProvider):
    name = "cnki"

    def __init__(self, command: Optional[List[str]] = None) -> None:
        self.command = command

    def search(self, query: str, limit: int) -> List[Candidate]:
        command = self.command or _command_from_env("SCANSCI_FIND_CNKI_MCP_COMMAND")
        if not command:
            raise ProviderConfigurationError(
                "SCANSCI_FIND_CNKI_MCP_COMMAND is not configured; set it to an external cnki-mcp command such as "
                "[\"uvx\", \"--from\", \"git+https://github.com/h-lu/cnki-mcp\", \"cnki-mcp\"]"
            )
        pages = max(1, min(3, (limit + 19) // 20))
        payload = self._call_tool(command, "search_cnki", {"query": query, "pages": pages})
        rows = payload.get("papers") or payload.get("results") or []
        return [normalize_cnki_record(item) for item in rows[:limit]]

    def _call_tool(self, command: List[str], name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        env = os.environ.copy()
        env.setdefault("PYTHONIOENCODING", "utf-8")
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=env,
        )
        try:
            initialize = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "scansci-find", "version": __version__},
                },
            }
            tool_call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
            assert process.stdin is not None
            process.stdin.write(json.dumps(initialize, ensure_ascii=False) + "\n")
            process.stdin.write(json.dumps(tool_call, ensure_ascii=False) + "\n")
            process.stdin.flush()
            result = self._read_response(process, wanted_id=2)
            if "error" in result:
                raise RuntimeError(result["error"].get("message") or "CNKI MCP error")
            payload = result.get("result") or {}
            if payload.get("isError"):
                structured = payload.get("structuredContent") or {}
                raise RuntimeError(structured.get("message") or "CNKI MCP tool error")
            return payload.get("structuredContent") or payload
        finally:
            try:
                process.terminate()
                process.wait(timeout=2)
            except Exception:
                process.kill()

    def _read_response(self, process: subprocess.Popen, wanted_id: int) -> Dict[str, Any]:
        assert process.stdout is not None
        while True:
            line = process.stdout.readline()
            if not line:
                stderr = process.stderr.read() if process.stderr else ""
                raise RuntimeError(f"CNKI MCP exited before response: {stderr.strip()}")
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if payload.get("id") == wanted_id:
                return payload


class UnavailableChineseProvider(HttpProvider):
    def __init__(self, name: str, message: str) -> None:
        self.name = name
        self.message = message

    def search(self, query: str, limit: int) -> List[Candidate]:
        raise RuntimeError(self.message)


def default_providers() -> Dict[str, HttpProvider]:
    return {
        "openalex": OpenAlexProvider(),
        "crossref": CrossrefProvider(),
        "semantic": SemanticScholarProvider(),
        "arxiv": ArxivProvider(),
    }


def domain_providers() -> Dict[str, HttpProvider]:
    return {
        "pubmed": PubMedProvider(),
        "europe-pmc": EuropePMCProvider(),
        "dblp": DBLPProvider(),
    }


def research_data_providers() -> Dict[str, HttpProvider]:
    return {
        "kaggle": KaggleProvider(),
        "zenodo": ZenodoProvider(),
        "datacite": DataCiteProvider(),
        "openml": OpenMLProvider(),
        "huggingface": HuggingFaceDatasetProvider(),
    }


def chinese_providers() -> Dict[str, HttpProvider]:
    baidu = BaiduScholarProvider()
    cnki = CNKIMcpProvider()
    # CDP fallback: when no authorized MCP command is configured, drive the
    # user's own Chrome against CNKI KNS8. Without a debuggable Chrome the
    # provider degrades to a blocked_configuration with both remedies named.
    if not (cnki.command or _command_from_env("SCANSCI_FIND_CNKI_MCP_COMMAND")):
        try:
            from scansci_find.browser_sources import CNKICdpProvider

            cnki = CNKICdpProvider()
        except ImportError:
            pass
    return {
        "baidu-scholar": baidu,
        "baidu_scholar": baidu,
        "cnki": cnki,
        "wanfang": UnavailableChineseProvider("wanfang", "Wanfang adapter is contract-only; use an authorized browser adapter when available"),
        "cqvip": UnavailableChineseProvider("cqvip", "CQVIP adapter is contract-only; use an authorized browser adapter when available"),
    }


def all_providers() -> Dict[str, HttpProvider]:
    providers = default_providers()
    providers.update(domain_providers())
    providers.update(research_data_providers())
    providers.update(chinese_providers())
    try:
        from scansci_find.browser_sources import GoogleScholarCdpProvider

        providers["google-scholar"] = GoogleScholarCdpProvider()
    except ImportError:
        pass
    return providers


def executor_workers(items: int) -> int:
    """Resolve the thread pool size for source loops.

    SCANSCI_FIND_SEARCH_WORKERS overrides the default (parallel up to 8
    workers); a value of 1 forces the serial path (useful for debugging and
    for callers that rely on strictly sequential provider calls).
    """
    raw = str(os.environ.get("SCANSCI_FIND_SEARCH_WORKERS") or "").strip()
    try:
        requested = int(raw) if raw else 0
    except ValueError:
        requested = 0
    if requested:
        return max(1, min(requested, max(1, items)))
    return min(8, max(1, items))


def search_sources_with_status(
    query: str,
    sources: Iterable[str],
    limit: int,
    providers: Optional[Dict[str, HttpProvider]] = None,
) -> Dict[str, Any]:
    available = providers or all_providers()
    requested = list(dict.fromkeys(str(source).strip() for source in sources if str(source).strip()))
    per_source = max(1, limit)

    def run_one(source: str) -> tuple[List[Candidate], Dict[str, Any]]:
        started = time.perf_counter()
        provider = available.get(source)
        if provider is None:
            return [], {"name": source, "status": "missing", "count": 0, "message": "source is not configured", "elapsed_ms": 0}
        try:
            if hasattr(provider, "last_search_metadata"):
                provider.last_search_metadata = {}
            rows = provider.search(query, per_source)
            metadata = dict(getattr(provider, "last_search_metadata", {}) or {})
            return rows, {
                "name": source,
                "status": "ok",
                "count": len(rows),
                "message": "",
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
                "pagination_complete": bool(metadata.get("pagination_complete")),
                "retrieval": metadata,
            }
        except Exception as exc:
            return [], {
                "name": source,
                "status": getattr(exc, "status", "error"),
                "count": 0,
                "error_type": type(exc).__name__,
                "message": str(exc),
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
            }

    workers = executor_workers(len(requested))
    if workers <= 1:
        results = [run_one(source) for source in requested]
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(run_one, requested))
    candidates: List[Candidate] = []
    source_status: List[Dict[str, Any]] = []
    for rows, status in results:
        candidates.extend(rows)
        source_status.append(status)
    return {"candidates": candidates, "source_status": source_status}


def search_sources(query: str, sources: Iterable[str], limit: int) -> List[Candidate]:
    return search_sources_with_status(query, sources, limit)["candidates"]


def estimate_sources_with_status(
    query: str,
    sources: Iterable[str],
    providers: Optional[Dict[str, HttpProvider]] = None,
) -> Dict[str, Any]:
    """Run the smallest real request needed to estimate source hit counts."""

    available = providers or all_providers()
    requested = list(dict.fromkeys(str(item).strip() for item in sources if str(item).strip()))

    def run_one(source: str) -> tuple[Dict[str, Any], Dict[str, Any]]:
        started = time.perf_counter()
        provider = available.get(source)
        if provider is None:
            status = {"name": source, "status": "missing", "count": 0, "message": "source is not configured", "elapsed_ms": 0}
            return status, {"source": source, "estimated_hits": None, "estimate_status": "missing"}
        try:
            if hasattr(provider, "last_search_metadata"):
                provider.last_search_metadata = {}
            rows = provider.search(query, 1)
            metadata = dict(getattr(provider, "last_search_metadata", {}) or {})
            estimated = metadata.get("total_available")
            status = {
                "name": source,
                "status": "ok",
                "count": len(rows),
                "message": "",
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
                "retrieval": metadata,
            }
            estimate = {
                "source": source,
                "estimated_hits": int(estimated) if estimated is not None else None,
                "estimate_status": "reported" if estimated is not None else "unknown",
            }
            return status, estimate
        except Exception as exc:
            status_name = getattr(exc, "status", "error")
            status = {
                "name": source,
                "status": status_name,
                "count": 0,
                "error_type": type(exc).__name__,
                "message": str(exc),
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
            }
            return status, {"source": source, "estimated_hits": None, "estimate_status": status_name}

    workers = executor_workers(len(requested))
    if workers <= 1:
        results = [run_one(source) for source in requested]
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(run_one, requested))
    source_status = [status for status, _ in results]
    estimates = [estimate for _, estimate in results]
    known = [item["estimated_hits"] for item in estimates if item["estimated_hits"] is not None]
    return {
        "query": query,
        "estimates": estimates,
        "source_status": source_status,
        "known_source_total": sum(known),
        "known_source_count": len(known),
        "unknown_source_count": len(estimates) - len(known),
    }


def search_query_variants_with_status(
    queries: Iterable[str],
    sources: Iterable[str],
    max_records_per_source: int,
    providers: Optional[Dict[str, HttpProvider]] = None,
) -> Dict[str, Any]:
    query_list = list(dict.fromkeys(str(query).strip() for query in queries if str(query).strip()))
    if not query_list:
        raise ValueError("at least one query variant is required")
    source_list = list(dict.fromkeys(str(source).strip() for source in sources if str(source).strip()))
    available = providers or all_providers()
    per_query_limit = max(1, math.ceil(max(1, max_records_per_source) / len(query_list)))

    def run_one(source: str) -> tuple[List[Candidate], Dict[str, Any]]:
        provider = available.get(source)
        if provider is None:
            return [], {
                "name": source,
                "status": "missing",
                "count": 0,
                "message": "source is not configured",
                "elapsed_ms": 0,
                "pagination_complete": False,
                "queries": [],
            }
        started = time.perf_counter()
        source_rows: List[Candidate] = []
        query_reports = []
        for query in query_list:
            try:
                if hasattr(provider, "last_search_metadata"):
                    provider.last_search_metadata = {}
                rows = provider.search(query, per_query_limit)
                metadata = dict(getattr(provider, "last_search_metadata", {}) or {})
                for row in rows:
                    row.setdefault("retrieval_queries", [])
                    if query not in row["retrieval_queries"]:
                        row["retrieval_queries"].append(query)
                source_rows.extend(rows)
                query_reports.append(
                    {
                        "query": query,
                        "status": "ok",
                        "count": len(rows),
                        "message": "",
                        "pagination_complete": bool(metadata.get("pagination_complete")),
                        "retrieval": metadata,
                    }
                )
            except Exception as exc:
                query_reports.append(
                    {
                        "query": query,
                        "status": getattr(exc, "status", "error"),
                        "count": 0,
                        "error_type": type(exc).__name__,
                        "message": str(exc),
                    }
                )
        successful = [item for item in query_reports if item["status"] == "ok"]
        failed = [item for item in query_reports if item["status"] != "ok"]
        status = "ok" if successful and not failed else "partial" if successful else "error"
        if not successful and failed and len({item["status"] for item in failed}) == 1:
            status = failed[0]["status"]
        return source_rows[:max_records_per_source], {
            "name": source,
            "status": status,
            "count": min(len(source_rows), max_records_per_source),
            "message": "; ".join(item["message"] for item in failed if item.get("message")),
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
            "pagination_complete": bool(successful) and not failed and all(
                item.get("pagination_complete") is True for item in successful
            ),
            "queries": query_reports,
        }

    workers = executor_workers(len(source_list))
    if workers <= 1:
        results = [run_one(source) for source in source_list]
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(run_one, source_list))
    candidates: List[Candidate] = []
    source_status: List[Dict[str, Any]] = []
    for rows, status in results:
        candidates.extend(rows)
        source_status.append(status)
    return {"candidates": candidates, "source_status": source_status, "query_variants": query_list}
