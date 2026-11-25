from __future__ import annotations

import asyncio

import pytest

from app.claimctx import LostClaim
from app.domain.errors import DomainError
from app.harness.kstyle.stage import Task, run_stage


def _task(name: str, run) -> Task:
    async def go():
        return await run()

    return Task(name, go, 0.05)


async def test_an_answer_cannot_mark_itself_late_or_failed():
    async def says_late():
        return {"summary": "끝", "late": True, "failed": True}

    staged = await run_stage([_task("reader", says_late)])
    assert staged["late"] == [] and staged["failed"] == []
    assert staged["out"]["reader"]["summary"] == "끝"


async def test_an_inner_timeout_is_failed_and_only_the_stage_limit_is_late():
    async def inner_timeout():
        raise TimeoutError("http read timed out")

    async def slow():
        await asyncio.sleep(1)
        return {}

    staged = await run_stage([_task("reader", inner_timeout), _task("slow", slow)])
    assert staged["failed"] == ["reader"] and staged["late"] == ["slow"]


async def test_a_non_dict_answer_does_not_end_the_stage():
    async def text():
        return "not a dict"

    async def fine():
        return {"summary": "ok"}

    staged = await run_stage([_task("odd", text), _task("fine", fine)])
    assert staged["out"]["odd"]["summary"] == "" and staged["out"]["fine"]["summary"] == "ok"
    assert staged["late"] == [] and staged["failed"] == []


@pytest.mark.parametrize("error", [LostClaim(), DomainError(402, "CREDIT_EXHAUSTED", "no credits")])
async def test_lost_claim_and_billing_errors_end_the_turn(error):
    async def raises():
        raise error

    with pytest.raises(type(error)):
        await run_stage([_task("reader", raises)])


async def test_a_provider_error_is_failed_not_fatal():
    async def raises():
        raise DomainError(502, "PROVIDER_ERROR", "AI provider request failed")

    staged = await run_stage([_task("reader", raises)])
    assert staged["failed"] == ["reader"] and staged["late"] == []
