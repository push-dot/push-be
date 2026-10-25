"""Error handlers, request id propagation and body limit, on a tiny app."""
import json
import logging

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel
from starlette.exceptions import HTTPException

from app.api.errors import (
    BodyLimitMiddleware, RequestIDMiddleware, domain_error_handler, error_body,
    http_error_handler, unhandled_error_handler, validation_error_handler,
)
from app.domain.errors import DomainError


class Body(BaseModel):
    name: str
    n: int


def make_app():
    app = FastAPI()
    app.add_exception_handler(DomainError, domain_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(HTTPException, http_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)
    app.add_middleware(BodyLimitMiddleware, limit=10)
    app.add_middleware(RequestIDMiddleware)

    @app.get("/domain")
    async def domain():
        raise DomainError(409, "CONFLICT", "revision conflict", {"currentRevision": 3})

    @app.post("/validate")
    async def validate(b: Body):
        return {"ok": True}

    @app.get("/http/{code}")
    async def http(code: int):
        raise HTTPException(code, detail="d")

    @app.get("/boom")
    async def boom():
        raise RuntimeError("kaput")

    @app.get("/ok")
    async def ok():
        return {"ok": True}

    @app.get("/leak")
    async def leak():
        raise RuntimeError("connect postgres://u:hunter2@db/x failed token=abc123")

    return app


@pytest.fixture
def client():
    with TestClient(make_app(), raise_server_exceptions=False) as c:
        yield c


def test_error_body_shape():
    assert error_body("C", "m", "r") == {
        "error": {"code": "C", "message": "m", "requestId": "r", "details": None}}


def test_domain_error_maps_status_code_and_request_id(client):
    r = client.get("/domain", headers={"X-Request-Id": "abc"})
    assert r.status_code == 409
    assert r.headers["x-request-id"] == "abc"
    assert r.json() == {"error": {"code": "CONFLICT", "message": "revision conflict",
                                  "requestId": "abc", "details": {"currentRevision": 3}}}


def test_validation_error_lists_fields(client):
    r = client.post("/validate", content=b'{"n":"x"}', headers={"content-type": "application/json"})
    assert r.status_code == 400
    err = r.json()["error"]
    assert err["code"] == "VALIDATION_ERROR" and err["message"] == "invalid request"
    fields = {d["field"] for d in err["details"]}
    assert fields == {"body.name", "body.n"}


@pytest.mark.parametrize("code,want,msg", [
    (401, "UNAUTHENTICATED", "Unauthorized"),
    (403, "FORBIDDEN", "Forbidden"),
    (409, "CONFLICT", "Conflict"),
    (429, "RATE_LIMITED", "Too Many Requests"),
    (418, "VALIDATION_ERROR", "I'm a Teapot"),
    (503, "INTERNAL", "Service Unavailable"),
    (599, "INTERNAL", "Error"),
])
def test_http_exception_codes(client, code, want, msg):
    r = client.get(f"/http/{code}")
    assert r.status_code == code
    assert r.json()["error"]["code"] == want and r.json()["error"]["message"] == msg


def test_router_404_and_405_are_not_found(client):
    assert client.get("/nope").json()["error"]["code"] == "NOT_FOUND"
    r = client.post("/ok", content=b"")
    assert r.status_code == 405 and r.json()["error"]["code"] == "NOT_FOUND"


def test_unhandled_exception_is_generic_500(client):
    r = client.get("/boom", headers={"X-Request-Id": "rid-9"})
    assert r.status_code == 500
    assert r.json()["error"] == {"code": "INTERNAL", "message": "internal error",
                                 "requestId": "rid-9", "details": None}
    assert "kaput" not in r.text


def test_request_id_generated_when_missing_or_too_long(client):
    r = client.get("/ok")
    assert r.headers["x-request-id"].startswith("req_")
    r = client.get("/ok", headers={"X-Request-Id": "a" * 129})
    assert r.headers["x-request-id"].startswith("req_")


def test_request_id_with_unsafe_characters_is_replaced(client):
    # The id is echoed into logs and a response header; keep it to a token charset.
    for bad in ('a"b', "a b", "<script>", "a\x7fb"):
        r = client.get("/ok", headers={"X-Request-Id": bad})
        assert r.headers["x-request-id"].startswith("req_"), bad
    r = client.get("/ok", headers={"X-Request-Id": "req_1a2B-3.c:4"})
    assert r.headers["x-request-id"] == "req_1a2B-3.c:4"


def test_unhandled_error_log_redacts_secrets(client, caplog):
    with caplog.at_level(logging.ERROR, logger="app.api.errors"):
        r = client.get("/leak", headers={"X-Request-Id": "rid-leak"})
    assert r.status_code == 500
    assert "RuntimeError" in caplog.text and "rid-leak" in caplog.text
    assert "hunter2" not in caplog.text and "abc123" not in caplog.text


def test_request_is_logged_once_per_response(client, caplog):
    with caplog.at_level(logging.INFO, logger="app.api.errors"):
        client.get("/ok", headers={"X-Request-Id": "log-1"})
    lines = [json.loads(r.message) for r in caplog.records if "http_request" in r.message]
    assert len(lines) == 1
    assert lines[0]["requestId"] == "log-1" and lines[0]["statusCode"] == 200
    assert lines[0]["path"] == "/ok" and lines[0]["method"] == "GET"


def test_declared_content_length_over_limit_is_413(client):
    r = client.post("/validate", content=b"x" * 11, headers={"X-Request-Id": "big"})
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert r.json()["error"]["requestId"] == "big"


async def _drive(mw, body_chunks, headers=()):
    msgs = [{"type": "http.request", "body": c, "more_body": i < len(body_chunks) - 1}
            for i, c in enumerate(body_chunks)]
    sent = []

    async def receive():
        return msgs.pop(0) if msgs else {"type": "http.disconnect"}

    async def send(m):
        sent.append(m)

    scope = {"type": "http", "headers": list(headers), "state": {"request_id": "rq"}}
    await mw(scope, receive, send)
    return sent


async def test_streamed_body_over_limit_rewrites_response():
    seen = []

    async def app(scope, receive, send):
        while True:
            m = await receive()
            seen.append(m["type"])
            if m["type"] == "http.disconnect" or not m.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"handler", "more_body": True})

    sent = await _drive(BodyLimitMiddleware(app, 10), [b"x" * 6, b"x" * 6])
    assert seen == ["http.request", "http.disconnect"]
    assert [m["type"] for m in sent] == ["http.response.start", "http.response.body"]
    assert sent[0]["status"] == 413
    assert json.loads(sent[1]["body"])["error"]["requestId"] == "rq"


