"""Employer harness flows (super-recruit) as LangGraph subgraphs.

posting_flow   research → role gate → draft → review → confirm gate → save
review_flow    read → match → baseline → verify → report gate
interview_flow plan check → inherit review → design → kit

Each flow shares ``EmployerState`` with the parent graph, so interrupts and
checkpoints live on the conversation thread. Gates are ``EMPLOYER_GATE``
approval cards whose answers resume the same thread.
"""

from __future__ import annotations

import json
from uuid import NAMESPACE_URL, uuid5

from langchain_core.messages import SystemMessage
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt
from pydantic import BaseModel

from app.clock import utcnow
from app.domain.employer_baseline import baseline_stats
from app.domain.fair_hiring import DECISION_DISCLAIMER
from app.domain.plan_levers import levers_for
from app.graphs.chat_surface import insert_chat_approval
from app.harness.employer import nodes
from app.harness.employer.recruit_prompts import node_prompt
from app.harness.employer.schemas import (
    CompanyProfile,
    Match,
    PostingDraft,
    RoleSpec,
)
from app.harness.tools import emit
from app.infrastructure.store_employer import EmployerStore, posting_text

FLOWS = ("posting", "review", "interview")
_PLAN_RANK = {"": 0, "BASIC": 1, "PRO": 2, "ULTRA": 3}
_MAX_REWRITES = 3
_POSTING_STEPS = {
    "role_options": "pf_role_options",
    "role": "pf_role",
    "role_detail": "pf_role_detail",
    "draft": "pf_draft",
    "review": "pf_review",
    "confirm": "pf_confirm",
    "save": "pf_save",
}


class RoleOption(BaseModel):
    id: str
    label: str
    detail: str = ""


class RoleOptions(BaseModel):
    note: str = ""
    options: list[RoleOption]


class Matches(BaseModel):
    matches: list[Match]


def flow_of(state: dict) -> dict:
    raw = state.get("flow") or {}
    return raw if isinstance(raw, dict) else {}


def flow_update(state: dict, **changes) -> dict:
    return {"flow": {**flow_of(state), **changes}}


def plan_allows(plan: str | None, need: str) -> bool:
    return _PLAN_RANK.get((plan or "").upper(), 0) >= _PLAN_RANK[need]


async def gate(
    state: dict,
    db,
    gate_id: str,
    title: str,
    options: list[dict],
    *,
    recommended: str | None = None,
) -> dict:
    """Ask one EMPLOYER_GATE question and wait. Returns {"option_id"} or {"text"}."""
    seed = f"push:employer-gate:{state.get('conversation_id')}:{state.get('job_id')}:{gate_id}"
    event = {
        "type": "choice",
        "id": str(uuid5(NAMESPACE_URL, seed)),
        "kind": "EMPLOYER_GATE",
        "gate": gate_id,
        "title": title,
        "options": [*options, {"id": "cancel", "label": "그만하기"}],
    }
    if recommended:
        event["recommended"] = recommended
    if db is not None:
        await insert_chat_approval(
            db, state.get("user_id"), state.get("conversation_id"), event, None
        )
    emit(event)
    answer = (
        interrupt(
            {
                "approval_id": event["id"],
                "awaiting": "choice",
                "kind": "EMPLOYER_GATE",
                "gate": gate_id,
            }
        )
        or {}
    )
    return answer if isinstance(answer, dict) else {"text": str(answer)}


def cancelled(answer: dict) -> bool:
    text = str(answer.get("text") or "")
    return answer.get("option_id") == "cancel" or text.startswith(("그만", "취소", "중단"))


def _done(state: dict, status: str, **data) -> dict:
    return flow_update(state, status=status, **data)


