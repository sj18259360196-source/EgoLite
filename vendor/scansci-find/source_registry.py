from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Dict, Iterable, List, Sequence


@dataclass(frozen=True)
class SourceSpec:
    name: str
    label: str
    role: str
    domains: tuple[str, ...]
    capabilities: tuple[str, ...]
    access: str
    implementation: str
    tier: str = "domain"
    notes: str = ""

    @property
    def executable(self) -> bool:
        return self.implementation in {"native", "external_mcp", "cdp"} and "search" in self.capabilities

    @property
    def support_executable(self) -> bool:
        return self.implementation in {"native", "external_mcp"} and "search" not in self.capabilities

    def to_dict(self) -> Dict[str, object]:
        payload = asdict(self)
        payload["domains"] = list(self.domains)
        payload["capabilities"] = list(self.capabilities)
        payload["executable"] = self.executable
        payload["support_executable"] = self.support_executable
        return payload


def _spec(
    name: str,
    label: str,
    role: str,
    domains: Sequence[str],
    capabilities: Sequence[str],
    access: str,
    implementation: str,
    tier: str = "domain",
    notes: str = "",
) -> SourceSpec:
    return SourceSpec(
        name=name,
        label=label,
        role=role,
        domains=tuple(domains),
        capabilities=tuple(capabilities),
        access=access,
        implementation=implementation,
        tier=tier,
        notes=notes,
    )


