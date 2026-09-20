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
from app.graph.resume_prompt import (
    _phase_prompt, gate_for_phase, needs_gate, resume_phase,
    wants_resume_flow)


byok_key_var: ContextVar[str] = ContextVar("byok_key", default="")


def _now() -> datetime:
    return datetime.now(timezone.utc)


_CO_NAME_RE = re.compile(r"^\[([^\[\]]{2,30})\]", re.M)
_JOB_TITLE_RE = re.compile(r"^\[[^\[\]]{2,30}\]\s*([^|\n]{2,120})", re.M)
_PLACEHOLDER_TITLES = {"새 채팅", "New chat", ""}


def _company_from_pages(sections: list) -> str:
    meta = _job_meta(sections)
    return meta[0] if meta else ""


def _job_meta(sections: list):
    for s in sections:
        if not s.startswith("[웹 페이지] "):
            continue
        head, _, text = s.partition("\n")
        url = head[len("[웹 페이지] "):].strip()
        m = _CO_NAME_RE.search(text[:400])
        if not m:
            continue
        tm = _JOB_TITLE_RE.search(text[:400])
        title = tm.group(1).strip() if tm else url
        return m.group(1).strip(), title, url, text
    return None


def _uid(v) -> UUID:
    return v if isinstance(v, UUID) else UUID(str(v))


