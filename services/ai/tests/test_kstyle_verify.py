from __future__ import annotations

import pytest

from app.harness.kstyle.ledger import add_evidence, empty_notes
from app.harness.kstyle.verify import (
    fact_check,
    finding,
    fix_once,
    unknown_ids,
    unsupported_numbers,
)
from tests.kstyle_fakes import RoleModel

_FACT = "너는 완성된 서류를"


def test_numbers_must_come_from_a_source():
    assert unsupported_numbers("응답 30% 단축, 2023년, 2024.03 출시, 5명 팀", "5명이 함께") == ["30%"]
    assert unsupported_numbers("3배 빨라짐", "속도 3 배") == []


@pytest.mark.parametrize(("draft", "source", "left"), [
    ("MAU 1,200명", "MAU 1200명", []),
    ("MAU 1,200명", "팀 200명", ["1200명"]),
    ("사용자 2000명, 장애 2024건, 1999% 성장", "", ["2000명", "2024건", "1999%"]),
    ("2024초 출시", "", []),
    ("연봉 4000만~5000만원", "연봉 4000~5000만원", []),
    ("팀은 3명에서 5명", "3~5명", []),
    ("고객 1000명", "고객 1,000명", []),
    ("Next.js 14 배포 파이프라인", "Next.js 14로 배포", []),
    ("Python 3 초기 설정", "Python 3으로", []),
    ("상위 10 만들기", "상위 10개", []),
    ("40.0% 줄였어요", "40% 줄였어요", []),
    ("처리량을 40% 올렸어요", "처리량을 올렸어요", ["40%"]),
    ("전환율 30% 올렸어요", "팀 30명", ["30%"]),
    ("전환율 30 % 올렸어요", "전환율 30%", []),
])
def test_a_number_is_backed_by_its_value_and_a_matching_or_missing_unit(draft, source, left):
    assert unsupported_numbers(draft, source) == left


def test_ids():
    notes = empty_notes()
    add_evidence(notes, "repo", "acme/widgets", "widgets ship weekly", "배포", text="widgets ship weekly")
    add_evidence(notes, "repo", "acme/widgets", "invented", "지어냄", text="")
    assert unknown_ids(["E1", "E2", "E9", "E1"], notes) == ["E2", "E9"]


async def test_fact_check_keeps_only_sentences_in_the_draft():
    model = RoleModel({"너는 완성된 검토 결과를": [{"mismatches": [
        {"sentence": "회사 A에서 5년 일했다.", "problem": "기간이 다름"},
        {"sentence": "draft에 없는 문장", "problem": "x"}]}]})
    events = []
    found = await fact_check(model, "회사 A에서 5년 일했다. 다른 문장.", "회사 A 3년", events.append,
                             noun="검토 결과")
    assert found == [{"sentence": "회사 A에서 5년 일했다.", "problem": "기간이 다름"}]
    assert [event["state"] for event in events] == ["run", "ok"]
    assert events[0]["summary"] == "검토 결과를 근거와 대조해요"


async def test_fix_once_retries_exactly_once():
    redos = []

    async def check(output: dict) -> list[dict]:
        return [finding("P0", "unsupported_number", "30%")]

    async def redo(findings: list[dict]) -> dict:
        redos.append(findings)
        return {"markdown": "고친 글"}

    output, left = await fix_once({"markdown": "처음 글"}, check, redo, lambda out: bool(out.get("markdown")))
    assert len(redos) == 1 and output == {"markdown": "고친 글"} and left[0]["rule"] == "unsupported_number"


async def test_fix_once_keeps_the_first_output_when_the_redo_is_unusable_or_not_needed():
    async def p0(output: dict) -> list[dict]:
        return [finding("P0", "unknown_evidence", "E9")]

    async def p1(output: dict) -> list[dict]:
        return [finding("P1", "style", "x")]

    async def redo(findings: list[dict]) -> dict:
        return {}

    def usable(out: dict) -> bool:
        return bool(out)

    assert await fix_once({"a": 1}, p0, redo, usable) == ({"a": 1}, [finding("P0", "unknown_evidence", "E9")])
    called = []

    async def never(findings):
        called.append(1)
        return {}

    assert (await fix_once({"a": 1}, p1, never, usable))[0] == {"a": 1} and called == []


async def test_fact_check_reads_json_after_prose():
    reply = ('검사 결과입니다.\n```JSON\n'
             '{"mismatches": [{"sentence": "5년 일했다.", "problem": "기간"}]}\n```\n끝.')
    model = RoleModel({_FACT: [reply]})
    found = await fact_check(model, "5년 일했다.", "3년", [].append)
    assert found == [{"sentence": "5년 일했다.", "problem": "기간"}]


@pytest.mark.parametrize("reply", ["문제 없어 보여요.", {"summary": "ok"}])
async def test_an_unreadable_fact_check_raises_and_closes_its_line(reply):
    events = []
    with pytest.raises(ValueError):
        await fact_check(RoleModel({_FACT: [reply]}), "5년 일했다.", "3년", events.append)
    assert [event["state"] for event in events] == ["run", "err"]


async def test_a_failed_fact_check_call_closes_its_line():
    async def down(_messages):
        raise RuntimeError("provider down")

    events = []
    with pytest.raises(RuntimeError):
        await fact_check(RoleModel({_FACT: down}), "5년 일했다.", "3년", events.append)
    assert [event["state"] for event in events] == ["run", "err"]
