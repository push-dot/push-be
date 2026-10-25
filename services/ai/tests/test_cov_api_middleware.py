"""ApiMiddleware at the ASGI level: auth, public paths, rate limits, idempotency."""
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.api import middleware as mw
from app.api.middleware import ApiMiddleware, _client_ip, _is_public, _public_error
from app.domain.entities import IdempotencyRecord, User
from app.domain.errors import token_expired

USER = User(id=uuid4(), display_name="u", created_at=datetime.now(timezone.utc))
KEY = str(uuid4())


class Auth:
    def __init__(self, err=None):
        self.err = err
        self.tokens = []

    async def resolve_access_token(self, token):
        self.tokens.append(token)
        if self.err:
            raise self.err
        return USER


class Idem:
    """Scripted idempotency store; each attribute is a list of results."""

    def __init__(self, insert=(True,), get=None, delete_err=None, complete_err=None):
        self.insert = list(insert)
        self.existing = get
        self.delete_err = delete_err
        self.complete_err = complete_err
        self.completed = []
        self.deleted = []

    async def insert_pending(self, rec):
        r = self.insert.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    async def get(self, user_id, method, path, key):
        if isinstance(self.existing, Exception):
            raise self.existing
        return self.existing

    async def delete_pending(self, id_):
        self.deleted.append(id_)
        if self.delete_err:
            raise self.delete_err

    async def complete(self, id_, status, body, headers):
        if self.complete_err:
            raise self.complete_err
        self.completed.append((status, body, headers))


def inner(status=201, body=b'{"ok":1}', raise_=None, start=True):
    seen = {"bodies": [], "calls": 0}

    async def app(scope, receive, send):
        seen["calls"] += 1
        seen["scope"] = scope
        msg = await receive()
        seen["bodies"].append(msg)
        seen["after"] = await receive()
        if start:
            await send({"type": "http.response.start", "status": status,
                        "headers": [(b"content-type", b"application/json")]})
        if raise_:
            raise raise_
        await send({"type": "http.response.body", "body": body})
    return app, seen


async def call(app, deps, method="POST", path="/api/v1/x", headers=None, body=(b"{}",),
               client=("9.9.9.9", 1), state=None):
    hdrs = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    msgs = []
    for i, chunk in enumerate(body):
        if chunk is None:
            msgs.append({"type": "http.disconnect"})
        else:
            msgs.append({"type": "http.request", "body": chunk,
                         "more_body": i < len(body) - 1})
    sent = []

    async def receive():
        return msgs.pop(0) if msgs else {"type": "http.disconnect"}

    async def send(m):
        sent.append(m)

    app_state = SimpleNamespace(deps=deps, **(state or {}))
    scope = {"type": "http", "method": method, "path": path, "headers": hdrs,
             "app": SimpleNamespace(state=app_state), "state": {"request_id": "rid-1"},
             "client": client}
    await app(scope, receive, send)
    start = next((m for m in sent if m["type"] == "http.response.start"), None)
    body_bytes = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return (start["status"] if start else None), (start or {}).get("headers"), body_bytes


def deps(auth=None, idem=None):
    return SimpleNamespace(auth=auth or Auth(), idem=idem or Idem())


AUTH = {"Authorization": "Bearer tok", "Idempotency-Key": KEY}


def _err(body):
    return json.loads(body)["error"]


def test_public_paths():
    assert _is_public("/api/v1/healthz")
    assert _is_public("/api/v1/auth/google/start")
    assert _is_public("/api/v1/conversations/shared/abc")
    assert not _is_public("/api/v1/conversations/shared/abc", "POST")
    assert _is_public("/api/v1/uploads/images/a.png")
    assert not _is_public("/api/v1/uploads/images/../x")
    assert not _is_public("/api/v1/uploads/images/a.png", "POST")
    assert not _is_public("/api/v1/documents")


def test_client_ip_prefers_cloudflare_then_forwarded_then_peer():
    assert _client_ip({"headers": [(b"cf-connecting-ip", b" 1.1.1.1 ")]}) == "1.1.1.1"
    assert _client_ip({"headers": [(b"x-forwarded-for", b"2.2.2.2, 3.3.3.3")]}) == "2.2.2.2"
    assert _client_ip({"headers": [], "client": ("4.4.4.4", 5)}) == "4.4.4.4"
    assert _client_ip({"headers": []}) == ""


def test_public_error_redacts_secrets():
    text = _public_error(RuntimeError(
        "connect postgres://user:pw@host/db failed password=hunter2 token=abc"))
    assert "pw@" not in text and "hunter2" not in text and "abc" not in text
    assert text.startswith("RuntimeError: connect postgres://host/db")
    assert len(_public_error(RuntimeError("x" * 1000))) == 400


