from __future__ import annotations

import asyncio
import inspect
import json
from types import SimpleNamespace
from uuid import UUID

import pytest

from app.domain.posting_fit import (
    cached_view,
    fit_inputs,
    fit_view,
    keyword_ratio,
    plan_name,
    tech_ratio,
)
from app.infrastructure.posting_fit_cache import _CACHED, load_fit
from app.main import create_app

USER_ID = UUID("00000000-0000-4000-8000-0000000000aa")
OTHER_ID = UUID("00000000-0000-4000-8000-0000000000ff")
POSTING_ID = UUID("00000000-0000-4000-8000-0000000000b1")
DOC_ID = UUID("00000000-0000-4000-8000-0000000000d1")
SCORES = {
    "techStack": 10,
    "experienceLink": 8,
    "careerLevel": 6,
    "keyword": 4,
    "domain": 2,
}
_PARTS = (
    "techStack", "experienceLink", "careerLevel", "keyword", "domain",
)


@pytest.fixture(autouse=True)
def scripted_judge(monkeypatch):
    calls = {"n": 0}

    async def fake(requirements, keywords, description, content, plan, **kwargs):
        calls["n"] += 1
        return fit_view(SCORES, plan)

    monkeypatch.setattr(
        "app.infrastructure.posting_fit_cache.judge_fit", fake, raising=False)
    return calls


def test_five_weighted_dimensions():
    view = fit_view(SCORES, "PRO")
    assert view == {
        "fitScore": 7.4,
        "parts": SCORES,
        "topGap": "도메인",
        "plan": "PRO",
        "reachable": 8.2,
    }
    assert tuple(view["parts"]) == _PARTS


def test_top_gap_ties_follow_rubric_order():
    tied = {key: 4 for key in _PARTS}
    assert fit_view(tied, "FREE")["topGap"] == "기술 스택"
    level = {**tied, "careerLevel": 1}
    assert fit_view(level, "PRO")["topGap"] == "경력 수준"
    keyword = {**tied, "keyword": 1, "domain": 1}
    assert fit_view(keyword, "FREE")["topGap"] == "키워드"


def test_scores_clamp_to_the_ten_point_scale():
    view = fit_view({
        "techStack": 12, "experienceLink": -1, "careerLevel": 6,
        "keyword": 4, "domain": 2,
    }, "FREE")
    assert view["parts"]["techStack"] == 10
    assert view["parts"]["experienceLink"] == 0
    assert view["fitScore"] == 5.0


def test_blank_plan_is_free():
    assert fit_view(SCORES, None)["plan"] == "FREE"
    assert fit_view(SCORES, "  ")["plan"] == "FREE"
    zeros = {key: 0 for key in _PARTS}
    assert fit_view(zeros, "FREE")["fitScore"] == 0.0


def test_cached_view_keeps_five_decimal_scores():
    parts = {**SCORES, "domain": 2.5}
    row = {
        "fit_score": "7.4", "parts": json.dumps(parts),
        "top_gap": "도메인", "plan": "PRO",
    }
    view = cached_view(row)
    assert tuple(view["parts"]) == _PARTS
    assert view["parts"]["domain"] == 2.5
    assert view["fitScore"] == 7.4
    assert view["reachable"] == 8.2


class _Db:
    def __init__(self, posting, document, plan):
        self.posting = posting
        self.document = document
        self.plan = plan
        self.cache = {}
        self.inserts = 0
        self.edits = 0

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        if "FROM posting_fit_cache" in sql:
            if len(args) < 4:
                return None
            user_id, posting_id, document_id, plan = args
            hit = self.cache.get((user_id, posting_id, document_id, plan))
            if hit is None or hit["edits"] != self.edits:
                return None
            posted = None if self.posting is None else self.posting.get("revision")
            if posted is not None and hit.get("revision") != posted:
                return None
            return hit
        if "FROM job_postings" in sql:
            user_id, posting_id, document_id = args
            p, d = self.posting, self.document
            if p is None or d is None or p["id"] != posting_id or d["id"] != document_id:
                return None
            if d["user_id"] != user_id:
                return None
            return {**p, "content": d["content"], "plan": self.plan}
        return None

    async def execute(self, sql, *args):
        if "posting_fit_cache" not in sql:
            return
        self.inserts += 1
        parts = json.loads(args[4]) if isinstance(args[4], str) else args[4]
        self.cache[(args[0], args[1], args[2], args[6])] = {
            "fit_score": args[3],
            "parts": parts,
            "top_gap": args[5],
            "plan": args[6],
            "edits": self.edits,
            "revision": args[7] if len(args) > 7 else None,
        }


