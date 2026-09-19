from __future__ import annotations
import asyncio
import re
from contextvars import ContextVar
from typing import Any, Optional, TypedDict
from uuid import UUID, uuid4
from datetime import datetime, timezone

from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from app.domain import entities as ent
from app.domain.errors import (
    invalid_transition, not_found, validation_field,
)
from app.db import NotFoundError
from app.domain.pagination import PageRequest
from app.infrastructure.web_page import (fetch_github_context,
                                         fetch_page_text, find_urls,
                                         github_usernames)
from app.jsonutil import to_jsonable
from app.graph.resume_prompt import resume_system_prompt, wants_resume_flow


byok_key_var: ContextVar[str] = ContextVar("byok_key", default="")


def _now() -> datetime:
    return datetime.now(timezone.utc)


_CO_NAME_RE = re.compile(r"^\[([^\[\]]{2,30})\]", re.M)


def _company_from_pages(sections: list) -> str:
    for s in sections:
        if not s.startswith("[웹 페이지]"):
            continue
        m = _CO_NAME_RE.search(s[:400])
        if m:
            return m.group(1).strip()
    return ""


def _uid(v) -> UUID:
    return v if isinstance(v, UUID) else UUID(str(v))


def stub_reply(text: str) -> str:
    if len(text) > 80:
        text = text[:80]
    return f"(로컬 스텁) 메시지를 받았습니다: {text}"


class ChatState(TypedDict, total=False):
    user_id: Any
    conversation_id: Any
    text: str
    context: dict
    ai: Optional[dict]
    access_mode: str
    conversation: Any
    attachments: list
    context_text: str
    completion: Any
    operation: Any
    resume_flow: bool