SOURCE_CATALOG: Dict[str, SourceSpec] = {
    # Open, cross-disciplinary metadata backbone.
    "openalex": _spec(
        "openalex",
        "OpenAlex",
        "discovery_graph",
        ["all"],
        ["search", "citations", "oa_links"],
        "free_api_key_required",
        "native",
        "core",
        "All API calls require OPENALEX_API_KEY since 2026-02-13.",
    ),
    "crossref": _spec("crossref", "Crossref", "metadata_verification", ["all"], ["search", "doi_verify", "metadata_enrich"], "open", "native", "core"),
    "semantic": _spec("semantic", "Semantic Scholar", "discovery_graph", ["all"], ["search", "citations", "oa_links"], "open_rate_limited", "native", "core"),
    "core": _spec("core", "CORE", "repository_fulltext", ["all"], ["search", "oa_links", "fulltext"], "optional_api_key", "contract", "supplemental"),
    "base": _spec("base", "BASE", "repository_discovery", ["all"], ["search", "oa_links"], "open", "contract", "supplemental"),
    "openaire": _spec("openaire", "OpenAIRE", "repository_discovery", ["all"], ["search", "oa_links"], "open", "contract", "supplemental"),
    "doaj": _spec("doaj", "DOAJ", "oa_journal_discovery", ["all"], ["search", "oa_links"], "open", "contract", "supplemental"),
    "hal": _spec("hal", "HAL", "repository_discovery", ["all"], ["search", "oa_links", "fulltext"], "open", "contract", "supplemental"),
    "osf-preprints": _spec("osf-preprints", "OSF Preprints", "preprint_discovery", ["all"], ["search", "oa_links", "fulltext"], "open", "contract", "supplemental"),
    "scielo": _spec("scielo", "SciELO", "regional_open_index", ["all", "social_sciences", "humanities", "public_health"], ["search", "oa_links", "fulltext"], "open", "contract", "supplemental"),
    "redalyc": _spec("redalyc", "Redalyc", "regional_open_index", ["social_sciences", "humanities", "public_health"], ["search", "oa_links", "fulltext"], "open", "contract", "supplemental"),
    "opencitations": _spec("opencitations", "OpenCitations", "citation_infrastructure", ["all"], ["citations", "metadata_enrich"], "open", "native", "supplemental"),
    "unpaywall": _spec("unpaywall", "Unpaywall", "oa_resolution", ["all"], ["oa_links", "fulltext"], "email_required", "native", "supplemental"),
    "zenodo": _spec("zenodo", "Zenodo", "grey_literature_data", ["all", "research_data"], ["search", "fulltext", "datasets"], "open", "native", "supplemental"),
    "datacite": _spec("datacite", "DataCite", "research_object_metadata", ["all", "research_data"], ["search", "doi_verify", "datasets"], "open", "native", "supplemental"),

    # Discipline adapters. Medicine is supported but is not the default identity.
    "arxiv": _spec("arxiv", "arXiv", "preprint", ["computer_science", "engineering", "natural_sciences", "environmental_science"], ["search", "fulltext"], "open", "native", "domain"),
    "dblp": _spec("dblp", "DBLP", "computer_science_bibliography", ["computer_science"], ["search", "metadata_enrich"], "open", "native", "domain"),
    "openreview": _spec("openreview", "OpenReview", "conference_grey_literature", ["computer_science"], ["search", "reviews", "fulltext"], "open", "contract", "domain"),
    "cvf": _spec("cvf", "CVF Open Access", "computer_vision_proceedings", ["computer_science"], ["search", "fulltext"], "open", "contract", "domain"),
    "pubmed": _spec("pubmed", "PubMed", "biomedical_index", ["medicine", "life_sciences", "public_health"], ["search", "controlled_vocabulary", "metadata_enrich"], "open", "native", "domain"),
    "europe-pmc": _spec("europe-pmc", "Europe PMC", "biomedical_fulltext", ["medicine", "life_sciences", "public_health"], ["search", "citations", "oa_links", "fulltext"], "open", "native", "domain"),
    "biorxiv": _spec("biorxiv", "bioRxiv", "life_science_preprint", ["life_sciences", "medicine"], ["search", "fulltext"], "open", "contract", "supplemental"),
    "medrxiv": _spec("medrxiv", "medRxiv", "medical_preprint", ["medicine", "public_health"], ["search", "fulltext"], "open", "contract", "supplemental"),
    "clinicaltrials": _spec("clinicaltrials", "ClinicalTrials.gov", "clinical_trials", ["medicine", "public_health"], ["search", "study_records"], "open", "contract", "supplemental"),
    "zbmath-open": _spec("zbmath-open", "zbMATH Open", "mathematics_bibliography", ["mathematics"], ["search", "metadata_enrich"], "open", "contract", "domain"),
    "mathscinet": _spec("mathscinet", "MathSciNet", "mathematics_bibliography", ["mathematics"], ["search", "reviews"], "institution", "contract", "domain"),
    "nasa-ads": _spec("nasa-ads", "NASA ADS", "astronomy_physics_index", ["physics_astronomy"], ["search", "citations", "metadata_enrich"], "api_token", "contract", "domain"),
    "inspire-hep": _spec("inspire-hep", "INSPIRE HEP", "high_energy_physics_index", ["physics_astronomy"], ["search", "citations", "metadata_enrich"], "open", "contract", "domain"),
    "chemrxiv": _spec("chemrxiv", "ChemRxiv", "chemistry_preprint", ["chemistry_materials"], ["search", "fulltext"], "open", "contract", "domain"),
    "agricola": _spec("agricola", "AGRICOLA", "agriculture_index", ["agriculture", "life_sciences"], ["search", "metadata_enrich"], "open", "contract", "domain"),
    "eric": _spec("eric", "ERIC", "education_index", ["education", "social_sciences"], ["search", "metadata_enrich", "fulltext"], "open", "contract", "domain"),
    "psycinfo": _spec("psycinfo", "APA PsycInfo", "psychology_index", ["psychology", "social_sciences"], ["search", "metadata_enrich"], "institution", "contract", "domain"),
    "ssrn": _spec("ssrn", "SSRN", "social_science_preprint", ["social_sciences", "law", "economics"], ["search", "fulltext"], "mixed", "contract", "domain"),
    "repec": _spec("repec", "RePEc", "economics_bibliography", ["economics", "social_sciences"], ["search", "metadata_enrich"], "open", "contract", "domain"),
    "jstor": _spec("jstor", "JSTOR", "humanities_social_sciences", ["humanities", "social_sciences"], ["search", "fulltext"], "institution", "contract", "domain"),
    "doab": _spec("doab", "DOAB", "open_access_books", ["humanities", "social_sciences"], ["search", "oa_links", "fulltext"], "open", "contract", "domain"),
    "worldcat": _spec("worldcat", "WorldCat", "books_library_catalog", ["humanities", "social_sciences"], ["search", "metadata_enrich"], "api_or_browser", "contract", "domain"),
    "proquest-dissertations": _spec("proquest-dissertations", "ProQuest Dissertations & Theses", "theses_dissertations", ["all"], ["search", "export", "fulltext"], "institution", "contract", "supplemental"),

    # Chinese and regional indexes.
    "baidu-scholar": _spec("baidu-scholar", "Baidu Scholar", "chinese_discovery", ["chinese_general", "all"], ["search", "metadata_enrich"], "api_key", "native", "domain"),
    "cnki": _spec("cnki", "CNKI", "chinese_database", ["chinese_general", "all"], ["search", "export", "fulltext"], "institution_or_login", "external_mcp", "domain", "Uses an authorized external MCP command."),
    "nssd": _spec("nssd", "NSSD", "chinese_open_discovery", ["chinese_general", "social_sciences", "humanities"], ["search", "metadata_enrich"], "open_or_login", "contract", "domain"),
    "wanfang": _spec("wanfang", "Wanfang", "chinese_database", ["chinese_general", "all"], ["search", "export", "fulltext"], "institution_or_login", "contract", "domain"),
    "cqvip": _spec("cqvip", "CQVIP", "chinese_database", ["chinese_general", "all"], ["search", "export", "fulltext"], "institution_or_login", "contract", "domain"),

    # Commercial or browser-backed discovery sources.
    "google-scholar": _spec("google-scholar", "Google Scholar", "broad_discovery_fallback", ["all"], ["search", "citations", "versions"], "browser", "cdp", "supplemental", "EgoLite Task Space adapter with Chrome CDP fallback; never bypasses CAPTCHA or login walls."),
    "web-of-science": _spec("web-of-science", "Web of Science", "curated_citation_index", ["all"], ["search", "citations", "export"], "institution", "contract", "supplemental"),
    "scopus": _spec("scopus", "Scopus", "curated_citation_index", ["all"], ["search", "citations", "export"], "institution", "contract", "supplemental"),
    "dimensions": _spec("dimensions", "Dimensions", "curated_research_index", ["all"], ["search", "citations", "grants", "datasets"], "account_or_institution", "contract", "supplemental"),
    "lens": _spec("lens", "The Lens", "scholarly_patent_index", ["all", "engineering", "law"], ["search", "citations", "patents", "export"], "account_or_institution", "contract", "supplemental"),
    "science-direct": _spec("science-direct", "ScienceDirect", "publisher_platform", ["all"], ["search", "fulltext"], "institution_or_login", "contract", "supplemental"),
    "ieee-xplore": _spec("ieee-xplore", "IEEE Xplore", "engineering_database", ["engineering", "computer_science"], ["search", "citations", "fulltext"], "api_key_or_institution", "contract", "supplemental"),
    "acm-dl": _spec("acm-dl", "ACM Digital Library", "computer_science_database", ["computer_science"], ["search", "citations", "fulltext"], "institution", "contract", "supplemental"),

    # Research data and software sources.
    "openml": _spec("openml", "OpenML", "ml_dataset_benchmark", ["research_data", "computer_science"], ["search", "datasets", "benchmarks"], "open", "native", "domain"),
    "huggingface": _spec("huggingface", "Hugging Face Datasets", "ml_dataset", ["research_data", "computer_science"], ["search", "datasets"], "open", "native", "domain"),
    "kaggle": _spec("kaggle", "Kaggle", "dataset", ["research_data", "computer_science"], ["search", "datasets"], "api_key", "native", "domain"),
    "github": _spec("github", "GitHub", "software_discovery", ["research_data", "computer_science", "engineering"], ["search", "software"], "optional_login", "contract", "supplemental"),
}