def _posting():
    return {
        "id": POSTING_ID,
        "requirements": ["python service"],
        "skills": ["Python", "Rust"],
        "description": "",
        "revision": 1,
    }


def _document(user_id=USER_ID):
    return {
        "id": DOC_ID,
        "user_id": user_id,
        "content": {"type": "doc", "content": [
            {"type": "text", "text": "I use Python daily"}]},
    }


def _fit(db: _Db):
    return asyncio.run(load_fit(db, USER_ID, POSTING_ID, DOC_ID))


def test_cache_lookup_is_scoped_to_the_plan():
    assert "c.plan = $4" in _CACHED
    assert "document_id, plan)" in inspect.getsource(load_fit)


def test_second_call_does_not_call_the_model(scripted_judge):
    db = _Db(_posting(), _document(), "PRO")
    first = _fit(db)
    second = _fit(db)
    assert first["fitScore"] == 7.4
    assert tuple(first["parts"]) == _PARTS
    assert first["plan"] == "PRO"
    assert second == first
    assert scripted_judge["n"] == 1
    assert db.inserts == 1


def test_a_changed_plan_scores_again(scripted_judge):
    db = _Db(_posting(), _document(), "PRO")
    assert _fit(db)["plan"] == "PRO"
    db.plan = "ULTRA"
    assert _fit(db)["plan"] == "ULTRA"
    assert scripted_judge["n"] == 2
    assert set(db.cache) == {
        (USER_ID, POSTING_ID, DOC_ID, "PRO"),
        (USER_ID, POSTING_ID, DOC_ID, "ULTRA"),
    }


def test_document_edit_invalidates_the_cached_fit():
    db = _Db(_posting(), _document(), "PRO")
    _fit(db)
    db.edits += 1
    _fit(db)
    assert db.inserts == 2


def test_editing_the_posting_forces_a_recompute(scripted_judge):
    assert "c.posting_revision = p.revision" in _CACHED
    posting = _posting()
    posting["revision"] = 1
    db = _Db(posting, _document(), "PRO")
    _fit(db)
    posting["revision"] = 2
    _fit(db)
    assert scripted_judge["n"] == 2
    assert db.inserts == 2


def test_fit_inputs_load_in_one_query_scoped_to_the_user():
    from app.infrastructure.posting_fit_cache import _INPUTS
    assert "d.user_id = $1" in _INPUTS and "users u" in _INPUTS


def test_blank_db_plan_is_free(scripted_judge):
    db = _Db(_posting(), _document(), "  ")
    assert _fit(db)["plan"] == "FREE"
    assert (USER_ID, POSTING_ID, DOC_ID, "FREE") in db.cache
    assert scripted_judge["n"] == 1


def test_unknown_document_is_404():
    db = _Db(_posting(), None, "PRO")
    assert _fit(db) is None
    assert db.inserts == 0


def test_other_users_document_is_404():
    db = _Db(_posting(), _document(OTHER_ID), "PRO")
    assert _fit(db) is None
    assert db.inserts == 0


def test_unknown_posting_is_404():
    db = _Db(None, _document(), "PRO")
    assert _fit(db) is None
    assert db.inserts == 0


def test_fit_route_moved_to_core():
    matched = [
        route for route in create_app().routes
        if getattr(route, "path", "") == "/api/v1/postings/{id}/fit"
    ]
    assert matched == []


