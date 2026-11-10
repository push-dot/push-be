from __future__ import annotations

import logging
import os

from app.account_purge import (
    COMPANY_PURGE_SQL,
    OAUTH_STATES_SQL,
    PHONE_CODES_SQL,
    PURGE_SQL,
    RETENTION,
    SWEEP_BATCH,
    SWEEP_ROUNDS,
    purge_deleted,
)
from app.infrastructure.images import image_dir


class _Pool:
    def __init__(self, rows=None, error=None, tags=None):
        self.rows = rows or []
        self.error = error
        self.tags = tags or {}
        self.sql = []
        self.args = []

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        self.args.append(args)
        if self.error:
            raise self.error
        return self.rows if sql == PURGE_SQL else []

    async def execute(self, sql, *args):
        self.sql.append(sql)
        self.args.append(args)
        if self.error:
            raise self.error
        return self.tags.get(sql, lambda: "DELETE 0")()


def _images(tmp_path, *names):
    d = image_dir(str(tmp_path))
    os.makedirs(d, exist_ok=True)
    for n in names:
        open(os.path.join(d, n), "wb").close()
    return d


async def test_purge_without_pool_is_noop():
    await purge_deleted(None, "/nowhere")


async def test_purge_removes_returned_image_keys(tmp_path):
    d = _images(tmp_path, "gone.png", "avatar.jpg", "keep.png")
    secret = tmp_path / "secret.txt"
    secret.write_text("x")
    pool = _Pool(rows=[{"key": "gone.png"}, {"key": "avatar.jpg"},
                       {"key": "../secret.txt"}, {"key": "missing.png"}])
    await purge_deleted(pool, str(tmp_path))
    assert pool.sql[:2] == [PURGE_SQL, COMPANY_PURGE_SQL]
    assert os.listdir(d) == ["keep.png"]
    assert secret.exists()


async def test_purge_without_storage_dir_only_runs_sql(tmp_path):
    d = _images(tmp_path, "gone.png")
    pool = _Pool(rows=[{"key": "gone.png"}])
    await purge_deleted(pool, None)
    assert pool.sql[0] == PURGE_SQL
    assert os.listdir(d) == ["gone.png"]


async def test_purge_logs_and_swallows_db_errors(tmp_path, caplog):
    d = _images(tmp_path, "gone.png")
    with caplog.at_level(logging.WARNING):
        await purge_deleted(_Pool(error=RuntimeError("relation missing")), str(tmp_path))
    assert "account purge failed" in caplog.text
    assert "company purge failed" in caplog.text
    assert "phone_code sweep failed" in caplog.text
    assert os.listdir(d) == ["gone.png"]


async def test_every_statement_gets_its_period_from_the_retention_table():
    pool = _Pool()
    await purge_deleted(pool, None)
    assert len(pool.sql) == 16
    assert all("$1::text::interval" in sql for sql in pool.sql)
    assert {args[0] for args in pool.args} <= set(RETENTION.values())
    assert (RETENTION["payment"], SWEEP_BATCH) in pool.args and RETENTION["payment"] == "5 years"


async def test_a_sweep_repeats_full_batches_and_stops_at_a_short_one():
    first, second = PHONE_CODES_SQL, OAUTH_STATES_SQL
    left = iter([f"DELETE {SWEEP_BATCH}"] * 2 + ["DELETE 7"])
    pool = _Pool(tags={first: lambda: next(left), second: lambda: f"DELETE {SWEEP_BATCH}"})
    await purge_deleted(pool, None)
    assert pool.sql.count(first) == 3
    # A backlog stops after SWEEP_ROUNDS batches; the next pass takes the rest.
    assert pool.sql.count(second) == SWEEP_ROUNDS
    assert all("LIMIT $2" in sql for sql in pool.sql[2:])
