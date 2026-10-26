from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routers import internal
from app.api.routers.internal import router

INTERNAL = {"x-push-internal": "1"}


@pytest.fixture
def scheduled(monkeypatch):
    seen = []

    async def schedule(job_id):
        seen.append(job_id)

    monkeypatch.setattr(internal, "schedule_chat_job", schedule)
    return seen


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_schedule_is_hidden_without_the_internal_header(client, scheduled):
    job = str(uuid4())
    missing = client.post("/internal/chat/schedule", json={"jobId": job})
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "NOT_FOUND"
    ok = client.post("/internal/chat/schedule", json={"jobId": job}, headers=INTERNAL)
    assert ok.status_code == 200
    assert ok.json()["data"]["scheduled"] is True
    assert scheduled == [job]


@pytest.mark.parametrize("body", [
    b"not json", b"[]", b"{}", b'{"jobId": ""}', b'{"jobId": "job-1"}',
    b'{"jobId": 12}', b'{"jobId": {"$gt": ""}}',
])
def test_schedule_rejects_anything_but_a_uuid_job_id(client, scheduled, body):
    r = client.post("/internal/chat/schedule", content=body, headers=INTERNAL)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"
    assert scheduled == []