SOURCE_ALIASES = {
    "semantic-scholar": "semantic",
    "semantic_scholar": "semantic",
    "europepmc": "europe-pmc",
    "europe_pmc": "europe-pmc",
    "baidu_scholar": "baidu-scholar",
    "google_scholar": "google-scholar",
    "wos": "web-of-science",
    "science_direct": "science-direct",
    "ads": "nasa-ads",
    "zbmath": "zbmath-open",
    "proquest": "proquest-dissertations",
    "vip": "cqvip",
}


DOMAIN_PROFILES: Dict[str, Dict[str, object]] = {
    "general": {"framework": "concept-blocks", "sources": ["openalex", "crossref", "semantic"]},
    "interdisciplinary": {"framework": "concept-blocks", "sources": ["openalex", "crossref", "semantic", "arxiv", "zenodo"]},
    "computer_science": {"framework": "problem-method-dataset-metric", "sources": ["openalex", "crossref", "semantic", "arxiv", "dblp", "openreview", "cvf", "acm-dl"]},
    "engineering": {"framework": "problem-method-system-metric", "sources": ["openalex", "crossref", "semantic", "arxiv", "ieee-xplore"]},
    "natural_sciences": {"framework": "concept-blocks", "sources": ["openalex", "crossref", "semantic", "arxiv", "zenodo"]},
    "mathematics": {"framework": "concept-blocks", "sources": ["openalex", "crossref", "semantic", "arxiv", "zbmath-open", "mathscinet"]},
    "physics_astronomy": {"framework": "concept-blocks", "sources": ["openalex", "crossref", "semantic", "arxiv", "nasa-ads", "inspire-hep"]},
    "chemistry_materials": {"framework": "concept-blocks", "sources": ["openalex", "crossref", "semantic", "chemrxiv", "science-direct"]},
    "earth_sciences": {"framework": "concept-blocks", "optional_frameworks": ["PECO"], "sources": ["openalex", "crossref", "semantic", "arxiv", "zenodo"]},
    "agriculture": {"framework": "concept-blocks", "optional_frameworks": ["PECO"], "sources": ["openalex", "crossref", "semantic", "agricola", "zenodo"]},
    "medicine": {"framework": "concept-blocks", "optional_frameworks": ["PICO", "PECO"], "sources": ["openalex", "crossref", "semantic", "pubmed", "europe-pmc", "medrxiv", "clinicaltrials"]},
    "life_sciences": {"framework": "concept-blocks", "optional_frameworks": ["PICO", "PECO"], "sources": ["openalex", "crossref", "semantic", "pubmed", "europe-pmc", "biorxiv"]},
    "public_health": {"framework": "concept-blocks", "optional_frameworks": ["PICO", "PECO"], "sources": ["openalex", "crossref", "semantic", "pubmed", "europe-pmc", "clinicaltrials"]},
    "social_sciences": {"framework": "concept-blocks", "optional_frameworks": ["SPIDER", "PICo"], "sources": ["openalex", "crossref", "semantic", "ssrn", "nssd", "jstor"]},
    "education": {"framework": "concept-blocks", "optional_frameworks": ["SPIDER"], "sources": ["openalex", "crossref", "semantic", "eric"]},
    "psychology": {"framework": "concept-blocks", "optional_frameworks": ["PICO", "SPIDER"], "sources": ["openalex", "crossref", "semantic", "psycinfo"]},
    "law": {"framework": "concept-blocks", "sources": ["openalex", "crossref", "semantic", "ssrn", "lens"]},
    "humanities": {"framework": "concept-blocks", "sources": ["openalex", "crossref", "google-scholar", "jstor", "nssd", "doab", "worldcat"]},
    "economics": {"framework": "concept-blocks", "sources": ["openalex", "crossref", "semantic", "repec", "ssrn"]},
    "environmental_science": {"framework": "concept-blocks", "optional_frameworks": ["PECO"], "sources": ["openalex", "crossref", "semantic", "arxiv", "zenodo"]},
    "chinese_general": {"framework": "concept-blocks", "sources": ["openalex", "crossref", "semantic", "baidu-scholar", "cnki", "nssd", "wanfang", "cqvip"]},
    "research_data": {"framework": "problem-object-license-version", "sources": ["zenodo", "datacite", "openml", "huggingface", "kaggle", "github"]},
}