def build_flows(*, db, generate_for, research_text, plan_of, store=None, read_pdf=None):
    """``generate_for(state)`` returns a node ``generate``; ``research_text(state, name)`` runs
    the web search; ``plan_of(state)`` returns the company plan (BASIC/PRO/ULTRA or '')."""
    store = store or (EmployerStore(db) if db is not None else None)
    if read_pdf is None:
        from app.ingest.pdf_text import extract_pdf_bytes as read_pdf
    from app.harness.graph import HarnessState

    class EmployerState(HarnessState, total=False):
        flow: dict | None
        start_flow: dict | None

    # ---- posting -----------------------------------------------------------------
    async def pf_research(state):
        company = await store.company(state.get("company_id")) if store else None
        name = (company or {}).get("name") or "우리 회사"
        cached = (company or {}).get("profile")
        cached = json.loads(cached) if isinstance(cached, str) else cached
        now = utcnow()
        if cached and nodes.profile_is_fresh((company or {}).get("profile_refreshed_at"), now):
            profile = CompanyProfile.model_validate(cached)
        else:
            emit({"type": "status", "text": "회사 정보를 찾는 중"})
            text = await research_text(state, name)
            profile = await nodes.research_company(generate_for(state), name, text)
            if store:
                await store.save_profile(
                    state.get("company_id"), profile.model_dump(by_alias=True), now
                )
        emit(
            {
                "type": "employer_research",
                "company": profile.name or name,
                "summary": profile.summary,
                "sourceCounts": {
                    "homepage": profile.homepage_count,
                    "news": profile.news_count,
                    "postings": profile.posting_count,
                },
                "facts": [f.model_dump(by_alias=True) for f in profile.facts[:3]],
            }
        )
        reference = ""
        ref_id = flow_of(state).get("reference_posting_id")
        if ref_id and store:
            reference = posting_text(await store.posting(ref_id))
        return flow_update(
            state,
            step="role_options",
            profile=profile.model_dump(by_alias=True),
            reference=reference,
        )

    async def pf_role_options(state):
        # Model work happens before the gate node: LangGraph replays a node from its start
        # when an interrupt resumes, so the gate node itself must not call the model.
        flow = flow_of(state)
        profile = CompanyProfile.model_validate(flow["profile"])
        reference = flow.get("reference") or "없음"
        user = f"[회사 프로필]\n{profile.model_dump_json()}\n\n[참고 공고]\n{reference}"
        choices = await generate_for(state)(RoleOptions, node_prompt("pf_role"), user)
        if choices.note:
            emit({"type": "status", "text": choices.note})
        options = [
            {"id": o.id or f"r{i}", "label": o.label} for i, o in enumerate(choices.options[:3])
        ]
        return flow_update(state, step="role", role_options=options)

    async def pf_role(state):
        flow = flow_of(state)
        options = flow.get("role_options") or []
        answer = await gate(
            state,
            db,
            "pf_role",
            "이번에 가장 필요한 사람은 누구예요?",
            [*options, {"id": "custom", "label": "직접 말하기"}],
        )
        if cancelled(answer):
            return _done(state, "cancelled")
        need = answer.get("text") or next(
            (o["label"] for o in options if o["id"] == answer.get("option_id")), ""
        )
        return flow_update(state, step="role_detail", need=need)

    async def pf_role_detail(state):
        flow = flow_of(state)
        profile = CompanyProfile.model_validate(flow["profile"])
        role = await generate_for(state)(
            RoleSpec,
            node_prompt("pf_role_detail"),
            f"[담당자 답]\n{flow.get('need')}\n\n[회사 프로필]\n{profile.model_dump_json()}",
        )
        return flow_update(state, step="draft", role=role.model_dump())

    async def pf_draft(state):
        flow = flow_of(state)
        draft = await nodes.draft_posting(
            generate_for(state),
            CompanyProfile.model_validate(flow["profile"]),
            RoleSpec.model_validate(flow["role"]),
            reference=flow.get("reference") or None,
            previous=PostingDraft.model_validate(flow["draft"]) if flow.get("draft") else None,
            request=flow.get("request"),
        )
        return flow_update(state, step="review", draft=draft.model_dump(), request=None)

    async def pf_review(state):
        flow = flow_of(state)
        review = await nodes.review_posting(
            generate_for(state),
            PostingDraft.model_validate(flow["draft"]),
            reference_text=flow.get("reference") or None,
        )
        version = int(flow.get("version") or 0) + 1
        emit(
            {
                "type": "posting_draft",
                "version": version,
                "draft": _draft_event(review.draft),
                "notes": review.notes,
            }
        )
        return flow_update(
            state,
            step="confirm",
            draft=review.draft.model_dump(),
            version=version,
            ask_salary=review.ask_salary,
        )

    async def pf_confirm(state):
        flow = flow_of(state)
        title = "이 초안으로 진행할까요?"
        if flow.get("ask_salary"):
            title = "이 초안으로 진행할까요? 연봉 범위를 넣으려면 직접 말해 주세요."
        answer = await gate(
            state,
            db,
            f"pf_confirm_{flow.get('version')}",
            title,
            [
                {"id": "save", "label": "초안으로 저장"},
                {"id": "rewrite", "label": "다시 쓰기"},
            ],
            recommended="save",
        )
        if cancelled(answer):
            return _done(state, "cancelled")
        if answer.get("option_id") == "save":
            return flow_update(state, step="save")
        rewrites = int(flow.get("rewrites") or 0) + 1
        if rewrites > _MAX_REWRITES:
            return flow_update(state, step="save")
        return flow_update(
            state,
            step="draft",
            rewrites=rewrites,
            request=answer.get("text") or "다르게 다시 써 주세요.",
        )

    async def pf_save(state):
        draft = PostingDraft.model_validate(flow_of(state)["draft"])
        fence = (
            "```posting-draft\n" + json.dumps(_fence(draft), ensure_ascii=False, indent=2) + "\n```"
        )
        reply = "공고 초안을 정리했어요. 공고 편집에서 고친 뒤 올릴 수 있어요.\n\n" + fence
        emit({"token": reply})
        return _done(state, "done", step="saved", reply=reply)

    def after_posting(state) -> str:
        flow = flow_of(state)
        if flow.get("status") in ("done", "cancelled"):
            return END
        return _POSTING_STEPS.get(flow.get("step"), END)

    posting = StateGraph(EmployerState)
    for name, fn in (
        ("pf_research", pf_research),
        ("pf_role_options", pf_role_options),
        ("pf_role", pf_role),
        ("pf_role_detail", pf_role_detail),
        ("pf_draft", pf_draft),
        ("pf_review", pf_review),
        ("pf_confirm", pf_confirm),
        ("pf_save", pf_save),
    ):
        posting.add_node(name, fn)
        posting.add_conditional_edges(name, after_posting)
    posting.add_conditional_edges(
        START, lambda s: _POSTING_STEPS.get(flow_of(s).get("step"), "pf_research")
    )

    # ---- review ------------------------------------------------------------------
    async def rv_read(state):
        flow = flow_of(state)
        if flow.get("attachment_id"):
            return await _read_attachment(state, flow)
        app_id = flow.get("application_id")
        row = await store.application(app_id, state.get("company_id")) if store and app_id else None
        if row is None:
            reply = "어떤 지원자의 서류를 볼지 지원자 목록에서 골라 주세요."
            emit({"token": reply})
            return _done(state, "cancelled", reply=reply)
        docs = await store.snapshots(app_id, state.get("company_id"))
        documents = "\n\n".join(f"# {d['title']}\n{d['content']}" for d in docs)
        submitted = docs[0]["created_at"].date().isoformat() if docs else ""
        emit(
            {
                "type": "status",
                "text": (
                    f"제출 서류 {len(docs)}개를 읽었어요. 지원할 때 제출한 그대로예요 ({submitted})"
                ),
            }
        )
        ctx = await store.applicant_context(row["user_id"])
        return flow_update(
            state,
            step="match",
            documents=documents,
            posting=posting_text(row),
            category=(ctx or {}).get("job_category") or row["job_category"],
            tenure=(ctx or {}).get("tenure_years"),
        )

    async def _read_attachment(state, flow):
        # Ultra only. The PDF stays in this conversation: it is never indexed into RAG or
        # turned into reference samples, and it goes away when the conversation is deleted.
        if not plan_allows(plan_of(state), "ULTRA"):
            reply = "Push 밖에서 받은 서류 검토는 기업 Ultra 요금제에서 쓸 수 있어요."
            emit({"token": reply})
            return _done(state, "cancelled", reply=reply)
        found = await store.attachment(
            flow["attachment_id"], state.get("conversation_id"), state.get("company_id")
        )
        if found is None or found["mime_type"] != "application/pdf":
            reply = "이 대화에 올린 PDF를 찾지 못했어요. 다시 올려 주세요."
            emit({"token": reply})
            return _done(state, "cancelled", reply=reply)
        posting_row = None
        if flow.get("posting_id"):
            posting_row = await store.company_posting(flow["posting_id"], state.get("company_id"))
        if posting_row is None:
            reply = "어떤 공고 기준으로 볼지 알려 주세요. 공고 관리에서 공고를 골라 주세요."
            emit({"token": reply})
            return _done(state, "cancelled", reply=reply)
        text = read_pdf(bytes(found["content"]))
        emit({"type": "status", "text": f"{found['file_name']}을 읽었어요. 이 대화에만 보관해요."})
        return flow_update(
            state,
            step="match",
            documents=text,
            posting=posting_text(posting_row),
            category=posting_row["job_category"],
            tenure=None,
            attachment_name=found["file_name"],
        )

    async def rv_match(state):
        flow = flow_of(state)
        matches = await generate_for(state)(
            Matches,
            node_prompt("rv_match"),
            f"[공고]\n{flow['posting']}\n\n[제출 서류]\n{flow['documents'][:20000]}",
        )
        return flow_update(state, step="verify", matches=[m.model_dump() for m in matches.matches])

    async def rv_verify(state):
        flow = flow_of(state)
        plan = plan_of(state)
        levers = levers_for("EMPLOYER", plan or "", None)
        samples = []
        if db is not None and flow.get("category"):
            from app.infrastructure.store_jobs import ReferenceSampleStore

            samples = await ReferenceSampleStore(db).list_for_prompt(flow["category"])
        stats = baseline_stats(
            samples,
            flow.get("category"),
            flow.get("tenure"),
            None,
            levers.tenure,
            levers.score_band,
        )
        flags = await nodes.verify_claims(
            generate_for(state),
            flow["documents"],
            flow["posting"],
            json.dumps(flow.get("matches") or [], ensure_ascii=False),
            stats,
        )
        report = {
            "summary": "서류 전체는 공고와 잘 맞아요. " + nodes.report_summary(flags)
            if any(m.get("status") == "MET" for m in flow.get("matches") or [])
            else nodes.report_summary(flags),
            "matches": flow.get("matches") or [],
            "flags": [f.model_dump() for f in flags],
            "baseline": {"used": stats["used"], "sampleCount": stats["sample_count"]},
        }
        review_id = None
        if store:
            review_id = await store.save_review(
                state.get("company_id"),
                state.get("conversation_id"),
                flow.get("application_id"),
                report,
                attachment_name=flow.get("attachment_name"),
            )
        emit(
            {
                "type": "review_report",
                "applicationId": flow.get("application_id"),
                "attachmentName": flow.get("attachment_name"),
                "summary": report["summary"],
                "matches": report["matches"],
                "flags": report["flags"],
                "disclaimer": DECISION_DISCLAIMER,
            }
        )
        return flow_update(state, step="next", review_id=review_id, report=report)

    async def rv_next(state):
        pro = plan_allows(plan_of(state), "PRO")
        if flow_of(state).get("attachment_name"):
            # Interview kits need a Push application; external PDFs end at the report.
            return _done(state, "done")
        options = [
            {
                "id": "interview",
                "label": "면접 질문 만들기" if pro else "면접 질문 만들기 · Pro부터",
            }
        ]
        answer = await gate(
            state, db, "rv_report", "다음으로 무엇을 할까요?", options, recommended="interview"
        )
        if answer.get("option_id") == "interview":
            return {
                "flow": {
                    "name": "interview",
                    "step": "start",
                    "application_id": flow_of(state).get("application_id"),
                }
            }
        return _done(state, "done" if not cancelled(answer) else "cancelled")

    def after_review(state) -> str:
        flow = flow_of(state)
        if flow.get("status") in ("done", "cancelled") or flow.get("name") != "review":
            return END
        return {"match": "rv_match", "verify": "rv_verify", "next": "rv_next"}.get(
            flow.get("step"), END
        )

    review = StateGraph(EmployerState)
    for name, fn in (
        ("rv_read", rv_read),
        ("rv_match", rv_match),
        ("rv_verify", rv_verify),
        ("rv_next", rv_next),
    ):
        review.add_node(name, fn)
        review.add_conditional_edges(name, after_review)
    review.add_conditional_edges(
        START,
        lambda s: {"match": "rv_match", "verify": "rv_verify", "next": "rv_next"}.get(
            flow_of(s).get("step"), "rv_read"
        ),
    )

    # ---- interview ---------------------------------------------------------------
    async def iv_start(state):
        flow = flow_of(state)
        if not plan_allows(plan_of(state), "PRO"):
            reply = (
                "면접 질문은 기업 Pro 요금제부터 만들 수 있어요. 요금제는 관리자가 바꿀 수 있어요."
            )
            emit({"token": reply})
            return _done(state, "cancelled", reply=reply)
        app_id = flow.get("application_id")
        found = (
            await store.latest_review(state.get("company_id"), app_id) if store and app_id else None
        )
        if found is None:
            return {"flow": {"name": "review", "step": "read", "application_id": app_id}}
        report = found["report"]
        report = json.loads(report) if isinstance(report, str) else report
        row = await store.application(app_id, state.get("company_id"))
        docs = await store.snapshots(app_id, state.get("company_id"))
        checks = [f for f in report.get("flags") or [] if f.get("level") == "CHECK"]
        emit(
            {"type": "status", "text": f"서류 검토 결과를 이어받았어요 · 확인 필요 {len(checks)}곳"}
        )
        from app.harness.employer.schemas import Flag

        kit = await nodes.design_interview(
            generate_for(state),
            [Flag.model_validate(f) for f in report.get("flags") or []],
            posting_text(row),
            "\n\n".join(d["content"] for d in docs),
        )
        await store.save_kit(
            state.get("company_id"),
            state.get("conversation_id"),
            app_id,
            found["id"],
            kit.model_dump(),
        )
        emit(
            {
                "type": "interview_kit",
                "applicationId": app_id,
                "questions": [
                    {
                        "text": q.text,
                        "verify": q.verify,
                        "goodSignals": q.good_signals,
                        "cautionSignals": q.caution_signals,
                        "fromFlag": q.from_flag,
                    }
                    for q in kit.questions
                ],
            }
        )
        return _done(state, "done")

    interview = StateGraph(EmployerState)
    interview.add_node("iv_start", iv_start)
    interview.add_edge(START, "iv_start")
    interview.add_edge("iv_start", END)

    return EmployerState, {
        "posting": posting.compile(),
        "review": review.compile(),
        "interview": interview.compile(),
    }


