"""In-memory ring buffer for captured network requests and WebSocket frames."""

from __future__ import annotations

import concurrent.futures
import logging
import re
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

MAX_REGEX_PATTERN_LENGTH = 1000
MAX_RESPONSE_BODY_SIZE = 500 * 1024  # 500 KB
REGEX_TIMEOUT_SECONDS = 1

_REGEX_CACHE: OrderedDict[str, re.Pattern[str] | None] = OrderedDict()
MAX_REGEX_CACHE_SIZE = 100

_regex_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)


def _safe_regex_search(pattern: str, text: str) -> bool:
    if len(pattern) > MAX_REGEX_PATTERN_LENGTH:
        logger.warning("Regex pattern too long (%d chars), rejecting", len(pattern))
        return False
    compiled = _REGEX_CACHE.get(pattern)
    if compiled is None and pattern not in _REGEX_CACHE:
        try:
            compiled = re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            logger.warning("Invalid regex pattern %r: %s", pattern, exc)
            _REGEX_CACHE[pattern] = None
            return False
        if len(_REGEX_CACHE) >= MAX_REGEX_CACHE_SIZE:
            _REGEX_CACHE.popitem(last=False)  # evict oldest (LRU)
        _REGEX_CACHE[pattern] = compiled
    elif compiled is not None:
        _REGEX_CACHE.move_to_end(pattern)  # mark as recently used
    if compiled is None:
        return False
    try:
        future = _regex_executor.submit(compiled.search, text)
        result = future.result(timeout=REGEX_TIMEOUT_SECONDS)
        return result is not None
    except (concurrent.futures.TimeoutError, RecursionError) as exc:
        logger.warning("Regex pattern %r failed (%s), evicting from cache", pattern, exc)
        _REGEX_CACHE[pattern] = None
        return False


@dataclass
class NetworkRequest:
    request_id: str
    tab_id: int
    url: str
    method: str
    timestamp: float
    request_headers: dict[str, str] = field(default_factory=dict)
    request_body: str | None = None
    status_code: int | None = None
    response_headers: dict[str, str] = field(default_factory=dict)
    response_body: str | None = None
    content_type: str | None = None
    ip: str | None = None
    response_body_truncated: bool = False

    def matches_filter(
        self,
        *,
        url_pattern: str | None = None,
        method: str | None = None,
        status_code: int | None = None,
        content_type: str | None = None,
        tab_id: int | None = None,
    ) -> bool:
        if tab_id is not None and self.tab_id != tab_id:
            return False
        if url_pattern and not _safe_regex_search(url_pattern, self.url):
            return False
        if method and self.method.upper() != method.upper():
            return False
        if status_code is not None and self.status_code != status_code:
            return False
        if content_type and (
            not self.content_type
            or content_type.lower() not in self.content_type.lower()
        ):
            return False
        return True

    def matches_search(self, query: str) -> bool:
        q = query.lower()
        if q in self.url.lower():
            return True
        for k, v in self.request_headers.items():
            if q in k.lower() or q in v.lower():
                return True
        for k, v in self.response_headers.items():
            if q in k.lower() or q in v.lower():
                return True
        if self.request_body and q in self.request_body.lower():
            return True
        if self.response_body and q in self.response_body.lower():
            return True
        return False

    def summary(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "method": self.method,
            "url": self.url,
            "status_code": self.status_code,
            "content_type": self.content_type,
            "timestamp": self.timestamp,
            "tab_id": self.tab_id,
        }

    def full_details(self) -> dict[str, Any]:
        return {
            **self.summary(),
            "request_headers": self.request_headers,
            "request_body": self.request_body,
            "response_headers": self.response_headers,
            "response_body": self.response_body,
            "response_body_truncated": self.response_body_truncated,
            "ip": self.ip,
        }


@dataclass
class WsFrame:
    connection_url: str
    direction: str  # "sent" or "received"
    data: str
    timestamp: float
    tab_id: int


