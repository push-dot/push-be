"""Background work that calls models: posting-match fit scoring runs concurrently, with the same items and
order as one-at-a-time scoring."""
from __future__ import annotations

import asyncio

import pytest

from app.claimctx import LostClaim
from app.domain.errors import FEATURE_DISABLED, DomainError
from app.domain.services.posting_match import find_matching_postings
from tests.test_posting_match import PARTS, _conditions, _posting


def _postings():
    return [_posting(index, embedding=[1.0, index / 100]) for index in range(1, 9)]


def _scorer(live: list[int], peak: list[int]):
    async def score_fit(row, _document_id):
        live.append(1)
        peak.append(len(live))
        await asyncio.sleep(0.01)
        live.pop()
        return {"fitScore": float(row["id"].int % 5), "parts": PARTS, "topGap": "도메인", "plan": "FREE"}
    return score_fit


async def _one_at_a_time(postings):
    lock = asyncio.Lock()
    inner = _scorer([], [])

    async def score_fit(row, document_id):
        async with lock:
            return await inner(row, document_id)

    return await find_matching_postings(postings, [[1.0, 0.0]], _conditions(), score_fit=score_fit)


async def test_fit_scoring_runs_concurrently_but_at_most_four_at_once():
    peak: list[int] = []
    await find_matching_postings(_postings(), [[1.0, 0.0]], _conditions(), score_fit=_scorer([], peak))
    assert 1 < max(peak) <= 4


async def test_concurrent_scoring_keeps_the_items_and_order():
    postings = _postings()
    concurrent = await find_matching_postings(postings, [[1.0, 0.0]], _conditions(), score_fit=_scorer([], []))
    serial = await _one_at_a_time(postings)
    assert [item["postingId"] for item in concurrent["items"]] == [item["postingId"] for item in serial["items"]]
    assert concurrent["text"] == serial["text"]


async def test_one_failed_score_keeps_every_row_and_leaves_that_one_unscored():
    postings = _postings()
    failing = postings[2]["id"]
    inner = _scorer([], [])

    async def score_fit(row, document_id):
        if row["id"] == failing:
            raise ValueError("fit judge returned an unreadable answer")
        return await inner(row, document_id)

    result = await find_matching_postings(
        postings, [[1.0, 0.0]], _conditions(), score_fit=score_fit)
    assert {item["postingId"] for item in result["items"]} == {str(row["id"]) for row in postings}
    unscored = [item for item in result["items"] if item["fitScore"] is None]
    assert [item["postingId"] for item in unscored] == [str(failing)]


@pytest.mark.parametrize("error", [
    DomainError(403, FEATURE_DISABLED, "monthly allowance used"), LostClaim()])
async def test_a_plan_limit_or_a_lost_claim_fails_the_match_instead_of_reading_as_no_score(error):
    async def score_fit(row, document_id):
        raise error

    with pytest.raises(type(error)):
        await find_matching_postings(_postings(), [[1.0, 0.0]], _conditions(), score_fit=score_fit)