def _chunk_text(text: str, size: int = 1200, overlap: int = 150) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]
    out = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        cut = text.rfind("\n\n", start, end)
        if cut > start + size // 2:
            end = cut
        out.append(text[start:end].strip())
        start = end if end == len(text) else max(end - overlap, start + 1)
    return [c for c in out if c]


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
    phase: int
    evidence_kinds: list


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
        kinds = []
        for eid in ctx.get("evidenceIds") or []:
            try:
                e = await svc.evidence.get(user_id, _uid(eid))
            except Exception:
                raise validation_field(
                    "context.evidenceIds", "evidence " + str(eid) + " not found")
            attachments.append(ent.MessageAttachment(
                type="EVIDENCE", id=e.id, title=e.title))
            kinds.append(e.kind)
            context_parts.append(
                "[첨부 자료] " + e.title + "\n" + e.source_text[:6000])
        return {"conversation": conv, "attachments": attachments,
                "context_text": "\n\n".join(context_parts),
                "evidence_kinds": kinds}

    async def _persist_user_msg(state: ChatState) -> None:
        user_msg = ent.Message(
            id=uuid4(), user_id=state["user_id"],
            conversation_id=state["conversation"].id,
            role="USER", text=state["text"],
            attachments=state.get("attachments") or [],
            operation_id=None, created_at=_now())
        await svc.db.run(lambda: svc.conversations.create_message(user_msg))

    async def generate_reply(state: ChatState) -> dict:
        try:
            return await _generate_reply(state)
        except Exception:
            try:
                await _persist_user_msg(state)
            except Exception:
                pass
            raise

    async def _generate_reply(state: ChatState) -> dict:
        writer = get_stream_writer()
        ai = state.get("ai")
        if ai is None:
            writer({"token": stub_reply(state["text"])})
            return {"completion": None}
        opts = ent.AiOptions(**ai)
        role_models = opts.models or {}
        if role_models.get("generate"):
            opts.model = role_models["generate"]
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
            writer({"status": "웹 페이지 읽는 중"})
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
        try:
            missing = await svc.chunks.evidence_ids_missing(
                state["user_id"], limit=10)
            for eid in missing:
                try:
                    e = await svc.evidence.get(state["user_id"], eid)
                    texts = _chunk_text(e.source_text)
                    vecs = await svc.ai.embed(texts)
                    if len(vecs) == len(texts):
                        await svc.chunks.replace_chunks(
                            state["user_id"], eid, list(zip(texts, vecs)))
                except Exception:
                    continue
            qvec = await svc.ai.embed([state["text"][:2000]])
            if qvec:
                hits = await svc.chunks.search(state["user_id"], qvec[0], 6)
                rag = [h for h in hits
                       if str(h["evidence_id"]) not in seen_evidence
                       and (h["dist"] or 0) < 0.6]
                if rag:
                    writer({"status": "관련 근거 검색 완료"})
                    sections.append(
                        "[관련 근거]\n" + "\n\n".join(
                            "- " + h["title"] + "\n" + h["text"]
                            for h in rag))
        except Exception:
            import logging
            logging.getLogger(__name__).exception("rag retrieval failed")
        attach_titles = " ".join(
            a.title for a in state.get("attachments") or [] if a.title)
        hist_text = "\n".join(hist_lines)
        resume_flow = wants_resume_flow(
            state["text"] + " " + attach_titles, hist_text,
            tuple(state.get("evidence_kinds") or ()))
        ultra = bool((state.get("ai") or {}).get("ultraResume"))
        if resume_flow and ultra:
            gh_users = []
            for src in [state.get("context_text") or "", state["text"],
                        *hist_lines]:
                for u in github_usernames(src):
                    if u not in gh_users:
                        gh_users.append(u)
            if gh_users:
                writer({"status": "GitHub 저장소 조회 중"})
                gh = await asyncio.gather(
                    *(fetch_github_context(u) for u in gh_users[:2]),
                    return_exceptions=True)
                for u, g in zip(gh_users[:2], gh):
                    if isinstance(g, str) and g:
                        sections.append("[GitHub] " + g)
            company = _company_from_pages(sections)
            if company:
                writer({"status": "회사 정보 검색 중"})
                page_ctx = next(
                    (s for s in sections if s.startswith("[웹 페이지]")), "")
                research = await svc.ai.company_research(
                    company, role_models.get("research", ""),
                    state["text"] + "\n" + page_ctx[:2000])
                if research:
                    sections.append("[회사 검색] " + company + "\n" + research)
        if hist_lines:
            sections.append("[이전 대화]\n" + "\n".join(hist_lines))
        sections.append("[현재 메시지]\n" + state["text"])
        user_msg = "\n\n".join(sections)
        conv = state.get("conversation")
        if (resume_flow and getattr(conv, "application_id", None) is None
                and getattr(svc, "job_svc", None)
                and getattr(svc, "application_svc", None)):
            meta = _job_meta(sections)
            if meta:
                try:
                    company, title, url, page_text = meta
                    job = await svc.job_svc.jobs.find_by_source_url(
                        state["user_id"], url)
                    if job is None:
                        job = await svc.job_svc.create(
                            state["user_id"], company, title, "URL", url,
                            page_text[:50000], [], [], None, "ko")
                    app = await svc.application_svc.applications.find_by_job(
                        state["user_id"], job.id)
                    if app is None:
                        app = await svc.application_svc.create(
                            state["user_id"], job.id, "")
                    conv.application_id = app.id
                    await svc.conversations.update(conv, conv.revision)
                    writer({"status": "지원 항목 연결됨"})
                except Exception:
                    import logging
                    logging.getLogger(__name__).exception(
                        "application link failed")
        phase = 0
        if resume_flow:
            phase = resume_phase(
                hist_text, getattr(conv, "id", None),
                getattr(conv, "title", "") or "")
            if getattr(conv, "id", None):
                from app.infrastructure.resume_workspace import workspace_dir
                wdir = workspace_dir(conv.id, getattr(conv, "title", "") or "")
                arts = []
                for f in sorted(wdir.iterdir()) if wdir.exists() else []:
                    if f.name.startswith(".") or f.suffix == ".pdf":
                        continue
                    try:
                        arts.append(f"### {f.name}\n" +
                                    f.read_text()[:10000])
                    except Exception:
                        continue
                if arts:
                    sections.append(
                        "[저장된 산출물 — 참고용. 이미 디스크에 저장됨. "
                        "그대로 다시 출력하지 말 것. 단, 사용자가 수정·재생성·"
                        "템플릿 변경을 요청하면 변경된 내용을 반영한 "
                        "# file: 블록으로 해당 파일을 다시 출력할 것]\n" +
                        "\n\n".join(arts))
                    user_msg = "\n\n".join(sections)
        system = _phase_prompt(phase) if resume_flow else ""
        from app.infrastructure.resume_workspace import visible_prefix
        parts = []
        emitted = 0
        writer({"status": "응답 작성 중"})
        for round_ in range(3):
            usage.pop("finish", None)
            async for tok in svc.ai.stream(
                    state["user_id"], opts, system, user_msg, usage,
                    byok_key=byok_key_var.get(),
                    search_query=state["text"],
                    assistant_prefix="".join(parts) if round_ else ""):
                parts.append(tok)
                if resume_flow:
                    safe = visible_prefix("".join(parts))
                    if len(safe) > emitted:
                        writer({"token": safe[emitted:]})
                        emitted = len(safe)
                else:
                    writer({"token": tok})
            if usage.get("finish") != "length":
                break
            writer({"status": "응답이 길어 이어서 작성 중"})
        return {"completion": ent.AICompletion(
            text="".join(parts),
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"]),
            "resume_flow": resume_flow, "phase": phase}

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
        if completion is None:
            reply = stub_reply(state["text"])
        elif state.get("resume_flow"):
            from app.infrastructure.resume_workspace import strip_file_blocks
            reply = strip_file_blocks(completion.text) or (
                "산출물을 저장했어요." if completion.text else
                "응답 생성이 중단됐어요. 다시 시도해 주세요.")
        else:
            reply = completion.text
        assistant_text = reply
        doc_attachments: list[ent.MessageAttachment] = []
        if state.get("resume_flow") and completion is not None:
            from app.infrastructure.resume_workspace import (
                save_artifacts, sync_documents)
            try:
                saved = await asyncio.to_thread(
                    save_artifacts, conv.id, conv.title or "", completion.text)
                if not saved and completion.text:
                    import logging
                    logging.getLogger(__name__).warning(
                        "no artifacts saved; raw head=%r tail=%r",
                        completion.text[:200], completion.text[-200:])
            except Exception:
                import logging
                logging.getLogger(__name__).exception("artifact save failed")
                saved = []
            new_phase = resume_phase(
                "", conv.id, conv.title or "") if saved else state.get("phase", 0)
            gate = gate_for_phase(new_phase - 1) if new_phase > state.get(
                "phase", 0) else ""
            if gate and needs_gate(reply):
                assistant_text = reply + "\n\n---\n\n" + gate
                get_stream_writer()({"token": "\n\n---\n\n" + gate})
            if saved:
                try:
                    synced = await sync_documents(svc, user_id, conv, saved)
                    doc_attachments = [
                        ent.MessageAttachment(
                            type="DOCUMENT_VERSION", id=r["version_id"],
                            document_id=r["document_id"],
                            title=r["title"])
                        for r in synced]
                except Exception:
                    import logging
                    logging.getLogger(__name__).exception("doc sync failed")
        assistant_msg = ent.Message(
            id=uuid4(), user_id=user_id, conversation_id=conv.id,
            role="ASSISTANT", text=assistant_text,
            attachments=doc_attachments,
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
            if (conv.title or "") in _PLACEHOLDER_TITLES:
                try:
                    fresh = await svc.conversations.get(user_id, conv.id)
                    fresh.title = (state["text"] or "대화")[:40]
                    await svc.conversations.update(fresh, fresh.revision)
                except Exception:
                    import logging
                    logging.getLogger(__name__).exception(
                        "auto title failed")

        await svc.db.run(work)
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
