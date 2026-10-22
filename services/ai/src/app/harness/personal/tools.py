from __future__ import annotations

import contextvars
import json
from typing import Literal
from urllib.parse import urlencode
from uuid import NAMESPACE_URL, UUID, uuid5

from langgraph.config import get_stream_writer
from langgraph.types import interrupt
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.domain.errors import DomainError
from app.domain.pagination import PageRequest
from app.domain.posting_fit import compute_fit
from app.graphs.chat_surface import insert_chat_approval
from app.harness.document_edits import apply_edit
from app.harness.core_client import idempotency_key
from app.harness.policy import Tier
from app.harness.tools import ToolContext, ToolSpec
from app.jsonutil import to_jsonable

bound_services: contextvars.ContextVar = contextvars.ContextVar(
    "harness_services", default=None)


class EmptyArgs(BaseModel):
    pass


class PostingId(BaseModel):
    posting_id: UUID


class SearchPostings(BaseModel):
    q: str = ""


class OfferId(BaseModel):
    offer_id: UUID


class OfferMessage(BaseModel):
    offer_id: UUID
    body: str


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


CalendarType = Literal["INTERVIEW", "DEADLINE", "FOLLOW_UP", "CUSTOM", "COFFEE_CHAT"]


class CalendarCreate(_Camel):
    type: CalendarType
    title: str
    starts_at: str
    ends_at: str


class CalendarUpdate(_Camel):
    event_id: UUID
    type: CalendarType | None = None
    title: str | None = None
    starts_at: str | None = None
    ends_at: str | None = None


class EventId(BaseModel):
    event_id: UUID


class PostBody(BaseModel):
    category: Literal["work", "dev", "daily", "career", "talk", "coffeechat", "marketing"]
    title: str
    body: str


class CommentBody(BaseModel):
    post_id: UUID
    body: str = ""


class FollowUser(BaseModel):
    user_id: UUID


class ProfilePatch(_Camel):
    display_name: str | None = None
    headline: str | None = None


class DocumentId(BaseModel):
    document_id: str


class EditDocumentArgs(BaseModel):
    document_id: str
    version_id: UUID | None = None
    before: str = ""
    after: str = ""
    instruction: str = ""


class FitArgs(BaseModel):
    posting_id: str = ""
    document_id: str = ""
    requirements: list[str] = []
    keywords: list[str] = []
    description: str = ""
    content: str = ""


class CareerQuery(BaseModel):
    query: str = ""


class PrepareArgs(BaseModel):
    interview_id: str
    expected_revision: int = 0


def _emit(event: dict) -> None:
    try:
        get_stream_writer()(event)
    except Exception:
        return


def _core(name, tier, model, summary, method, path_of, *, write=False, drop=()):
    async def run(ctx: ToolContext, args):
        body = args.model_dump(mode="json", exclude_none=True, by_alias=True, exclude=set(drop))
        return await ctx.core.call(
            method,
            path_of(args),
            user_id=ctx.user_id,
            company_id=ctx.company_id,
            json=body or None,
            idempotency_key=idempotency_key(ctx.job_id, ctx.tool_call_id) if write else None,
        )

    return ToolSpec(name, tier, model, run, lambda _args: summary)


def _svc():
    return bound_services.get()


async def _list_documents(ctx: ToolContext, _args: EmptyArgs) -> dict:
    svc = _svc()
    document_svc = getattr(svc, "document_svc", None) if svc else None
    if document_svc is None:
        return {"items": []}
    page = await document_svc.list(UUID(ctx.user_id), None, None, PageRequest())
    return {"items": to_jsonable(page.items)}


async def _get_document(ctx: ToolContext, args: DocumentId) -> dict:
    svc = _svc()
    document_svc = getattr(svc, "document_svc", None) if svc else None
    if document_svc is None:
        return {}
    return to_jsonable(await document_svc.get(UUID(ctx.user_id), UUID(args.document_id)))


def _diff(args: EditDocumentArgs) -> dict:
    hunks = []
    if args.before:
        hunks.append({"line": None, "sign": "-", "text": args.before})
    if args.after:
        hunks.append({"line": None, "sign": "+", "text": args.after})
    return {
        "type": "diff",
        "documentId": args.document_id,
        "revisionId": str(args.version_id or ""),
        "hunks": hunks,
    }


def _document_event(job_id: str, document_id: str) -> dict:
    approval_id = str(uuid5(NAMESPACE_URL, "push:chat-approval:" + str(job_id)))
    return {
        "type": "approval",
        "id": approval_id,
        "kind": "DOCUMENT_EDIT",
        "title": "이 수정을 적용할까요?",
        "documentId": document_id,
        "options": [
            {"id": "apply", "label": "적용"},
            {"id": "skip", "label": "그대로 두기"},
        ],
    }


