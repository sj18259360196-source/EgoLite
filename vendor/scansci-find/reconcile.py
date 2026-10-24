"""Write actual download outcomes back into the candidate set.

Reads scansci-pdf's ``download_results.json`` (written by ``batch`` and
``manifest``) and updates ``candidates.json`` so the full-text status reflects
reality rather than prediction:

- success            -> ``downloaded`` (plus the winning source)
- paywall/login      -> ``needs_institution``
- Cloudflare/captcha -> ``anti_bot_blocked``
- HTML/not-a-PDF     -> ``html_not_pdf``

Evidence dimensions are recomputed and the affected artifacts are rewritten
in place; a ``reconcile_report.json`` records what changed.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

from scansci_find.adapters import normalize_arxiv_id, normalize_doi
from scansci_find.evidence import attach_evidence_dimensions
from scansci_find.outputs import render_papers_md, write_evidence_table

#: (error_type values, resulting access_status)
FAILURE_STATUS_RULES: List[tuple[tuple[str, ...], str]] = [
    (("paywall", "login_required", "forbidden"), "needs_institution"),
    (("cloudflare_blocked", "captcha", "rate_limited"), "anti_bot_blocked"),
    (("suspicious_pdf", "not_pdf"), "html_not_pdf"),
]


def _failure_status(entry: Dict[str, Any]) -> str:
    error_type = str(entry.get("error_type") or "").casefold()
    reason = str(entry.get("reason") or "").casefold()
    for kinds, status in FAILURE_STATUS_RULES:
        if error_type in kinds:
            return status
    if "html" in reason or "not a pdf" in reason or "not pdf" in reason:
        return "html_not_pdf"
    return ""


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _identifier_key(identifier: str, doi: str = "") -> str:
    return normalize_doi(doi) or normalize_doi(identifier) or normalize_arxiv_id(identifier) or ""


def reconcile(runs_dir: str | Path) -> Dict[str, Any]:
    out = Path(runs_dir)
    results_payload = _read_json(out / "download_results.json", {})
    entries = results_payload.get("entries") if isinstance(results_payload, dict) else results_payload
    candidates: List[Dict[str, Any]] = _read_json(out / "candidates.json", [])
    if not isinstance(entries, list) or not isinstance(candidates, list):
        return {"error": "runs dir must contain download_results.json and candidates.json", "updated": 0}

    by_key = {_identifier_key(str(entry.get("identifier") or ""), str(entry.get("doi") or "")): entry for entry in entries}
    status_counts: Counter[str] = Counter()
    updated = 0
    for candidate in candidates:
        key = _identifier_key(candidate.get("doi") or "", candidate.get("doi") or "") or _identifier_key(candidate.get("arxiv_id") or "")
        entry = by_key.get(key)
        if not entry:
            continue
        access = dict(candidate.get("access") or {})
        if entry.get("success"):
            access["access_status"] = "downloaded"
            access["download_source"] = str(entry.get("source") or "")
        else:
            status = _failure_status(entry)
            if status:
                access["access_status"] = status
        access["download_checked"] = True
        candidate["access"] = access
        status_counts[access["access_status"]] += 1
        updated += 1

    attach_evidence_dimensions(candidates)
    (out / "candidates.json").write_text(json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "candidates.jsonl").write_text(
        "".join(json.dumps(candidate, ensure_ascii=False) + "\n" for candidate in candidates),
        encoding="utf-8",
    )
    write_evidence_table(candidates, out / "evidence_table.csv")
    protocol = _read_json(out / "protocol.json", {})
    (out / "papers.md").write_text(render_papers_md(candidates, str(protocol.get("query") or "reconciled")), encoding="utf-8")

    report: Dict[str, Any] = {
        "candidates": len(candidates),
        "results_entries": len(entries),
        "updated": updated,
        "status_counts": dict(sorted(status_counts.items())),
        "downloaded": status_counts.get("downloaded", 0),
    }
    (out / "reconcile_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report
