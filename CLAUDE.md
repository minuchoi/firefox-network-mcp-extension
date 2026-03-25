# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Firefox Browser Bridge — an MCP server + Firefox extension that gives Claude Code browser debugging tools (network capture, DOM queries, console logs, WebSocket frame capture). The Firefox extension connects via WebSocket to a Python MCP server, which exposes tools over MCP stdio.

## Development Setup

```bash
# Install Python dependencies
uv sync

# Run the MCP server directly
uv run python -m mcp_server.server
```

The Firefox extension is loaded as a temporary add-on via `about:debugging#/runtime/this-firefox` → Load `extension/manifest.json`. The extension badge shows "ON" (green) when connected to the MCP server.

The MCP server is configured in `.mcp.json` to launch via `uv run`.

## Architecture

**Two-component system:**

1. **Firefox Extension** (`extension/`) — Manifest V2 background script that:
   - Connects as a WebSocket client to `ws://127.0.0.1:7865`
   - Captures HTTP traffic via `webRequest` API listeners
   - Captures response bodies via `filterResponseData` (primary) and page-level XHR/fetch hooking (fallback for POST responses where `filterResponseData` fails)
   - Injects content scripts on-demand for DOM queries, console log capture, and WebSocket frame interception
   - Sends captured data and tool responses as JSON messages to the server
   - Popup UI (`popup.html` / `popup.js`) with toggles for network, DOM, console, and WebSocket capabilities
   - Capability state persisted via `browser.storage.local`

2. **Python MCP Server** (`src/mcp_server/`) — Async server running two concurrent tasks:
   - **MCP stdio server** — exposes 10 tools to Claude Code
   - **WebSocket server** (port 7865) — receives data from and sends commands to the extension

**Key data flow:** Claude calls MCP tool → `tools.py` dispatches → either queries local stores or sends request via `ConnectionManager` → extension executes and responds → result returned to Claude.

**Request/response correlation:** UUID-based `msg_id` with asyncio Futures (5s timeout). Single extension connection enforced.

**Response body capture** has three layers of fallback:
1. `filterResponseData` stream filter (primary — works for most responses)
2. `fetch(url, {cache: "force-cache"})` fallback (GET/HEAD only, when filter produces 0 chunks)
3. Page-level XHR/fetch hooking via `<script>` tag injection into the page's main world (captures POST response bodies that `filterResponseData` misses due to a Firefox bug with gzip-encoded responses). Note: `wrappedJSObject` prototype overrides do NOT work for this — Firefox's Xray wrappers prevent page-world code from seeing content-script prototype changes. The hook must run in the actual page context. The hook is dynamically registered via `browser.contentScripts.register()` with `runAt: "document_start"` for the strongest timing guarantee — this ensures `window.fetch` and `XMLHttpRequest` are hooked BEFORE any page scripts can capture references to the originals. The registration is only active when the network capability is enabled, avoiding any overhead on pages when capture is off. Only mutating methods (POST/PUT/DELETE/PATCH) are intercepted; GET/HEAD pass through with zero overhead. Communication from the page-world hook to the content script relay uses `document.dispatchEvent(new CustomEvent(...))` instead of `window.postMessage` — `dispatchEvent` is **synchronous**, so the content script relay fires immediately within the XHR load handler, before the page can navigate away. This was critical for sites (like those using Axios) where a POST response triggers an immediate full-page navigation. Bodies are correlated with webRequest entries by URL + method + tab ID + timestamp proximity (5s tolerance). Three-stage correlation: pending entry match → buffer lookup → server-side patch of already-stored entries.

**XHR/fetch hook response type handling:**
- `responseType` "" / "text": reads `xhr.responseText` directly
- `responseType` "json": serializes `xhr.response` via `JSON.stringify`
- `responseType` "document" (XML/HTML): serializes via `XMLSerializer().serializeToString()`
- `responseType` "arraybuffer" / "blob": skipped (binary, not text-representable; `filterResponseData` still captures these as base64)
- The fetch hook uses `response.clone().text()` which works for all text-based formats (JSON, XML, HTML, plain text) regardless of content-type header.

