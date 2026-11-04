from __future__ import annotations

from uuid import UUID

import pytest

from app.domain.posting_fit import fit_view
from app.domain.posting_match import FIT_FLOOR, SCORE_CAP, cosine_similarity, rank_postings
from app.domain.services.posting_match import find_matching_postings
from app.infrastructure.posting_fit_cache import load_fit
from app.infrastructure.posting_match import POSTING_MATCH_SQL

USER = UUID("00000000-0000-4000-8000-0000000000aa")
DOC = UUID("00000000-0000-4000-8000-0000000000d1")
PARTS = {
    "techStack": 10,
    "experienceLink": 8,
    "careerLevel": 6,
    "keyword": 4,
    "domain": 2,
}


def _posting(number: int, **extra) -> dict:
    posting_id = UUID(int=number)
    row = {
        "id": posting_id,
        "company": f"회사{number}",
        "title": "백엔드 엔지니어",
        "job_category": "dev",
        "career_min": 4,
        "career_max": 6,
        "location": "서울 강남구",
        "skills": ["Kotlin", "Spring Boot"],
        "description": "백엔드 서비스",
        "status": "OPEN",
        "closed_at": None,
        "requirements": ["Kotlin"],
        "revision": 1,
        "embedding": [1.0, 0.0],
    }
    row.update(extra)
    return row


def _conditions(**extra) -> dict:
    row = {
        "category": "dev",
        "role": "백엔드",
        "careerMin": 4,
        "careerMax": 6,
        "locations": ["서울"],
        "skills": ["Kotlin", "Spring Boot"],
        "minFit": False,
        "documentId": str(DOC),
    }
    row.update(extra)
    return row


def test_cosine_similarity_matches_llamaindex_distance():
    assert cosine_similarity([1.0, 0.0], [1.0, 0.0]) == 1.0
    assert cosine_similarity([1.0, 0.0], [0.0, 1.0]) == 0.0


def test_rank_postings_orders_by_max_similarity_and_drops_closed():
    user = [[1.0, 0.0]]
    near = _posting(1, embedding=[1.0, 0.0])
    far = _posting(2, embedding=[0.0, 1.0])
    closed = _posting(3, embedding=[1.0, 0.0], status="CLOSED")
    missed = _posting(4, embedding=[0.6, 0.8], location="부산", skills=["Go"])
    ranked = rank_postings([near, far, closed, missed], user, _conditions())
    assert [row["id"] for row in ranked] == [near["id"], far["id"]]
    assert ranked[0]["similarity"] == 1.0
    assert ranked[1]["similarity"] == 0.0


def test_rank_postings_uses_the_best_node_per_posting():
    posting = _posting(1, embedding=[[0.0, 1.0], [1.0, 0.0]])
    ranked = rank_postings([posting], [[1.0, 0.0]], _conditions())
    assert ranked[0]["similarity"] == 1.0


@pytest.mark.asyncio
async def test_scoring_stops_at_twenty():
    seen = []

    async def score_fit(row, document_id):
        seen.append(row["id"])
        return {"fitScore": 8.0, "parts": PARTS, "topGap": "도메인", "plan": "FREE"}

    postings = [_posting(index, embedding=[1.0, index / 100]) for index in range(1, 26)]
    result = await find_matching_postings(
        postings, [[1.0, 0.0]], _conditions(), score_fit=score_fit)
    assert len(seen) == SCORE_CAP == 20
    assert len(result["items"]) == 20
    assert result["scored"] == 20


@pytest.mark.asyncio
async def test_min_fit_switch_drops_scores_under_seven():
    async def score_fit(row, document_id):
        score = 8.0 if row["id"] == UUID(int=1) else 6.9
        return {"fitScore": score, "parts": PARTS, "topGap": "도메인", "plan": "FREE"}

    postings = [_posting(1), _posting(2, embedding=[0.2, 0.9])]
    result = await find_matching_postings(
        postings, [[1.0, 0.0]], _conditions(minFit=True), score_fit=score_fit)
    assert FIT_FLOOR == 7.0
    assert [item["postingId"] for item in result["items"]] == [str(UUID(int=1))]
    assert "6.9" not in result["text"]
    assert "회사1" in result["text"]


class _CacheDb:
    def __init__(self, postings: list[dict]):
        self.postings = {row["id"]: row for row in postings}
        self.cache = {}
        self.inserts = 0

    async def fetchrow(self, sql, *args):
        if "FROM posting_fit_cache" in sql:
            return self.cache.get((args[0], args[1], args[2], args[3]))
        if "FROM job_postings" in sql:
            user_id, posting_id, document_id = args
            posting = self.postings.get(posting_id)
            if posting is None or user_id != USER or document_id != DOC:
                return None
            return {**posting, "content": "Kotlin 백엔드", "plan": "FREE"}
        return None

    async def execute(self, sql, *args):
        if "posting_fit_cache" not in sql:
            return
        self.inserts += 1
        self.cache[(args[0], args[1], args[2], args[6])] = {
            "fit_score": args[3],
            "parts": args[4],
            "top_gap": args[5],
            "plan": args[6],
            "revision": args[7],
        }


@pytest.mark.asyncio
async def test_second_run_reuses_posting_fit_cache(monkeypatch):
    calls = {"n": 0}

    async def judge(*args, **kwargs):
        calls["n"] += 1
        return fit_view(PARTS, "FREE")

    monkeypatch.setattr("app.infrastructure.posting_fit_cache.judge_fit", judge)
    postings = [_posting(1), _posting(2, embedding=[0.0, 1.0])]
    db = _CacheDb(postings)

    async def score_fit(row, document_id):
        return await load_fit(db, USER, row["id"], UUID(document_id))

    first = await find_matching_postings(
        postings, [[1.0, 0.0]], _conditions(), score_fit=score_fit)
    second = await find_matching_postings(
        postings, [[1.0, 0.0]], _conditions(), score_fit=score_fit)
    assert calls["n"] == 2
    assert db.inserts == 2
    assert second["items"] == first["items"]
    assert len(first["items"]) == 2


def test_match_sql_uses_tenant_filter_and_llamaindex_similarity():
    assert "user_node.user_id = $1" in POSTING_MATCH_SQL
    assert "source_type = ANY($2::text[])" in POSTING_MATCH_SQL
    assert "source_type = 'posting'" in POSTING_MATCH_SQL
    assert "1 - (posting.embedding <=> user_node.embedding)" in POSTING_MATCH_SQL
    assert "p.status = 'OPEN'" in POSTING_MATCH_SQL
