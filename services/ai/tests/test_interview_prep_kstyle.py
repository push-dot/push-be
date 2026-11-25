"""Interview prep with a model: same result keys, grounded ids only, ungrounded STAR fields left to the user.
Fixtures are invented."""
from __future__ import annotations

import asyncio
from uuid import uuid4

import app.harness.kstyle.subagent as subagent
import app.harness.personal.interview_prep as interview_prep
from app.domain import entities as ent
from app.domain.services.posting_match import find_matching_postings
from tests import test_cov_svc_fakes as f
from tests.kstyle_fakes import RoleModel
from tests.test_cov_svc_interview import A, _world
from tests.test_posting_match import PARTS, _conditions, _posting

_TEXT = "주문 서비스를 Go로 다시 만들었다.\n응답 시간이 30% 줄었다."
_SOURCE = "회사 A는 물류 소프트웨어를 만든다. 직원은 120명이다."


def _setup():
    source = ent.CompanySource(source_url="https://company-a.example/about", source_text=_SOURCE,
                               accessed_at=f.now())
    s, iv, evs = _world(sources=[source], requirements=("Go", "SQL"))
    row = evs[0]
    s.evidence.rows[row.id] = row.model_copy(update={"title": "주문 서비스", "source_text": _TEXT})
    return s, iv, str(row.id)


def _script(eid: str, writer) -> dict:
    return {
        "evidence_reader": [{"findings": [
            {"evidenceId": eid, "quote": "주문 서비스를 Go로 다시 만들었다.", "claim": "Go로 서비스를 다시 만들었다."},
            {"evidenceId": eid, "quote": "응답 시간이 30% 줄었다.", "claim": "응답 시간을 30% 줄였다."},
            {"evidenceId": eid, "quote": "원문에 없는 문장이다.", "claim": "지어낸 것"},
        ]}],
        "company_reader": [{"findings": [
            {"sourceId": "C1", "quote": "회사 A는 물류 소프트웨어를 만든다.", "claim": "회사 A는 물류 소프트웨어 회사다."},
        ]}],
        "interview_writer": writer,
        "면접 답변을 검사": [{"mismatches": []}],
    }


def _shape(value: dict) -> list:
    return [sorted(value), *[[sorted(item) for item in value[key]] for key in sorted(value)]]


async def test_keys_are_the_same_with_and_without_a_model():
    s, iv, eid = _setup()
    plain = (await s.prepare(A, iv.id, 2, None)).result.value
    writer = [{"questions": [{"requirement": "Go", "question": "Go로 서비스를 다시 만든 과정을 설명해 주세요.",
                              "evidence": ["E1"]}], "starAnswers": []}]
    model = RoleModel(_script(eid, writer))
    value = (await s.prepare(A, iv.id, 2, None, model=model)).result.value
    assert _shape(value) == _shape(plain)
    assert value["questions"][0] == {"question": "Go로 서비스를 다시 만든 과정을 설명해 주세요.",
                                     "requirement": "Go", "evidenceIds": [eid]}
    # A requirement the writer skipped still gets a Korean question.
    assert value["questions"][1]["question"] == "SQL 관련 경험을 구체적으로 말씀해 주세요."
    # Research is marked as the user's own source, so it carries the verified quote, not the reader's claim.
    assert value["research"][0]["claim"] == "회사 A는 물류 소프트웨어를 만든다."
    assert value["research"][0]["sourceUrl"] == "https://company-a.example/about"
    assert {role for role, _ in model.calls} >= {"evidence_reader", "company_reader", "interview_writer"}


async def test_unknown_evidence_ids_are_dropped():
    s, iv, eid = _setup()
    stranger = str(uuid4())
    writer = [{"questions": [{"requirement": "Go", "question": "질문", "evidence": [stranger, "E3", "E9", eid]}],
               "starAnswers": [{"evidenceId": stranger, "task": {"text": "남의 근거", "evidence": ["E1"]}}]}]
    value = (await s.prepare(A, iv.id, 2, None, model=RoleModel(_script(eid, writer)))).result.value
    assert value["questions"][0]["evidenceIds"] == [eid]
    assert [item["evidenceIds"] for item in value["starAnswers"]] == [[eid]]


