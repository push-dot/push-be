"""The migrate workflow is manual. These checks do not run it."""

from pathlib import Path

from app.db import pg_transport


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github" / "workflows" / "migrate.yml"


def test_migrate_workflow_defaults_to_websocket_and_keeps_tcp():
    text = WORKFLOW.read_text()
    steps = "\n".join(
        line for line in text.splitlines() if not line.strip().startswith("#"))
    assert "workflow_dispatch:" in text
    assert "default: websocket" in text
    assert "\n          - websocket\n" in text
    assert "\n          - tcp\n" in text
    assert "PG_TRANSPORT: ${{ inputs.transport }}" in text
    assert "DATABASE_URL: ${{ secrets.DATABASE_URL }}" in text
    assert "secret put" not in steps
    assert "wrangler deploy" not in steps
    # The choice is checked again in the shell so a bad dispatch cannot
    # smuggle another transport into the process environment.
    assert 'tcp|websocket' in text
    assert "websockets>=13,<17" in text


def test_pg_transport_honors_the_workflow_env(monkeypatch):
    monkeypatch.delenv("PG_TRANSPORT", raising=False)
    monkeypatch.delenv("CF_WORKER", raising=False)
    assert pg_transport() == "tcp"
    monkeypatch.setenv("PG_TRANSPORT", "websocket")
    assert pg_transport() == "websocket"
    monkeypatch.setenv("PG_TRANSPORT", "tcp")
    assert pg_transport() == "tcp"
    monkeypatch.setenv("PG_TRANSPORT", "nope")
    assert pg_transport() == "tcp"
