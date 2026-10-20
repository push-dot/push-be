"""Reject VPS traffic that did not come through the gateway.

Health checks stay open so Dokploy and Traefik can probe /healthz.
When AI_SHARED_SECRET is unset (local uvicorn and the Cloudflare Worker)
the check is skipped.
"""

from __future__ import annotations

import hmac
import json
import os

from starlette.types import Receive, Scope, Send

from app.api.errors import error_body

_OPEN = {"/healthz", "/api/v1/healthz"}


def secrets_match(got: str, expected: str) -> bool:
    if len(got) != len(expected):
        return False
    return hmac.compare_digest(got, expected)


class SharedSecretMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        expected = os.environ.get("AI_SHARED_SECRET", "")
        path = scope.get("path", "")
        if not expected or path in _OPEN:
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        got = headers.get(b"x-push-ai-secret", b"").decode(errors="replace")
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
