from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from app.db import DB


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _dump(v):
    from app.jsonutil import to_jsonable
    return to_jsonable(v)


class ChatJobStore:
    def __init__(self, db: DB):
        self.db = db

    async def enqueue(self, user_id: UUID, conversation_id: UUID,
                      payload: dict) -> UUID:
        job_id = uuid4()
        await self.db.q().execute(
            "INSERT INTO chat_jobs (id, user_id, conversation_id, payload) "
            "VALUES ($1,$2,$3,$4)",
            job_id, user_id, conversation_id, _dump(payload))
        return job_id

    async def claim(self) -> Optional[dict]:
        row = await self.db.pool.fetchrow(
            "UPDATE chat_jobs SET status='RUNNING', attempt=attempt+1, "
            "updated_at=$1 WHERE id = ("
            "  SELECT id FROM chat_jobs WHERE status='PENDING' AND run_at<=now()"
            "  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED"
            ") RETURNING id, user_id, conversation_id, payload, attempt",
            _now())
        return dict(row) if row else None

    async def finish(self, job_id: UUID, status: str,
                     error: Optional[str] = None) -> None:
        await self.db.q().execute(
            "UPDATE chat_jobs SET status=$2, error=$3, updated_at=$4 "
            "WHERE id=$1", job_id, status, error, _now())

    async def requeue(self, job_id: UUID, delay_s: float) -> None:
        await self.db.q().execute(
            "UPDATE chat_jobs SET status='PENDING', "
            "run_at=now() + make_interval(secs => $2), updated_at=$3 "
            "WHERE id=$1", job_id, delay_s, _now())

    async def reset_stale(self) -> int:
        await self.db.pool.execute(
            "UPDATE chat_jobs SET status='FAILED', error='worker died', "
            "updated_at=$1 WHERE status='RUNNING' AND attempt >= 3", _now())
        return await self.db.pool.fetchval(
            "WITH r AS (UPDATE chat_jobs SET status='PENDING', "
            "run_at=now(), updated_at=$1 WHERE status='RUNNING' "
            "RETURNING 1) SELECT count(*) FROM r", _now())

    async def emit(self, job_id: UUID, type_: str, payload: dict) -> None:
        await self.db.q().execute(
            "INSERT INTO chat_events (job_id, type, payload) "
            "VALUES ($1,$2,$3)", job_id, type_, _dump(payload))

    async def status(self, job_id: UUID) -> Optional[str]:
        return await self.db.q().fetchval(
            "SELECT status FROM chat_jobs WHERE id=$1", job_id)

    async def events_since(self, job_id: UUID, after_id: int) -> list[dict]:
        rows = await self.db.q().fetch(
            "SELECT id, type, payload FROM chat_events "
            "WHERE job_id=$1 AND id>$2 ORDER BY id", job_id, after_id)
        return [dict(r) for r in rows]
