from __future__ import annotations
from app.clock import utcnow
import asyncio
import re
from contextvars import ContextVar
from typing import Any, Optional, TypedDict
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5
from datetime import datetime, timezone

from app.domain import entities as ent
from app.domain.errors import (
    DomainError, invalid_transition, not_found, validation_field,
)
from app.db import NotFoundError
from app.domain.pagination import PageRequest
from app.jsonutil import to_jsonable
from app.graphs.resume_prompt import (
    _phase_prompt, gate_for_phase, needs_gate, resume_phase,
    wants_resume_flow)


byok_key_var: ContextVar[str] = ContextVar("byok_key", default="")
event_sink: ContextVar[list | None] = ContextVar("event_sink", default=None)


def _emit(payload: dict) -> None:
    sink = event_sink.get()
    if sink is not None:
        sink.append(payload)
        return
    # Imported here so health checks do not load LangGraph.
    from langgraph.config import get_stream_writer
    get_stream_writer()(payload)


def _blob_db() -> bool:
    import os
    return os.environ.get("BLOB_STORE") == "db" or os.environ.get("CF_WORKER") == "1"


def _now() -> datetime:
    return utcnow()


_CO_NAME_RE = re.compile(r"^\[([^\[\]]{2,30})\]", re.M)
_JOB_TITLE_RE = re.compile(r"^\[[^\[\]]{2,30}\]\s*([^|\n]{2,120})", re.M)
_PLACEHOLDER_TITLES = {"새 채팅", "New chat", ""}


def _stable_ids(job_id) -> tuple:
    if job_id:
        from app.infrastructure.store_chat_jobs import user_message_id
        jid = job_id if isinstance(job_id, UUID) else UUID(str(job_id))
        base = "push:chat:" + str(jid)
        return (user_message_id(jid),
                uuid5(NAMESPACE_URL, base + ":assistant"),
                uuid5(NAMESPACE_URL, base + ":op"))
    return uuid4(), uuid4(), uuid4()


def _load_artifacts(conv) -> list:
    from app.infrastructure.resume_workspace import workspace_dir
    wdir = workspace_dir(conv.id, getattr(conv, "title", "") or "")
    arts = []
    for f in sorted(wdir.iterdir()) if wdir.exists() else []:
        if f.name.startswith(".") or f.suffix == ".pdf":
            continue
        try:
            arts.append(f"### {f.name}\n" + f.read_text()[:10000])
        except Exception:
            continue
    return arts


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
    job_id: Any
    usage_ids: list
    resume_flow: bool
    phase: int
    evidence_kinds: list
    prepared: bool
    prompt_user: str
    prompt_system: str
    intent: Optional[str]
    application_id: Any
    employer_owned: bool
    company_plan: str
    confirm_before_edit: bool


