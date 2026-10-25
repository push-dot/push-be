from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Final
from uuid import UUID, uuid4

from starlette.types import Message, Receive, Scope, Send

from app.domain.entities import IdempotencyRecord
from app.domain.errors import DomainError
from app.api.errors import error_body, redact
from app.ratelimit import SlidingWindow, allow as allow_shared

# Everything else under /api/v1 needs a bearer token. Auth, OAuth callbacks,
# webhooks and image bytes are served by push-be-core, not this service.
_PUBLIC_EXACT: Final = frozenset({"/api/v1/healthz"})
_PUBLIC_SHARE: Final = re.compile(r"^/api/v1/conversations/shared/[^/]+$")
_PENDING_TTL = timedelta(minutes=5)

logger = logging.getLogger(__name__)


def _public_error(exc: BaseException) -> str:
    """Exception text safe to log. Connection strings and secrets are redacted."""
    return redact(f"{type(exc).__name__}: {exc}")[:400]


def _is_public(path: str, method: str = "GET") -> bool:
    return path in _PUBLIC_EXACT or (
        method == "GET" and _PUBLIC_SHARE.match(path) is not None)


def _client_ip(scope: Scope) -> str:
    headers = dict(scope.get("headers") or [])
    forwarded = headers.get(b"cf-connecting-ip", b"").decode(errors="replace").strip()
    if forwarded:
        return forwarded
    chain = headers.get(b"x-forwarded-for", b"").decode(errors="replace")
    if chain.strip():
        return chain.split(",")[0].strip()
    return (scope.get("client") or ("", 0))[0] or ""


