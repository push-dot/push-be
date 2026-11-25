"""Employer harness flows (super-recruit) as LangGraph subgraphs.

posting_flow   research ∥ reference → role gate → draft → reviewers → review → confirm gate → save
review_flow    read + baseline → match ∥ claims → verify + fact check → report gate
interview_flow plan check → inherit review → design → kit tied to flags
sourcing_flow  search → shortlist (reasons checked) → pick gate → offers ∥ → send gate

The k-style way: code works first, independent model work runs together under a time limit, what a
model says is checked by code, and each flow ends with the fixed four-part message (``kstyle.final``).

Each flow shares ``EmployerState`` with the parent graph, so interrupts and
checkpoints live on the conversation thread. Gates are ``EMPLOYER_GATE``
approval cards whose answers resume the same thread.
"""

from __future__ import annotations

import asyncio
import json
import re
from functools import partial
from uuid import NAMESPACE_URL, UUID, uuid5

from langchain_core.messages import SystemMessage
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt
from pydantic import BaseModel

from app.clock import utcnow
from push_agent.domain.employer_baseline import baseline_stats
from push_agent.domain.fair_hiring import DECISION_DISCLAIMER, banned_in_posting
from app.domain.plan_levers import levers_for
from app.harness.approvals import insert_chat_approval
from push_agent.harness import nodes
from push_agent.harness.recruit_prompts import CLAIM_READER, POSTING_REVIEWERS, node_prompt
from push_agent.harness.schemas import (
    CompanyProfile,
    Flag,
    InterviewKit,
    Match,
    OfferDraft,
    PostingDraft,
    RoleSpec,
)
from app.harness.kstyle.ask import needs_ask
from app.harness.kstyle.budget import budget_for
from app.harness.kstyle.final import Final, late_lines, render
from app.harness.kstyle.ledger import add_evidence, empty_notes, ledger_text
from app.harness.kstyle.review import Reviewer, run_reviewers
from app.harness.kstyle.stage import Task, run_stage
from app.harness.kstyle.subagent import Corpus, light_model, line, mid_model, single_call, squash
from app.harness.kstyle.verify import fact_check, unsupported_numbers
from app.harness.status import job_of
from app.harness.tools import emit
from push_agent.infrastructure.store_employer import EmployerStore, posting_text

FLOWS = ("posting", "review", "interview", "sourcing")
_PLAN_RANK = {"": 0, "BASIC": 1, "PRO": 2, "ULTRA": 3}
_MAX_REWRITES = 3
RESEARCH_SECONDS = 90  # web research is not waited past this; the flow goes on with what it has
_REVIEWERS = tuple(Reviewer(*row) for row in POSTING_REVIEWERS)
_LABELS = {
    "research": "회사 조사",
    "reference": "참고 공고 읽기",
    "match": "요건 매칭",
    "claims": "서류 주장 읽기",
    **{reviewer.name: "초안 검토" for reviewer in _REVIEWERS},
}
_SOURCING_STEPS = {"pick": "sc_pick", "draft_offers": "sc_draft_offers", "send": "sc_send"}
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
    options: list[RoleOption]


class Matches(BaseModel):
    matches: list[Match]


class Person(BaseModel):
    profile_id: str
    name: str
    reasons: list[str] = []


class Shortlist(BaseModel):
    people: list[Person]


def _profiles(found) -> list[dict]:
    data = found.get("data") if isinstance(found, dict) else found
    items = data.get("items") if isinstance(data, dict) else data
    return [p for p in items or [] if isinstance(p, dict)]


def _notes(flow: dict):
    notes = empty_notes()
    notes.update({k: v for k, v in (flow.get("notes") or {}).items() if k in notes})
    return notes


def _values(value) -> list[str]:
    if isinstance(value, dict):
        return [text for item in value.values() for text in _values(item)]
    if isinstance(value, list):
        return [text for item in value for text in _values(item)]
    return [] if value is None else [squash(str(value))]