async def _edit_document(ctx: ToolContext, args: EditDocumentArgs) -> dict:
    if ctx.access_mode == "ALWAYS_ASK":
        event = _document_event(ctx.job_id, args.document_id)
        approval_id = UUID(str(event["id"]))
        row = await ctx.db.q().fetchrow(
            "SELECT id FROM approvals WHERE id = $1", approval_id)
        if row is None:
            await insert_chat_approval(
                ctx.db, ctx.user_id, ctx.conversation_id, event, args.document_id)
            await ctx.db.q().execute(
                "UPDATE approvals SET job_id = $2 WHERE id = $1", approval_id, ctx.job_id)
            _emit(event)
        answer = interrupt({
            "approval_id": event["id"],
            "awaiting": "approval",
            "kind": "DOCUMENT_EDIT",
        }) or {}
        if answer.get("option_id") != "apply":
            return {"skipped": True}
    diff = _diff(args)
    try:
        applied = await apply_edit(ctx.core, ctx.user_id, diff)
    except DomainError as err:
        return {"error": err.code}
    _emit(diff)
    return {"diff": diff, "versionId": str((applied.get("version") or {}).get("id") or "")}


async def _resume_row(ctx: ToolContext):
    try:
        return await ctx.db.q().fetchrow(
            "SELECT resume_state FROM conversations WHERE id = $1",
            ctx.conversation_id,
        )
    except Exception:
        return None


def _resume_status(row) -> str:
    if not row:
        return ""
    raw = row["resume_state"] if isinstance(row, dict) else None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return ""
    if isinstance(raw, dict):
        return str(raw.get("status") or "")
    return ""


async def _start_document(ctx: ToolContext, _args: EmptyArgs) -> dict:
    if _resume_status(await _resume_row(ctx)) == "active":
        choice = {
            "type": "choice",
            "id": str(uuid5(NAMESPACE_URL, "push:start-document:" + ctx.conversation_id)),
            "gate": "start_document",
            "options": [
                {"id": "continue", "label": "이어서 작성하기"},
                {"id": "cancel", "label": "그만하기"},
            ],
        }
        _emit(choice)
        return {"choice": choice}
    state = {"status": "active", "phase": "mode_select"}
    await ctx.db.q().execute(
        "UPDATE conversations SET resume_state = $2::jsonb WHERE id = $1",
        ctx.conversation_id,
        json.dumps(state, ensure_ascii=False),
    )
    return {"harness": "resume", "resume_state": state}


async def _list_applications(ctx: ToolContext, _args: EmptyArgs) -> dict:
    svc = _svc()
    application_svc = getattr(svc, "application_svc", None) if svc else None
    if application_svc is None:
        return {"items": []}
    page = await application_svc.list(UUID(ctx.user_id), None, "", PageRequest())
    return {"items": to_jsonable(page.items)}


async def _get_fit_score(_ctx: ToolContext, args: FitArgs) -> dict:
    document_id = UUID(args.document_id) if args.document_id else UUID(int=0)
    return compute_fit(
        args.requirements, args.keywords, args.description,
        document_id, args.content, "FREE")


async def _prepare_interview(ctx: ToolContext, args: PrepareArgs) -> dict:
    svc = _svc()
    interviews = getattr(svc, "interviews", None) if svc else None
    if interviews is None:
        return {"error": "UNAVAILABLE"}
    op = await interviews.prepare(
        UUID(ctx.user_id), UUID(args.interview_id), args.expected_revision, None)
    return to_jsonable(op)


async def _search_career(ctx: ToolContext, args: CareerQuery) -> dict:
    svc = _svc()
    if svc is None or getattr(svc, "ai", None) is None:
        return {"text": ""}
    from app.framework.rag import collect_evidence
    text = await collect_evidence(
        svc,
        {"text": args.query, "user_id": ctx.user_id, "job_id": ctx.job_id},
        set(),
    )
    return {"text": text or ""}


def _spec(name, tier, model, run, summary, approval_kind="TOOL_ACTION"):
    return ToolSpec(name, tier, model, run, lambda _args: summary, approval_kind)


