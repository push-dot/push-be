from __future__ import annotations

import json

from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse

from app.domain.errors import DomainError
from app.jsonutil import to_jsonable
from app.presentation import schemas as s
from app.presentation.deps import (deps,
    bind_json, current_user, data, optional_query_uuid, page_body,
    page_request, param_id,
)
from app.presentation.routers.jobs import _ai

router = APIRouter()




@router.get("/conversations")
async def list_conversations(request: Request):
    d = deps(request)
    p = await d.conversations.list(
        current_user(request).id,
        optional_query_uuid(request, "applicationId"), page_request(request))
    return page_body(p)


@router.post("/conversations", status_code=201)
async def create_conversation(request: Request):
    d = deps(request)
    req = await bind_json(request, s.CreateConversationReq)
    v = await d.conversations.create(current_user(request).id,
                                     req.application_id, req.title)
    return data(201, v)


@router.patch("/conversations/{id}")
async def patch_conversation(id: str, request: Request):
    d = deps(request)
    req = await bind_json(request, s.PatchConversationReq)
    v = await d.conversations.patch(current_user(request).id,
                                    param_id(id, "id"), req.expected_revision,
                                    req.title, req.pinned)
    return data(200, v)


@router.get("/conversations/{id}/messages")
async def list_messages(id: str, request: Request):
    d = deps(request)
    p = await d.conversations.list_messages(current_user(request).id,
                                            param_id(id, "id"),
                                            page_request(request))
    return page_body(p)


@router.post("/conversations/{id}/messages", status_code=202)
async def post_message(id: str, request: Request):
    d = deps(request)
    req = await bind_json(request, s.PostMessageReq)
    context = (req.context.model_dump(by_alias=True) if req.context else {})
    op = await d.conversations.post_message(current_user(request).id,
                                            param_id(id, "id"), req.text,
                                            context, _ai(req.ai),
                                            req.access_mode,
                                            request.headers.get("x-byok-key", ""))
    return data(202, op)


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
                    user_id, conversation_id, req.text, context, _ai(req.ai),
                    req.access_mode,
                    request.headers.get("x-byok-key", "")),
                request):
            yield frame

    return _sse_response(events())


@router.get("/conversations/{id}/messages/stream/active")
async def get_active_stream(id: str, request: Request):
    d = deps(request)
    user_id = current_user(request).id
    conversation_id = param_id(id, "id")
    if await d.conversations.active_job_id(user_id, conversation_id) is None:
        return Response(status_code=204)
    after_raw = request.query_params.get("after", "")
    after = int(after_raw) if after_raw.isdigit() else 0

    async def events():
        async for frame in _sse_frames(
                d.conversations.stream_active(user_id, conversation_id, after),
                request):
            yield frame

    return _sse_response(events())


async def _sse_frames(gen, request: Request):
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
            else:
                body = {"type": "done", "operation": to_jsonable(payload)}
            if seq is not None:
                body["seq"] = seq
            yield "data: " + json.dumps(body) + "\n\n"
    except DomainError as e:
        yield "data: " + json.dumps(
            {"type": "error",
             "error": {"code": e.code, "message": e.message,
                       "details": e.details}}) + "\n\n"


def _sse_response(gen):
    return StreamingResponse(
        gen, media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/conversations/{id}/archive")
async def archive_conversation(id: str, request: Request):
    d = deps(request)
    req = await bind_json(request, s.ExpectedRevisionReq)
    v = await d.conversations.archive(current_user(request).id,
                                      param_id(id, "id"),
                                      req.expected_revision)
    return data(200, v)
