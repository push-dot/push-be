"""Recording fake asyncpg connection and entity samples for store tests."""
from __future__ import annotations

import re
import types
import typing
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from uuid import UUID, uuid4

from pydantic import BaseModel

from app.db import DB
from app.domain.pagination import Cursor, PageRequest

NOW = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
USER = UUID("11111111-1111-1111-1111-111111111111")
OTHER = UUID("22222222-2222-2222-2222-222222222222")


class FakeConn:
    """Acts as pool and connection. Each call pops the next queued result.

    A queued Exception instance is raised instead of returned.
    """

    def __init__(self, *results):
        self.results = list(results)
        self.calls: list[tuple[str, str, tuple]] = []

    def _next(self, op, sql, args, default):
        self.calls.append((op, sql, args))
        if not self.results:
            return default
        r = self.results.pop(0)
        if isinstance(r, BaseException):
            raise r
        return r

    async def execute(self, sql, *args):
        return self._next("execute", sql, args, "UPDATE 1")

    async def executemany(self, sql, rows):
        return self._next("executemany", sql, (rows,), None)

    async def fetch(self, sql, *args):
        return self._next("fetch", sql, args, [])

    async def fetchrow(self, sql, *args):
        return self._next("fetchrow", sql, args, None)

    async def fetchval(self, sql, *args):
        return self._next("fetchval", sql, args, None)

    @asynccontextmanager
    async def transaction(self):
        yield self

    @asynccontextmanager
    async def acquire(self):
        yield self

    @property
    def last(self):
        return self.calls[-1]


def fake_db(*results) -> tuple[DB, FakeConn]:
    conn = FakeConn(*results)
    return DB(conn), conn


def assert_scoped(call, user_id, col: str = "user_id"):
    """The SQL filters ``col = $N`` and arg N is ``user_id``."""
    _, sql, args = call
    nums = re.findall(rf"(?<![\w.]){col}\s*=\s*\$(\d+)", sql)
    assert nums, f"{col} filter missing: {sql}"
    assert all(args[int(n) - 1] == user_id for n in nums), (sql, args)


def page(limit: int = 0, cursor: Cursor | None = None) -> PageRequest:
    return PageRequest(limit=limit, cursor=cursor)


def _value(ann):
    origin = typing.get_origin(ann)
    if origin in (typing.Union, types.UnionType):
        inner = [a for a in typing.get_args(ann) if a is not type(None)]
        return _value(inner[0]) if inner else None
    if origin is typing.Literal:
        return typing.get_args(ann)[0]
    if origin in (list, tuple, set):
        return []
    if origin is dict:
        return {}
    if ann is UUID:
        return uuid4()
    if ann is datetime:
        return NOW
    if ann is bool:
        return False
    if ann is int:
        return 1
    if ann is float:
        return 1.0
    if ann is str:
        return "x"
    if ann is bytes:
        return b"x"
    if ann is list:
        return []
    if ann is dict:
        return {}
    if isinstance(ann, type) and issubclass(ann, BaseModel):
        return ann(**sample(ann))
    return None


def sample(cls, **over) -> dict:
    """Field values that validate for ``cls``, keyed by field name."""
    out = {}
    for name, f in cls.model_fields.items():
        if name in over:
            out[name] = over[name]
        elif f.is_required():
            out[name] = _value(f.annotation)
        else:
            out[name] = f.get_default(call_default_factory=True)
    return out


def entity(cls, **over):
    return cls(**sample(cls, **over))


def row(cols: str, cls, **over) -> dict:
    """A DB row for a ``SELECT cols`` with values valid for ``cls``."""
    s = sample(cls, **over)
    names = [c.strip() for c in cols.split(",")]
    return {n: s.get(n, over.get(n)) for n in names}
