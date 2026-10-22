import uuid

import httpx
import pytest

from app.harness.core_client import CoreClient, CoreError, idempotency_key


def test_key_is_stable_uuid():
    first = idempotency_key("job-1", "call-1")
    assert first == idempotency_key("job-1", "call-1")
    uuid.UUID(first)
    assert first != idempotency_key("job-1", "call-2")


async def test_headers_sent():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["headers"] = request.headers
        return httpx.Response(200, json={"data": {"ok": True}})

    client = CoreClient("https://core.example", "sek", transport=httpx.MockTransport(handler))
    out = await client.call(
        "POST",
        "/api/v1/postings/x/bookmark",
        user_id="user-1",
        company_id="company-1",
        json={"a": 1},
        idempotency_key="idem-1",
    )
    assert out == {"ok": True}
    assert seen["method"] == "POST"
    assert seen["url"] == "https://core.example/api/v1/postings/x/bookmark"
    headers = seen["headers"]
    assert headers["x-push-internal-secret"] == "sek"
    assert headers["x-push-act-as"] == "user-1"
    assert headers["x-push-company"] == "company-1"
    assert headers["idempotency-key"] == "idem-1"


async def test_4xx_raises_core_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"code": "FORBIDDEN", "message": "no"}})

    client = CoreClient("https://core.example", "sek", transport=httpx.MockTransport(handler))
    with pytest.raises(CoreError) as err:
        await client.call("GET", "/api/v1/me/bookmarks", user_id="user-1")
    assert err.value.status == 403
    assert err.value.code == "FORBIDDEN"
    assert err.value.message == "no"


async def test_204_is_empty_object():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(204)

    client = CoreClient("https://core.example/", "sek", transport=httpx.MockTransport(handler))
    assert await client.call("DELETE", "/api/v1/postings/x/bookmark", user_id="user-1") == {}
