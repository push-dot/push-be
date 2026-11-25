from __future__ import annotations

import asyncio

from app.harness.kstyle.review import Reviewer, run_reviewers
from tests.kstyle_fakes import RoleModel

READER = Reviewer("review_reader", "읽는 사람 입장에서 봐요", "너는 시간이 없는 서류 검토자다.\n멈추게 하는 점을 찾는다.")
EDITOR = Reviewer("review_editor", "편집자 입장에서 봐요", "너는 삼분의 일을 잘라야 하는 편집자다.")


async def test_objections_on_unknown_targets_are_dropped():
    model = RoleModel({"서류 검토자": [{"objections": [
        {"target": "s1", "objection": "근거가 없어요"},
        {"target": "s9", "objection": "없는 항목"},
        {"target": "s2", "objection": ""}]}]})
    events = []
    out = await run_reviewers(model, [READER], {"items": [{"id": "s1"}, {"id": "s2"}]}, events.append)
    assert out == {"objections": [{"by": "review_reader", "target": "s1", "objection": "근거가 없어요"}],
                   "late": [], "failed": []}
    assert [event["state"] for event in events] == ["run", "ok"]


async def test_a_late_reviewer_is_dropped():
    async def slow(_messages):
        await asyncio.sleep(1)
        return {"objections": [{"target": "s1", "objection": "늦은 반대"}]}

    model = RoleModel({"서류 검토자": [{"objections": [{"target": "s1", "objection": "빠른 반대"}]}],
                       "편집자": slow})
    events = []
    out = await run_reviewers(model, [READER, EDITOR], {"items": [{"id": "s1"}]}, events.append, seconds=0.05)
    assert out["late"] == ["review_editor"] and out["failed"] == []
    assert [item["objection"] for item in out["objections"]] == ["빠른 반대"]
    assert events[-1]["name"] == "review_editor" and events[-1]["state"] == "err"
    assert sorted(role for role, _tier in model.calls) == ["서류 검토자", "편집자"]


async def test_a_raising_or_unreadable_reviewer_failed_not_late():
    async def broken(_messages):
        raise RuntimeError("provider down")

    model = RoleModel({"서류 검토자": broken, "편집자": ["검토했어요. 문제 없어요."]})
    events = []
    out = await run_reviewers(model, [READER, EDITOR], {"items": [{"id": "s1"}]}, events.append)
    assert out == {"objections": [], "late": [], "failed": ["review_reader", "review_editor"]}
    errors = [event["resultLine"] for event in events if event["state"] == "err"]
    assert errors == ["끝내지 못했어요", "끝내지 못했어요"]
