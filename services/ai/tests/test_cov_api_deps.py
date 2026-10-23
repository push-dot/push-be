import json
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic import BaseModel
from starlette.requests import Request

from app.api import deps as d
from app.domain.errors import DomainError
from app.domain.pagination import Cursor, Page

NOW = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)


def req(query: str = "", body: bytes = b"", user=None, app_deps=None):
    scope = {"type": "http", "method": "POST", "path": "/", "headers": [],
             "query_string": query.encode(), "state": {}}
    if user is not None:
        scope["state"]["user"] = user
    if app_deps is not None:
        scope["app"] = SimpleNamespace(state=SimpleNamespace(deps=app_deps))
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}
    return Request(scope, receive)


def _field(exc):
    return (exc.value.status, exc.value.code, (exc.value.details or {}).get("field"))


def test_deps_reads_app_state():
    marker = object()
    assert d.deps(req(app_deps=marker)) is marker


def test_current_user_missing_is_401():
    with pytest.raises(DomainError) as e:
        d.current_user(req())
    assert e.value.status == 401 and e.value.code == "UNAUTHENTICATED"
    u = object()
    assert d.current_user(req(user=u)) is u


class M(BaseModel):
    a: int


async def test_bind_json():
    assert (await d.bind_json(req(body=b'{"a": 1}'), M)).a == 1
    for body, msg in [(b"", "request body required"), (b"{", "invalid request body"),
                      (b'{"a": "x"}', "invalid request body")]:
        with pytest.raises(DomainError) as e:
            await d.bind_json(req(body=body), M)
        assert e.value.status == 400 and e.value.message.startswith(msg)


def test_param_id():
    u = uuid4()
    assert d.param_id(str(u), "id") == u
    for bad in ("nope", "", 123):
        with pytest.raises(DomainError) as e:
            d.param_id(bad, "documentId")
        assert _field(e) == (400, "VALIDATION_ERROR", "documentId")


def test_page_request_defaults_limit_and_cursor():
    p = d.page_request(req())
    assert p.limit == 0 and p.cursor is None
    assert d.page_request(req("limit=5")).limit == 5
    assert d.page_request(req("limit=1000")).limit == d.MAX_LIMIT
    cur = Cursor(NOW, uuid4())
    assert d.page_request(req("cursor=" + cur.encode())).cursor == cur


@pytest.mark.parametrize("q,field", [
    ("limit=abc", "limit"), ("limit=0", "limit"), ("limit=-3", "limit"), ("cursor=%%%", "cursor"),
])
def test_page_request_rejects_bad_values(q, field):
    with pytest.raises(DomainError) as e:
        d.page_request(req(q))
    assert _field(e) == (400, "VALIDATION_ERROR", field)


def test_optional_query_uuid():
    u = uuid4()
    assert d.optional_query_uuid(req(), "applicationId") is None
    assert d.optional_query_uuid(req(f"applicationId={u}"), "applicationId") == u
    with pytest.raises(DomainError) as e:
        d.optional_query_uuid(req("applicationId=x"), "applicationId")
    assert _field(e)[2] == "applicationId"


def test_optional_query_time_and_rfc3339():
    assert d.optional_query_time(req(), "from") is None
    assert d.optional_query_time(req("from=2026-01-02T03:04:05Z"), "from") == NOW
    naive = d.parse_rfc3339("2026-01-02T03:04:05")
    assert naive == NOW and naive.tzinfo is timezone.utc
    assert d.parse_rfc3339("2026-01-02T12:04:05+09:00") == NOW
    with pytest.raises(DomainError) as e:
        d.optional_query_time(req("from=yesterday"), "from")
    assert _field(e)[2] == "from"


def test_data_and_page_body():
    u = uuid4()
    r = d.data(201, {"id": u, "at": NOW})
    assert r.status_code == 201
    assert json.loads(r.body) == {"data": {"id": str(u), "at": "2026-01-02T03:04:05Z"}}
    r = d.page_body(Page(items=[1, 2], next_cursor="c", has_more=True))
    assert json.loads(r.body) == {"data": [1, 2], "page": {"nextCursor": "c", "hasMore": True}}


def test_parse_deadline():
    assert d.parse_deadline("2026-01-02", False) == (None, False)
    assert d.parse_deadline(None, True) == (None, True)
    assert d.parse_deadline("2026-01-02", True) == (datetime(2026, 1, 2, tzinfo=timezone.utc), True)
    for bad in ("2026-1-2", "02/01/2026", "2026-02-30", 5):
        with pytest.raises(DomainError) as e:
            d.parse_deadline(bad, True)
        assert _field(e)[2] == "deadline"


def test_parse_time_field():
    assert d.parse_time_field("2026-01-02T03:04:05Z", "startsAt") == NOW
    for bad in (None, 5, "soon"):
        with pytest.raises(DomainError) as e:
            d.parse_time_field(bad, "startsAt")
        assert _field(e)[2] == "startsAt"