def test_tech_ratio_weighs_preferred_items_half():
    assert tech_ratio([True, True], []) == 10.0
    assert tech_ratio([True, False], []) == 5.0
    assert tech_ratio([True, False], [True, False]) == 5.0
    assert tech_ratio([True, True], [False, False]) == 6.7
    assert tech_ratio([False], [True, True]) == 5.0
    assert tech_ratio([], []) is None


def test_keyword_ratio_is_a_casefold_substring_share():
    assert keyword_ratio(["Python", "rust", " PYTHON ", ""], "I use python daily") == 5.0
    assert keyword_ratio("Kafka", "kafka streams") == 10.0
    assert keyword_ratio([], "anything") == 0.0
    assert keyword_ratio(["Go"], "") == 0.0


def test_an_ascii_keyword_is_a_whole_word_and_a_korean_one_takes_particles():
    assert keyword_ratio(["Go", "R", "C"], "Google Chrome React") == 0.0
    assert keyword_ratio(["Go"], "Go와 Rust") == 10.0
    assert keyword_ratio(["C++", "Node.js"], "c++ and node.js services") == 10.0
    assert keyword_ratio(["파이썬"], "파이썬으로 만들었어요") == 10.0


def test_nothing_to_check_leaves_tech_stack_out_of_the_score():
    others = {"experienceLink": 8, "careerLevel": 6, "keyword": 4, "domain": 2}
    view = fit_view({"techStack": None, **others}, "FREE")
    # (8*30 + 6*15 + 4*10 + 2*10) / 65, the other four weights renormalised.
    assert view["fitScore"] == 6.0
    assert view["parts"]["techStack"] == 6.0
    assert cached_view({
        "fit_score": view["fitScore"], "parts": json.dumps(view["parts"]),
        "top_gap": view["topGap"], "plan": "FREE",
    })["reachable"] == view["reachable"]


def test_fit_inputs_number_required_and_preferred_items():
    posting, document = fit_inputs(
        ["Python", "SQL"], ["k8s"], "", {"type": "text", "text": "doc"}, ["Rust"])
    assert posting == "필수 요구사항:\n1. Python\n2. SQL\n우대 사항:\n1. Rust\n키워드:\nk8s"
    assert document == "doc"
    unsplit, _ = fit_inputs([], [], "backend role", "doc")
    assert unsplit == "필수 요구사항:\n키워드:\n공고 설명:\nbackend role"


def test_without_a_requirement_list_skills_then_the_description_stand_in():
    from app.domain.posting_fit import requirement_items

    assert requirement_items([], ["Python", "Django"], "자격요건 Kafka")[0] == ["Python", "Django"]
    found = requirement_items(None, [], "자격요건 Kafka 운영 경험 우대사항 Go")[0]
    assert found == ["Kafka 운영 경험"]
    assert requirement_items([], [], "회사 소개 문단")[0] == []


def test_plan_name_blank_is_free():
    assert plan_name(None) == "FREE"
    assert plan_name("  ") == "FREE"


def _usage_response():
    message = SimpleNamespace(usage_metadata={"input_tokens": 11, "output_tokens": 7})
    return SimpleNamespace(generations=[[SimpleNamespace(message=message)]])


class _Settling:
    def __init__(self, **kwargs):
        self.schema = None

    def bind_tools(self, tools, **kwargs):
        self.schema = tools[0]
        return self

    async def ainvoke(self, messages, config=None, **kwargs):
        from langchain_core.messages import AIMessage

        for callback in (config or {}).get("callbacks") or []:
            await callback.on_llm_end(_usage_response(), run_id="fit-run")
        return AIMessage(content="", tool_calls=[{
            "name": self.schema.__name__, "id": "call-fit",
            "args": {"required_met": [True], "experience_link": 8, "career_level": 6,
                     "domain": 2},
        }])


class _Boom:
    def __init__(self, **kwargs):
        pass

    def bind_tools(self, tools, **kwargs):
        return self

    async def ainvoke(self, messages, config=None, **kwargs):
        raise RuntimeError("judge down")


