from __future__ import annotations

import hashlib
import json
import secrets

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.db import NotFoundError
from app.domain.errors import DomainError, not_found
from app.jsonutil import to_jsonable
from app.api import schemas as s
from app.graphs.chat_surface import resolve_chat_approval
from app.infrastructure.store_conversations import ConversationStore
from app.api.deps import deps, ai_options, bind_json, current_user, data, param_id

router = APIRouter()


@router.post("/conversations/{id}/messages/stream")
async def post_message_stream(id: str, request: Request):
    d = deps(request)
    req = await bind_json(request, s.PostMessageReq)
    context = (req.context.model_dump(by_alias=True) if req.context else {})
    user_id = current_user(request).id
    conversation_id = param_id(id, "id")

    async def events():
        async for frame in _sse_frames(
                d.conversations.stream_message(
                    user_id, conversation_id, req.text, context, ai_options(req.ai),
                    req.access_mode,
                    request.headers.get("x-byok-key", ""),
                    req.intent, req.application_id),
                request):
            yield frame

    return _sse_response(events())


async def _sse_frames(gen, request: Request):
    # EventSource reconnects with Last-Event-ID. Free-plan Workers close the
    # response after a short poll budget; `retry` asks the client to resume.
    yield "retry: 400\n\n"
    try:
        async for kind, payload, seq in gen:
            if await request.is_disconnected():
                break
            if kind == "token":
                body = {"type": "token", "text": payload}
            elif kind == "status":
                body = {"type": "status", "text": payload}
            elif kind == "error":
                body = {"type": "error", "error": payload}
            elif kind == "done" and isinstance(payload, dict) and payload.get("awaiting"):
                body = {"type": "done", "operation": None, "awaiting": payload["awaiting"]}
            elif kind == "done":
                body = {"type": "done", "operation": to_jsonable(payload)}
            elif kind == "cancelled":
                body = {"type": "cancelled"}
            elif isinstance(payload, dict):
                body = {"type": kind}
                body.update({
                    key: value for key, value in payload.items() if key != "type"})
            else:
                body = {"type": kind}
            if seq is not None:
                body["seq"] = seq
            prefix = f"id: {seq}\n" if seq is not None else ""
            yield prefix + "data: " + json.dumps(body) + "\n\n"
    except DomainError as e:
        yield "data: " + json.dumps(
            {"type": "error",
             "error": {"code": e.code, "message": e.message,
                       "details": e.details}}) + "\n\n"
    except Exception:
        yield "data: " + json.dumps(
            {"type": "error",
             "error": {"code": "INTERNAL", "message": "internal error",
                       "details": None}}) + "\n\n"


def _sse_response(gen):
    return StreamingResponse(
        gen, media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class _ResolveApprovalReq(s.Req):
    option_id: str


@router.post("/conversations/{id}/approvals/{approval_id}")
async def resolve_conversation_approval(id: str, approval_id: str, request: Request):
    req = await bind_json(request, _ResolveApprovalReq)
    body = await resolve_chat_approval(
        request.app.state.db, current_user(request).id,
        param_id(id, "id"), param_id(approval_id, "approvalId"),
        req.option_id)
    return data(200, body)


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
