from __future__ import annotations

import json
import sys
from typing import Any, Dict, Iterable, Optional

from scansci_find import __version__
from scansci_find.mcp_contract import handle_tool_call, list_tools
from scansci_find.service import ScanSciFindService


def serialize_response(response: Dict[str, Any]) -> str:
    return json.dumps(response, ensure_ascii=True)


class JsonRpcMcpServer:
    def __init__(self, service: Optional[ScanSciFindService] = None) -> None:
        self.service = service or ScanSciFindService()

    def handle(self, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        method = request.get("method")
        request_id = request.get("id")
        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "scansci-find-mcp", "version": __version__},
                },
            }
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": list_tools()}}
        if method == "tools/call":
            params = request.get("params") or {}
            result = handle_tool_call(params.get("name", ""), params.get("arguments") or {}, self.service)
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
        if method == "shutdown":
            return {"jsonrpc": "2.0", "id": request_id, "result": None}
        if request_id is None:
            return None
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}

    def serve(self, lines: Iterable[str], out: Any = None) -> None:
        out = out or sys.stdout
        for line in lines:
            if not line.strip():
                continue
            response = self.handle(json.loads(line))
            if response is not None:
                out.write(serialize_response(response) + "\n")
                out.flush()


def main(argv: Optional[list[str]] = None) -> int:
    JsonRpcMcpServer().serve(sys.stdin)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