def _usage_gate():
    from app.domain.services.ai import AIGate
    from tests.stubs import FakeDB, StubAiUsageStore, StubUserStore
    from tests.test_ai import _user

    gate = AIGate(FakeDB(), "sk", None)
    gate.users = StubUserStore(_user("FREE"))
    gate.usage = StubAiUsageStore()
    return gate


def _real_judge(monkeypatch):
    from app.framework.fit_judge import judge_fit

    monkeypatch.setattr("app.infrastructure.posting_fit_cache.judge_fit", judge_fit)


async def test_cache_miss_settles_one_usage_row(monkeypatch):
    from app.domain import entities as ent
    from app.domain.services.ai import usage_row_id

    _real_judge(monkeypatch)
    gate = _usage_gate()
    job_id = "fit-job-1"
    view = await load_fit(
        _Db(_posting(), _document(), "PRO"), USER_ID, POSTING_ID, DOC_ID,
        gate=gate, job_id=job_id, cls=_Settling)
    # Keyword 5.0: "Python" is in the document, "Rust" is not.
    assert view["fitScore"] == 7.5
    assert len(gate.usage.items) == 1
    row = gate.usage.items[0]
    assert row.id == usage_row_id(job_id, f"fit:{POSTING_ID}:{DOC_ID}")
    assert row.status == ent.USAGE_SETTLED
    assert (row.input_tokens, row.output_tokens) == (11, 7)


async def test_two_postings_with_the_same_text_reserve_two_usage_rows(monkeypatch):
    from app.domain.services.ai import usage_row_id

    _real_judge(monkeypatch)
    gate = _usage_gate()
    other = UUID("00000000-0000-4000-8000-0000000000b2")
    for posting_id in (POSTING_ID, other):
        db = _Db({**_posting(), "id": posting_id}, _document(), "PRO")
        await load_fit(
            db, USER_ID, posting_id, DOC_ID, gate=gate, job_id="fit-job-2", cls=_Settling)
    ids = {row.id for row in gate.usage.items}
    assert ids == {
        usage_row_id("fit-job-2", f"fit:{POSTING_ID}:{DOC_ID}"),
        usage_row_id("fit-job-2", f"fit:{other}:{DOC_ID}"),
    }
    assert len(ids) == 2


async def test_cache_hit_writes_no_usage_row(monkeypatch):
    _real_judge(monkeypatch)
    db = _Db(_posting(), _document(), "PRO")
    db.cache[(USER_ID, POSTING_ID, DOC_ID, "PRO")] = {
        "fit_score": 7.4,
        "parts": SCORES,
        "top_gap": "도메인",
        "plan": "PRO",
        "edits": 0,
        "revision": 1,
    }
    gate = _usage_gate()
    view = await load_fit(
        db, USER_ID, POSTING_ID, DOC_ID, gate=gate, job_id="fit-job-hit", cls=_Settling)
    assert view["fitScore"] == 7.4
    assert gate.usage.items == []


async def test_cache_miss_releases_the_reservation_when_the_judge_fails(monkeypatch):
    from app.domain import entities as ent

    _real_judge(monkeypatch)
    gate = _usage_gate()
    with pytest.raises(RuntimeError, match="judge down"):
        await load_fit(
            _Db(_posting(), _document(), "PRO"), USER_ID, POSTING_ID, DOC_ID,
            gate=gate, job_id="fit-job-fail", cls=_Boom)
    assert len(gate.usage.items) == 1
    assert gate.usage.items[0].status == ent.USAGE_RELEASED


def test_fit_inputs_keep_the_posting_description_beside_requirements():
    from app.domain.posting_fit import fit_inputs

    posting, _document = fit_inputs(["지게차 운전"], [], "예시물류 냉장 창고" + "가" * 3000, "")
    assert "공고 설명:\n예시물류 냉장 창고" in posting
    assert len(posting.split("공고 설명:\n", 1)[1]) == 1500
    assert fit_inputs([], [], "본문만", "")[0] == "필수 요구사항:\n키워드:\n공고 설명:\n본문만"
