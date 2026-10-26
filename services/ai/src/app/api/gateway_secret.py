"""Reject VPS traffic that did not come through the gateway.

Health checks stay open so the Traefik proxy and uptime checks can probe /healthz.
When AI_SHARED_SECRET is unset (local uvicorn and the Cloudflare Worker)
the check is skipped.
"""

from __future__ import annotations

import hmac
import json
import os
from typing import Final

from starlette.types import ASGIApp, Receive, Scope, Send

from app.api.errors import error_body

_OPEN: Final = frozenset({"/healthz", "/api/v1/healthz"})


def secrets_match(got: str | bytes, expected: str) -> bool:
    # Bytes, not str: compare_digest raises TypeError on non-ASCII str.
    raw = got.encode() if isinstance(got, str) else got
    return hmac.compare_digest(raw, expected.encode())


class SharedSecretMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        expected = os.environ.get("AI_SHARED_SECRET", "")
        if not expected or scope.get("path", "") in _OPEN:
            await self.app(scope, receive, send)
            return
        got = dict(scope.get("headers") or []).get(b"x-push-ai-secret", b"")
        if secrets_match(got, expected):
            await self.app(scope, receive, send)
            return
        rid = (scope.get("state") or {}).get("request_id", "")
        body = json.dumps(error_body(
            "UNAUTHENTICATED", "missing gateway secret", rid)).encode()
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"content-type", b"application/json; charset=utf-8"),
                (b"content-length", str(len(body)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": body})
