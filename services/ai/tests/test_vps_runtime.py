"""The AI service no longer has a Cloudflare Worker runtime."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
_GONE = "CF_" "WORKER"


def test_dead_runtime_flag_does_not_select_external_jobs(monkeypatch):
    from app.jobs import external_jobs

    monkeypatch.delenv("CHAT_EXECUTOR", raising=False)
    monkeypatch.setenv(_GONE, "1")
    assert external_jobs() is False


def test_dead_runtime_flag_does_not_store_blobs_in_the_db(monkeypatch):
    from app.graphs.chat import _blob_db
    from app.infrastructure.resume_workspace import _db_blobs

    monkeypatch.delenv("BLOB_STORE", raising=False)
    monkeypatch.setenv(_GONE, "1")
    assert _blob_db() is False
    assert _db_blobs() is False


def test_blob_store_db_still_selects_the_database(monkeypatch):
    from app.graphs.chat import _blob_db
    from app.infrastructure.resume_workspace import _db_blobs

    monkeypatch.setenv("BLOB_STORE", "db")
    assert _blob_db() is True
    assert _db_blobs() is True


def test_chat_executor_still_selects_external_jobs(monkeypatch):
    from app.jobs import external_jobs

    monkeypatch.delenv(_GONE, raising=False)
    monkeypatch.setenv("CHAT_EXECUTOR", "external")
    assert external_jobs() is True
    for mode in ("workflow", "local"):
        monkeypatch.setenv("CHAT_EXECUTOR", mode)
        assert external_jobs() is False


def test_dead_runtime_flag_does_not_change_framework(monkeypatch):
    from app.framework.flag import framework, use_langchain

    monkeypatch.setenv(_GONE, "1")
    assert framework() == "langchain"
    assert use_langchain() is True


def test_dead_runtime_flag_does_not_change_database_driver(monkeypatch):
    from app.db import database_driver, pg_transport

    monkeypatch.delenv("DB_DRIVER", raising=False)
    monkeypatch.delenv("PG_TRANSPORT", raising=False)
    monkeypatch.setenv(_GONE, "1")
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


def test_worker_page_fetch_is_gone():
    import app.ingest.web_page as web_page

    assert not hasattr(web_page, "_fetch_page_text_worker")
    assert not hasattr(web_page, "_browser_markdown")
    assert not hasattr(web_page, "_reject_private_host")


def test_listed_modules_have_no_dead_runtime_flag():
    roots = [
        ROOT / "src" / "app" / "framework" / "flag.py",
        ROOT / "src" / "app" / "db.py",
        ROOT / "src" / "app" / "main.py",
        ROOT / "src" / "app" / "api" / "middleware.py",
        ROOT / "src" / "app" / "ingest" / "web_page.py",
        ROOT / "src" / "app" / "pgproto.py",
        ROOT / "src" / "app" / "jobs.py",
        ROOT / "src" / "app" / "graphs" / "chat.py",
        ROOT / "src" / "app" / "infrastructure" / "resume_workspace.py",
        ROOT / "src" / "app" / "framework" / "smoke.py",
    ]
    for path in roots:
        assert _GONE not in path.read_text(), path.name
    assert "_open_workers_websocket" not in (ROOT / "src" / "app" / "pgproto.py").read_text()


def test_migrate_action_defaults_to_tcp():
    text = (REPO / ".github" / "workflows" / "migrate.yml").read_text()
    assert "default: tcp" in text
    assert "default: websocket" not in text


def test_pyproject_has_no_workers_dev_deps():
    text = (ROOT / "pyproject.toml").read_text()
    assert "workers-py" not in text
    assert "workers-runtime-sdk" not in text
    assert "py" "odide" not in text.lower()
