from __future__ import annotations

import pytest

from app.config import load_config
from app.domain.errors import DomainError
from app.domain.plan_levers import _ROWS, PlanLevers, levers_for, provider_for
from app.infrastructure.openai_client import (
    OpenAIClient,
    completion_body,
    stream_body,
)

FREE = "deepseek/deepseek-v4.1-flash"
PRO = "anthropic/claude-sonnet-5-5"
ULTRA = "anthropic/claude-opus-5-5"
EMPLOYER_ULTRA = "anthropic/claude-fable-5-1"
PIN = {"allow_fallbacks": False, "data_collection": "deny"}
DEEPSEEK_US = {"only": ["together", "fireworks", "novita"], **PIN}
ANTHROPIC_US = {"only": ["anthropic"], **PIN}


def _cfg():
    return load_config()


@pytest.mark.parametrize(
    ("audience", "plan", "expected"),
    [
        ("PERSONAL", "FREE", PlanLevers(FREE, "LOW", "basic", "same", "same", 1_800_000)),
        ("PERSONAL", None, PlanLevers(FREE, "LOW", "basic", "same", "same", 1_800_000)),
        ("PERSONAL", "", PlanLevers(FREE, "LOW", "basic", "same", "same", 1_800_000)),
        ("PERSONAL", "PRO", PlanLevers(PRO, "MEDIUM", "extended", "plus1", "up1", 27_000_000)),
        ("PERSONAL", "ULTRA", PlanLevers(ULTRA, "HIGH", "full", "plus2", "top", 108_000_000)),
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
    cfg = load_config()
    assert levers_for("PERSONAL", "FREE", cfg).model == "custom/free"
    assert levers_for("PERSONAL", "PRO", cfg).model == "custom/pro"
    assert levers_for("EMPLOYER", "BASIC", cfg).model == "custom/pro"
    assert levers_for("PERSONAL", "ULTRA", cfg).model == "custom/ultra"
    assert levers_for("EMPLOYER", "PRO", cfg).model == "custom/ultra"
    assert levers_for("EMPLOYER", "ULTRA", cfg).model == "custom/employer-ultra"
    # A configured model outside the pinned list is refused, not sent unpinned.
    with pytest.raises(DomainError):
        provider_for("custom/free")


def test_empty_model_env_keeps_defaults(monkeypatch):
    monkeypatch.setenv("MODEL_FREE", "")
    monkeypatch.setenv("MODEL_PRO", "")
    monkeypatch.setenv("MODEL_ULTRA", "")
    monkeypatch.setenv("MODEL_EMPLOYER_ULTRA", "")
    cfg = load_config()
    assert levers_for("PERSONAL", None, cfg).model == FREE
    assert levers_for("PERSONAL", "PRO", cfg).model == PRO
    assert levers_for("PERSONAL", "ULTRA", cfg).model == ULTRA
    assert levers_for("EMPLOYER", "ULTRA", cfg).model == EMPLOYER_ULTRA


def test_client_default_base_url_is_openrouter():
    from inspect import signature

    assert signature(OpenAIClient.__init__).parameters["base_url"].default == (
        "https://openrouter.ai/api/v1")


@pytest.mark.parametrize(("audience", "plan"), sorted(_ROWS))
def test_every_plan_model_is_pinned_to_us_providers(audience, plan):
    model = levers_for(audience, plan, _cfg()).model
    expected = DEEPSEEK_US if model == FREE else ANTHROPIC_US
    messages = [{"role": "user", "content": "hi"}]
    for body in (completion_body(model, messages, "low"), stream_body(model, messages, "low"),
                 completion_body(model + ":online", messages)):
        assert body["provider"] == expected
    assert completion_body(model + ":online", messages)["plugins"] == [
        {"id": "web", "engine": "exa"}]
    assert "plugins" not in completion_body(model, messages)


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


async def test_managed_client_chat_body_pins_every_model():
    client = OpenAIClient(base_url="https://openrouter.ai/api/v1", config=_cfg())
    capture = _Capture()
    client._client = capture
    await client.chat("sk", FREE, "", "hi", "low")
    assert capture.body["provider"] == DEEPSEEK_US
    await client.chat("sk", PRO, "", "hi", "medium")
    assert capture.body["provider"] == ANTHROPIC_US