def _draft_event(draft: PostingDraft) -> dict:
    return {
        "title": draft.title,
        "jobCategory": draft.job_category,
        "careerMin": draft.career_min,
        "careerMax": draft.career_max,
        "location": draft.location,
        "employmentType": draft.employment_type,
        "workStyle": draft.work_style,
        "salaryRange": draft.salary_range,
        "description": draft.description,
        "requirements": draft.requirements,
        "preferred": draft.preferred,
        "skills": draft.skills,
    }


def _fence(draft: PostingDraft) -> dict:
    return {
        "title": draft.title,
        "description": "\n".join(draft.description),
        "requirements": draft.requirements,
        "preferred": draft.preferred,
        "workConditions": {
            "location": draft.location,
            "employmentType": draft.employment_type,
            "workStyle": draft.work_style,
            "salaryRange": draft.salary_range,
        },
    }


def flow_summary(flow: dict) -> str:
    status = flow.get("status")
    name = flow.get("name")
    if status == "cancelled":
        return "기업 흐름을 그만뒀어요."
    return {
        "posting": "공고 초안을 만들었어요.",
        "review": "서류 검토를 마쳤어요.",
        "interview": "면접 질문을 만들었어요.",
    }.get(name, "기업 흐름을 마쳤어요.")


def leave_message(flow: dict) -> SystemMessage:
    return SystemMessage(content=flow_summary(flow))
