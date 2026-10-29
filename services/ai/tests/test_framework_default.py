from app.framework.flag import framework, use_langchain


def test_default_framework_is_langchain(monkeypatch):
    monkeypatch.delenv("AI_FRAMEWORK", raising=False)
    assert framework() == "langchain"
    assert use_langchain() is True


def test_legacy_flag_is_gone(monkeypatch):
    monkeypatch.setenv("AI_FRAMEWORK", "legacy")
    assert framework() == "langchain"


