from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from scansci_find import __version__


# Journal Scout accepts journal-quality filters only. Retrieval filters such as
# ``year``, ``doc_type``, and ``field`` are applied locally by the service and
# must never be forwarded to the gateway.
JOURNAL_SCOUT_FILTER_KEYS = {
    "cas_2025",
    "jcr_quartile",
    "hq_levels",
    "hq_catalog",
    "hq_field_keywords",
    "exclude_warning",
    "min_if",
    "is_top",
    "xuankan_2026",
    "pku_core",
    "cssci_type",
    "cscd_type",
    "ei_indexed",
    "xuankan_warning",
}


def _scout_filters(filters: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not filters:
        return None
    supported = {key: value for key, value in filters.items() if key in JOURNAL_SCOUT_FILTER_KEYS}
    return supported or None


class JournalScoutMcpGateway:
    version = ""
    data_sha256 = ""

    def __init__(
        self,
        command: Optional[List[str]] = None,
        cwd: Optional[str] = None,
        data_path: Optional[str] = None,
    ) -> None:
        self.cwd = cwd or os.environ.get("JOURNAL_SCOUT_REPO") or r"D:\scansci\journal-scout"
        self.data_path = data_path or os.environ.get("JOURNAL_SCOUT_DATA_PATH") or str(Path(self.cwd) / "data" / "journals.json")
        self.command = command or [sys.executable, "-m", "journal_scout_mcp", "--data-path", self.data_path]

    def health_check(self) -> Dict[str, Any]:
        payload = self.call_tool("health_check", {})
        self.version = payload.get("server_version") or payload.get("version") or self.version
        data = payload.get("data") or {}
        self.data_sha256 = data.get("sha256") or self.data_sha256
        return payload

    def screen_papers(self, papers: List[Dict[str, Any]], policy: Optional[str] = None, filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        args: Dict[str, Any] = {"papers": papers}
        if policy:
            args["policy"] = policy
        scout_filters = _scout_filters(filters)
        if scout_filters:
            args["filters"] = scout_filters
        return self.call_tool("screen_papers", args)

    def explain_journal(self, candidate: Dict[str, Any], policy: Optional[str] = None, filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        args: Dict[str, Any] = {
            "query": candidate.get("journal") or candidate.get("title") or "",
            "issn": candidate.get("issn") or candidate.get("eissn") or "",
        }
        if policy:
            args["policy"] = policy
        scout_filters = _scout_filters(filters)
        if scout_filters:
            args["filters"] = scout_filters
        return self.call_tool("explain_journal", args)

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        env = os.environ.copy()
        env.setdefault("PYTHONIOENCODING", "utf-8")
        process = subprocess.Popen(
            self.command,
            cwd=self.cwd if Path(self.cwd).exists() else None,
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
                raise RuntimeError(result["error"].get("message") or "Journal Scout MCP error")
            payload = result.get("result") or {}
            if payload.get("isError"):
                structured = payload.get("structuredContent") or {}
                raise RuntimeError(structured.get("message") or "Journal Scout MCP tool error")
            return payload.get("structuredContent") or {}
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
                raise RuntimeError(f"Journal Scout MCP exited before response: {stderr.strip()}")
            payload = json.loads(line)
            if payload.get("id") == wanted_id:
                return payload


class OptionalJournalScoutGateway:
    """Keep retrieval usable when the optional Journal Scout is absent."""

    version = "unavailable"
    data_sha256 = ""

    def __init__(self, gateway: Optional[Any] = None) -> None:
        self.gateway = gateway or JournalScoutMcpGateway()
        self._error = ""

    def health_check(self) -> Dict[str, Any]:
        if self._error:
            return self._unavailable_health()
        try:
            return self.gateway.health_check()
        except Exception as exc:
            self._error = str(exc)
            return self._unavailable_health()

    def _unavailable_health(self) -> Dict[str, Any]:
        return {
            "status": "blocked_configuration",
            "server_version": self.version,
            "data": {"sha256": "", "journal_count": 0},
            "error": self._error,
        }

    def screen_papers(self, papers: List[Dict[str, Any]], policy: Optional[str] = None, filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self._error:
            try:
                return self.gateway.screen_papers(papers, policy=policy, filters=filters)
            except Exception as exc:
                self._error = str(exc)
        return {
            "status": "blocked_configuration",
            "data": {"sha256": "", "journal_count": 0},
            "results": [
                {
                    "paper": paper,
                    "passed": False,
                    "policy_result": {
                        "policy": policy or "custom_filters",
                        "pass": False,
                        "reasons": ["Journal Scout unavailable; journal-level quality was not evaluated"],
                    },
                }
                for paper in papers
            ],
            "error": self._error,
        }

    def explain_journal(self, candidate: Dict[str, Any], policy: Optional[str] = None, filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self._error:
            try:
                return self.gateway.explain_journal(candidate, policy=policy, filters=filters)
            except Exception as exc:
                self._error = str(exc)
        return {"status": "blocked_configuration", "error": self._error, "candidate": candidate}


class FixtureJournalScoutGateway:
    def __init__(self, fixture: Dict[str, Any]) -> None:
        section = fixture.get("journal_scout") or {}
        self.version = section.get("version") or "fixture"
        self.data_sha256 = section.get("data_sha256") or ""
        self._results = list(section.get("results") or [])

    def health_check(self) -> Dict[str, Any]:
        return {"server_version": self.version, "data": {"sha256": self.data_sha256, "journal_count": len(self._results)}}

    def screen_papers(self, papers: List[Dict[str, Any]], policy: Optional[str] = None, filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        rows = []
        for index, paper in enumerate(papers):
            row = dict(self._results[index]) if index < len(self._results) else {}
            row.setdefault("paper", paper)
            rows.append(row)
        return {"policy": policy, "data": {"sha256": self.data_sha256}, "results": rows, "total": len(rows)}

    def explain_journal(self, candidate: Dict[str, Any], policy: Optional[str] = None, filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._results[0] if self._results else {}
