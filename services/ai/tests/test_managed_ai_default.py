from app.domain.managed_ai import with_managed_default
from app.domain import entities as ent


def test_missing_ai_uses_managed_plan_model_when_a_managed_key_exists(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    ai = with_managed_default(None)
    assert ai["credentialMode"] == "MANAGED"
    assert ent.AiOptions(**ai).credential_mode == "MANAGED"


def test_missing_ai_stays_none_without_a_managed_key(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert with_managed_default(None) is None


def test_client_ai_options_are_kept(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    raw = {"provider": "OPENROUTER", "model": "x/y", "credentialMode": "BYOK", "effort": "HIGH"}
    assert with_managed_default(raw) is raw
