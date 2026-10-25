from __future__ import annotations

import json
import logging
import re
import time
import traceback
import uuid
from http import HTTPStatus
from typing import Any, Final

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.domain.errors import DomainError

logger = logging.getLogger(__name__)

_URL_USERINFO: Final = re.compile(r"([a-z][a-z0-9+.-]*://)[^/\s:]+:[^@\s/]+@", re.I)
_SECRET_ASSIGN: Final = re.compile(
    r"(?i)(password|secret|token|api_key|database_url)=([^\s,;]+)")
# Echoed into logs and the x-request-id header; anything else gets a fresh id.
_REQUEST_ID: Final = re.compile(r"[A-Za-z0-9._:-]{1,128}")


def redact(text: str) -> str:
    """Strip URL credentials and ``key=value`` secrets before logging."""
    return _SECRET_ASSIGN.sub(r"\1=***", _URL_USERINFO.sub(r"\1", text))


def error_body(code: str, message: str, request_id: str,
               details: Any = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message,
                      "requestId": request_id, "details": details}}


def request_id_of(request: Request) -> str:
    return getattr(request.state, "request_id", "")


async def domain_error_handler(request: Request, exc: DomainError):
    return JSONResponse(
        status_code=exc.status,
        content=error_body(exc.code, exc.message, request_id_of(request),
                           exc.details))


async def validation_error_handler(request: Request,
                                   exc: RequestValidationError):
    details = [
        {"field": ".".join(str(p) for p in e.get("loc", [])),
         "message": e.get("msg", "")}
        for e in exc.errors()]
    return JSONResponse(
        status_code=400,
        content=error_body("VALIDATION_ERROR", "invalid request",
                           request_id_of(request), details or None))


_STATUS_CODES = {
    400: "VALIDATION_ERROR",
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "NOT_FOUND",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    429: "RATE_LIMITED",
}


def _status_phrase(status: int) -> str:
    try:
        return HTTPStatus(status).phrase
    except ValueError:
        return "Error"


async def http_error_handler(request: Request, exc: HTTPException):
    code = _STATUS_CODES.get(exc.status_code,
                             "INTERNAL" if exc.status_code >= 500
                             else "VALIDATION_ERROR")
    message = _status_phrase(exc.status_code)
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(code, message, request_id_of(request)))


async def unhandled_error_handler(request: Request, exc: Exception):
    # The traceback is formatted here so its text goes through redact().
    logger.error("unhandled error rid=%s %s %s\n%s",
                 request_id_of(request), request.method, request.url.path,
                 redact("".join(traceback.format_exception(exc))))
    return JSONResponse(
        status_code=500,
        content=error_body("INTERNAL", "internal error",
                           request_id_of(request)))


class RequestIDMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        rid = headers.get(b"x-request-id", b"").decode(errors="replace")
        if not _REQUEST_ID.fullmatch(rid):
            rid = f"req_{uuid.uuid4()}"
        scope.setdefault("state", {})["request_id"] = rid

        status = 0
        started = time.perf_counter()

        async def send_with_rid(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                hdrs = list(message.get("headers") or [])
                hdrs.append((b"x-request-id", rid.encode()))
                message["headers"] = hdrs
            if message["type"] == "http.response.body" and not message.get(
                    "more_body"):
                logger.info(json.dumps({
                    "event": "http_request", "requestId": rid,
                    "method": scope.get("method", ""),
                    "path": scope.get("path", ""), "statusCode": status,
                    "durationMs": round(
                        (time.perf_counter() - started) * 1000, 2)}))
            await send(message)

        await self.app(scope, receive, send_with_rid)


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp, limit: int) -> None:
        self.app = app
        self.limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        try:
            content_length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            content_length = 0
        if content_length > self.limit:
            await self._too_large(scope, send)
            return
        received = 0
        overflow = False
        started = False

        async def counting_receive() -> Message:
            nonlocal received, overflow
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body") or b"")
                if received > self.limit:
                    overflow = True
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal started
            if overflow and not started:
                return  # the 413 below replaces whatever the app answers
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counting_receive, guarded_send)
        except Exception:
            if not overflow or started:
                raise
        # Handlers that return silently on disconnect would otherwise leave
        # the client without any response.
        if overflow and not started:
            await self._too_large(scope, send)

    async def _too_large(self, scope: Scope, send: Send) -> None:
        body = json.dumps(error_body(
            "PAYLOAD_TOO_LARGE", "request body too large",
            (scope.get("state") or {}).get("request_id", ""))).encode()
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
