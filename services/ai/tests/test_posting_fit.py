from __future__ import annotations

import asyncio
import json
from uuid import UUID

from app.infrastructure.posting_fit_cache import load_fit
from app.domain import posting_fit
from app.domain.posting_fit import compute_fit, fit_view
from app.main import create_app

USER_ID = UUID("00000000-0000-4000-8000-0000000000aa")
OTHER_ID = UUID("00000000-0000-4000-8000-0000000000ff")
POSTING_ID = UUID("00000000-0000-4000-8000-0000000000b1")
DOC_ID = UUID("00000000-0000-4000-8000-0000000000d1")
PARTS = {"techStack": 100, "experienceLink": 80, "keyword": 60}


def test_score_and_top_gap_for_known_parts():
    assert fit_view(PARTS, "PRO") == {
        "fitScore": 8.0,
        "parts": PARTS,
        "topGap": "키워드",
        "plan": "PRO",
    }


def test_top_gap_ties_prefer_tech_stack_then_experience():
    tech = fit_view(
        {"techStack": 40, "experienceLink": 40, "keyword": 90}, "FREE")
    assert tech["topGap"] == "기술 스택"
    experience = fit_view(
        {"techStack": 80, "experienceLink": 20, "keyword": 20}, "PRO")
    assert experience["topGap"] == "경험 연관성"
    assert fit_view(
        {"techStack": 10, "experienceLink": 10, "keyword": 10}, "FREE",
    )["topGap"] == "기술 스택"


def test_blank_plan_is_free():
    assert fit_view(PARTS, None)["plan"] == "FREE"
    assert fit_view(PARTS, "  ")["plan"] == "FREE"
    assert fit_view(
        {"techStack": 0, "experienceLink": 0, "keyword": 0}, "FREE",
    )["fitScore"] == 0.0


def test_empty_requirements_use_description():
    view = compute_fit(
        [],
        ["Python", "Rust"],
        "python service",
        DOC_ID,
        {"type": "doc", "content": [
            {"type": "text", "text": "I use Python daily"}]},
        None,
    )
    assert view == {
        "fitScore": 3.3,
        "parts": {"techStack": 50, "experienceLink": 0, "keyword": 50},
        "topGap": "경험 연관성",
        "plan": "FREE",
    }


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
        user_id, posting_id, document_id = args
        if "FROM posting_fit_cache" in sql:
            hit = self.cache.get(args)
            # Mirrors created_at >= documents.updated_at.
            return hit if hit is not None and hit["edits"] == self.edits else None
        if "FROM job_postings" in sql:
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
        self.cache[(args[0], args[1], args[2])] = {
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


def test_second_call_does_not_recompute(monkeypatch):
    calls = {"n": 0}
    real = posting_fit.part_scores

    def _wrapped(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(posting_fit, "part_scores", _wrapped)
    db = _Db(_posting(), _document(), "PRO")
    first = _fit(db)
    second = _fit(db)
    assert first == {
        "fitScore": 3.3,
        "parts": {"techStack": 50, "experienceLink": 0, "keyword": 50},
        "topGap": "경험 연관성",
        "plan": "PRO",
    }
    assert second == first
    assert calls["n"] == 1
    assert db.inserts == 1


def test_document_edit_invalidates_the_cached_fit():
    db = _Db(_posting(), _document(), "PRO")
    _fit(db)
    db.edits += 1  # the document was saved after the score was cached
    _fit(db)
    assert db.inserts == 2


def test_fit_inputs_load_in_one_query_scoped_to_the_user():
    from app.infrastructure.posting_fit_cache import _INPUTS
    assert "d.user_id = $1" in _INPUTS and "users u" in _INPUTS


def test_blank_db_plan_is_free():
    db = _Db(_posting(), _document(), "  ")
    assert _fit(db)["plan"] == "FREE"


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
