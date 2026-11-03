"""pytest plugin (test-only): with SQL_CAPTURE=<file>, record the SQL services/ai sends.

Stores reach the database through Store.q() and DB.q(). Both are wrapped to return a
proxy that appends the first argument of fetch/fetchrow/fetchval/execute/executemany to
<file> (one JSON string per line), then calls through to whatever the test supplied.
prepare.mjs PREPAREs the captured statements next to the Workers' ones.

Usage: SQL_CAPTURE=/tmp/sql.jsonl uv run --extra test pytest -p sql_capture
       (with scripts/sql-check on PYTHONPATH)
"""

from __future__ import annotations

import json
import os

_METHODS = {"fetch", "fetchrow", "fetchval", "execute", "executemany"}


class _Recording:
    def __init__(self, inner, path: str):
        self._inner = inner
        self._path = path

    def __getattr__(self, name):
        attr = getattr(self._inner, name)
        if name not in _METHODS or not callable(attr):
            return attr

        def call(sql, *args, **kwargs):
            if isinstance(sql, str):
                with open(self._path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(sql, ensure_ascii=False) + "\n")
            return attr(sql, *args, **kwargs)

        return call


def pytest_configure(config):
    path = os.environ.get("SQL_CAPTURE")
    if not path:
        return
    from app.db import DB
    from app.infrastructure.store_common import Store

    for cls in (DB, Store):
        original = cls.q

        def q(self, _original=original):
            return _Recording(_original(self), path)

        cls.q = q
