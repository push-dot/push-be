from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

import pytest

from app.queue.admin import FINISHED, AdminJobs

NOW = datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc)
JOB = UUID("99999999-9999-4999-8999-999999999999")


class Conn:
    def __init__(self, *, rows=(), row=None, vals=(), tags=()):
        self.rows = list(rows)
        self.row = row
        self.vals = list(vals)
        self.tags = list(tags)
        self.log = []
        self.in_tx = False
        self.closed = False

    async def fetch(self, sql, *args):
        self.log.append(("fetch", sql, args, self.in_tx))
        return self.rows

    async def fetchrow(self, sql, *args):
        self.log.append(("fetchrow", sql, args, self.in_tx))
        return self.row

    async def fetchval(self, sql, *args):
        self.log.append(("fetchval", sql, args, self.in_tx))
        return self.vals.pop(0)

    async def execute(self, sql, *args):
        self.log.append(("execute", sql, args, self.in_tx))
        return self.tags.pop(0) if self.tags else "UPDATE 1"

    @asynccontextmanager
    async def transaction(self):
        self.in_tx = True
        try:
            yield
        finally:
            self.in_tx = False

    async def close(self):
        self.closed = True


async def test_close_closes_the_connection():
    conn = Conn()
    await AdminJobs(conn).close()
    assert conn.closed


async def test_dead_jobs_serializes_rows_for_the_admin_api():
    conn = Conn(rows=[
        {"id": JOB, "type": "chat", "status": "DEAD", "error": {"message": "boom"}, "attempts": 3,
         "updated_at": NOW},
        {"id": UUID(int=1), "type": "fit", "status": "DEAD", "error": None, "attempts": 0, "updated_at": None},
    ])
    out = await AdminJobs(conn).dead_jobs("DEAD", 25)
    assert out == [
        {"id": str(JOB), "type": "chat", "status": "DEAD", "error": {"message": "boom"}, "attempts": 3,
         "updatedAt": "2026-05-01T12:00:00Z"},
        {"id": str(UUID(int=1)), "type": "fit", "status": "DEAD", "error": None, "attempts": 0, "updatedAt": None},
    ]
    _, sql, args, _ = conn.log[0]
    assert "WHERE status = $1" in sql and "LIMIT $2" in sql
    assert args == ("DEAD", 25)


async def test_retry_requeues_rereserves_credits_and_writes_outbox_atomically():
    conn = Conn(row={"queue": "q:document"})
    assert await AdminJobs(conn).retry(JOB, NOW) is True
    (_, update, uargs, utx), (_, credits, cargs, ctx), (_, outbox, oargs, otx) = conn.log
    assert "SET status = 'QUEUED', attempts = 0, error = NULL" in update
    assert "status IN ('DEAD', 'FAILED')" in update
    assert uargs == (JOB, NOW)
    assert "SET status = 'RESERVED'" in credits and "status = 'RELEASED'" in credits
    assert cargs == (JOB, NOW)
    assert outbox.startswith("INSERT INTO outbox") and oargs == (JOB, "q:document")
    assert utx and ctx and otx


async def test_retry_of_a_job_that_is_not_dead_or_failed_changes_nothing():
    conn = Conn(row=None)
    assert await AdminJobs(conn).retry(JOB, NOW) is False
    assert [entry[0] for entry in conn.log] == ["fetchrow"]


async def test_cancel_marks_cancelled_and_releases_reserved_credits():
    conn = Conn(tags=["UPDATE 1"])
    assert await AdminJobs(conn).cancel(JOB, NOW) is True
    (_, cancel, cargs, _), (_, release, rargs, _) = conn.log
    assert "SET status = 'CANCELLED'" in cancel and "('QUEUED', 'RETRY', 'RUNNING')" in cancel
    assert cargs == (JOB, NOW)
    assert "credit_reservations SET status = 'RELEASED'" in release and "status = 'RESERVED'" in release
    assert rargs == (JOB, NOW)


async def test_cancel_of_a_finished_job_does_not_release_credits():
    conn = Conn(tags=["UPDATE 0"])
    assert await AdminJobs(conn).cancel(JOB, NOW) is False
    assert len(conn.log) == 1


async def test_cancel_counts_ten_rows_as_changed():
    conn = Conn(tags=["UPDATE 10"])
    assert await AdminJobs(conn).cancel(JOB, NOW) is True


async def test_type_stats_rounds_and_defaults_per_job_type():
    conn = Conn(rows=[
        {"type": "chat", "wait_p50": 1.23456, "wait_p95": Decimal("9.8765"), "run_p50": 2, "run_p95": 30.0,
         "fail_rate": 0.333333333, "dead": 2},
        {"type": "fit", "wait_p50": None, "wait_p95": None, "run_p50": None, "run_p95": None,
         "fail_rate": None, "dead": 0},
    ])
    out = await AdminJobs(conn).type_stats(NOW)
    assert out == {
        "chat": {"waitP50": 1.235, "waitP95": 9.877, "runP50": 2.0, "runP95": 30.0, "failRate": 0.3333, "dead": 2},
        "fit": {"waitP50": None, "waitP95": None, "runP50": None, "runP95": None, "failRate": 0.0, "dead": 0},
    }
    _, sql, args, _ = conn.log[0]
    assert "GROUP BY type" in sql and args == (NOW - timedelta(hours=24),)


@pytest.mark.parametrize("size, nodes, expected", [
    (123456, 42, {"dbSizeBytes": 123456, "ragNodes": 42}),
    (None, None, {"dbSizeBytes": 0, "ragNodes": 0}),
    (10, -1, {"dbSizeBytes": 10, "ragNodes": 0}),  # reltuples is -1 before the first ANALYZE
])
async def test_neon_stats_reports_size_and_node_estimate(size, nodes, expected):
    conn = Conn(vals=[size, nodes])
    assert await AdminJobs(conn).neon_stats() == expected
    assert "pg_database_size" in conn.log[0][1]
    assert "to_regclass('rag_nodes')" in conn.log[1][1]


async def test_purge_finished_deletes_old_finished_jobs_and_dispatched_outbox():
    conn = Conn(tags=["DELETE 7", "DELETE 3"])
    assert await AdminJobs(conn).purge_finished(NOW) == 7
    (_, jobs, jargs, _), (_, outbox, oargs, _) = conn.log
    cutoff = NOW - timedelta(days=30)
    assert jobs.startswith("DELETE FROM ai_jobs") and jargs == (list(FINISHED), cutoff)
    assert set(FINISHED) == {"DONE", "FAILED", "DEAD", "CANCELLED"}
    assert "dispatched_at IS NOT NULL" in outbox and oargs == (cutoff,)