def _grounded(reason: str, profile: dict, size: int = 4) -> bool:
    """The reason comes from the profile's values (never its keys): it is in them whole, or
    each of its numbers is and so is one run of ``size`` letters. A shorter reason must be a
    whole value."""
    reason, values = squash(reason), _values(profile)
    if len(reason) < size:
        return bool(reason) and reason in values
    text = " ".join(values)
    if reason in text:
        return True
    if not set(re.findall(r"\d+", reason)) <= set(re.findall(r"\d+", text)):
        return False
    flat, plain = reason.replace(" ", ""), text.replace(" ", "")
    return any(flat[i : i + size] in plain for i in range(len(flat) - size + 1))


def _cut_asks(before: PostingDraft, after: PostingDraft, role: RoleSpec, need: str) -> list:
    """Skills the 담당자 named in the role answer that review took out of the requirements."""
    was = " ".join(before.requirements).lower()
    kept = " ".join(after.requirements).lower()
    preferred = " ".join(after.preferred).lower()
    items = []
    for skill in role.must_skills:
        key = skill.strip().lower()
        if not key or key not in need.lower() or key not in was or key in kept:
            continue
        moved = key in preferred
        items.append({"source": "user", "verdict": "lighten" if moved else "cut", "what": skill.strip(),
                      "why": "우대 사항으로 내렸어요" if moved else "검수에서 뺐어요"})
    return needs_ask(items)


def _unfinished(flow: dict) -> list[str]:
    """Stages dropped from the flow: a late one ran out of time, a failed one raised."""
    return [*late_lines(flow.get("late") or [], _LABELS),
            *(f"{_LABELS.get(name, name)}: 끝내지 못해 빼고 진행했어요"
              for name in flow.get("failed") or [])]


def _title_key(title: str | None) -> str:
    return squash(title or "").strip("'\"「」 ")


def _career_line(draft: PostingDraft) -> str:
    if draft.career_max:
        return f"경력은 {draft.career_min}~{draft.career_max}년으로 잡았어요"
    if draft.career_min:
        return f"경력은 {draft.career_min}년 이상으로 잡았어요"
    return "경력 조건은 두지 않았어요"


def _baseline_line(stats: dict) -> str:
    if stats.get("used"):
        return f"같은 직군·연차 참고 서류 {stats.get('sample_count')}건의 통계와 비교했어요"
    return "비교할 참고 서류가 충분하지 않아 다른 서류와 비교하지 않았어요"


async def _read_claims(model, documents: str) -> dict:
    summary = "서류에서 확인할 주장을 골라요"
    emit(line("claim_reader", "run", summary, ""))
    out = await single_call(model, CLAIM_READER, {"documents": documents[:20000]})
    claims = [{"quote": str(c.get("quote") or ""), "claim": str(c.get("claim") or "")}
              for c in out.get("claims") or [] if isinstance(c, dict)]
    emit(line("claim_reader", "ok", summary, "", f"주장 {len(claims)}개"))
    return {"claims": claims}


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
    multiple: bool = False,
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
    if multiple:
        event["multiple"] = True
    # A resumed gate node replays from its top: the card goes out only when its row is new.
    new = db is None or await db.q().fetchrow(
        "SELECT id FROM approvals WHERE id = $1", UUID(event["id"])) is None
    if new:
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


