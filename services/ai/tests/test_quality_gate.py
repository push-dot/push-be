from __future__ import annotations

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from app.harness.personal.resume.graph import build_resume_graph
from tests.test_harness_resume import _Approvals, _base, _config, _PhaseModel
from tests.test_resume_flow_decisions import _events

_REVIEW = {
    "message": "검토했어요.",
    "auto_fixes": [
        {"line": 4, "before": "old", "after": "new"},
        {"line": 9, "before": "a", "after": "b"},
    ],
    "recommendations": [
        {"label": "숫자로", "desc": "성과", "priority": "P1"},
        {"label": "키워드", "priority": "P2"},
        {"label": "도메인", "priority": "P1"},
    ],
}


def _graph(output):
    return build_resume_graph(MemorySaver(), model=_PhaseModel({"review": output}), db=_Approvals())


async def test_quality_applies_every_recommendation_without_asking():
    graph = _graph(_REVIEW)
    config = _config()
    events = await _events(graph, _base(phase="review"), config)
    assert not any(event.get("gate") == "quality" for event in events)
    assert any(event.get("type") == "diff" for event in events)
    applied = next(event for event in events if event.get("name") == "apply_recommendations")
    assert applied["target"] == "3개"
    assert applied["resultLine"] == "숫자로 · 키워드 · 도메인"
    assert any(event.get("type") == "choice" and event.get("gate") == "review" for event in events)
    snap = await graph.aget_state(config)
    assert snap.values["review"]["apply"] == ["숫자로", "키워드", "도메인"]


async def test_quality_skipped_when_no_recommendations():
    graph = _graph({"message": "고칠 곳이 없어요"})
    events = await _events(graph, _base(phase="review"), _config())
    assert not any(event.get("gate") == "quality" for event in events)
    assert any(event.get("type") == "choice" and event.get("gate") == "review" for event in events)
    assert any(
        event.get("name") == "quality_check" and event.get("resultLine") == "고칠 곳이 없어요"
        for event in events
    )
