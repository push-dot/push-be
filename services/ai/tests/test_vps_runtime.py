"""The AI service no longer has a Cloudflare Worker runtime."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]


def test_cf_worker_does_not_change_framework(monkeypatch):
    from app.framework.flag import framework, use_langchain

    monkeypatch.setenv("CF_WORKER", "1")
    assert framework() == "langchain"
    assert use_langchain() is True


def test_cf_worker_does_not_change_database_driver(monkeypatch):
    from app.db import database_driver, pg_transport

    monkeypatch.delenv("DB_DRIVER", raising=False)
    monkeypatch.delenv("PG_TRANSPORT", raising=False)
    monkeypatch.setenv("CF_WORKER", "1")
    assert database_driver("postgres://localhost/db") == "asyncpg"
    assert pg_transport() == "tcp"


def test_sse_max_polls_is_gone():
    import app.jobs as jobs

    assert not hasattr(jobs, "sse_max_polls")


def test_worker_files_are_gone():
    assert not (ROOT / "src" / "worker.py").exists()
    assert not (ROOT / "wrangler.jsonc").exists()
    assert not (ROOT / "scripts" / "check_worker_bundle.py").exists()
    assert not (ROOT / "tests" / "test_workflow_steps.py").exists()


def test_listed_modules_ignore_cf_worker():
    roots = [
        ROOT / "src" / "app" / "framework" / "flag.py",
        ROOT / "src" / "app" / "db.py",
        ROOT / "src" / "app" / "main.py",
        ROOT / "src" / "app" / "api" / "middleware.py",
        ROOT / "src" / "app" / "ingest" / "web_page.py",
        ROOT / "src" / "app" / "pgproto.py",
    ]
    for path in roots:
        assert "CF_WORKER" not in path.read_text(), path.name
    assert "_open_workers_websocket" not in (ROOT / "src" / "app" / "pgproto.py").read_text()


def test_migrate_action_defaults_to_tcp():
    text = (REPO / ".github" / "workflows" / "migrate.yml").read_text()
    assert "default: tcp" in text
    assert "default: websocket" not in text


def test_pyproject_has_no_workers_dev_deps():
    text = (ROOT / "pyproject.toml").read_text()
    assert "workers-py" not in text
    assert "workers-runtime-sdk" not in text
    assert "pyodide" not in text.lower()
