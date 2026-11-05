from __future__ import annotations

import hashlib
import secrets

from fastapi import APIRouter, Request

from app.db import NotFoundError
from app.domain.chat_turns import card_ids, card_resolution, turn_events, turn_view
from app.domain.errors import not_found
from app.domain.pagination import Cursor, new_page
from app.infrastructure.store_chat_jobs import assistant_message_id, user_message_id
from app.infrastructure.store_conversations import ConversationStore
from app.infrastructure.store_turns import TurnStore
from app.api.deps import current_user, data, page_body, page_request, param_id

router = APIRouter()


def _shares(request: Request) -> ConversationStore:
    return ConversationStore(request.app.state.db)


async def _visible_conversation(request: Request, id_: str):
    conversation_id = param_id(id_, "id")
    try:
        return await _shares(request).get(current_user(request).id, conversation_id)
    except NotFoundError:
        raise not_found()


@router.post("/conversations/{id}/share")
async def share_conversation(id: str, request: Request):
    conversation = await _visible_conversation(request, id)
    token = secrets.token_urlsafe(32)
    await _shares(request).put_share(
        conversation.id, hashlib.sha256(token.encode()).hexdigest())
    return data(200, {
        "token": token,
        "path": "/api/v1/conversations/shared/" + token,
    })


@router.get("/conversations/shared/{token}")
async def get_shared_conversation(token: str, request: Request):
    store = _shares(request)
    row = await store.share_by_hash(hashlib.sha256(token.encode()).hexdigest())
    if row is None:
        raise not_found()
    messages = await store.list_share_messages(row["conversation_id"])
    return data(200, {
        "title": row["title"],
        "messages": [
            {"role": message["role"], "text": message["text"],
             "createdAt": message["created_at"]}
            for message in messages
        ],
    })


@router.get("/conversations/{id}/artifacts")
async def list_conversation_artifacts(id: str, request: Request):
    conversation = await _visible_conversation(request, id)
    return data(200, await _shares(request).list_artifacts(conversation.id))


@router.get("/conversations/{id}/turns")
async def list_conversation_turns(id: str, request: Request):
    conversation = await _visible_conversation(request, id)
    page = page_request(request)
    turns = TurnStore(request.app.state.db)
    jobs = await turns.jobs(
        conversation.id, current_user(request).id, conversation.company_id is not None, page)
    shown = jobs[:page.effective_limit()]
    job_ids = [job["id"] for job in shown]
    rows = await turns.events(job_ids)
    cards = await turns.cards(conversation.id, card_ids(rows))
    resolutions = {str(card["id"]): card_resolution(card) for card in cards}
    stored = await turns.message_ids(conversation.id, job_ids)
    views = [
        turn_view(
            job,
            turn_events([row for row in rows if row["job_id"] == job["id"]], resolutions),
            _present(user_message_id(job["id"]), stored),
            _present(assistant_message_id(job["id"]), stored),
        )
        for job in jobs
    ]
    return page_body(new_page(
        views, page.effective_limit(),
        lambda view: Cursor(view["createdAt"], view["jobId"])))


def _present(message_id, stored):
    return message_id if message_id in stored else None
