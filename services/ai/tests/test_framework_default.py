from app.framework.flag import framework, use_langchain


def test_default_framework_is_langchain(monkeypatch):
    monkeypatch.delenv("CF_WORKER", raising=False)
    monkeypatch.delenv("AI_FRAMEWORK", raising=False)
    assert framework() == "langchain"
    assert use_langchain() is True


def test_legacy_flag_is_gone(monkeypatch):
    monkeypatch.delenv("CF_WORKER", raising=False)
    monkeypatch.setenv("AI_FRAMEWORK", "legacy")
    assert framework() == "langchain"


def test_only_the_cloudflare_python_worker_skips_langchain(monkeypatch):
    monkeypatch.setenv("CF_WORKER", "1")
    assert framework() == "legacy"
    assert use_langchain() is False
