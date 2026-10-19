from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routers.internal import router


def test_schedule_is_hidden_without_the_internal_header():
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    missing = client.post("/internal/chat/schedule", json={"jobId": "job-1"})
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "NOT_FOUND"
    ok = client.post(
        "/internal/chat/schedule",
        json={"jobId": "job-1", "byok": ""},
        headers={"x-push-internal": "1"},
    )
    assert ok.status_code == 200
    assert ok.json()["data"]["scheduled"] is True
