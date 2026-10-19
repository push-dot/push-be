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

    async def enqueue_started(self, user_id: UUID, conversation_id: UUID,
                              payload: dict, status_text: str) -> Optional[UUID]:
        """Insert the job and a status event, or return None if the chat is gone.

        The conversation check, the insert, and the first SSE status are
        one round trip. Archived chats are still inserted; resolve_context
        rejects them later, matching ``conversations.get``.
        """
        job_id = uuid4()
        row = await self.db.q().fetchrow(
            "WITH conv AS ("
            "SELECT id FROM conversations WHERE id = $2 AND user_id = $1"
            "), job AS ("
            "INSERT INTO chat_jobs (id, user_id, conversation_id, payload) "
            "SELECT $3, $1, conv.id, $4 FROM conv RETURNING id"
            "), ev AS ("
            "INSERT INTO chat_events (job_id, type, payload) "
            "SELECT job.id, 'status', $5 FROM job RETURNING job_id"
            ") "
            "SELECT job.id FROM job JOIN ev ON ev.job_id = job.id",
            user_id, conversation_id, job_id, _dump(payload),
            _dump({"text": status_text}))
        if row is None:
            return None
        return row["id"]

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
        async def work():
            await self.db.q().execute(
                "UPDATE chat_jobs SET status='PENDING', "
                "run_at=now() + make_interval(secs => $2), updated_at=$3 "
                "WHERE id=$1", job_id, delay_s, _now())
            await self.db.q().execute(
                "DELETE FROM chat_events WHERE job_id=$1", job_id)

        await self.db.do(work)

    async def reset_stale(self) -> int:
        await self.db.pool.execute(
            "UPDATE chat_jobs SET status='FAILED', error='worker died', "
            "updated_at=$1 WHERE status='RUNNING' AND ("
            "attempt >= 3 OR COALESCE((checkpoint->>'fails')::int, 0) >= 3)",
            _now())
        return await self.db.pool.fetchval(
            "WITH r AS (UPDATE chat_jobs SET status='PENDING', "
            "run_at=now(), updated_at=$1 WHERE status='RUNNING' "
            "RETURNING id), "
            "d AS (DELETE FROM chat_events WHERE job_id IN (SELECT id FROM r)) "
            "SELECT count(*) FROM r", _now())

    async def emit(self, job_id: UUID, type_: str, payload: dict) -> None:
        await self.db.q().execute(
            "INSERT INTO chat_events (job_id, type, payload) "
            "VALUES ($1,$2,$3)", job_id, type_, _dump(payload))

    async def active_for_conversation(
            self, user_id: UUID,
            conversation_id: UUID) -> Optional[UUID]:
        return await self.db.q().fetchval(
            "SELECT id FROM chat_jobs "
            "WHERE user_id=$1 AND conversation_id=$2 "
            "AND status IN ('PENDING','RUNNING') "
            "ORDER BY created_at DESC LIMIT 1",
            user_id, conversation_id)

    async def status(self, job_id: UUID) -> Optional[str]:
        return await self.db.q().fetchval(
            "SELECT status FROM chat_jobs WHERE id=$1", job_id)

    async def delete_events_after(self, job_id: UUID, event_id: int) -> None:
        await self.db.q().execute(
            "DELETE FROM chat_events WHERE job_id=$1 AND id>$2",
            job_id, event_id)

    async def max_event_id(self, job_id: UUID) -> int:
        val = await self.db.q().fetchval(
            "SELECT COALESCE(MAX(id), 0) FROM chat_events WHERE job_id=$1",
            job_id)
        return int(val or 0)

    async def events_since(self, job_id: UUID, after_id: int) -> list[dict]:
        rows = await self.db.q().fetch(
            "SELECT id, type, payload FROM chat_events "
            "WHERE job_id=$1 AND id>$2 ORDER BY id", job_id, after_id)
        return [dict(r) for r in rows]

    async def emit_many(self, job_id: UUID, events: list[tuple[str, dict]]) -> None:
        if not events:
            return
        await self.db.q().executemany(
            "INSERT INTO chat_events (job_id, type, payload) VALUES ($1,$2,$3)",
            [(job_id, type_, _dump(payload)) for type_, payload in events])

    async def claim_id(self, job_id: UUID) -> Optional[dict]:
        row = await self.db.pool.fetchrow(
            "UPDATE chat_jobs SET status='RUNNING', attempt=attempt+1, "
            "updated_at=$2 WHERE id=$1 AND status='PENDING' AND run_at<=now() "
            "RETURNING id, user_id, conversation_id, payload, attempt",
            job_id, _now())
        return dict(row) if row else None

    async def get(self, job_id: UUID) -> Optional[dict]:
        row = await self.db.q().fetchrow(
            "SELECT id, user_id, conversation_id, payload, attempt, status, "
            "checkpoint FROM chat_jobs WHERE id=$1", job_id)
        return dict(row) if row else None

    async def save_checkpoint(self, job_id: UUID, checkpoint: dict) -> None:
        await self.db.q().execute(
            "UPDATE chat_jobs SET checkpoint=$2, updated_at=$3 WHERE id=$1",
            job_id, _dump(checkpoint), _now())

    async def pending_ids(self, limit: int = 5) -> list[UUID]:
        rows = await self.db.pool.fetch(
            "SELECT id FROM chat_jobs WHERE status='PENDING' AND run_at<=now() "
            "ORDER BY created_at LIMIT $1", limit)
        return [r["id"] for r in rows]
