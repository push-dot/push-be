from app.config import Config, load_config


def test_app_env_defaults_to_production(monkeypatch):
    # A host that forgets APP_ENV must not accept DEV_AUTH_TOKEN.
    monkeypatch.delenv("APP_ENV", raising=False)
    assert load_config().app_env == "production"
    assert Config().app_env == "production"


def test_app_env_development_is_explicit(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    assert load_config().app_env == "development"


def test_managed_key_comes_from_openrouter_only(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "router-key")
    assert load_config().managed_ai_key == "router-key"


def test_missing_openrouter_key_leaves_managed_ai_unconfigured(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert load_config().managed_ai_key == ""


def test_bad_dev_user_id_and_experiments_fall_back(monkeypatch):
    monkeypatch.setenv("DEV_USER_ID", "nope")
    monkeypatch.setenv("EXPERIMENTS", '{"not": "a list"}')
    cfg = load_config()
    assert str(cfg.dev_user_id) == "00000000-0000-4000-8000-000000000001"
    assert cfg.experiments == []
