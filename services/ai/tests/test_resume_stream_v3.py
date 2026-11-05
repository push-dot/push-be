from __future__ import annotations

from langgraph.checkpoint.memory import MemorySaver

from app.domain.services.conversation import _live_event
from app.harness.personal.resume.graph import build_resume_graph
from tests.test_harness_resume import _Approvals, _base, _config, _PhaseModel
from tests.test_resume_flow_decisions import _events


def test_live_events_store_think_plan_and_paper():
    kind, payload = _live_event({"type": "think", "seconds": 2, "phase": "craft"})
    assert kind == "think"
    assert payload == {"seconds": 2, "phase": "craft"}
    assert _live_event({"type": "plan", "id": "strategy", "title": "수정 전략"})[0] == "plan"
    assert _live_event({"type": "paper", "id": "draft-resume-v1", "lines": []})[0] == "paper"
    assert _live_event({"type": "nope"}) is None
    assert "token" not in payload and "status" not in payload


async def test_work_phase_emits_think_before_reply():
    graph = build_resume_graph(MemorySaver(), model=_PhaseModel(), db=_Approvals())
    events = await _events(graph, _base(phase="strategy"), _config())
    think_at = next(index for index, event in enumerate(events) if event.get("type") == "think")
    token_at = next(index for index, event in enumerate(events) if "token" in event)
    assert think_at < token_at
    assert events[think_at]["phase"] == "strategy"
    assert events[think_at]["seconds"] >= 1
    assert "seq" not in events[think_at]

    quiet = build_resume_graph(MemorySaver(), model=None, db=_Approvals())
    events = await _events(
        quiet, _base(phase="strategy"), {"configurable": {"thread_id": "no-model"}}
    )
    assert not any(event.get("type") == "think" for event in events)
    assert any("token" in event for event in events)


async def test_strategy_phase_emits_plan_before_gate():
    output = {
        "message": "전략을 세웠어요.",
        "sections": [
            {
                "section": "경력",
                "action": "expand",
                "reason": "성과를 키운다",
                "suggested_keywords": ["결제 승인"],
            },
            {"section": "학력", "action": "keep", "reason": "유지"},
        ],
    }
    graph = build_resume_graph(
        MemorySaver(), model=_PhaseModel({"strategy": output}), db=_Approvals()
    )
    events = await _events(graph, _base(phase="strategy"), _config())
    kinds = []
    for event in events:
        if event.get("type") == "think":
            kinds.append("think")
        elif event.get("type") == "tool" and event.get("name") == "strategy":
            kinds.append("tool")
        elif event.get("type") == "plan":
            kinds.append("plan")
        elif "token" in event:
            kinds.append("token")
        elif event.get("type") == "choice":
            kinds.append(event.get("gate"))
    assert kinds == ["think", "tool", "plan", "token", "strategy"]
    plan = next(event for event in events if event.get("type") == "plan")
    assert plan["rows"][0]["tag"] == "강화"
    assert plan["keywords"] == ["결제 승인"]


async def test_craft_emits_paper_per_target():
    markdown = "# 김서준\n백엔드\n- 결제 승인"
    graph = build_resume_graph(
        MemorySaver(),
        model=_PhaseModel({"craft": {"markdown": markdown, "message": "초안이에요"}}),
        db=_Approvals(),
    )
    events = await _events(
        graph,
        _base(phase="craft", output_targets=["resume", "cover_letter"]),
        _config(),
    )
    papers = [event for event in events if event.get("type") == "paper"]
    assert [event["label"] for event in papers] == ["이력서 초안 v1", "자기소개서 초안 v1"]
    assert papers[0]["id"] == "draft-resume-v1"
    assert papers[1]["id"] == "draft-cover_letter-v1"
    assert papers[0]["heading"] == "김서준"
    assert "• 결제 승인" in papers[0]["lines"]
    token_at = next(index for index, event in enumerate(events) if "token" in event)
    assert all(
        index < token_at for index, event in enumerate(events) if event.get("type") == "paper"
    )


async def test_feedback_node_emits_tool_plan_token():
    analysis = {
        "message": "키워드가 부족해요",
        "feedback": [
            {"tag": "키워드", "problem": "키워드가 없어요", "fix": "결제 승인을 넣어요"},
            {"tag": "도메인", "problem": "도메인이 약해요", "fix": "핀테크를 적어요"},
            {"tag": "성과", "problem": "숫자가 없어요", "fix": "승인율을 적어요"},
        ],
    }
    graph = build_resume_graph(MemorySaver(), model=_PhaseModel(), db=_Approvals())
    events = await _events(graph, _base(phase="feedback", analysis=analysis), _config())
    assert events[0]["type"] == "tool"
    assert events[0]["name"] == "feedback"
    assert events[0]["resultLine"] == "고칠 점 3개"
    assert events[1]["type"] == "plan"
    assert events[1]["id"] == "feedback"
    assert events[1]["meta"] == "3개"
    assert events[2]["token"] == "이 공고 기준으로 고칠 점이에요."


async def test_invalid_strategy_does_not_emit_a_plan():
    graph = build_resume_graph(
        MemorySaver(),
        model=_PhaseModel(
            {
                "strategy": {
                    "valid": False,
                    "sections": [{"section": "경력", "action": "expand", "reason": "키운다"}],
                },
            }
        ),
        db=_Approvals(),
    )
    events = await _events(graph, _base(phase="strategy"), _config())
    assert any(event.get("type") == "think" for event in events)
    assert not any(event.get("type") == "plan" for event in events)