async def test_non_http_and_missing_deps_and_non_api_pass_through():
    app, seen = inner(200)
    m = ApiMiddleware(app)
    hit = []

    async def life(scope, receive, send):
        hit.append(scope["type"])
    await ApiMiddleware(life)({"type": "lifespan"}, None, None)
    assert hit == ["lifespan"]
    status, _, _ = await call(m, None)
    assert status == 200
    status, _, _ = await call(m, deps(), path="/healthz")
    assert status == 200 and seen["calls"] == 2


async def test_public_path_skips_auth_until_ip_limit():
    app, seen = inner(200)
    m = ApiMiddleware(app)
    d = deps()
    for _ in range(60):
        status, _, _ = await call(m, d, "GET", "/api/v1/healthz")
        assert status == 200
    status, _, body = await call(m, d, "GET", "/api/v1/healthz")
    assert status == 429 and _err(body)["code"] == "RATE_LIMITED"
    assert _err(body)["requestId"] == "rid-1"
    status, _, _ = await call(m, d, "GET", "/api/v1/healthz", client=("8.8.8.8", 1))
    assert status == 200 and d.auth.tokens == []


@pytest.mark.parametrize("authz", [None, "Basic abc", "bearer tok"])
async def test_missing_bearer_is_401(authz):
    app, seen = inner()
    hdrs = {"Authorization": authz} if authz else {}
    status, headers, body = await call(ApiMiddleware(app), deps(), "GET", headers=hdrs)
    assert status == 401 and _err(body) == {
        "code": "UNAUTHENTICATED", "message": "missing bearer token",
        "requestId": "rid-1", "details": None}
    assert (b"content-type", b"application/json; charset=utf-8") in headers
    assert seen["calls"] == 0


async def test_expired_token_maps_domain_error():
    app, seen = inner()
    a = Auth(token_expired())
    status, _, body = await call(ApiMiddleware(app), deps(a), "GET",
                                 headers={"Authorization": "Bearer old"})
    assert status == 401 and _err(body)["code"] == "TOKEN_EXPIRED"
    assert a.tokens == ["old"] and seen["calls"] == 0


async def test_auth_backend_failure_is_500_without_leaking():
    app, _ = inner()
    a = Auth(RuntimeError("postgres://u:secret@h"))
    status, _, body = await call(ApiMiddleware(app), deps(a), "GET",
                                 headers={"Authorization": "Bearer t"})
    assert status == 500 and b"secret" not in body
    assert _err(body)["code"] == "INTERNAL"


async def test_user_rate_limit():
    app, _ = inner(200)
    m = ApiMiddleware(app)
    d = deps()
    hdr = {"Authorization": "Bearer t"}
    for _ in range(600):
        assert (await call(m, d, "GET", headers=hdr))[0] == 200
    status, _, body = await call(m, d, "GET", headers=hdr)
    assert status == 429 and _err(body)["code"] == "RATE_LIMITED"


async def test_worker_uses_shared_limiter(monkeypatch):
    seen = []

    async def fake_allow(pool, kind, key, limit, now):
        seen.append((pool, kind, key, limit))
        return kind == "user"
    monkeypatch.setenv("CF_WORKER", "1")
    monkeypatch.setattr(mw, "allow_shared", fake_allow)
    app, _ = inner(200)
    m = ApiMiddleware(app)
    state = {"db": SimpleNamespace(pool="POOL")}
    status, _, _ = await call(m, deps(), "GET", headers={"Authorization": "Bearer t"}, state=state)
    assert status == 200 and seen[-1] == ("POOL", "user", str(USER.id), 600)
    status, _, _ = await call(m, deps(), "GET", "/api/v1/healthz", state=state)
    assert status == 429 and seen[-1] == ("POOL", "ip", "9.9.9.9", 60)


async def test_get_and_stream_and_exempt_posts_skip_idempotency():
    app, seen = inner(200)
    m = ApiMiddleware(app)
    hdr = {"Authorization": "Bearer t"}
    assert (await call(m, deps(), "GET", headers=hdr))[0] == 200
    assert (await call(m, deps(), "POST", "/api/v1/conversations/c/messages/stream",
                       headers=hdr))[0] == 200
    assert seen["scope"]["state"]["user"] is USER


@pytest.mark.parametrize("key", [None, "not-a-uuid"])
async def test_post_requires_uuid_idempotency_key(key):
    app, seen = inner()
    hdr = {"Authorization": "Bearer t"}
    if key:
        hdr["Idempotency-Key"] = key
    status, _, body = await call(ApiMiddleware(app), deps(), headers=hdr)
    assert status == 400 and _err(body)["details"] == {"field": "Idempotency-Key"}
    assert seen["calls"] == 0


async def test_first_post_runs_handler_and_completes_record():
    app, seen = inner(201, b'{"ok":1}')
    idem = Idem()
    status, _, body = await call(ApiMiddleware(app), deps(idem=idem), headers=AUTH,
                                 body=(b'{"a"', b":1}"))
    assert status == 201 and body == b'{"ok":1}'
    assert seen["bodies"][0]["body"] == b'{"a":1}'
    assert seen["after"] == {"type": "http.disconnect"}
    assert idem.completed == [(201, b'{"ok":1}', [["content-type", "application/json"]])]


