from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from app.claimctx import LostClaim, bound_claim
from app.db import DB

# One Workflow attempt is prepare 3 min + generate 3 min + persist 1 min.
# Each step retries 5 times (6 tries) and backs off 2+4+8+16+32 seconds.
# The cron must wait longer than that whole budget before it treats a
# RUNNING job as dead. A live job is never reset, even at attempt 3.
_STEP_BUDGET_S = (3 + 3 + 1) * 60
_STEP_BACKOFF_S = 2 + 4 + 8 + 16 + 32
STALE_RUNNING_S = _STEP_BUDGET_S * 6 + _STEP_BACKOFF_S * 3 + 10 * 60
NUDGE_PENDING_AGE_S = 60


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _affected(tag) -> int:
    if not tag:
        return 0
    try:
        return int(str(tag).split()[-1])
    except ValueError:
        return 0


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
        # DONE and FAILED stay. A later error from a stale run cannot
        # reopen a chat that already finished.
        token = bound_claim(job_id)
        if token:
            tag = await self.db.q().execute(
                "UPDATE chat_jobs SET status=$2, error=$3, updated_at=$4 "
                "WHERE id=$1 AND status='RUNNING' AND checkpoint->>'claim'=$5",
                job_id, status, error, _now(), token)
            if _affected(tag) == 0:
                raise LostClaim()
            return
        await self.db.q().execute(
            "UPDATE chat_jobs SET status=$2, error=$3, updated_at=$4 "
            "WHERE id=$1 AND status NOT IN ('DONE', 'FAILED')",
            job_id, status, error, _now())

    async def requeue(self, job_id: UUID, delay_s: float) -> None:
        async def work():
            await self.db.q().execute(
                "UPDATE chat_jobs SET status='PENDING', "
                "run_at=now() + make_interval(secs => $2), updated_at=$3, "
                "checkpoint = COALESCE(checkpoint, '{}'::jsonb) - 'claim' "
                "WHERE id=$1", job_id, delay_s, _now())
            await self.db.q().execute(
                "DELETE FROM chat_events WHERE job_id=$1", job_id)

        await self.db.do(work)

    async def reset_stale(self, max_age_s: Optional[float] = None) -> int:
        """Requeue RUNNING jobs whose heartbeat is older than ``max_age_s``.

        The default is longer than a Workflow's timeouts and retries.
        ``0`` recovers every RUNNING job and is only for a process restart.
        """
        age = STALE_RUNNING_S if max_age_s is None else max_age_s
        now = _now()
        await self.db.pool.execute(
            "UPDATE chat_jobs SET status='FAILED', error='worker died', "
            "updated_at=$1 WHERE status='RUNNING' AND ("
            "attempt >= 3 OR COALESCE((checkpoint->>'fails')::int, 0) >= 3) "
            "AND updated_at <= now() - make_interval(secs => $2::double precision)",
            now, age)
        val = await self.db.pool.fetchval(
            "WITH r AS (UPDATE chat_jobs SET status='PENDING', run_at=now(), "
            "updated_at=$1, "
            "checkpoint = COALESCE(checkpoint, '{}'::jsonb) - 'claim' "
            "WHERE status='RUNNING' AND updated_at <= now() - "
            "make_interval(secs => $2::double precision) RETURNING id), "
            "d AS (DELETE FROM chat_events WHERE job_id IN (SELECT id FROM r)) "
            "SELECT count(*) FROM r", now, age)
        return int(val or 0)

    async def emit(self, job_id: UUID, type_: str, payload: dict) -> None:
        token = bound_claim(job_id)
        if token:
            tag = await self.db.q().execute(
                "INSERT INTO chat_events (job_id, type, payload) "
                "SELECT $1, $2, $3 FROM chat_jobs "
                "WHERE id=$1 AND status='RUNNING' AND checkpoint->>'claim'=$4",
                job_id, type_, _dump(payload), token)
            if _affected(tag) == 0:
                raise LostClaim()
            return
        if type_ == "error":
            await self.db.q().execute(
                "INSERT INTO chat_events (job_id, type, payload) "
                "SELECT $1, $2, $3 FROM chat_jobs "
                "WHERE id=$1 AND status NOT IN ('DONE', 'FAILED')",
                job_id, type_, _dump(payload))
            return
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
        token = bound_claim(job_id)
        if token:
            row = await self.db.q().fetchrow(
                "WITH owner AS ("
                "SELECT 1 AS ok FROM chat_jobs WHERE id=$1 AND status='RUNNING' "
                "AND checkpoint->>'claim'=$3"
                "), deleted AS ("
                "DELETE FROM chat_events WHERE job_id=$1 AND id>$2 "
                "AND EXISTS (SELECT 1 FROM owner) RETURNING 1"
                ") SELECT ok FROM owner",
                job_id, event_id, token)
            if row is None:
                raise LostClaim()
            return
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
        token = bound_claim(job_id)
        if token:
            import json
            tag = await self.db.q().execute(
                "INSERT INTO chat_events (job_id, type, payload) "
                "SELECT $1, e.type, e.payload "
                "FROM jsonb_to_recordset($2::jsonb) AS e(type text, payload jsonb) "
                "WHERE EXISTS (SELECT 1 FROM chat_jobs WHERE id=$1 "
                "AND status='RUNNING' AND checkpoint->>'claim'=$3)",
                job_id, json.dumps(
                    [{"type": type_, "payload": _dump(payload)}
                     for type_, payload in events]), token)
            if _affected(tag) == 0:
                raise LostClaim()
            return
        await self.db.q().executemany(
            "INSERT INTO chat_events (job_id, type, payload) VALUES ($1,$2,$3)",
            [(job_id, type_, _dump(payload)) for type_, payload in events])

    async def claim_with_token(self, job_id: UUID, claim: str) -> Optional[dict]:
        row = await self.db.pool.fetchrow(
            "UPDATE chat_jobs SET status='RUNNING', attempt=attempt+1, "
            "updated_at=$2, checkpoint = jsonb_set("
            "COALESCE(checkpoint, '{}'::jsonb), '{claim}', to_jsonb($3::text), true) "
            "WHERE id=$1 AND status='PENDING' AND run_at<=now() "
            "RETURNING id, user_id, conversation_id, payload, attempt, status",
            job_id, _now(), claim)
        return dict(row) if row else None

    async def touch_owner(self, job_id: UUID, claim: str) -> bool:
        tag = await self.db.q().execute(
            "UPDATE chat_jobs SET updated_at=$3 WHERE id=$1 AND status='RUNNING' "
            "AND checkpoint->>'claim'=$2",
            job_id, claim, _now())
        return _affected(tag) != 0

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
        body = dict(checkpoint)
        token = bound_claim(job_id)
        if token:
            body["claim"] = token
            tag = await self.db.q().execute(
                "UPDATE chat_jobs SET checkpoint=$2, updated_at=$3 "
                "WHERE id=$1 AND status IN ('RUNNING', 'DONE') "
                "AND checkpoint->>'claim'=$4",
                job_id, _dump(body), _now(), token)
            if _affected(tag) == 0:
                raise LostClaim()
            return
        await self.db.q().execute(
            "UPDATE chat_jobs SET checkpoint=$2, updated_at=$3 WHERE id=$1",
            job_id, _dump(body), _now())

    async def pending_ids(self, limit: int = 5,
                          min_age_s: float = NUDGE_PENDING_AGE_S) -> list[UUID]:
        rows = await self.db.pool.fetch(
            "SELECT id FROM chat_jobs WHERE status='PENDING' AND run_at<=now() "
            "AND created_at <= now() - make_interval(secs => $2::double precision) "
            "ORDER BY created_at LIMIT $1", limit, min_age_s)
        return [r["id"] for r in rows]