PERSONAL_TOOLS = [
    _core("search_postings", Tier.READ, SearchPostings, "공고를 찾아요", "GET",
          lambda args: "/api/v1/postings" + ("?" + urlencode({"q": args.q}) if args.q else ""),
          drop=("q",)),
    _core("get_posting", Tier.READ, PostingId, "공고 내용을 봐요", "GET",
          lambda args: f"/api/v1/postings/{args.posting_id}", drop=("posting_id",)),
    _core("list_bookmarks", Tier.READ, EmptyArgs, "저장한 공고를 봐요", "GET",
          lambda _args: "/api/v1/me/bookmarks"),
    _spec("list_applications", Tier.READ, EmptyArgs, _list_applications, "지원 현황을 봐요"),
    _spec("list_documents", Tier.READ, EmptyArgs, _list_documents, "서류를 봐요"),
    _spec("get_document", Tier.READ, DocumentId, _get_document, "서류 내용을 봐요"),
    _core("list_offers", Tier.READ, EmptyArgs, "받은 제안을 봐요", "GET",
          lambda _args: "/api/v1/me/offers"),
    _core("get_offer", Tier.READ, OfferId, "제안 내용을 봐요", "GET",
          lambda args: f"/api/v1/me/offers/{args.offer_id}", drop=("offer_id",)),
    _core("list_calendar_events", Tier.READ, EmptyArgs, "일정을 봐요", "GET",
          lambda _args: "/api/v1/calendar/events"),
    _core("get_my_profile", Tier.READ, EmptyArgs, "내 프로필을 봐요", "GET",
          lambda _args: "/api/v1/me/profile"),
    _core("list_posts", Tier.READ, EmptyArgs, "글을 봐요", "GET",
          lambda _args: "/api/v1/posts"),
    _spec("get_fit_score", Tier.READ, FitArgs, _get_fit_score, "공고와 얼마나 맞는지 봐요"),
    _spec("search_career_context", Tier.READ, CareerQuery, _search_career, "내 경력 자료를 찾아요"),
    _core("bookmark_posting", Tier.SAFE_WRITE, PostingId, "공고를 저장해요", "POST",
          lambda args: f"/api/v1/postings/{args.posting_id}/bookmark",
          write=True, drop=("posting_id",)),
    _core("unbookmark_posting", Tier.SAFE_WRITE, PostingId, "저장한 공고에서 빼요", "DELETE",
          lambda args: f"/api/v1/postings/{args.posting_id}/bookmark",
          write=True, drop=("posting_id",)),
    _core("create_calendar_event", Tier.SAFE_WRITE, CalendarCreate, "일정을 추가해요", "POST",
          lambda _args: "/api/v1/calendar/events", write=True),
    _core("update_calendar_event", Tier.SAFE_WRITE, CalendarUpdate, "일정을 수정해요", "PATCH",
          lambda args: f"/api/v1/calendar/events/{args.event_id}",
          write=True, drop=("event_id",)),
    _spec("edit_document", Tier.SAFE_WRITE, EditDocumentArgs, _edit_document,
          "서류에서 이 부분을 고쳐요", "DOCUMENT_EDIT"),
    _spec("start_document", Tier.SAFE_WRITE, EmptyArgs, _start_document, "새 서류 작성을 시작해요"),
    _spec("prepare_interview", Tier.SAFE_WRITE, PrepareArgs, _prepare_interview, "면접 준비를 시작해요"),
    _core("apply_to_posting", Tier.RISKY_WRITE, PostingId, "이 공고에 지원해요", "POST",
          lambda args: f"/api/v1/postings/{args.posting_id}/apply",
          write=True, drop=("posting_id",)),
    _core("accept_offer", Tier.RISKY_WRITE, OfferId, "제안을 수락해요", "POST",
          lambda args: f"/api/v1/me/offers/{args.offer_id}/accept",
          write=True, drop=("offer_id",)),
    _core("decline_offer", Tier.RISKY_WRITE, OfferId, "제안을 거절해요", "POST",
          lambda args: f"/api/v1/me/offers/{args.offer_id}/decline",
          write=True, drop=("offer_id",)),
    _core("send_offer_message", Tier.RISKY_WRITE, OfferMessage, "제안에 답장을 보내요", "POST",
          lambda args: f"/api/v1/me/offers/{args.offer_id}/messages",
          write=True, drop=("offer_id",)),
    _core("create_post", Tier.RISKY_WRITE, PostBody, "글을 올려요", "POST",
          lambda _args: "/api/v1/posts", write=True),
    _core("create_comment", Tier.RISKY_WRITE, CommentBody, "댓글을 남겨요", "POST",
          lambda args: f"/api/v1/posts/{args.post_id}/comments",
          write=True, drop=("post_id",)),
    _core("follow_user", Tier.RISKY_WRITE, FollowUser, "이 사람을 팔로우해요", "POST",
          lambda args: f"/api/v1/users/{args.user_id}/follow",
          write=True, drop=("user_id",)),
    _core("update_my_profile", Tier.RISKY_WRITE, ProfilePatch, "내 프로필을 수정해요", "PATCH",
          lambda _args: "/api/v1/me/profile", write=True),
    _core("delete_calendar_event", Tier.RISKY_WRITE, EventId, "일정을 삭제해요", "DELETE",
          lambda args: f"/api/v1/calendar/events/{args.event_id}",
          write=True, drop=("event_id",)),
]
