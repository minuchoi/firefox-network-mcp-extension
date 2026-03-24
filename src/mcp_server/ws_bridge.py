"""WebSocket server: manages the extension connection and request/response dispatch."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection

from .request_store import (
    MAX_RESPONSE_BODY_SIZE,
    NetworkRequest,
    RequestStore,
    WsFrame,
    WsFrameStore,
)

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 5.0  # seconds
MAX_MESSAGE_SIZE = 10 * 1024 * 1024  # 10 MB


class ConnectionManager:
    """Manages the single WebSocket connection to the Firefox extension."""

    def __init__(
        self, request_store: RequestStore, ws_frame_store: WsFrameStore
    ) -> None:
        self.request_store = request_store
        self.ws_frame_store = ws_frame_store
        self._connection: ServerConnection | None = None
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._connection is not None

    async def register(self, ws: ServerConnection) -> None:
        async with self._lock:
            if self._connection is not None:
                logger.warning("Replacing existing extension connection")
                try:
                    await self._connection.close()
                except Exception:
                    pass  # connection may already be closed or in a bad state
            self._connection = ws
            logger.info("Extension connected")

    async def unregister(self, ws: ServerConnection) -> None:
        async with self._lock:
            if self._connection is ws:
                self._connection = None
                logger.info("Extension disconnected")
                # Cancel all pending futures
                for fut in list(self._pending.values()):
                    if not fut.done():
                        fut.set_exception(
                            ConnectionError("Extension disconnected")
                        )
                self._pending.clear()

    async def send_request(
        self, action: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Send a request to the extension and wait for the response."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        msg_id = uuid.uuid4().hex[:12]

        # Lock protects the send+store-future sequence so that
        # unregister() cannot clear _pending between send and store.
        async with self._lock:
            if not self._connection:
                raise ConnectionError("No extension connected")

            message = {"msg_id": msg_id, "action": action, **(params or {})}
            self._pending[msg_id] = future

            try:
                await self._connection.send(json.dumps(message))
            except Exception:
                self._pending.pop(msg_id, None)
                raise ConnectionError(
                    f"Failed to send '{action}' request to extension"
                )

        # Wait for response OUTSIDE the lock to avoid blocking the dispatcher
        try:
            return await asyncio.wait_for(future, timeout=REQUEST_TIMEOUT)
        except TimeoutError:
            if self._connection is None:
                raise ConnectionError(
                    f"Extension disconnected while waiting for '{action}' response"
                )
            raise TimeoutError(
                f"Extension did not respond to '{action}' within {REQUEST_TIMEOUT}s"
            )
        finally:
            self._pending.pop(msg_id, None)

    async def handle_message(self, raw: str) -> None:
        """Process an incoming message from the extension."""
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("Invalid JSON from extension: %s", raw[:200])
            return

        msg_type = data.get("type")

        if msg_type == "hello":
            logger.info("Extension says hello: %s", data.get("version", "?"))
            return

        if msg_type == "network_event":
            self._handle_network_event(data)
            return

        if msg_type == "ws_frame":
            self._handle_ws_frame(data)
            return

        if msg_type == "xhr_body_patch":
            self._handle_xhr_body_patch(data)
            return

        # Check if it's a response to a pending request
        msg_id = data.get("msg_id")
        if msg_id:
            fut = self._pending.pop(msg_id, None)
            if fut is not None and not fut.done():
                fut.set_result(data)
                return

        logger.debug("Unhandled message type: %s", msg_type)

    def _handle_network_event(self, data: dict[str, Any]) -> None:
        try:
            tab_id = int(data.get("tab_id", -1))
        except (TypeError, ValueError):
            logger.warning("Malformed tab_id in network event: %r", data.get("tab_id"))
            return

        try:
            timestamp = float(data.get("timestamp", 0))
        except (TypeError, ValueError):
            timestamp = 0.0

        raw_status = data.get("status_code")
        status_code: int | None = None
        if raw_status is not None:
            try:
                status_code = int(raw_status)
            except (TypeError, ValueError):
                logger.warning("Malformed status_code in network event: %r", raw_status)

        url = data.get("url")
        if not isinstance(url, str) or not url:
            logger.warning("Missing or invalid url in network event, skipping")
            return

        raw_body = data.get("response_body")
        body_truncated = bool(data.get("response_body_truncated", False))
        if isinstance(raw_body, str) and len(raw_body) > MAX_RESPONSE_BODY_SIZE:
            raw_body = raw_body[:MAX_RESPONSE_BODY_SIZE]
            body_truncated = True

        req = NetworkRequest(
            request_id=str(data.get("request_id", uuid.uuid4().hex)),
            tab_id=tab_id,
            url=url,
            method=str(data.get("method", "GET")),
            timestamp=timestamp,
            request_headers=data.get("request_headers") or {},
            request_body=data.get("request_body"),
            status_code=status_code,
            response_headers=data.get("response_headers") or {},
            response_body=raw_body,
            content_type=data.get("content_type"),
            ip=data.get("ip"),
            response_body_truncated=body_truncated,
        )
        self.request_store.add(req)
        logger.debug("Stored request: %s %s", req.method, req.url[:80])

    def _handle_ws_frame(self, data: dict[str, Any]) -> None:
        try:
            tab_id = int(data.get("tab_id", -1))
        except (TypeError, ValueError):
            logger.warning("Malformed tab_id in ws_frame: %r", data.get("tab_id"))
            return

        try:
            timestamp = float(data.get("timestamp", 0))
        except (TypeError, ValueError):
            timestamp = 0.0

        direction = data.get("direction", "received")
        if direction not in ("sent", "received"):
            logger.warning("Invalid ws_frame direction: %r, skipping", direction)
            return

        frame = WsFrame(
            connection_url=str(data.get("connection_url", "")),
            direction=direction,
            data=str(data.get("data", "")),
            timestamp=timestamp,
            tab_id=tab_id,
        )
        self.ws_frame_store.add(frame)

    def _handle_xhr_body_patch(self, data: dict[str, Any]) -> None:
        """Patch a previously stored request with a response body from the XHR hook."""
        url = data.get("url")
        method = data.get("method", "").upper()
        body = data.get("response_body")

        if not url or not body:
            return

        try:
            tab_id = int(data.get("tab_id", -1))
        except (TypeError, ValueError):
            return

        try:
            timestamp = float(data.get("timestamp", 0))
        except (TypeError, ValueError):
            timestamp = 0.0

        tolerance_ms = 5000
        candidates = self.request_store.filter(
            method=method, tab_id=tab_id, limit=50
        )
        for req in candidates:
            if req.url != url:
                continue
            if req.response_body:
                continue
            if abs(req.timestamp - timestamp) > tolerance_ms:
                continue
            req.response_body = body[:MAX_RESPONSE_BODY_SIZE]
            req.response_body_truncated = len(body) > MAX_RESPONSE_BODY_SIZE
            logger.debug("Patched response body via XHR hook: %s %s", method, url[:80])
            return


async def ws_handler(
    ws: ServerConnection, manager: ConnectionManager
) -> None:
    """Handle a single WebSocket connection from the extension."""
    await manager.register(ws)
    try:
        async for message in ws:
            await manager.handle_message(message)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        await manager.unregister(ws)


async def start_ws_server(
    manager: ConnectionManager,
    host: str = "127.0.0.1",
    port: int = 7865,
    shutdown_event: asyncio.Event | None = None,
) -> None:
    """Start the WebSocket server. Runs until *shutdown_event* is set (or forever)."""
    async with websockets.serve(
        lambda ws: ws_handler(ws, manager),
        host,
        port,
        max_size=MAX_MESSAGE_SIZE,
        ping_interval=30,
        ping_timeout=10,
        reuse_address=True,
    ):
        logger.info("WebSocket server listening on ws://%s:%d", host, port)
        if shutdown_event is not None:
            await shutdown_event.wait()
        else:
            await asyncio.Future()  # run forever
