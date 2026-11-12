from __future__ import annotations

from uuid import UUID

from app.db import DB
from app.domain.pagination import PageRequest
from app.infrastructure.store_chat_jobs import assistant_message_id, user_message_id

_JOBS = (
    "SELECT j.id, j.status, j.created_at, j.payload->'resume' AS resume FROM chat_jobs j "
    "WHERE j.conversation_id = $1 AND ($2::boolean OR j.user_id = $3) "
    "AND ($4::timestamptz IS NULL OR (j.created_at, j.id) < ($4::timestamptz, $5::uuid)) "
    "ORDER BY j.created_at DESC, j.id DESC LIMIT $6"
)

_EVENTS = (
    "SELECT id, job_id, type, payload, created_at FROM chat_events WHERE job_id = ANY($1::uuid[]) ORDER BY id"
)

_CARDS = (
    "SELECT a.id, a.option_id, a.created_at AS opened_at, a.expires_at, "
    "CASE WHEN a.status = 'PENDING' AND a.expires_at <= now() THEN 'EXPIRED' "
    "ELSE a.status END AS status, approval_retryable(a) AS retryable, "
    "(SELECT j.payload->'resume'->'optionIds' FROM chat_jobs j "
    "WHERE j.conversation_id = $1 AND j.payload->'resume'->>'approvalId' = a.id::text "
    "ORDER BY j.created_at DESC LIMIT 1) AS option_ids "
    "FROM approvals a WHERE a.conversation_id = $1 AND a.id = ANY($2::uuid[])"
)

_MESSAGES = "SELECT id FROM messages WHERE conversation_id = $1 AND id = ANY($2::uuid[])"

_TURN_MESSAGES = (
    "SELECT id, text, attachments FROM messages WHERE conversation_id = $1 AND id = ANY($2::uuid[])"
)

# $2 NULL is the caller's Push Bot.
_BOT_THREAD = (
    "SELECT t.id AS thread_id FROM bots b LEFT JOIN conversations t ON t.bot_id = b.id "
    "WHERE b.user_id = $1 AND b.deleted_at IS NULL "
    "AND (CASE WHEN $2::uuid IS NULL THEN b.kind = 'push' ELSE b.id = $2::uuid END)"
)


def _uuid(raw) -> UUID | None:
    try:
        return UUID(str(raw))
    except ValueError:
        return None


class TurnStore:
    def __init__(self, db: DB):
        self.db = db

    async def jobs(
        self, conversation_id: UUID, user_id: UUID, shared: bool, page: PageRequest
    ) -> list[dict]:
        cursor = page.cursor
        rows = await self.db.q().fetch(
            _JOBS,
            conversation_id,
            shared,
            user_id,
            cursor.created_at if cursor else None,
            cursor.id if cursor else None,
            page.effective_limit() + 1,
        )
        return [dict(row) for row in rows]

    async def events(self, job_ids: list[UUID]) -> list[dict]:
        if not job_ids:
            return []
        return [dict(row) for row in await self.db.q().fetch(_EVENTS, job_ids)]

    async def cards(self, conversation_id: UUID, card_ids: list) -> list[dict]:
        ids = [found for found in map(_uuid, card_ids) if found is not None]
        if not ids:
            return []
        return [dict(row) for row in await self.db.q().fetch(_CARDS, conversation_id, ids)]

    async def message_ids(self, conversation_id: UUID, job_ids: list[UUID]) -> set[UUID]:
        wanted = [make(job) for job in job_ids for make in (user_message_id, assistant_message_id)]
        if not wanted:
            return set()
        rows = await self.db.q().fetch(_MESSAGES, conversation_id, wanted)
        return {row["id"] if isinstance(row["id"], UUID) else UUID(str(row["id"])) for row in rows}

    async def bot_thread(self, user_id: UUID, bot_id: UUID | None) -> dict | None:
        """The caller's bot as {thread_id}, thread_id None before its first message. None: no such bot."""
        row = await self.db.q().fetchrow(_BOT_THREAD, user_id, bot_id)
        return None if row is None else dict(row)

    async def turn_messages(self, conversation_id: UUID, job_ids: list[UUID]) -> dict[UUID, dict]:
        """The USER and ASSISTANT rows the jobs wrote, by message id."""
        wanted = [make(job) for job in job_ids for make in (user_message_id, assistant_message_id)]
        if not wanted:
            return {}
        rows = await self.db.q().fetch(_TURN_MESSAGES, conversation_id, wanted)
        return {_uuid(row["id"]): dict(row) for row in rows}