def build_flows(
    *, db, generate_for, research_text, plan_of, store=None, read_pdf=None, call_tool=None, model_for=None
):
    """``call_tool(state, name, args)`` runs an employer tool through core (sourcing flow).
    ``model_for(state)`` returns the turn's chat model for subagents and reviewers, or None.
    ``generate_for(state)`` returns a node ``generate``; ``research_text(state, name)`` runs
        the web search; ``plan_of(state)`` returns the company plan (BASIC/PRO/ULTRA or '')."""
    store = store or (EmployerStore(db) if db is not None else None)
    if read_pdf is None:
        from app.ingest.pdf_text import read_pdf_text as read_pdf
    from app.harness.graph import HarnessState

    def _chat(state):
        return model_for(state) if model_for is not None else None

    def _light(state):
        chat = _chat(state)
        # shortcut: without the managed gate there is no light tier, so the turn model reads; fine for
        # BYO keys and tests, revisit if a non-gate model ever runs in production.
        return None if chat is None else (light_model(chat) or chat)

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
        tasks = []
        if not (cached and nodes.profile_is_fresh((company or {}).get("profile_refreshed_at"), now)):
            emit({"type": "status", "text": "회사 정보를 찾는 중"})

            async def research() -> dict:
                text = await research_text(state, name)
                found = await nodes.research_company(generate_for(state), name, text)
                return {"profile": found.model_dump(by_alias=True)}

            tasks.append(Task("research", research, seconds=RESEARCH_SECONDS))
        ref_id = flow_of(state).get("reference_posting_id")
        if ref_id and store:

            async def read_reference() -> dict:
                return {"text": posting_text(await store.posting(ref_id))}

            tasks.append(Task("reference", read_reference))
        staged = await run_stage(tasks)
        out = staged["out"]
        if "profile" in out.get("research", {}):
            profile = CompanyProfile.model_validate(out["research"]["profile"])
            if store:
                await store.save_profile(
                    state.get("company_id"), profile.model_dump(by_alias=True), now
                )
        else:
            # Fresh cache, or research ran late: go on with the stored (even stale) or an empty profile.
            profile = CompanyProfile.model_validate(cached) if cached else CompanyProfile(name=name)
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
        return flow_update(
            state,
            step="role_options",
            profile=profile.model_dump(by_alias=True),
            reference=(out.get("reference") or {}).get("text") or "",
            late=staged["late"],
            failed=staged["failed"],
        )

    async def pf_role_options(state):
        # Model work happens before the gate node: LangGraph replays a node from its start
        # when an interrupt resumes, so the gate node itself must not call the model.
        flow = flow_of(state)
        profile = CompanyProfile.model_validate(flow["profile"])
        reference = flow.get("reference") or "없음"
        user = f"[회사 프로필]\n{profile.model_dump_json()}\n\n[참고 공고]\n{reference}"
        choices = await generate_for(state)(RoleOptions, node_prompt("pf_role"), user)
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

    async def _objections(state, draft: PostingDraft, flow: dict) -> tuple[list[dict], dict]:
        count = budget_for(f"EMPLOYER:{plan_of(state) or ''}").reviewers
        chat = _chat(state)
        if not count or chat is None:
            return [], {}
        items = [
            {"id": f"{key}{i}", "section": label, "text": text}
            for key, label, lines in (
                ("req", "필수", draft.requirements),
                ("pref", "우대", draft.preferred),
                ("desc", "하는 일", draft.description),
            )
            for i, text in enumerate(lines)
        ]
        subject = {"items": items, "need": flow.get("need") or "", "role": flow.get("role") or {},
                   "requests": flow.get("requests") or []}
        out = await run_reviewers(mid_model(chat), list(_REVIEWERS[:count]), subject, emit)
        text = {item["id"]: item["text"] for item in items}
        dropped = {"late": out.get("late") or [], "failed": out.get("failed") or []}
        found = [{"line": text[o["target"]], "objection": o["objection"]}
                 for o in out["objections"]]
        return found, dropped

    async def pf_review(state):
        flow = flow_of(state)
        draft = PostingDraft.model_validate(flow["draft"])
        role = RoleSpec.model_validate(flow["role"])
        objections, dropped = await _objections(state, draft, flow)
        sources = (
            json.dumps(flow.get("profile") or {}, ensure_ascii=False),
            role.model_dump_json(),
            flow.get("need") or "",
            *(flow.get("requests") or []),
        )
        review = await nodes.review_posting(
            generate_for(state),
            draft,
            reference_text=flow.get("reference") or None,
            objections=objections,
            number_sources=sources,
            requests=flow.get("requests") or [],
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
        notes = _notes(flow)
        asks = _cut_asks(draft, review.draft, role, flow.get("need") or "")
        ask_lines, recut = "", []
        if asks and notes["ask"] is None:  # once per flow
            notes["ask"] = {"gate": f"pf_confirm_{version}", "items": asks}
            ask_lines = "\n".join(f"{i}. {a['what']} — {a['why']}" for i, a in enumerate(asks, 1))
        elif asks:
            # Asked once already: what this review cut again goes in the save reply, not away.
            recut = [f"말씀하신 요건 {a['what']}: {a['why']}" for a in asks]
        return flow_update(
            state,
            step="confirm",
            draft=review.draft.model_dump(),
            version=version,
            ask_salary=review.ask_salary,
            ask_lines=ask_lines,
            recut=recut,
            title_numbers=unsupported_numbers(review.draft.title, *sources),
            notes=notes,
            removed=[*(flow.get("removed") or []), *review.removed],
            late=[*(flow.get("late") or []), *(dropped.get("late") or [])],
            failed=[*(flow.get("failed") or []), *(dropped.get("failed") or [])],
            reviewed=int(flow.get("reviewed") or 0) + len(objections),
        )

    async def pf_confirm(state):
        flow = flow_of(state)
        title = "이 초안으로 진행할까요?"
        if flow.get("ask_salary"):
            title = "이 초안으로 진행할까요? 연봉 범위를 넣으려면 직접 말해 주세요."
        if flow.get("ask_lines"):
            title += "\n\n말씀하신 요건 중 검수에서 바뀐 게 있어요. 다시 넣으려면 직접 말해 주세요.\n"
            title += flow["ask_lines"]
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
        request = answer.get("text") or "다르게 다시 써 주세요."
        return flow_update(
            state,
            step="draft",
            rewrites=rewrites,
            request=request,
            requests=[*(flow.get("requests") or []), request],
            ask_lines="",
        )

    async def pf_save(state):
        flow = flow_of(state)
        draft = PostingDraft.model_validate(flow["draft"])
        fence = (
            "```posting-draft\n" + json.dumps(_fence(draft), ensure_ascii=False, indent=2) + "\n```"
        )
        decided = [_career_line(draft)]
        if flow.get("reference"):
            decided.append("참고 공고는 구조만 따르고 문장은 새로 썼어요")
        if flow.get("reviewed"):
            decided.append(f"검토 의견 {flow['reviewed']}개를 보고 요건을 다시 다듬었어요")
        left = ["연봉 범위가 비어 있어요"] if not draft.salary_range else []
        role = RoleSpec.model_validate(flow["role"]) if isinstance(flow.get("role"), dict) else None
        # 0 and None both mean "no bound"; (0, None) is the schema default, not an answer, and a
        # rewrite request after the role answer may change the career on purpose.
        asked = (role.career_min or 0, role.career_max or None) if role is not None else (0, None)
        made = (draft.career_min or 0, draft.career_max or None)
        if asked != (0, None) and not flow.get("requests") and asked != made:
            said = f"{asked[0]}~{asked[1]}년" if asked[1] else f"{asked[0]}년 이상"
            left.append(f"답한 경력 조건({said})과 초안의 경력 조건이 달라요")
        left += flow.get("recut") or []
        if flow.get("title_numbers"):
            left.append(f"제목에 근거 없는 숫자가 남아 있어요: {', '.join(flow['title_numbers'])}")
        left += [f"검수에서 뺀 줄: {item}" for item in flow.get("removed") or []]
        left += _unfinished(flow)
        final = Final(
            made=[f"공고 초안: {draft.title}"],
            decided=decided,
            left=left,
            next="공고 편집에서 고친 뒤 게시해 주세요",
        )
        reply = render(final) + "\n\n" + fence
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
        emit({"type": "status", "text": "제출 서류를 읽는 중"})
        ctx = await store.applicant_context(row["user_id"])
        category = (ctx or {}).get("job_category") or row["job_category"]
        tenure = (ctx or {}).get("tenure_years")
        return flow_update(
            state,
            step="match",
            documents=documents,
            posting=posting_text(row),
            category=category,
            tenure=tenure,
            baseline=await _baseline(state, category, tenure),
        )

    async def _baseline(state, category, tenure) -> dict:
        # Pure DB and code: loaded while reading, not behind a model call.
        levers = levers_for("EMPLOYER", plan_of(state) or "", None)
        samples = []
        if db is not None and category:
            from app.infrastructure.store_jobs import ReferenceSampleStore

            samples = await ReferenceSampleStore(db).list_for_prompt(category)
        return baseline_stats(samples, category, tenure, None, levers.tenure, levers.score_band)

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
        text = await read_pdf(bytes(found["content"]))
        emit({"type": "status", "text": "첨부 서류를 읽는 중"})
        return flow_update(
            state,
            step="match",
            documents=text,
            posting=posting_text(posting_row),
            category=posting_row["job_category"],
            tenure=None,
            attachment_name=found["file_name"],
            baseline=await _baseline(state, posting_row["job_category"], None),
        )

    async def rv_match(state):
        """Stage one: the requirement match (main model) and a light claim reader run together."""
        flow = flow_of(state)
        documents = flow["documents"]
        generate = generate_for(state)

        async def match() -> dict:
            found = await generate(
                Matches,
                node_prompt("rv_match"),
                f"[공고]\n{flow['posting']}\n\n[제출 서류]\n{documents[:20000]}",
            )
            return {"matches": [m.model_dump() for m in found.matches]}

        # The match is what the review is: it runs outside the stage, so its failure stops the turn
        # instead of saving an empty review. Only the optional claim reader may be dropped.
        light = _light(state)
        claims = None
        if light is not None:
            claims = asyncio.ensure_future(
                run_stage([Task("claims", lambda: _read_claims(light, documents))]))
        try:
            matched = await match()
        except BaseException:
            if claims is not None:
                claims.cancel()
            raise
        staged = await claims if claims is not None else {"out": {}, "late": [], "failed": []}
        found = [Match.model_validate(m) for m in matched.get("matches") or []]
        matches, lowered = nodes.check_matches(found, documents)
        notes = _notes(flow)
        corpus = Corpus({"documents": documents})
        for claim in (staged["out"].get("claims") or {}).get("claims") or []:
            if corpus.anywhere(claim["quote"]):  # code keeps only quotes really in the documents
                add_evidence(notes, "claim", "제출 서류", claim["quote"], claim["claim"], text=documents)
        return flow_update(
            state,
            step="verify",
            matches=[m.model_dump() for m in matches],
            notes=notes,
            left=[f"근거 문장을 서류에서 찾지 못해 '일부'로 낮춘 요건: {r}" for r in lowered],
            late=staged["late"],
            failed=staged["failed"],
        )

    async def _fact_checked(state, flags: list[Flag], documents: str) -> tuple[list[Flag], list[str]]:
        """SUPPORTED flags say the documents back something up: a light checker compares them with the
        documents, and a mismatched flag is dropped, never rewritten. CHECK flags are questions, not claims."""
        light = _light(state)
        supported = {f.title: f"{f.title}: {f.reason}" for f in flags if f.level == "SUPPORTED"}
        reasons = {f.title: squash(f.reason) for f in flags if f.level == "SUPPORTED"}
        if light is None or not supported:
            return flags, []
        try:
            wrong = await fact_check(light, "\n".join(supported.values()), documents[:20000], emit,
                                     noun="검토 결과")
        except Exception:
            return flags, ["서류 대조를 끝내지 못했어요. '근거 있음' 항목은 직접 확인해 주세요"]
        def covers(title: str, sentence: str) -> bool:
            # A mismatch must cover a flag's whole text or reason: a shared fragment drops none.
            reason = reasons[title]
            return squash(supported[title]) in sentence or bool(reason and reason in sentence)

        sentences = [(item["sentence"], squash(item["sentence"])) for item in wrong]
        bad = [title for title in supported if any(covers(title, s) for _, s in sentences)]
        # A mismatch that drops no flag is still said, never lost.
        loose = [said for said, s in sentences if not any(covers(title, s) for title in supported)]
        return [f for f in flags if f.title not in bad], [
            *(f"서류와 맞지 않아 뺀 항목: {t}" for t in bad),
            *(f"서류와 맞지 않을 수 있는 문장: {said}" for said in loose)]

    async def rv_verify(state):
        flow = flow_of(state)
        stats = flow.get("baseline") or await _baseline(state, flow.get("category"), flow.get("tenure"))
        flags = await nodes.verify_claims(
            generate_for(state),
            flow["documents"],
            flow["posting"],
            json.dumps(flow.get("matches") or [], ensure_ascii=False),
            stats,
            ledger=ledger_text(_notes(flow)),
        )
        flags, dropped = await _fact_checked(state, flags, flow["documents"])
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
        checks = sum(1 for f in flags if f.level == "CHECK")
        matches = report["matches"]
        final = Final(
            made=[
                *([f"요건 {len(matches)}개를 서류와 맞춰 봤어요"] if matches else []),
                f"면접에서 확인할 곳 {checks}곳을 짚었어요" if checks else "따로 확인할 곳은 찾지 못했어요",
            ],
            decided=[_baseline_line(stats)],
            left=[*(flow.get("left") or []), *dropped, *_unfinished(flow)],
            next="" if flow.get("attachment_name") else "면접 질문 만들기",
        )
        reply = render(final)
        emit({"token": reply})
        # Said before the rv_report gate: stored with this job, so the answer turn does not.
        return flow_update(state, step="next", review_id=review_id, report=report, reply=reply,
                           reply_job=job_of(state))

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
        if cancelled(answer):
            return _done(state, "cancelled", reply=None)
        # The report was stored on the turn that opened this gate; leave closes with its own line.
        return _done(state, "done", reply=None)

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
        emit({"type": "status", "text": "검토 결과를 이어받는 중"})
        flags = [Flag.model_validate(f) for f in report.get("flags") or []]
        # Questions are made only for what the review marked CHECK, and each must name one of them.
        checks = {_title_key(f.title): f.title for f in flags if f.level == "CHECK"}
        if not checks:
            reply = render(Final(
                left=["서류 검토에서 확인이 필요한 곳이 없어 질문을 만들지 않았어요"]))
            emit({"token": reply})
            return _done(state, "done", reply=reply)
        kit = await nodes.design_interview(
            generate_for(state),
            flags,
            posting_text(row),
            "\n\n".join(d["content"] for d in docs),
        )
        tied = [q.model_copy(update={"from_flag": checks[_title_key(q.from_flag)]})
                for q in kit.questions if _title_key(q.from_flag) in checks]
        untied = len(kit.questions) - len(tied)
        asked = {q.from_flag for q in tied}
        left = [f"검토 항목에 묶이지 않은 질문 {untied}개는 뺐어요"] if untied else []
        left += [f"질문이 묶이지 않은 확인 항목: {title}"
                 for title in checks.values() if title not in asked]
        if not tied:
            left.insert(0, "질문을 검토 항목에 묶지 못해 만들지 못했어요")
            reply = render(Final(left=left))
            emit({"token": reply})
            return _done(state, "done", reply=reply)
        kit = InterviewKit(questions=tied)
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
        final = Final(
            made=[f"면접 질문 {len(tied)}개를 만들었어요"],
            decided=["서류 검토에서 확인이 필요하다고 짚은 곳에 질문을 묶었어요"],
            left=left,
            next="면접에서 질문마다 좋은 신호와 주의 신호를 함께 봐 주세요",
        )
        reply = render(final)
        emit({"token": reply})
        return _done(state, "done", reply=reply)

    interview = StateGraph(EmployerState)
    interview.add_node("iv_start", iv_start)
    interview.add_edge(START, "iv_start")
    interview.add_edge("iv_start", END)

    # ---- sourcing ----------------------------------------------------------------
    async def sc_search(state):
        flow = flow_of(state)
        posting = ""
        if flow.get("posting_id") and store:
            posting = posting_text(
                await store.company_posting(flow["posting_id"], state.get("company_id"))
            )
        query = flow.get("query") or ""
        found = await call_tool(state, "search_profiles", {"q": query}) if call_tool else {}
        profiles = _profiles(found)[:10]
        if not profiles:
            reply = "조건에 맞는 공개 프로필을 찾지 못했어요. 검색어를 바꿔 볼까요?"
            emit({"token": reply})
            return _done(state, "cancelled", reply=reply)
        shortlist = await generate_for(state)(
            Shortlist,
            node_prompt("sc_shortlist"),
            f"[공고]\n{posting or query}\n\n[공개 프로필]\n"
            + json.dumps(profiles, ensure_ascii=False)[:20000],
        )
        found = {str(p.get("userId") or p.get("id")): p for p in profiles}
        texts = {key: json.dumps(p, ensure_ascii=False) for key, p in found.items()}
        # A reason must come from the profile itself; one that does not is dropped, the person stays.
        picks = [
            p.model_copy(update={"reasons": [r for r in p.reasons if _grounded(r, found[p.profile_id])]})
            for p in shortlist.people
            if p.profile_id in texts
        ][:10]
        return flow_update(
            state,
            step="pick",
            posting=posting,
            people=[p.model_dump() for p in picks],
            profiles={p.profile_id: texts[p.profile_id] for p in picks},
        )

    async def sc_pick(state):
        people = flow_of(state).get("people") or []
        options = [
            {
                "id": p["profile_id"],
                "label": " · ".join([p["name"], *([" / ".join(p["reasons"][:2])] if p["reasons"] else [])]),
            }
            for p in people
        ]
        answer = await gate(state, db, "sc_shortlist", "누구에게 제안을 보낼까요?", options,
                            multiple=True)
        if cancelled(answer):
            return _done(state, "cancelled")
        chosen = answer.get("option_ids") or (
            [answer["option_id"]] if answer.get("option_id") else []
        )
        chosen = [c for c in chosen if any(p["profile_id"] == c for p in people)]
        if not chosen:
            return _done(state, "cancelled")
        return flow_update(state, step="draft_offers", chosen=chosen)

    async def sc_draft_offers(state):
        """Offers are drafted together. Each is checked for banned wording and for numbers found in
        neither the person's profile nor the posting; a failing draft is redone once, then dropped."""
        flow = flow_of(state)
        people = {p["profile_id"]: p for p in flow.get("people") or []}
        profiles = flow.get("profiles") or {}
        posting = flow.get("posting") or ""
        generate = generate_for(state)

        async def offer(profile_id: str) -> dict:
            person = people[profile_id]
            profile = profiles.get(profile_id, "")
            user = f"[공고]\n{posting}\n\n[사람]\n" + json.dumps(person, ensure_ascii=False)
            if profile:
                user += f"\n\n[공개 프로필]\n{profile}"
            for _ in range(2):
                draft = await generate(OfferDraft, node_prompt("sc_offer"), user)
                problems = [*banned_in_posting(draft.message), *unsupported_numbers(
                    draft.message, profile, json.dumps(person, ensure_ascii=False), posting,
                    flow.get("query") or "")]
                if not problems:
                    return {"profile_id": profile_id, "name": person["name"], "message": draft.message}
                user += f"\n\n[다시 쓸 때 뺄 말 · 차별 표현이거나 근거 없는 숫자]\n{problems}"
            return {"profile_id": profile_id, "name": person["name"], "dropped": True}

        # One stage: a failing or late draft is dropped alone, and none outlives the turn.
        chosen = [pid for pid in flow.get("chosen") or [] if pid in people]
        staged = await run_stage([Task(pid, partial(offer, pid)) for pid in chosen], name="offers")
        unmade = set(staged["late"] + staged["failed"])
        results = [staged["out"][pid] for pid in chosen if pid not in unmade]
        drafts = [r for r in results if not r.get("dropped")]
        skipped = [
            *(f"{r['name']}: 제안 문구가 검사를 통과하지 못해 보내지 않았어요"
              for r in results if r.get("dropped")),
            *(f"{people[pid]['name']}: 제안 문구를 만들지 못했어요"
              for pid in chosen if pid in unmade),
        ]
        if not drafts:
            reply = "제안 메시지를 만들지 못했어요. 다시 시도해 주세요."
            emit({"token": reply})
            return _done(state, "cancelled", reply=reply)
        preview = "\n\n".join(f"**{d['name']}**\n{d['message']}" for d in drafts)
        reply = "보낼 제안 메시지예요.\n\n" + preview
        emit({"token": reply})
        # Said before the send gate: stored with this job, so the employer keeps what they approve.
        return flow_update(state, step="send", drafts=drafts, skipped=skipped, reply=reply,
                           reply_job=job_of(state))

    async def sc_send(state):
        flow = flow_of(state)
        drafts = flow.get("drafts") or []
        answer = await gate(
            state,
            db,
            "sc_send",
            f"이 메시지로 {len(drafts)}명에게 보낼까요?",
            [{"id": "send", "label": "보내기"}],
        )
        if answer.get("option_id") != "send":
            return _done(state, "cancelled", reply=None)
        sent, failed = 0, []
        for draft in drafts:
            result = await call_tool(
                state,
                "send_offer",
                {
                    "profileId": draft["profile_id"],
                    "message": draft["message"],
                    "postingId": flow_of(state).get("posting_id"),
                },
            )
            if isinstance(result, dict) and not result.get("error"):
                sent += 1
            else:
                failed.append(draft["name"])
        final = Final(
            made=[f"{sent}명에게 제안을 보냈어요"] if sent else [],
            left=[
                *(f"{name}: 보내지 못했어요. 이미 보낸 사람일 수 있어요" for name in failed),
                *(flow.get("skipped") or []),
            ],
            next="답을 기다리는 동안 다른 조건으로 인재를 더 찾아볼 수 있어요" if sent else "",
        )
        reply = render(final)
        emit({"token": reply})
        return _done(state, "done", reply=reply)

    def after_sourcing(state) -> str:
        flow = flow_of(state)
        if flow.get("status") in ("done", "cancelled"):
            return END
        return _SOURCING_STEPS.get(flow.get("step"), END)

    sourcing = StateGraph(EmployerState)
    for name, fn in (
        ("sc_search", sc_search),
        ("sc_pick", sc_pick),
        ("sc_draft_offers", sc_draft_offers),
        ("sc_send", sc_send),
    ):
        sourcing.add_node(name, fn)
        sourcing.add_conditional_edges(name, after_sourcing)
    sourcing.add_conditional_edges(
        START, lambda s: _SOURCING_STEPS.get(flow_of(s).get("step"), "sc_search")
    )

    return EmployerState, {
        "posting": posting.compile(),
        "review": review.compile(),
        "interview": interview.compile(),
        "sourcing": sourcing.compile(),
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
        "sourcing": "인재 찾기를 마쳤어요.",
    }.get(name, "기업 흐름을 마쳤어요.")


def leave_message(flow: dict) -> SystemMessage:
    return SystemMessage(content=flow_summary(flow))
