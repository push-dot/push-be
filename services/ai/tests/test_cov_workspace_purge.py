from __future__ import annotations

import logging
import os

from app.account_purge import PURGE_SQL, purge_deleted
from app.infrastructure.images import image_dir


class _Pool:
    def __init__(self, rows=None, error=None):
        self.rows = rows or []
        self.error = error
        self.sql = []

    async def fetch(self, sql):
        self.sql.append(sql)
        if self.error:
            raise self.error
        return self.rows


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
    assert pool.sql == [PURGE_SQL]
    assert os.listdir(d) == ["keep.png"]
    assert secret.exists()


async def test_purge_without_storage_dir_only_runs_sql(tmp_path):
    d = _images(tmp_path, "gone.png")
    pool = _Pool(rows=[{"key": "gone.png"}])
    await purge_deleted(pool, None)
    assert pool.sql == [PURGE_SQL]
    assert os.listdir(d) == ["gone.png"]


async def test_purge_logs_and_swallows_db_errors(tmp_path, caplog):
    d = _images(tmp_path, "gone.png")
    with caplog.at_level(logging.WARNING):
        await purge_deleted(_Pool(error=RuntimeError("relation missing")), str(tmp_path))
    assert "account purge failed" in caplog.text
    assert os.listdir(d) == ["gone.png"]
