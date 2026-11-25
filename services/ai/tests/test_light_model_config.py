from __future__ import annotations

from push_agent.harness.flows import agent_light_model


def test_the_agent_reads_applicant_documents_with_the_configured_model(monkeypatch):
    monkeypatch.delenv("AGENT_LIGHT_MODEL", raising=False)
    assert agent_light_model() == ""
    monkeypatch.setenv("AGENT_LIGHT_MODEL", " anthropic/claude-haiku-5-5 ")
    assert agent_light_model() == "anthropic/claude-haiku-5-5"


def test_a_setting_of_only_spaces_keeps_the_default(monkeypatch):
    from app.config import env

    monkeypatch.setenv("MODEL_FREE", "   ")
    assert env("MODEL_FREE", "deepseek/deepseek-v4.1-flash") == "deepseek/deepseek-v4.1-flash"
    monkeypatch.setenv("MODEL_FREE", " anthropic/claude-haiku-5-5 ")
    assert env("MODEL_FREE", "x") == "anthropic/claude-haiku-5-5"