class ApiMiddleware:
    def __init__(self, app):
        self.app = app
        self._user_rl = SlidingWindow()
        self._public_rl = SlidingWindow()

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        deps = getattr(scope["app"].state, "deps", None)
        if deps is None:
            await self.app(scope, receive, send)
            return
        self.auth = deps.auth
        self.idem = deps.idem
        path = scope.get("path", "")
        if not path.startswith("/api/v1"):
            await self.app(scope, receive, send)
            return
        rid = (scope.get("state") or {}).get("request_id", "")
        now = datetime.now(timezone.utc).timestamp()
        if _is_public(path, scope.get("method", "GET")):
            if not await self._limited(
                    scope, "ip", _client_ip(scope), self._public_rl, 60, now):
                await self._error(send, 429, "RATE_LIMITED",
                                  "too many requests", rid)
                return
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        authz = headers.get(b"authorization", b"").decode(errors="replace")
        if not authz.startswith("Bearer "):
            await self._error(send, 401, "UNAUTHENTICATED",
                              "missing bearer token", rid)
            return
        try:
            user = await self.auth.resolve_access_token(authz[7:])
        except DomainError as e:
            logger.warning(
                "auth rejected rid=%s path=%s code=%s status=%s",
                rid, path, e.code, e.status)
            await self._error(send, e.status, e.code, e.message, rid, e.details)
            return
        except Exception as e:
            logger.error(
                "auth failed rid=%s path=%s err=%s",
                rid, path, _public_error(e))
            await self._error(send, 500, "INTERNAL", "internal error", rid)
            return
        scope.setdefault("state", {})["user"] = user
        if not await self._limited(
                scope, "user", str(user.id), self._user_rl, 600, now):
            await self._error(send, 429, "RATE_LIMITED",
                              "too many requests", rid)
            return

        if scope["method"] != "POST" or path.endswith("/stream"):
            await self.app(scope, receive, send)
            return
        await self._idempotent(scope, receive, send, user, path, rid)

    async def _limited(self, scope: Scope, kind: str, key: str,
                       memory: SlidingWindow, limit: int, now: float) -> bool:
        # Local uvicorn and the test suite stay on the in-process window.
        # Workers set CF_WORKER and share one Neon counter across isolates.
        if os.environ.get("CF_WORKER") == "1":
            pool = getattr(getattr(scope["app"].state, "db", None), "pool", None)
            return await allow_shared(pool, kind, key, limit, now)
        return memory.allow(key or "unknown", limit, now)

    async def _idempotent(self, scope: Scope, receive: Receive, send: Send,
                          user, path: str, rid: str):
        headers = dict(scope.get("headers") or [])
        key_raw = headers.get(b"idempotency-key", b"").decode(errors="replace")
        try:
            key = UUID(key_raw)
        except (ValueError, AttributeError):
            await self._error(send, 400, "VALIDATION_ERROR",
                              "must be a UUID", rid,
                              {"field": "Idempotency-Key"})
            return
        body = b""
        while True:
            message = await receive()
            if message["type"] == "http.request":
                body += message.get("body") or b""
                if not message.get("more_body"):
                    break
            elif message["type"] == "http.disconnect":
                return
        request_hash = hashlib.sha256(body).hexdigest()
        rec = IdempotencyRecord(
            id=uuid4(), user_id=user.id, key=key, method="POST", path=path,
            request_hash=request_hash,
            created_at=datetime.now(timezone.utc))
        try:
            inserted = await self.idem.insert_pending(rec)
        except Exception as e:
            logger.error(
                "idempotency insert failed rid=%s path=%s err=%s",
                rid, path, _public_error(e))
            await self._error(send, 500, "INTERNAL", "internal error", rid)
            return
        if not inserted:
            try:
                existing = await self.idem.get(user.id, "POST", path, key)
            except Exception as e:
                logger.error(
                    "idempotency read failed rid=%s path=%s err=%s",
                    rid, path, _public_error(e))
                await self._error(send, 500, "INTERNAL", "internal error", rid)
                return
            if existing.response_status is None and datetime.now(
                    timezone.utc) - existing.created_at > _PENDING_TTL:
                try:
                    await self.idem.delete_pending(existing.id)
                    inserted = await self.idem.insert_pending(rec)
                except Exception:
                    logger.exception("idempotency stale pending cleanup failed")
                    inserted = False
            if not inserted:
                if (existing.request_hash != request_hash
                        or existing.response_status is None):
                    await self._error(send, 409, "IDEMPOTENCY_CONFLICT",
                                      "idempotency key conflict", rid)
                    return
                payload = existing.response_body or b""
                replay_headers = [
                    (str(k).encode("latin-1"), str(v).encode("latin-1"))
                    for k, v in (existing.response_headers or [])]
                if not any(k.lower() == b"content-type"
                           for k, _ in replay_headers):
                    replay_headers.append(
                        (b"content-type",
                         b"application/json; charset=utf-8"))
                await send({"type": "http.response.start",
                            "status": existing.response_status,
                            "headers": replay_headers})
                await send({"type": "http.response.body", "body": payload})
                return

        sent = False

        async def replay_receive() -> Message:
            nonlocal sent
            if sent:
                return {"type": "http.disconnect"}
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        status = 500
        captured = bytearray()
        start_message: dict = {}
        handler_failed = False

        async def capture_send(message: Message):
            nonlocal status
            if message["type"] == "http.response.start":
                start_message.update(message)
                status = message["status"]
            elif message["type"] == "http.response.body":
                captured.extend(message.get("body") or b"")

        try:
            await self.app(scope, replay_receive, capture_send)
        except Exception:
            logger.exception("idempotent handler failed rid=%s %s", rid, path)
            handler_failed = True
        if handler_failed or not (200 <= status < 300):
            try:
                await self.idem.delete_pending(rec.id)
            except Exception:
                logger.exception("idempotency delete_pending failed rid=%s", rid)
        else:
            resp_headers = [
                [k.decode("latin-1"), v.decode("latin-1")]
                for k, v in (start_message.get("headers") or [])]
            try:
                await self.idem.complete(rec.id, status, bytes(captured),
                                         resp_headers)
            except Exception:
                logger.exception("idempotency complete failed rid=%s", rid)
        if handler_failed and not start_message:
            await self._error(send, 500, "INTERNAL", "internal error", rid)
            return
        if start_message:
            await send(dict(start_message))
        await send({"type": "http.response.body", "body": bytes(captured)})

    async def _error(self, send: Send, status: int, code: str, message: str,
                     rid: str, details=None):
        body = json.dumps(error_body(code, message, rid, details)).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type",
                                 b"application/json; charset=utf-8"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
