import re
from pathlib import Path

SQL = (Path(__file__).resolve().parents[3] / "db" / "migrations"
       / "0027_ai_runtime_indexes.sql").read_text()


def test_0027_indexes_are_idempotent_and_skip_the_chat_jobs_view():
    stmts = [s.strip() for s in SQL.split(";") if s.strip().replace("-", "").strip()]
    creates = [s for s in stmts if "CREATE" in s]
    assert len(creates) == 10
    assert all("CREATE INDEX IF NOT EXISTS" in s for s in creates)
    targets = {re.search(r" ON (\w+) \(([^)]*)\)", s).groups() for s in creates}
    assert ("gap_analyses", "application_id, created_at DESC, id DESC") in targets
    assert ("ai_jobs", "conversation_id, created_at DESC") in targets
    assert ("access_tokens", "refresh_token_id") in targets
    assert "ON chat_jobs" not in SQL