async def test_ungrounded_star_fields_stay_in_needs_input_after_one_fix():
    s, iv, eid = _setup()
    draft = {"questions": [], "starAnswers": [{
        "evidenceId": eid,
        "situation": {"text": "주문 서비스를 다시 만들어야 했다.", "evidence": ["E1"]},
        "task": {"text": "인증 구조를 설계했다.", "evidence": []},
        "action": {"text": "Go로 서비스를 다시 만들었다.", "evidence": ["E1"]},
        "result": {"text": "응답 시간이 50% 줄었다.", "evidence": ["E2"]},
    }]}
    model = RoleModel(_script(eid, [draft, draft]))
    value = (await s.prepare(A, iv.id, 2, None, model=model)).result.value
    answer = value["starAnswers"][0]
    assert answer["situation"] == "주문 서비스를 다시 만들어야 했다."
    assert answer["action"] == "Go로 서비스를 다시 만들었다."
    assert answer["task"] == "" and answer["result"] == ""
    assert answer["needsInput"] == ["task", "result"]
    # 50% is in no source: one redo, not more.
    assert [role for role, _ in model.calls].count("interview_writer") == 2


async def test_a_fact_check_mismatch_clears_the_field():
    s, iv, eid = _setup()
    draft = {"questions": [], "starAnswers": [{
        "evidenceId": eid, "action": {"text": "Go로 서비스를 혼자 다시 만들었다.", "evidence": ["E1"]}}]}
    script = _script(eid, [draft])
    script["면접 답변을 검사"] = [{"mismatches": [
        {"sentence": "Go로 서비스를 혼자 다시 만들었다.", "problem": "혼자였다는 근거가 없다"}]}]
    value = (await s.prepare(A, iv.id, 2, None, model=RoleModel(script))).result.value
    assert value["starAnswers"][0]["action"] == ""
    assert value["starAnswers"][0]["needsInput"] == ["task", "action", "result"]


async def test_a_failed_fact_check_keeps_the_draft_and_its_cited_fields():
    s, iv, eid = _setup()
    draft = {"questions": [], "starAnswers": [{
        "evidenceId": eid, "action": {"text": "Go로 서비스를 다시 만들었다.", "evidence": ["E1"]},
        "result": {"text": "응답 시간이 50% 줄었다.", "evidence": ["E2"]}}]}
    writes = []

    def writer(_messages):
        writes.append(1)
        if len(writes) > 1:
            raise RuntimeError("provider down")
        return draft

    def broken(_messages):
        raise RuntimeError("provider down")

    script = _script(eid, writer)
    script["면접 답변을 검사"] = broken
    value = (await s.prepare(A, iv.id, 2, None, model=RoleModel(script))).result.value
    answer = value["starAnswers"][0]
    assert answer["action"] == "Go로 서비스를 다시 만들었다."
    # The number check still holds when the redo fails too.
    assert answer["result"] == "" and "result" in answer["needsInput"]
    assert len(writes) == 2


async def test_a_reader_that_fails_or_runs_late_closes_its_line(monkeypatch):
    s, iv, eid = _setup()
    events: list[dict] = []
    monkeypatch.setattr(interview_prep, "emit", events.append)
    monkeypatch.setattr(subagent, "SUB_SECONDS", 0.05)

    def broken(_messages):
        raise RuntimeError("provider down")

    async def slow(_messages):
        await asyncio.sleep(5)

    script = _script(eid, [{"questions": [], "starAnswers": []}])
    script["evidence_reader"], script["company_reader"] = broken, slow
    await s.prepare(A, iv.id, 2, None, model=RoleModel(script))
    for name in ("evidence_reader", "company_reader"):
        assert [e["state"] for e in events if e.get("name") == name] == ["run", "err"]


async def test_unverified_company_quote_keeps_the_users_source():
    s, iv, eid = _setup()
    script = _script(eid, [{"questions": [], "starAnswers": []}])
    script["company_reader"] = [{"findings": [{"sourceId": "C1", "quote": "자료에 없는 문장", "claim": "지어낸 것"}]}]
    value = (await s.prepare(A, iv.id, 2, None, model=RoleModel(script))).result.value
    assert value["research"][0]["claim"] == _SOURCE


async def test_fit_scoring_runs_four_at_a_time_and_keeps_items_and_order():
    postings = [_posting(index, embedding=[1.0, index / 100]) for index in range(1, 11)]
    running, peak = 0, 0

    async def slow(row, _doc):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.01)
        running -= 1
        return {"fitScore": 8.0, "parts": PARTS, "topGap": "도메인", "plan": "FREE"}

    async def fast(row, _doc):
        return {"fitScore": 8.0, "parts": PARTS, "topGap": "도메인", "plan": "FREE"}

    together = await find_matching_postings(postings, [[1.0, 0.0]], _conditions(), score_fit=slow)
    alone = await find_matching_postings(postings, [[1.0, 0.0]], _conditions(), score_fit=fast)
    assert peak == 4 and len(together["items"]) == 10
    assert together == alone
