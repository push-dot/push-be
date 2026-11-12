from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.api.deps import current_user, page_request, param_id
from app.domain.chat_turns import bot_card, bot_turn, bot_turn_events, card_ids
from app.domain.errors import not_found
from app.domain.pagination import Cursor
from app.infrastructure.store_chat_jobs import assistant_message_id, user_message_id
from app.infrastructure.store_turns import TurnStore
from app.jsonutil import to_jsonable

router = APIRouter()

PUSH = "push"
TRANSCRIPT_PAGE = 30
_ACTIVE = frozenset({"PENDING", "RUNNING"})


@router.get("/bots/{id}/transcript")
async def bot_transcript(id: str, request: Request):
    user = current_user(request)
    page = page_request(request)
    page.limit = page.limit or TRANSCRIPT_PAGE
    limit = page.effective_limit()
    store = TurnStore(request.app.state.db)
    bot = await store.bot_thread(user.id, None if id == PUSH else param_id(id, "id"))
    if bot is None and id != PUSH:
        raise not_found()
    thread = bot["thread_id"] if bot else None
    jobs = await store.jobs(thread, user.id, False, page) if thread else []
    shown = jobs[:limit]
    job_ids = [job["id"] for job in shown]
    rows = await store.events(job_ids)
    cards = {str(card["id"]): bot_card(card) for card in await store.cards(thread, card_ids(rows))}
    messages = await store.turn_messages(thread, job_ids)
    rows_of: dict = {}
    for row in rows:
        rows_of.setdefault(row["job_id"], []).append(row)
    turns = [
        bot_turn(
            job,
            bot_turn_events(rows_of.get(job["id"], []), cards, job["status"] in _ACTIVE),
            messages.get(user_message_id(job["id"])),
            messages.get(assistant_message_id(job["id"])),
        )
        for job in shown
    ]
    more = len(jobs) > limit
    newest = shown[0] if shown and page.cursor is None and shown[0]["status"] in _ACTIVE else None
    return JSONResponse(content=to_jsonable({
        "data": turns,
        "page": {
            "nextCursor": Cursor(shown[-1]["created_at"], shown[-1]["id"]).encode() if more else None,
            "hasMore": more,
        },
        "live": None if newest is None else {
            "turnId": str(newest["id"]),
            "lastSeq": max((int(row["id"]) for row in rows_of.get(newest["id"], [])), default=0),
        },
    }))