def build_chat_graph(svc, checkpointer=None):
    async def resolve_context(state: ChatState) -> dict:
        user_id = state["user_id"]
        try:
            conv = await svc.conversations.get(user_id, state["conversation_id"])
        except NotFoundError:
            raise not_found()
        if conv.archived:
            raise invalid_transition("conversation is archived")
        ctx = state.get("context") or {}
        attachments = []
        context_parts = []
        document_id = ctx.get("documentId")
        version_id = ctx.get("versionId")
        if document_id or version_id:
            doc = None
            version = None
            if document_id:
                try:
                    doc = await svc.documents.get(user_id, _uid(document_id))
                except Exception:
                    raise validation_field("context.documentId", "document not found")
                if (conv.application_id is not None
                        and doc.application_id != conv.application_id):
                    raise validation_field(
                        "context.documentId",
                        "document belongs to another application")
                if version_id:
                    try:
                        version = await svc.documents.get_version(
                            user_id, doc.id, _uid(version_id))
                    except Exception:
                        raise validation_field(
                            "context.versionId", "version not found in document")
                else:
                    if doc.latest_version_id is None:
                        raise validation_field(
                            "context.documentId", "document has no versions")
                    try:
                        version = await svc.documents.get_version(
                            user_id, doc.id, doc.latest_version_id)
                    except Exception:
                        from app.domain.errors import internal
                        raise internal()
            else:
                try:
                    version = await svc.documents.get_version_by_id(
                        user_id, _uid(version_id))
                except NotFoundError:
                    raise validation_field("context.versionId", "version not found")
                except Exception:
                    from app.domain.errors import internal
                    raise internal()
                try:
                    doc = await svc.documents.get(user_id, version.document_id)
                except Exception:
                    from app.domain.errors import internal
                    raise internal()
            if (conv.application_id is not None
                    and doc.application_id != conv.application_id):
                raise validation_field(
                    "context.documentId",
                    "document belongs to another application")
            attachments.append(ent.MessageAttachment(
                type="DOCUMENT_VERSION", id=version.id, document_id=doc.id,
                title=doc.title))
            context_parts.append(
                "[첨부 문서] " + doc.title + "\n"
                + "\n".join(b.text for b in version.blocks))
        for eid in ctx.get("evidenceIds") or []:
            try:
                e = await svc.evidence.get(user_id, _uid(eid))
            except Exception:
                raise validation_field(
                    "context.evidenceIds", "evidence " + str(eid) + " not found")
            attachments.append(ent.MessageAttachment(
                type="EVIDENCE", id=e.id, title=e.title))
            context_parts.append(
                "[첨부 자료] " + e.title + "\n" + e.source_text[:6000])
        return {"conversation": conv, "attachments": attachments,
                "context_text": "\n\n".join(context_parts)}

    async def generate_reply(state: ChatState) -> dict:
        writer = get_stream_writer()
        ai = state.get("ai")
        if ai is None:
            writer({"token": stub_reply(state["text"])})
            return {"completion": None}
        opts = ent.AiOptions(**ai)
        usage = {"input_tokens": 0, "output_tokens": 0}
        sections = []
        if state.get("context_text"):
            sections.append(state["context_text"])
        urls = set(find_urls(state["text"])[:2])
        hist_items = []
        hist_lines: list[str] = []
        try:
            hist = await svc.conversations.list_messages(
                state["user_id"], state["conversation"].id,
                PageRequest(limit=12))
            hist_items = list(reversed(hist.items))
            for m in hist_items:
                hist_lines.append(m.role + ": " + m.text)
                urls.update(find_urls(m.text))
        except Exception:
            import logging
            logging.getLogger(__name__).exception("history load failed")
        urls = list(urls)[:4]
        if urls:
            pages = await asyncio.gather(
                *(fetch_page_text(u) for u in urls),
                return_exceptions=True)
            for u, p in zip(urls, pages):
                if isinstance(p, str) and p:
                    sections.append("[웹 페이지] " + u + "\n" + p)
        seen_evidence = set()
        ctx = state.get("context") or {}
        for eid in ctx.get("evidenceIds") or []:
            seen_evidence.add(str(eid))
        for m in hist_items:
            for a in m.attachments or []:
                if a.type != "EVIDENCE" or str(a.id) in seen_evidence:
                    continue
                seen_evidence.add(str(a.id))
                try:
                    e = await svc.evidence.get(state["user_id"], a.id)
                    sections.append(
                        "[첨부 자료] " + e.title + "\n" + e.source_text[:6000])
                except Exception:
                    continue
        attach_titles = " ".join(
            a.title for a in state.get("attachments") or [] if a.title)
        resume_flow = wants_resume_flow(
            state["text"] + " " + attach_titles, "\n".join(hist_lines))
        ultra = bool((state.get("ai") or {}).get("ultraResume"))
        if resume_flow and ultra:
            gh_users = []
            for src in [state.get("context_text") or "", state["text"],
                        *hist_lines]:
                for u in github_usernames(src):
                    if u not in gh_users:
                        gh_users.append(u)
            if gh_users:
                gh = await asyncio.gather(
                    *(fetch_github_context(u) for u in gh_users[:2]),
                    return_exceptions=True)
                for u, g in zip(gh_users[:2], gh):
                    if isinstance(g, str) and g:
                        sections.append("[GitHub] " + g)
            company = _company_from_pages(sections)
            if company:
                research = await svc.ai.company_research(company)
                if research:
                    sections.append("[회사 검색] " + company + "\n" + research)
        if hist_lines:
            sections.append("[이전 대화]\n" + "\n".join(hist_lines))
        sections.append("[현재 메시지]\n" + state["text"])
        user_msg = "\n\n".join(sections)
        system = resume_system_prompt() if resume_flow else ""
        parts = []
        async for tok in svc.ai.stream(
                state["user_id"], opts, system, user_msg, usage,
                byok_key=byok_key_var.get(),
                search_query=state["text"]):
            parts.append(tok)
            writer({"token": tok})
        return {"completion": ent.AICompletion(
            text="".join(parts),
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"]),
            "resume_flow": resume_flow}

    async def persist(state: ChatState) -> dict:
        user_id = state["user_id"]
        conv = state["conversation"]
        attachments = state["attachments"]
        completion = state.get("completion")
        now = _now()
        op_id = uuid4()
        user_msg = ent.Message(
            id=uuid4(), user_id=user_id, conversation_id=conv.id,
            role="USER", text=state["text"], attachments=attachments,
            operation_id=op_id, created_at=now)
        reply = stub_reply(state["text"]) if completion is None else completion.text
        assistant_msg = ent.Message(
            id=uuid4(), user_id=user_id, conversation_id=conv.id,
            role="ASSISTANT", text=reply, attachments=[],
            operation_id=op_id, created_at=now)
        op = ent.Operation(
            id=op_id, user_id=user_id, type=ent.OP_CHAT_MESSAGE,
            application_id=conv.application_id, status=ent.OP_SUCCEEDED,
            result=ent.OperationResult(kind=ent.OP_CHAT_MESSAGE, value={
                "userMessage": to_jsonable(user_msg),
                "assistantMessage": to_jsonable(assistant_msg),
                "approvalIds": []}),
            created_at=now, updated_at=now)

        async def work():
            await svc.conversations.create_message(user_msg)
            await svc.conversations.create_message(assistant_msg)
            await svc.ops.create(op)
            if completion is not None:
                from app.domain.services.ai import record_usage
                await record_usage(svc.usage, user_id, op_id,
                                   ent.AiOptions(**state["ai"]), completion)

        await svc.db.run(work)
        if state.get("resume_flow") and completion is not None:
            from app.infrastructure.resume_workspace import save_artifacts
            try:
                await asyncio.to_thread(
                    save_artifacts, conv.id, conv.title or "", completion.text)
            except Exception:
                import logging
                logging.getLogger(__name__).exception("artifact save failed")
        return {"operation": op}

    g = StateGraph(ChatState)
    g.add_node("resolve_context", resolve_context)
    g.add_node("generate_reply", generate_reply)
    g.add_node("persist", persist)
    g.add_edge(START, "resolve_context")
    g.add_edge("resolve_context", "generate_reply")
    g.add_edge("generate_reply", "persist")
    g.add_edge("persist", END)
    return g.compile(checkpointer=checkpointer)