**Known limitations of the XHR/fetch hook fallback:**
- Pages with strict `Content-Security-Policy` (`script-src` without `'unsafe-inline'`) will block the `<script>` tag injection. `filterResponseData` still works as primary capture on those pages.
- Only hooks the top frame — XHR calls from iframes are not hooked (but are still captured by `webRequest` at the network level).
- Multiple rapid POST requests to the same URL from the same tab may collide in the correlation buffer (keyed by `tabId:method:url`). The primary correlation path (matching pending webRequest entries) handles most cases before the buffer is needed.
- Brotli (`br`) content-encoding is not supported by `DecompressionStream`. If `filterResponseData` delivers raw brotli bytes, the body will be decoded as latin-1 (garbled). In practice Firefox typically delivers already-decompressed data so this rarely triggers.

**Performance:**
- All webRequest listeners and the XHR/fetch content script are registered dynamically based on capability toggles. When network capture is off, zero webRequest listeners are active and no content scripts are injected — the extension has near-zero overhead on browsing.
- The XHR/fetch page-world hook is registered via `browser.contentScripts.register()` at `document_start` and only intercepts mutating methods (POST/PUT/DELETE/PATCH). GET/HEAD requests pass through the original `fetch`/`XHR.send` with zero overhead.
- `filterResponseData` is skipped for obviously binary URLs (images, fonts, video, wasm) and static assets (`.js`, `.mjs`, `.css`) to avoid unnecessary per-request IPC overhead.
- Tab monitoring is always scoped to a single tab (no "all tabs" mode) to avoid the IPC overhead of `filterResponseData` and webRequest handlers firing across all open tabs. The active tab is auto-selected on extension startup.
- Console capture injection on tab navigation is gated by `isTabMonitored()`.
- Pending requests for a tab are cleaned up when the tab is closed, preventing stale entry accumulation.

**Storage:** In-memory ring buffers in `request_store.py` — 500 requests/tab (max 20 tabs), 500 frames/connection URL. No persistence.

## Key Files

- `src/mcp_server/server.py` — Entry point, wires up MCP + WebSocket servers
- `src/mcp_server/tools.py` — All MCP tool definitions and dispatch logic (match/case)
- `src/mcp_server/ws_bridge.py` — WebSocket server, ConnectionManager, message routing
- `src/mcp_server/request_store.py` — RequestStore and WsFrameStore ring buffers
- `extension/background.js` — All extension logic (WS client, network capture, DOM tools, WS frame capture, capability toggles)
- `extension/xhr_hook_content.js` — Content script for XHR/fetch body capture, registered via `contentScripts.register()` at `document_start`
- `extension/popup.html` — Popup UI for toggling capabilities and viewing connection status
- `extension/popup.js` — Popup script communicating with background.js via runtime messaging

## Testing

```bash
# Run all tests
uv run pytest

# Run a specific test file
uv run pytest tests/test_tools.py
```

Test files mirror the source modules:
- `tests/test_request_store.py` — RequestStore ring buffer, eviction, filtering
- `tests/test_ws_frame_store.py` — WsFrameStore capture, pattern matching
- `tests/test_safe_regex.py` — Regex caching, timeout, LRU eviction
- `tests/test_connection_manager.py` — ConnectionManager send/receive, timeouts, reconnection
- `tests/test_tools.py` — MCP tool dispatch, parameter validation, error handling
- `tests/test_server_integration.py` — Server startup, tool listing, WS server binding

## Concurrency Model

Both runtimes are **single-threaded** — be aware of this during code review:
- **Python (asyncio):** All coroutines run on one thread, yielding only at `await`. Synchronous methods like `RequestStore.add()`, `filter()`, `search()` are atomic — no locks needed.
- **JavaScript (extension):** Single event loop, no preemption. Functions run to completion before the next event is processed.

The only actual thread is the `ThreadPoolExecutor(max_workers=1)` in `request_store.py` for regex timeout enforcement.

## Workflow Rules

- **Every code change must update docs**: After any fix, feature, or refactor, update this `CLAUDE.md` and `README.md` to reflect the change. Never leave docs out of sync with code.
- **Do not commit or push unless explicitly asked**: Only stage, commit, or push when the user requests it. Batch changes together to avoid excessive commits.

## Tech Stack

- Python ≥3.12 (uses match/case, modern type hints)
- `mcp[cli]` ≥1.2.0 for MCP framework
- `websockets` ≥13.0 for extension communication
- Build: hatchling, src-layout
- Tests: pytest + pytest-asyncio