def bind_chat_nodes(svc):
    """Register node callables without importing LangGraph.

    Workflow steps call these directly so a step does not pay for graph
    compile. ``build_chat_graph`` compiles the local graph afterwards.
    """
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
        await _ingest_links(state, conv)
        from app.domain.chat_settings import (
            apply_chat_settings, load_chat_settings)
        row = None
        try:
            row = await load_chat_settings(svc.db.q(), user_id)
        except Exception:
            row = None
        return {"conversation": conv, "attachments": attachments,
                "context_text": "\n\n".join(context_parts),
                "evidence_kinds": kinds,
                **apply_chat_settings(state, row)}

    async def _ingest_links(state, conv) -> None:
        from app.domain.link_ingest import (
            has_https, ingest_chat_links, older_message_counted)
        text = state.get("text") or ""
        context = state.get("context") or {}
        if not has_https(text) and not context:
            return
        try:
            query = svc.db.q()
            job_id = state.get("job_id")
            exclude_id = None
            if job_id:
                exclude_id, _, _ = _stable_ids(job_id)
            counted = await older_message_counted(
                query, conv.id, exclude_id, text)
            await ingest_chat_links(
                query,
                user_id=state["user_id"],
                conversation_id=conv.id,
                text=text,
                context=context,
                already_counted=counted,
                exclude_message_id=exclude_id,
            )
        except Exception:
            import logging
            logging.getLogger(__name__).exception("link ingest failed")

    async def _persist_user_msg(state: ChatState) -> None:
        user_msg_id, _, _ = _stable_ids(state.get("job_id"))
        user_msg = ent.Message(
            id=user_msg_id, user_id=state["user_id"],
            conversation_id=state["conversation"].id,
            role="USER", text=state["text"],
            attachments=state.get("attachments") or [],
            operation_id=None, created_at=_now())
        await svc.db.run(lambda: svc.conversations.create_message(user_msg))

    def _emit_prepared(state: dict) -> None:
        from app.graphs.chat_surface import surface_events
        for event in surface_events(state):
            if event["type"] in ("tool", "todo", "choice"):
                _emit(event)

    async def prepare_reply(state: ChatState) -> dict:
        # Own workflow step: page fetch, RAG, and prompt assembly.
        # The local graph does not call this; generate_reply does it inline.
        if state.get("prepared"):
            return {}
        return await _prepare_reply(state)

    async def generate_reply(state: ChatState) -> dict:
        try:
            extra = {}
            if not state.get("prepared"):
                extra = await _prepare_reply(state)
            result = await _complete_prepared({**state, **extra})
            return {**extra, **result}
        except DomainError:
            # A rejected request (FEATURE_DISABLED and other 4xx) must not
            # leave the user's message in the conversation.
            raise
        except Exception:
            try:
                await _persist_user_msg(state)
            except Exception:
                pass
            raise

    async def _employer_turn(state: ChatState, conv):
        company_id = getattr(conv, "company_id", None)
        if not company_id:
            return None, None
        plan = None
        try:
            plan = await svc.conversations.company_plan(company_id)
        except NotFoundError:
            plan = None
        from app.config import load_config
        from app.domain.employer_chat import apply_employer_turn
        gate = getattr(svc, "ai", None)
        cfg = (gate._levers_config()
               if gate is not None and hasattr(gate, "_levers_config")
               else load_config())
        intent = state.get("intent")
        raw = state.get("ai")
        base = ent.AiOptions(**raw) if raw is not None else ent.AiOptions(
            provider="OPENAI", model="managed",
            credential_mode="MANAGED", effort="LOW")
        return apply_employer_turn(base, plan, intent, cfg), plan

    async def _reference_lines(state, conv, resume_flow, employer, company_plan):
        from app.config import load_config
        from app.domain.plan_levers import levers_for
        from app.domain.reference_text import prompt_lines, prompt_samples
        from app.infrastructure.store_jobs import ReferenceSampleStore
        intent = state.get("intent")
        store = ReferenceSampleStore(svc.db)
        if employer:
            if intent not in {"review", "interview"}:
                return []
            app_id = state.get("application_id") or state.get("applicationId")
            if not app_id:
                return []
            owner = await store.application_owner(app_id)
            if owner is None:
                return []
            row = await store.context(owner)
            if row is None:
                return []
            ctx = dict(row)
            score = await store.latest_fit(app_id)
            audience = "EMPLOYER"
            plan = company_plan
        else:
            if not resume_flow:
                return []
            row = await store.context(state["user_id"])
            if row is None:
                return []
            ctx = dict(row)
            app_id = getattr(conv, "application_id", None)
            score = await store.latest_fit(app_id) if app_id else None
            audience = "PERSONAL"
            plan = ctx.get("plan")
        category = ctx.get("job_category")
        tenure = ctx.get("tenure_years")
        if category is None or tenure is None:
            return []
        gate = getattr(svc, "ai", None)
        cfg = (gate._levers_config()
               if gate is not None and hasattr(gate, "_levers_config")
               else load_config())
        levers = levers_for(audience, plan, cfg)
        samples = await store.list_for_prompt(category)
        picked = prompt_samples(
            samples, category, tenure, score, levers.tenure, levers.score_band)
        return prompt_lines(picked)

    async def _prepare_reply(state: ChatState) -> dict:
        _emit_prepared(state)
        from app.ingest.web_page import (
            fetch_github_context, fetch_page_text, find_urls, github_usernames)
        conv = state.get("conversation")
        employer_opts, company_plan = await _employer_turn(state, conv)
        ai = state.get("ai")
        if ai is None and employer_opts is None:
            return {"prepared": True, "prompt_user": "", "prompt_system": "",
                    "resume_flow": False, "phase": 0}
        opts = employer_opts if employer_opts is not None else ent.AiOptions(**ai)
        role_models = opts.models or {}
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
            _emit({"status": "웹 페이지 읽는 중"})
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
            from app.framework.rag import collect_evidence
            section = await collect_evidence(svc, state, seen_evidence)
            if section:
                _emit({"status": "관련 근거 검색 완료"})
                sections.append(section)
        except Exception as rag_err:
            from app.claimctx import LostClaim
            if isinstance(rag_err, LostClaim):
                raise
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
                _emit({"status": "GitHub 저장소 조회 중"})
                gh = await asyncio.gather(
                    *(fetch_github_context(u) for u in gh_users[:2]),
                    return_exceptions=True)
                for u, g in zip(gh_users[:2], gh):
                    if isinstance(g, str) and g:
                        sections.append("[GitHub] " + g)
            company = _company_from_pages(sections)
            if company:
                _emit({"status": "회사 정보 검색 중"})
                page_ctx = next(
                    (s for s in sections if s.startswith("[웹 페이지]")), "")
                research = await svc.ai.company_research(
                    company, role_models.get("research", ""),
                    state["text"] + "\n" + page_ctx[:2000],
                    user_id=state["user_id"], job_id=state.get("job_id"))
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
                    _emit({"status": "지원 항목 연결됨"})
                except Exception:
                    import logging
                    logging.getLogger(__name__).exception(
                        "application link failed")
        phase = 0
        if resume_flow:
            if _blob_db() and getattr(conv, "id", None):
                from app.infrastructure.resume_workspace import (
                    artifact_names, read_artifact)
                from app.graphs.resume_prompt import phase_from_filenames
                names = await artifact_names(svc.db, conv.id)
                phase = phase_from_filenames(names, hist_text)
                arts = []
                for name in sorted(names):
                    if name.startswith(".") or name.endswith(".pdf"):
                        continue
                    body = await read_artifact(svc.db, conv.id, name)
                    if body:
                        arts.append(f"### {name}\n" + body[:10000])
            else:
                phase = await asyncio.to_thread(
                    resume_phase, hist_text, getattr(conv, "id", None),
                    getattr(conv, "title", "") or "")
                arts = []
                if getattr(conv, "id", None):
                    arts = await asyncio.to_thread(_load_artifacts, conv)
            if arts:
                    sections.append(
                        "[저장된 산출물 — 참고용. 이미 디스크에 저장됨. "
                        "그대로 다시 출력하지 말 것. 단, 사용자가 수정·재생성·"
                        "템플릿 변경을 요청하면 변경된 내용을 반영한 "
                        "# file: 블록으로 해당 파일을 다시 출력할 것]\n" +
                        "\n\n".join(arts))
                    user_msg = "\n\n".join(sections)
        system = (await asyncio.to_thread(_phase_prompt, phase)
                  if resume_flow else "")
        if employer_opts is not None and state.get("intent") == "posting":
            from app.domain.employer_chat import posting_system_prompt
            system = (system + "\n" + posting_system_prompt()).strip()
        try:
            lines = await _reference_lines(
                state, conv, resume_flow, employer_opts is not None, company_plan)
        except Exception:
            lines = []
        if lines:
            system = (system + "\n" + "\n".join(lines)).strip()
        prepared = {"prepared": True, "prompt_user": user_msg,
                    "prompt_system": system, "resume_flow": resume_flow,
                    "phase": phase, "conversation": conv}
        if employer_opts is not None:
            prepared["ai"] = employer_opts.model_dump(by_alias=True)
            prepared["employer_owned"] = True
            prepared["company_plan"] = company_plan or ""
        return prepared

    async def _complete_prepared(state: ChatState) -> dict:
        ai = state.get("ai")
        if ai is None:
            _emit({"token": stub_reply(state["text"])})
            return {"completion": None}
        opts = ent.AiOptions(**ai)
        role_models = opts.models or {}
        if role_models.get("generate") and not state.get("employer_owned"):
            opts.model = role_models["generate"]
        usage = {"input_tokens": 0, "output_tokens": 0}
        user_msg = state.get("prompt_user") or ""
        system = state.get("prompt_system") or ""
        resume_flow = bool(state.get("resume_flow"))
        phase = int(state.get("phase") or 0)
        from app.infrastructure.resume_workspace import visible_prefix
        parts = []
        emitted = 0
        _emit({"status": "응답 작성 중"})
        import os
        from app.domain.employer_chat import bind_employer_plan, reset_employer_plan
        token = (bind_employer_plan(state.get("company_plan") or "")
                 if state.get("employer_owned") else None)
        try:
            if os.environ.get("LLM_STREAM", "1") == "0":
                completion = await svc.ai.complete(
                    state["user_id"], opts, system, user_msg,
                    byok_key=byok_key_var.get(), search_query=state["text"],
                    job_id=state.get("job_id"))
                text = completion.text or ""
                step = 48
                for i in range(0, len(text), step):
                    _emit({"token": text[i:i + step]})
                return {"completion": completion,
                        "usage_ids": [completion.usage_id] if completion.usage_id else [],
                        "resume_flow": resume_flow, "phase": phase}
            for round_ in range(3):
                usage.pop("finish", None)
                async for tok in svc.ai.stream(
                        state["user_id"], opts, system, user_msg, usage,
                        byok_key=byok_key_var.get(),
                        search_query=state["text"],
                        assistant_prefix="".join(parts) if round_ else "",
                        job_id=state.get("job_id")):
                    parts.append(tok)
                    if resume_flow:
                        safe = visible_prefix("".join(parts))
                        if len(safe) > emitted:
                            _emit({"token": safe[emitted:]})
                            emitted = len(safe)
                    else:
                        _emit({"token": tok})
                if usage.get("finish") != "length":
                    break
                _emit({"status": "응답이 길어 이어서 작성 중"})
            return {"completion": ent.AICompletion(
                text="".join(parts),
                input_tokens=usage["input_tokens"],
                output_tokens=usage["output_tokens"]),
                "usage_ids": usage.get("usage_ids") or [],
                "resume_flow": resume_flow, "phase": phase}
        finally:
            if token is not None:
                reset_employer_plan(token)

    async def _emit_persisted(state: dict) -> bool:
        from app.graphs.chat_surface import publish_persisted_surface
        document_svc = getattr(svc, "document_svc", None)
        apply = None
        if document_svc is not None:
            async def apply(diff):
                await document_svc.apply_hunks(state["user_id"], diff)
        return await publish_persisted_surface(state, svc.db, _emit, apply)

    async def persist(state: ChatState) -> dict:
        user_id = state["user_id"]
        conv = state["conversation"]
        attachments = state["attachments"]
        completion = state.get("completion")
        if completion is None:
            from app.jobs import external_jobs
            if external_jobs():
                # A racing run can drop `completion` from the checkpoint.
                # Storing the local stub there shipped a fake assistant
                # message. The Workflow retries this step instead.
                raise RuntimeError("chat completion missing")
        blocked = await _emit_persisted(state)
        now = _now()
        user_msg_id, assistant_msg_id, op_id = _stable_ids(
            state.get("job_id"))
        user_msg = ent.Message(
            id=user_msg_id, user_id=user_id, conversation_id=conv.id,
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
        needs_approval = False
        doc_attachments: list[ent.MessageAttachment] = []
        if state.get("resume_flow") and completion is not None and not blocked:
            from app.infrastructure.resume_workspace import (
                save_artifacts, sync_documents)
            try:
                if _blob_db():
                    from app.infrastructure.resume_workspace import (
                        artifact_names, save_artifacts_db)
                    from app.graphs.resume_prompt import phase_from_filenames
                    saved = await save_artifacts_db(
                        svc.db, conv.id, conv.title or "", completion.text)
                else:
                    saved = await asyncio.to_thread(
                        save_artifacts, conv.id, conv.title or "", completion.text)
                if not saved and completion.text:
                    import logging
                    logging.getLogger(__name__).warning(
                        "no artifacts saved; completion_len=%d",
                        len(completion.text))
            except Exception:
                import logging
                logging.getLogger(__name__).exception("artifact save failed")
                saved = []
            if saved and _blob_db():
                new_phase = phase_from_filenames(
                    await artifact_names(svc.db, conv.id), "")
            else:
                new_phase = (await asyncio.to_thread(
                    resume_phase, "", conv.id, conv.title or "")
                    if saved else state.get("phase", 0))
            gate = gate_for_phase(new_phase - 1) if new_phase > state.get(
                "phase", 0) else ""
            if gate and needs_gate(reply):
                needs_approval = True
                assistant_text = reply + "\n\n---\n\n" + gate
                _emit({"token": "\n\n---\n\n" + gate})
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
            id=assistant_msg_id, user_id=user_id, conversation_id=conv.id,
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
            # The queue path already inserted this USER row at enqueue.
            # Upsert fills attachments and operation_id and does not add
            # a second row. The local path has no earlier insert, so this
            # creates the row. The assistant reply is the new message.
            await svc.conversations.upsert_user_message(user_msg)
            await svc.conversations.create_message(assistant_msg)
            await svc.ops.create(op)
            if completion is not None:
                from app.domain.services.ai import record_usage
                await record_usage(svc.usage, user_id, op_id,
                                   ent.AiOptions(**state["ai"]), completion,
                                   state.get("usage_ids") or [],
                                   job_id=state.get("job_id"))
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
        return {
            "operation": op,
            "messageId": str(assistant_msg.id),
            "needs_approval": needs_approval,
        }

    svc.chat_nodes = {
        "resolve_context": resolve_context,
        "prepare_reply": prepare_reply,
        "generate_reply": generate_reply,
        "persist": persist,
    }
    return svc.chat_nodes


def build_chat_graph(svc, checkpointer=None):
    nodes = bind_chat_nodes(svc)
    # Imported here so workflow steps that only bind nodes skip LangGraph.
    from langgraph.graph import END, START, StateGraph

    g = StateGraph(ChatState)
    g.add_node("resolve_context", nodes["resolve_context"])
    g.add_node("generate_reply", nodes["generate_reply"])
    g.add_node("persist", nodes["persist"])
    g.add_edge(START, "resolve_context")
    g.add_edge("resolve_context", "generate_reply")
    g.add_edge("generate_reply", "persist")
    g.add_edge("persist", END)
    return g.compile(checkpointer=checkpointer)