async def test_body_over_limit_is_413_when_the_app_sends_nothing():
    # ApiMiddleware's idempotent path returns silently on http.disconnect.
    async def app(scope, receive, send):
        while (await receive())["type"] != "http.disconnect":
            pass

    sent = await _drive(BodyLimitMiddleware(app, 10), [b"x" * 6, b"x" * 6])
    assert sent[0]["status"] == 413
    assert json.loads(sent[1]["body"])["error"]["code"] == "PAYLOAD_TOO_LARGE"


async def test_body_over_limit_is_413_when_the_app_raises_on_disconnect():
    async def app(scope, receive, send):
        await receive()
        await receive()
        raise RuntimeError("client disconnected")

    sent = await _drive(BodyLimitMiddleware(app, 10), [b"x" * 6, b"x" * 6])
    assert len(sent) == 2 and sent[0]["status"] == 413


async def test_bad_content_length_is_ignored_and_small_body_passes():
    async def app(scope, receive, send):
        m = await receive()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": m["body"]})

    sent = await _drive(BodyLimitMiddleware(app, 10), [b"abc"],
                        headers=[(b"content-length", b"oops")])
    assert sent[0]["status"] == 200 and sent[1]["body"] == b"abc"


async def test_middlewares_pass_non_http_scopes():
    hit = []

    async def app(scope, receive, send):
        hit.append(scope["type"])
    await RequestIDMiddleware(app)({"type": "websocket"}, None, None)
    await BodyLimitMiddleware(app, 1)({"type": "lifespan"}, None, None)
    assert hit == ["websocket", "lifespan"]
