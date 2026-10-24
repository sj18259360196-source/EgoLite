"""Deterministic query-term expansion for broader recall.

Expansion is a pure function of the input terms and the domain, so protocol
fingerprints stay stable: identical terms plus identical domain always expand
the same way. Built-in tables cover common abbreviations (bidirectional) and a
small set of unambiguous discipline synonyms; users can extend the vocabulary
with JSON files (``{"pairs": {...}, "synonyms": {...}}``) loaded from
``SCANSCI_FIND_VOCAB_DIR``.

Expansion only ever adds terms — it never renames or drops a user term — and
keeps the first occurrence order stable.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

#: Common abbreviation -> full form. Expansion is bidirectional: entering
#: either side of a pair adds the other.
GLOBAL_ABBREVIATIONS: Dict[str, str] = {
    "ai": "artificial intelligence",
    "ml": "machine learning",
    "dl": "deep learning",
    "llm": "large language model",
    "icl": "in-context learning",
    "rag": "retrieval augmented generation",
    "gpt": "generative pre-trained transformer",
    "nn": "neural network",
    "nlp": "natural language processing",
    "cv": "computer vision",
    "rl": "reinforcement learning",
    "gnn": "graph neural network",
    "cnn": "convolutional neural network",
    "rnn": "recurrent neural network",
    "gan": "generative adversarial network",
    "vae": "variational autoencoder",
    "ts": "time series",
    "mri": "magnetic resonance imaging",
    "fmri": "functional magnetic resonance imaging",
    "dti": "diffusion tensor imaging",
    "ct": "computed tomography",
    "ehr": "electronic health record",
    "icu": "intensive care unit",
    "rct": "randomized controlled trial",
    "pet": "positron emission tomography",
}

#: Unambiguous per-discipline synonyms (term -> additional search terms).
#: Deliberately small: recall pollution from loose synonyms is worse than
#: missing an edge case, so only near-equivalent pairs are curated here.
DOMAIN_SYNONYMS: Dict[str, Dict[str, List[str]]] = {
    "medicine": {
        "stroke": ["cerebrovascular accident"],
        "tumor": ["neoplasm"],
        "tumour": ["neoplasm"],
        "myocardial infarction": ["heart attack"],
    },
    "computer_science": {
        "pretraining": ["pre-training"],
        "transfer learning": ["knowledge transfer"],
    },
    "environmental_science": {
        "climate change": ["global warming"],
        "carbon emission": ["carbon dioxide emission"],
    },
}


def _merge_vocab(extra: Optional[Dict[str, Any]] = None) -> Dict[str, List[str]]:
    vocab: Dict[str, List[str]] = {}
    for key, value in GLOBAL_ABBREVIATIONS.items():
        vocab.setdefault(key, [])
        if value not in vocab[key]:
            vocab[key].append(value)
        vocab.setdefault(value, [])
        if key not in vocab[value]:
            vocab[value].append(key)
    for key, synonyms in (extra or {}).items():
        for synonym in synonyms or []:
            if synonym and synonym not in vocab.setdefault(key, []):
                vocab[key].append(synonym)
    return vocab


def _domain_vocab(domain: str) -> Dict[str, List[str]]:
    vocab = _merge_vocab()
    for key, synonyms in (DOMAIN_SYNONYMS.get(domain) or {}).items():
        for synonym in synonyms:
            if synonym and synonym not in vocab.setdefault(key, []):
                vocab[key].append(synonym)
    return vocab


@lru_cache(maxsize=8)
def _user_vocab(directory: str) -> Dict[str, Any]:
    """Load user vocabulary JSON files from a directory (cached)."""
    merged: Dict[str, List[str]] = {}
    root = Path(directory)
    if not root.is_dir():
        return merged
    for path in sorted(root.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for key, value in (payload.get("pairs") or {}).items():
            merged.setdefault(str(key).casefold(), [])
            if str(value).casefold() not in merged[str(key).casefold()]:
                merged[str(key).casefold()].append(str(value).casefold())
        for key, values in (payload.get("synonyms") or {}).items():
            for value in values or []:
                if str(value).casefold() not in merged.setdefault(str(key).casefold(), []):
                    merged[str(key).casefold()].append(str(value).casefold())
    return merged


def load_user_vocab(directory: Optional[str] = None) -> Dict[str, Any]:
    """Load user vocabulary files; returns an empty dict when unconfigured."""
    directory = directory or os.environ.get("SCANSCI_FIND_VOCAB_DIR") or ""
    if not directory:
        return {}
    return _user_vocab(directory)


def expand_terms(
    terms: Iterable[str],
    domain: str = "general",
    extra_vocab: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """Append deterministic expansions for each term, preserving first order.

    Builtin abbreviation pairs apply bidirectionally; domain synonyms apply
    per profile; user vocab (from ``extra_vocab`` or ``SCANSCI_FIND_VOCAB_DIR``)
    is merged last.
    """
    out: List[str] = []
    seen: set[str] = set()
    vocab = _domain_vocab(domain)
    for key, values in (extra_vocab or {}).items():
        for value in values or []:
            if value not in vocab.setdefault(key, []):
                vocab[key].append(value)
    for term in terms:
        text = str(term or "").strip()
        if not text:
            continue
        key = text.casefold()
        if key not in seen:
            seen.add(key)
            out.append(text)
        for addition in vocab.get(key, []):
            if addition not in seen:
                seen.add(addition)
                out.append(addition)
    return out