class RequestStore:
    """Ring buffer storing the last N requests per tab, with O(1) lookup by ID."""

    def __init__(
        self, max_per_tab: int = 500, max_tabs: int = 20
    ) -> None:
        self._max_per_tab = max_per_tab
        self._max_tabs = max_tabs
        # tab_id -> deque of request_ids (insertion order)
        self._tabs: dict[int, deque[str]] = {}
        # request_id -> NetworkRequest
        self._requests: dict[str, NetworkRequest] = {}

    def add(self, req: NetworkRequest) -> None:
        # If duplicate, remove old entry from its tab's deque
        if req.request_id in self._requests:
            old = self._requests[req.request_id]
            old_q = self._tabs.get(old.tab_id)
            if old_q is not None:
                try:
                    old_q.remove(old.request_id)
                except ValueError:
                    pass
                if not old_q:
                    del self._tabs[old.tab_id]

        tab_q = self._tabs.setdefault(req.tab_id, deque())
        if len(tab_q) >= self._max_per_tab:
            evicted_id = tab_q.popleft()
            self._requests.pop(evicted_id, None)
        tab_q.append(req.request_id)
        self._requests[req.request_id] = req

        # Evict oldest tab if too many
        if len(self._tabs) > self._max_tabs:
            oldest_tab = next(iter(self._tabs))
            for rid in self._tabs.pop(oldest_tab):
                self._requests.pop(rid, None)

    def get(self, request_id: str) -> NetworkRequest | None:
        return self._requests.get(request_id)

    def filter(
        self,
        *,
        url_pattern: str | None = None,
        method: str | None = None,
        status_code: int | None = None,
        content_type: str | None = None,
        tab_id: int | None = None,
        limit: int = 50,
    ) -> list[NetworkRequest]:
        results: list[NetworkRequest] = []
        # Sort by timestamp (newest first) using a snapshot to avoid mutation during iteration
        for req in sorted(
            list(self._requests.values()),
            key=lambda r: r.timestamp,
            reverse=True,
        ):
            if req.matches_filter(
                url_pattern=url_pattern,
                method=method,
                status_code=status_code,
                content_type=content_type,
                tab_id=tab_id,
            ):
                results.append(req)
                if len(results) >= limit:
                    break
        return results

    def search(
        self, query: str, *, tab_id: int | None = None, limit: int = 50
    ) -> list[NetworkRequest]:
        results: list[NetworkRequest] = []
        # Sort by timestamp (newest first) using a snapshot to avoid mutation during iteration
        for req in sorted(
            list(self._requests.values()),
            key=lambda r: r.timestamp,
            reverse=True,
        ):
            if tab_id is not None and req.tab_id != tab_id:
                continue
            if req.matches_search(query):
                results.append(req)
                if len(results) >= limit:
                    break
        return results

    def clear(self) -> None:
        self._tabs.clear()
        self._requests.clear()

    @property
    def total_count(self) -> int:
        return len(self._requests)


class WsFrameStore:
    """Ring buffer for captured WebSocket frames, keyed by connection URL."""

    def __init__(self, max_per_connection: int = 500) -> None:
        self._max = max_per_connection
        # connection_url -> deque of WsFrame
        self._frames: dict[str, deque[WsFrame]] = {}
        # URLs currently being captured
        self._active_captures: set[str] = set()

    def add(self, frame: WsFrame) -> None:
        # Only store frames if there's an active capture pattern that matches
        if not self._active_captures:
            return
        matched = any(
            _safe_regex_search(pattern, frame.connection_url)
            for pattern in self._active_captures
        )
        if not matched:
            return
        q = self._frames.setdefault(frame.connection_url, deque())
        if len(q) >= self._max:
            q.popleft()
        q.append(frame)

    def get_frames(
        self,
        *,
        url_pattern: str | None = None,
        direction: str | None = None,
        tab_id: int | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for conn_url, frames in self._frames.items():
            if url_pattern and not _safe_regex_search(url_pattern, conn_url):
                continue
            for frame in reversed(frames):
                if direction and frame.direction != direction:
                    continue
                if tab_id is not None and frame.tab_id != tab_id:
                    continue
                results.append({
                    "connection_url": frame.connection_url,
                    "direction": frame.direction,
                    "data": frame.data,
                    "timestamp": frame.timestamp,
                    "tab_id": frame.tab_id,
                })
                if len(results) >= limit:
                    return results
        return results

    def start_capture(self, url_pattern: str) -> None:
        self._active_captures.add(url_pattern)

    def stop_capture(self, url_pattern: str) -> bool:
        if url_pattern in self._active_captures:
            self._active_captures.discard(url_pattern)
            return True
        return False

    def clear(self) -> None:
        self._frames.clear()
        self._active_captures.clear()

    @property
    def active_captures(self) -> set[str]:
        return set(self._active_captures)
