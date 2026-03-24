"""MCP tool definitions for the browser bridge."""

from __future__ import annotations

import json
from typing import Any

from mcp.server import Server
from mcp.types import TextContent, Tool

from .request_store import RequestStore, WsFrameStore
from .ws_bridge import ConnectionManager


def _error_response(code: str, message: str) -> dict[str, Any]:
    """Return a standardized error envelope."""
    return {"error": {"code": code, "message": message}}


def _require_param(args: dict[str, Any], name: str) -> Any:
    """Extract a required parameter or raise ValueError."""
    if name not in args:
        raise ValueError(f"Missing required parameter: {name}")
    return args[name]


_TAB_ID_SCHEMA = {
    "type": "integer",
    "description": "Filter by tab ID. Omit for all tabs.",
}


def register_tools(
    mcp: Server,
    store: RequestStore,
    ws_store: WsFrameStore,
    manager: ConnectionManager,
) -> None:
    """Register all MCP tools on the server."""

    def _clamp_limit(args: dict[str, Any], default: int, maximum: int = 500) -> int:
        raw = args.get("limit", default)
        try:
            return max(1, min(int(raw), maximum))
        except (TypeError, ValueError):
            return default

    @mcp.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name="get_network_requests",
                description=(
                    "List captured network requests from Firefox. "
                    "Filterable by URL regex pattern, HTTP method, status code, "
                    "and content type. Returns newest first."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "url_pattern": {
                            "type": "string",
                            "description": "Regex pattern to match against URLs",
                        },
                        "method": {
                            "type": "string",
                            "description": "HTTP method filter (GET, POST, etc.)",
                        },
                        "status_code": {
                            "type": "integer",
                            "description": "HTTP status code filter",
                        },
                        "content_type": {
                            "type": "string",
                            "description": "Content type substring filter (e.g. 'json', 'html')",
                        },
                        "tab_id": _TAB_ID_SCHEMA,
                        "limit": {
                            "type": "integer",
                            "description": "Max results to return (default 50)",
                            "default": 50,
                        },
                    },
                },
            ),
            Tool(
                name="get_request_details",
                description=(
                    "Get full details of a specific captured request: "
                    "headers, request body, response body, timing."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "request_id": {
                            "type": "string",
                            "description": "The request ID from get_network_requests",
                        },
                    },
                    "required": ["request_id"],
                },
            ),
            Tool(
                name="search_network",
                description=(
                    "Full-text search across all captured request URLs, "
                    "headers, and bodies."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search string",
                        },
                        "tab_id": _TAB_ID_SCHEMA,
                        "limit": {
                            "type": "integer",
                            "description": "Max results (default 50)",
                            "default": 50,
                        },
                    },
                    "required": ["query"],
                },
            ),
            Tool(
                name="get_page_info",
                description=(
                    "Get the current active tab's URL, title, and tab ID. "
                    "If a monitored tab is set in the extension popup, returns that tab's info."
                ),
                inputSchema={"type": "object", "properties": {}},
            ),
            Tool(
                name="query_dom",
                description=(
                    "Query DOM elements on the current page by CSS selector. "
                    "Returns tag, text content, attributes, and outerHTML "
                    "for up to 50 matching elements."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "selector": {
                            "type": "string",
                            "description": "CSS selector to query",
                        },
                    },
                    "required": ["selector"],
                },
            ),
            Tool(
                name="get_page_html",
                description=(
                    "Get the full page HTML or a specific element's HTML. "
                    "Truncated at 500KB."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector. If omitted, returns full page HTML.",
                        },
                    },
                },
            ),
            Tool(
                name="get_console_logs",
                description=(
                    "Get recent console log entries from the current page. "
                    "Only available after the first query triggers injection."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "level": {
                            "type": "string",
                            "description": "Filter by log level: log, warn, error, info, debug",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Max entries (default 100)",
                            "default": 100,
                        },
                    },
                },
            ),
            Tool(
                name="start_ws_capture",
                description=(
                    "Start capturing WebSocket frames for connections matching "
                    "the given URL pattern. Frames are NOT captured by default — "
                    "call this first to enable capture."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "url_pattern": {
                            "type": "string",
                            "description": "Glob/regex pattern to match WS connection URLs",
                        },
                    },
                    "required": ["url_pattern"],
                },
            ),
            Tool(
                name="stop_ws_capture",
                description="Stop capturing WebSocket frames for the given URL pattern.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "url_pattern": {
                            "type": "string",
                            "description": "The same pattern passed to start_ws_capture",
                        },
                    },
                    "required": ["url_pattern"],
                },
            ),
            Tool(
                name="get_ws_frames",
                description=(
                    "Get captured WebSocket frames. Must call start_ws_capture first."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "url_pattern": {
                            "type": "string",
                            "description": "Filter by connection URL pattern",
                        },
                        "direction": {
                            "type": "string",
                            "enum": ["sent", "received"],
                            "description": "Filter by frame direction",
                        },
                        "tab_id": _TAB_ID_SCHEMA,
                        "limit": {
                            "type": "integer",
                            "description": "Max frames (default 100)",
                            "default": 100,
                        },
                    },
                },
            ),
        ]

    @mcp.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
        try:
            result = await _dispatch(name, arguments)
            return [TextContent(type="text", text=json.dumps(result, indent=2))]
        except ConnectionError as e:
            return [TextContent(
                type="text",
                text=json.dumps(_error_response("connection_error", str(e))),
            )]
        except TimeoutError as e:
            return [TextContent(
                type="text",
                text=json.dumps(_error_response("timeout", str(e))),
            )]
        except ValueError as e:
            return [TextContent(
                type="text",
                text=json.dumps(_error_response("invalid_params", str(e))),
            )]
        except Exception as e:
            return [TextContent(
                type="text",
                text=json.dumps(_error_response("internal_error", str(e))),
            )]

    async def _dispatch(name: str, args: dict[str, Any]) -> Any:
        match name:
            case "get_network_requests":
                return _get_network_requests(args)
            case "get_request_details":
                return _get_request_details(args)
            case "search_network":
                return _search_network(args)
            case "get_page_info":
                return await _get_page_info()
            case "query_dom":
                return await _query_dom(args)
            case "get_page_html":
                return await _get_page_html(args)
            case "get_console_logs":
                return await _get_console_logs(args)
            case "start_ws_capture":
                return await _start_ws_capture(args)
            case "stop_ws_capture":
                return await _stop_ws_capture(args)
            case "get_ws_frames":
                return _get_ws_frames(args)
            case _:
                return _error_response("unknown_tool", f"Unknown tool: {name}")

    def _get_network_requests(args: dict[str, Any]) -> dict[str, Any]:
        requests = store.filter(
            url_pattern=args.get("url_pattern"),
            method=args.get("method"),
            status_code=args.get("status_code"),
            content_type=args.get("content_type"),
            tab_id=args.get("tab_id"),
            limit=_clamp_limit(args, 50),
        )
        return {
            "total_captured": store.total_count,
            "returned": len(requests),
            "requests": [r.summary() for r in requests],
        }

    def _get_request_details(args: dict[str, Any]) -> dict[str, Any]:
        request_id = _require_param(args, "request_id")
        req = store.get(request_id)
        if not req:
            return _error_response("not_found", f"Request {request_id} not found")
        return req.full_details()

    def _search_network(args: dict[str, Any]) -> dict[str, Any]:
        query = _require_param(args, "query")
        results = store.search(
            query,
            tab_id=args.get("tab_id"),
            limit=_clamp_limit(args, 50),
        )
        return {
            "query": query,
            "results": len(results),
            "requests": [r.summary() for r in results],
        }

    async def _get_page_info() -> dict[str, Any]:
        resp = await manager.send_request("get_page_info")
        return {
            "url": resp.get("url"),
            "title": resp.get("title"),
            "tab_id": resp.get("tab_id"),
        }

    async def _query_dom(args: dict[str, Any]) -> dict[str, Any]:
        selector = _require_param(args, "selector")
        resp = await manager.send_request("query_dom", {
            "selector": selector,
        })
        if "error" in resp:
            return _error_response("extension_error", resp["error"])
        return {
            "selector": selector,
            "count": resp.get("count", 0),
            "elements": resp.get("elements", []),
        }

    async def _get_page_html(args: dict[str, Any]) -> dict[str, Any]:
        resp = await manager.send_request("get_page_html", {
            "selector": args.get("selector"),
        })
        if "error" in resp:
            return _error_response("extension_error", resp["error"])
        return {
            "html": resp.get("html"),
            "truncated": resp.get("truncated", False),
        }

    async def _get_console_logs(args: dict[str, Any]) -> dict[str, Any]:
        resp = await manager.send_request("get_console_logs", {
            "level": args.get("level"),
            "limit": _clamp_limit(args, 100),
        })
        if "error" in resp:
            return _error_response("extension_error", resp["error"])
        return {
            "logs": resp.get("logs", []),
            "count": resp.get("count", 0),
        }

    async def _start_ws_capture(args: dict[str, Any]) -> dict[str, Any]:
        url_pattern = _require_param(args, "url_pattern")
        resp = await manager.send_request("start_ws_capture", {
            "url_pattern": url_pattern,
        })
        if "error" in resp:
            return _error_response("extension_error", resp["error"])
        ws_store.start_capture(url_pattern)
        return {
            "status": "capturing",
            "url_pattern": url_pattern,
            "matched_connections": resp.get("matched_connections", 0),
        }

    async def _stop_ws_capture(args: dict[str, Any]) -> dict[str, Any]:
        url_pattern = _require_param(args, "url_pattern")
        was_active = ws_store.stop_capture(url_pattern)
        try:
            resp = await manager.send_request("stop_ws_capture", {
                "url_pattern": url_pattern,
            })
            if "error" in resp:
                return _error_response("extension_error", resp["error"])
        except (ConnectionError, TimeoutError):
            pass  # Best-effort: local capture already stopped
        return {
            "status": "stopped",
            "url_pattern": url_pattern,
            "was_active": was_active,
        }

    def _get_ws_frames(args: dict[str, Any]) -> dict[str, Any]:
        frames = ws_store.get_frames(
            url_pattern=args.get("url_pattern"),
            direction=args.get("direction"),
            tab_id=args.get("tab_id"),
            limit=_clamp_limit(args, 100),
        )
        return {
            "active_captures": list(ws_store.active_captures),
            "returned": len(frames),
            "frames": frames,
        }
