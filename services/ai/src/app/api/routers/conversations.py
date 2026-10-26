from __future__ import annotations

import hashlib
import secrets

from fastapi import APIRouter, Request

from app.db import NotFoundError
from app.domain.errors import not_found
from app.infrastructure.store_conversations import ConversationStore
from app.api.deps import current_user, data, param_id

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
