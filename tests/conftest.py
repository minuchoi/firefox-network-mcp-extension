"""Shared fixtures and helpers for the test suite."""

from __future__ import annotations

import itertools
import time
from unittest.mock import AsyncMock

import pytest

from mcp_server.request_store import (
    NetworkRequest,
    RequestStore,
    WsFrame,
    WsFrameStore,
    _REGEX_CACHE,
)
from mcp_server.ws_bridge import ConnectionManager


# ─── Factory helpers ──────────────────────────────────────────────────────────

_counter = itertools.count(1)


def make_request(
    request_id: str | None = None,
    tab_id: int = 1,
    url: str = "https://example.com/api",
    method: str = "GET",
    timestamp: float | None = None,
    status_code: int | None = 200,
    content_type: str | None = "application/json",
    request_headers: dict | None = None,
    request_body: str | None = None,
    response_headers: dict | None = None,
    response_body: str | None = None,
) -> NetworkRequest:
    n = next(_counter)
    return NetworkRequest(
        request_id=request_id or f"req-{n}",
        tab_id=tab_id,
        url=url,
        method=method,
        timestamp=timestamp or time.time(),
        status_code=status_code,
        content_type=content_type,
        request_headers=request_headers or {},
        request_body=request_body,
        response_headers=response_headers or {},
        response_body=response_body,
    )


def make_ws_frame(
    connection_url: str = "wss://example.com/ws",
    direction: str = "received",
    data: str = "hello",
    timestamp: float | None = None,
    tab_id: int = 1,
) -> WsFrame:
    return WsFrame(
        connection_url=connection_url,
        direction=direction,
        data=data,
        timestamp=timestamp or time.time(),
        tab_id=tab_id,
    )


# ─── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def request_store():
    return RequestStore(max_per_tab=5, max_tabs=3)


@pytest.fixture
def ws_frame_store():
    return WsFrameStore(max_per_connection=5)


@pytest.fixture
def manager(request_store, ws_frame_store):
    return ConnectionManager(request_store, ws_frame_store)


@pytest.fixture
def mock_ws():
    ws = AsyncMock()
    ws.send = AsyncMock()
    ws.close = AsyncMock()
    return ws


@pytest.fixture(autouse=True)
def clear_regex_cache():
    _REGEX_CACHE.clear()
    yield
    _REGEX_CACHE.clear()