async def test_client_disconnect_while_reading_body_sends_nothing():
    app, seen = inner()
    status, _, _ = await call(ApiMiddleware(app), deps(), headers=AUTH, body=(None,))
    assert status is None and seen["calls"] == 0


async def test_insert_failure_is_500():
    app, _ = inner()
    idem = Idem(insert=(RuntimeError("db down"),))
    status, _, body = await call(ApiMiddleware(app), deps(idem=idem), headers=AUTH)
    assert status == 500 and _err(body)["code"] == "INTERNAL"


async def test_read_existing_failure_is_500():
    app, _ = inner()
    idem = Idem(insert=(False,), get=RuntimeError("db down"))
    status, _, _ = await call(ApiMiddleware(app), deps(idem=idem), headers=AUTH)
    assert status == 500


def _existing(**kw):
    import hashlib
    base = dict(id=uuid4(), user_id=USER.id, key=uuid4(), method="POST", path="/api/v1/x",
                request_hash=hashlib.sha256(b"{}").hexdigest(),
                created_at=datetime.now(timezone.utc))
    base.update(kw)
    return IdempotencyRecord(**base)


async def test_replay_returns_stored_response_with_default_content_type():
    app, seen = inner()
    rec = _existing(response_status=201, response_body=b'{"n":1}',
                    response_headers=[["x-a", "1"]])
    status, headers, body = await call(ApiMiddleware(app), deps(idem=Idem((False,), rec)),
                                       headers=AUTH)
    assert status == 201 and body == b'{"n":1}' and seen["calls"] == 0
    assert headers == [(b"x-a", b"1"), (b"content-type", b"application/json; charset=utf-8")]


async def test_replay_keeps_stored_content_type():
    app, _ = inner()
    rec = _existing(response_status=200, response_body=None,
                    response_headers=[["Content-Type", "text/plain"]])
    status, headers, body = await call(ApiMiddleware(app), deps(idem=Idem((False,), rec)),
                                       headers=AUTH)
    assert status == 200 and body == b"" and headers == [(b"Content-Type", b"text/plain")]


@pytest.mark.parametrize("rec_kw", [
    {"request_hash": "different", "response_status": 201},
    {"response_status": None},
])
async def test_conflicting_or_in_flight_key_is_409(rec_kw):
    app, _ = inner()
    rec = _existing(**rec_kw)
    status, _, body = await call(ApiMiddleware(app), deps(idem=Idem((False,), rec)),
                                 headers=AUTH)
    assert status == 409 and _err(body)["code"] == "IDEMPOTENCY_CONFLICT"


async def test_stale_pending_is_replaced_and_rerun():
    app, seen = inner(201)
    rec = _existing(created_at=datetime.now(timezone.utc) - timedelta(minutes=6))
    idem = Idem((False, True), rec)
    status, _, _ = await call(ApiMiddleware(app), deps(idem=idem), headers=AUTH)
    assert status == 201 and idem.deleted == [rec.id] and seen["calls"] == 1


async def test_stale_pending_cleanup_failure_is_conflict():
    app, seen = inner(201)
    rec = _existing(created_at=datetime.now(timezone.utc) - timedelta(minutes=6))
    idem = Idem((False,), rec, delete_err=RuntimeError("x"))
    status, _, _ = await call(ApiMiddleware(app), deps(idem=idem), headers=AUTH)
    assert status == 409 and seen["calls"] == 0


async def test_non_2xx_releases_the_key():
    app, _ = inner(422, b'{"error":1}')
    idem = Idem()
    status, _, body = await call(ApiMiddleware(app), deps(idem=idem), headers=AUTH)
    assert status == 422 and body == b'{"error":1}'
    assert len(idem.deleted) == 1 and idem.completed == []


async def test_release_failure_still_returns_response():
    app, _ = inner(400)
    idem = Idem(delete_err=RuntimeError("x"))
    status, _, _ = await call(ApiMiddleware(app), deps(idem=idem), headers=AUTH)
    assert status == 400


async def test_complete_failure_still_returns_response():
    app, _ = inner(201)
    idem = Idem(complete_err=RuntimeError("x"))
    status, _, _ = await call(ApiMiddleware(app), deps(idem=idem), headers=AUTH)
    assert status == 201


async def test_handler_crash_before_start_is_500():
    app, _ = inner(start=False, raise_=RuntimeError("boom"))
    idem = Idem()
    status, _, body = await call(ApiMiddleware(app), deps(idem=idem), headers=AUTH)
    assert status == 500 and _err(body)["code"] == "INTERNAL" and len(idem.deleted) == 1


async def test_handler_crash_after_start_forwards_partial_response():
    app, _ = inner(200, raise_=RuntimeError("boom"))
    idem = Idem()
    status, _, body = await call(ApiMiddleware(app), deps(idem=idem), headers=AUTH)
    assert status == 200 and body == b"" and len(idem.deleted) == 1
