from __future__ import annotations

from types import SimpleNamespace

from langgraph.checkpoint.memory import MemorySaver

from app.domain.services.conversation import _live_event
from app.harness.personal.tools import bound_services
from app.harness.personal.resume.graph import build_resume_graph
from tests.test_harness_resume import _Approvals, _base, _config, _PhaseModel
from tests.test_resume_flow_decisions import _events


def test_live_events_store_think_plan_and_paper():
    kind, payload = _live_event({"type": "think", "seconds": 2, "phase": "craft"}, "job")
    assert kind == "think"
    assert payload == {"seconds": 2, "phase": "craft"}
    assert _live_event({"type": "plan", "id": "strategy", "title": "수정 전략"}, "job")[0] == "plan"
    assert _live_event({"type": "paper", "id": "draft-resume-v1", "lines": []}, "job")[0] == "paper"
    assert _live_event({"type": "nope"}, "job") is None
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


async def test_craft_emits_paper_per_target(monkeypatch):
    async def fake_fit(*args, **kwargs):
        return {"fitScore": 5.0, "parts": {}, "topGap": "도메인", "plan": "FREE"}

    monkeypatch.setattr("app.framework.fit_judge.judge_fit", fake_fit)
    token = bound_services.set(SimpleNamespace(ai=SimpleNamespace(_reserve=object())))
    markdown = "# 김서준\n백엔드\n- 결제 승인"
    graph = build_resume_graph(
        MemorySaver(),
        model=_PhaseModel({"craft": {"markdown": markdown, "message": "초안이에요"}}),
        db=_Approvals(),
    )
    try:
        events = await _events(
            graph,
            _base(phase="craft", output_targets=["resume", "cover_letter"]),
            _config(),
        )
    finally:
        bound_services.reset(token)
    papers = [event for event in events if event.get("type") == "paper" and event["id"].endswith("-v1")]
    assert [event["label"] for event in papers] == ["이력서 초안 v1", "자기소개서 초안 v1"]
    assert papers[0]["id"] == "draft-resume-v1"
    assert papers[1]["id"] == "draft-cover_letter-v1"
    assert papers[0]["heading"] == "김서준"
    assert "• 결제 승인" in papers[0]["lines"]
    token_at = next(index for index, event in enumerate(events) if "token" in event)
    assert all(
        index < token_at for index, event in enumerate(events) if event in papers
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


async def test_blueprints_say_how_many_then_list_the_ones_that_passed():
    outputs = {
        "blueprints": {
            "message": "기획서 본문은 채팅에 쓰지 않아요.",
            "projects": [
                {"id": "p1", "title": "결제 승인 재시도 큐", "category": "안정성", "stack": ["Kotlin", "Kafka"]},
                {"id": "p2", "title": "결제 이벤트 아웃박스", "category": "무결성", "stack": ["Kafka", "JPA"]},
                {"id": "p3", "title": "가맹점 API 레이트 리미터", "category": "안정성", "stack": ["Redis"]},
            ],
        },
        "validate_bp": {
            "valid": True,
            "projects": [
                {"id": "p1", "verdict": "pass"},
                {"id": "p2", "verdict": "conditional"},
                {"id": "p3", "verdict": "fail"},
            ],
        },
    }
    graph = build_resume_graph(MemorySaver(), model=_PhaseModel(outputs), db=_Approvals())
    events = await _events(
        graph,
        _base(phase="blueprints", work_mode="experience_blueprint", approach="prevention"),
        _config(),
    )
    kinds = [
        "plan" if event.get("type") == "plan" else "token" if "token" in event else event.get("gate")
        for event in events
        if event.get("type") in {"plan", "choice"} or "token" in event
    ]
    assert kinds == ["token", "plan", "projects"]
    assert next(event["token"] for event in events if "token" in event) == "프로젝트 기획서 3개를 만들었어요."
    plan = next(event for event in events if event.get("type") == "plan")
    assert plan["id"] == "blueprints"
    assert plan["title"] == "프로젝트 기획서"
    assert plan["meta"] == "2개"
    assert plan["rows"] == [
        {"tag": "통과", "label": "결제 승인 재시도 큐", "note": "안정성 · Kotlin, Kafka"},
        {"tag": "조건부", "label": "결제 이벤트 아웃박스", "note": "무결성 · Kafka, JPA"},
    ]
    gate = next(event for event in events if event.get("type") == "choice")
    assert [option["label"] for option in gate["options"]] == [
        "결제 승인 재시도 큐",
        "결제 이벤트 아웃박스",
        "닫기",
    ]
    assert gate["submit"] == {"label": "구현하기"}


async def test_blueprints_all_dropped_by_the_check_count_as_a_failed_check():
    outputs = {
        "blueprints": {"projects": [{"id": "p1", "title": "재시도 큐"}, {"id": "p2", "title": "아웃박스"}]},
        "validate_bp": {
            "valid": True,
            "projects": [{"id": "p1", "verdict": "fail"}, {"id": "p2", "verdict": "fail"}],
        },
    }
    graph = build_resume_graph(MemorySaver(), model=_PhaseModel(outputs), db=_Approvals())
    events = await _events(
        graph,
        _base(phase="blueprints", work_mode="experience_blueprint", approach="prevention"),
        _config(),
    )
    assert not any(event.get("type") in {"plan", "choice"} for event in events)
    snap = await graph.aget_state(_config())
    assert snap.values["validation_failures"] == 1


async def test_a_verdict_never_lands_on_a_project_without_an_id():
    from app.harness.personal.resume.progress import blueprints_plan

    kept, plan = blueprints_plan(
        [{"title": "재시도 큐"}, {"title": "아웃박스"}],
        {"projects": [{"id": "", "verdict": "fail"}]},
    )
    assert len(kept) == 2
    assert [row["tag"] for row in plan["rows"]] == ["통과", "통과"]