DEPTH_PROFILES: Dict[str, Dict[str, object]] = {
    "quick": {"max_records_per_source": 20, "citation_rounds": 0, "tiers": ["core"]},
    "standard": {"max_records_per_source": 100, "citation_rounds": 1, "tiers": ["core", "domain"]},
    "systematic": {"max_records_per_source": 500, "citation_rounds": 3, "tiers": ["core", "domain", "supplemental"]},
}


SUPPORT_SOURCE_ROUTES: Dict[str, List[str]] = {
    "identity_metadata": ["crossref", "datacite"],
    "citation_expansion": ["semantic", "opencitations"],
    "oa_resolution": ["openalex", "unpaywall", "core", "openaire"],
}


def canonical_source_name(name: str) -> str:
    key = str(name or "").strip().casefold().replace(" ", "-")
    return SOURCE_ALIASES.get(key, key)


def get_source(name: str) -> SourceSpec | None:
    return SOURCE_CATALOG.get(canonical_source_name(name))


def list_sources() -> List[Dict[str, object]]:
    return [SOURCE_CATALOG[name].to_dict() for name in sorted(SOURCE_CATALOG)]


def list_domains() -> List[Dict[str, object]]:
    return [{"name": name, **profile} for name, profile in DOMAIN_PROFILES.items()]


def route_sources(
    domain: str = "general",
    depth: str = "standard",
    requested: Iterable[str] | None = None,
) -> Dict[str, List[str]]:
    domain_key = str(domain or "general").casefold()
    depth_key = str(depth or "standard").casefold()
    if domain_key not in DOMAIN_PROFILES:
        raise ValueError(f"Unknown domain profile: {domain}")
    if depth_key not in DEPTH_PROFILES:
        raise ValueError(f"Unknown search depth: {depth}")

    if requested:
        planned = list(dict.fromkeys(canonical_source_name(name) for name in requested if str(name).strip()))
    else:
        planned = list(DOMAIN_PROFILES[domain_key]["sources"])
        if depth_key == "systematic":
            planned.extend(
                [
                    "core",
                    "base",
                    "openaire",
                    "doaj",
                    "hal",
                    "osf-preprints",
                    "scielo",
                    "google-scholar",
                    "web-of-science",
                    "scopus",
                    "dimensions",
                    "lens",
                    "proquest-dissertations",
                ]
            )
        planned = list(dict.fromkeys(planned))

    executable = [name for name in planned if (SOURCE_CATALOG.get(name) and SOURCE_CATALOG[name].executable)]
    conditional = [name for name in planned if name not in executable and name in SOURCE_CATALOG]
    unknown = [name for name in planned if name not in SOURCE_CATALOG]
    return {"planned": planned, "executable": executable, "conditional": conditional, "unknown": unknown}
