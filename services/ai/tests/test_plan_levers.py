from __future__ import annotations

import pytest

from app.config import load_config
from app.domain.plan_levers import (
    PlanLevers, deepseek_provider, levers_for, provider_for,
)
from app.infrastructure.openai_client import (
    OpenAIClient, completion_body, stream_body,
)

FREE = "deepseek/deepseek-v4.1-flash"
PRO = "anthropic/claude-sonnet-5-5"
ULTRA = "anthropic/claude-opus-5-5"
EMPLOYER_ULTRA = "anthropic/claude-fable-5-1"
ORDER = ["Together", "Fireworks", "Novita"]


def _cfg():
    return load_config()


@pytest.mark.parametrize(
    ("audience", "plan", "expected"),
    [
        ("PERSONAL", "FREE", PlanLevers(FREE, "LOW", "basic", "same", "same", 1_800_000)),
        ("PERSONAL", None, PlanLevers(FREE, "LOW", "basic", "same", "same", 1_800_000)),
        ("PERSONAL", "", PlanLevers(FREE, "LOW", "basic", "same", "same", 1_800_000)),
        ("PERSONAL", "PRO", PlanLevers(PRO, "MEDIUM", "extended", "plus1", "up1", 30_000_000)),
        ("PERSONAL", "ULTRA", PlanLevers(ULTRA, "HIGH", "full", "plus2", "top", 100_000_000)),
        ("EMPLOYER", "BASIC", PlanLevers(PRO, "MEDIUM", "extended", "plus1", "up1", 18_000_000)),
        ("EMPLOYER", None, PlanLevers(PRO, "MEDIUM", "extended", "plus1", "up1", 0)),
        ("EMPLOYER", "", PlanLevers(PRO, "MEDIUM", "extended", "plus1", "up1", 0)),
        ("EMPLOYER", "PRO", PlanLevers(ULTRA, "HIGH", "full", "plus2", "top", 90_000_000)),
        ("EMPLOYER", "ULTRA", PlanLevers(EMPLOYER_ULTRA, "MAX", "full", "all", "all", 180_000_000)),
    ],
)
def test_levers_for_plan_table(audience, plan, expected):
    assert levers_for(audience, plan, _cfg()) == expected


def test_levers_read_model_ids_from_config(monkeypatch):
    monkeypatch.setenv("MODEL_FREE", "custom/free")
    monkeypatch.setenv("MODEL_PRO", "custom/pro")
    monkeypatch.setenv("MODEL_ULTRA", "custom/ultra")
    monkeypatch.setenv("MODEL_EMPLOYER_ULTRA", "custom/employer-ultra")
    monkeypatch.setenv("OPENROUTER_DEEPSEEK_PROVIDERS", "A, B, C")
    cfg = load_config()
    assert levers_for("PERSONAL", "FREE", cfg).model == "custom/free"
    assert levers_for("PERSONAL", "PRO", cfg).model == "custom/pro"
    assert levers_for("EMPLOYER", "BASIC", cfg).model == "custom/pro"
    assert levers_for("PERSONAL", "ULTRA", cfg).model == "custom/ultra"
    assert levers_for("EMPLOYER", "PRO", cfg).model == "custom/ultra"
    assert levers_for("EMPLOYER", "ULTRA", cfg).model == "custom/employer-ultra"
    assert deepseek_provider(cfg)["order"] == ["A", "B", "C"]


def test_empty_model_env_keeps_defaults(monkeypatch):
    monkeypatch.setenv("MODEL_FREE", "")
    monkeypatch.setenv("MODEL_PRO", "")
    monkeypatch.setenv("MODEL_ULTRA", "")
    monkeypatch.setenv("MODEL_EMPLOYER_ULTRA", "")
    monkeypatch.setenv("OPENROUTER_DEEPSEEK_PROVIDERS", "")
    cfg = load_config()
    assert levers_for("PERSONAL", None, cfg).model == FREE
    assert levers_for("PERSONAL", "PRO", cfg).model == PRO
    assert levers_for("PERSONAL", "ULTRA", cfg).model == ULTRA
    assert levers_for("EMPLOYER", "ULTRA", cfg).model == EMPLOYER_ULTRA
    assert deepseek_provider(cfg)["order"] == ORDER


def test_deepseek_provider_is_only_on_the_free_model_body():
    cfg = _cfg()
    payload = deepseek_provider(cfg)
    assert "DeepSeek" in payload["ignore"]
    assert payload["order"] == ORDER
    messages = [{"role": "user", "content": "hi"}]
    free_stream = stream_body(FREE, messages, "low", provider_for(FREE, cfg))
    assert free_stream["provider"]["ignore"] == ["DeepSeek"]
    assert free_stream["provider"]["order"] == ORDER
    assert free_stream["stream"] is True
    other_stream = stream_body(PRO, messages, "medium", provider_for(PRO, cfg))
    assert "provider" not in other_stream
    free_chat = completion_body(FREE + ":online", messages, "low",
                                provider_for(FREE + ":online", cfg))
    assert free_chat["provider"]["ignore"] == ["DeepSeek"]
    assert "stream" not in free_chat
    other_chat = completion_body(ULTRA, messages, "high", provider_for(ULTRA, cfg))
    assert "provider" not in other_chat


class _Capture:
    def __init__(self):
        self.body = None

    async def post(self, url, json=None, headers=None):
        self.body = json

        class _Resp:
            status_code = 200

            def json(self):
                return {"choices": [{"message": {"content": "ok"}}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1}}

        return _Resp()


async def test_managed_client_chat_body_sets_provider_only_for_free_model():
    cfg = _cfg()
    client = OpenAIClient(base_url="https://openrouter.ai/api/v1", config=cfg)
    capture = _Capture()
    client._client = capture
    await client.chat("sk", FREE, "", "hi", "low")
    assert capture.body["provider"]["ignore"] == ["DeepSeek"]
    assert capture.body["provider"]["order"] == ORDER
    await client.chat("sk", PRO, "", "hi", "medium")
    assert "provider" not in capture.body
