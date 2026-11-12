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


async def test_quality_submit_with_zero_picks_goes_to_template_gate():
    graph = _graph(_REVIEW)
    config = _config()
    opened = await _events(graph, _base(phase="review"), config)
    quality = next(event for event in opened if event.get("gate") == "quality")
    assert quality["sections"][0]["selected"] == ["rec1", "rec3"]
    assert any(event.get("type") == "diff" for event in opened)
    events = await _events(
        graph,
        Command(
            resume={
                "option_id": "submit",
                "option_ids": ["submit"],
            }
        ),
        config,
    )
    assert any(event.get("type") == "choice" and event.get("gate") == "review" for event in events)
    assert not any(event.get("name") == "apply_recommendations" for event in events)
    snap = await graph.aget_state(config)
    assert snap.values["review"]["apply"] == []


async def test_quality_old_answer_applies_the_sent_rec():
    graph = _graph(_REVIEW)
    config = _config()
    await _events(graph, _base(phase="review"), config)
    await _events(graph, Command(resume={"option_id": "rec2"}), config)
    snap = await graph.aget_state(config)
    assert snap.values["review"]["apply"] == ["키워드"]


async def test_quality_skipped_when_no_recommendations():
    graph = _graph({"message": "고칠 곳이 없어요"})
    events = await _events(graph, _base(phase="review"), _config())
    assert not any(event.get("gate") == "quality" for event in events)
    assert any(event.get("type") == "choice" and event.get("gate") == "review" for event in events)
    assert any(
        event.get("name") == "quality_check" and event.get("resultLine") == "고칠 곳이 없어요"
        for event in events
    )
