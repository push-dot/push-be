from __future__ import annotations

from uuid import UUID, uuid4

# What every personal turn reads, newest change first. The app shows up to 200 (core GET /me/memories).
PROMPT_LIMIT = 30
# A user keeps at most this many; the oldest change goes first.
KEEP_LIMIT = 100
TEXT_MAX = 300

_LIST = "SELECT text FROM user_memories WHERE user_id = $1 ORDER BY updated_at DESC, id LIMIT $2"
# Saying the same thing again moves it to the top instead of adding a copy.
_TOUCH = "UPDATE user_memories SET updated_at = now() WHERE user_id = $1 AND text = $2 RETURNING id"
_INSERT = "INSERT INTO user_memories (id, user_id, text) VALUES ($1, $2, $3)"
_PRUNE = (
    "DELETE FROM user_memories WHERE user_id = $1 AND id NOT IN ("
    "SELECT id FROM user_memories WHERE user_id = $1 ORDER BY updated_at DESC, id LIMIT $2)"
)


def _uid(user_id) -> UUID | None:
    try:
        return UUID(str(user_id))
    except (TypeError, ValueError):
        return None


async def memory_lines(db, user_id) -> list[str]:
    uid = _uid(user_id)
    if db is None or uid is None:
        return []
    rows = await db.q().fetch(_LIST, uid, PROMPT_LIMIT)
    return [str(row["text"]) for row in rows or []]


async def remember(db, user_id, text: str) -> dict:
    uid = _uid(user_id)
    fact = " ".join(text.split())[:TEXT_MAX]
    if db is None or uid is None or not fact:
        return {"saved": False}
    if await db.q().fetchval(_TOUCH, uid, fact) is None:
        await db.q().execute(_INSERT, uuid4(), uid, fact)
        await db.q().execute(_PRUNE, uid, KEEP_LIMIT)
    return {"saved": True, "text": fact}
