from __future__ import annotations

import asyncio
import inspect
import json
from uuid import UUID

import pytest

from app.domain.posting_fit import cached_view, fit_view, plan_name
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
            return hit if hit is not None and hit["edits"] == self.edits else None
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
        }


def _posting():
    return {
        "id": POSTING_ID,
        "requirements": ["python service"],
        "skills": ["Python", "Rust"],
        "description": "",
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


def test_plan_name_blank_is_free():
    assert plan_name(None) == "FREE"
    assert plan_name("  ") == "FREE"
