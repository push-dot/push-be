from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import NAMESPACE_URL, UUID, uuid5

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from app.harness.core_client import CoreClient
from app.harness.graph import astream_harness, build_harness_graph
from app.harness.personal.tools import bound_services
from app.harness.registry import REGISTRY
from app.harness.tools import HarnessSpec
from tests.fakes import ScriptedChat
from tests.test_harness_resume import _Approvals, _base, _config, _graph, _PhaseModel

_USER = UUID("6f1e2c3a-1b2d-4e5f-8a9b-0c1d2e3f4a5b")


def _cycle(snap):
    for task in snap.tasks:
        for item in getattr(task, "interrupts", ()) or ():
            value = getattr(item, "value", None)
            if isinstance(value, dict) and "gain" in value:
                return value
    return None


def _score(value):
    return {key: value[key] for key in ("cycle", "before", "after", "gain")}


def _gate_id(cycle):
    return str(uuid5(NAMESPACE_URL, f"push:resume-gate:conv-1:job-1:boost:{cycle}"))


def _script(monkeypatch, scores, gate):
    seen = []

    async def fake(*args, **kwargs):
        seen.append({"args": args, **kwargs})
        score = scores[len(seen) - 1]
        return {"fitScore": score, "parts": {}, "topGap": "도메인", "plan": "FREE"}

    monkeypatch.setattr("app.framework.fit_judge.judge_fit", fake)
    token = bound_services.set(SimpleNamespace(ai=gate))
    return seen, token


async def _pull(graph, payload, config):
    events = []
    async for mode, chunk in graph.astream(payload, config, stream_mode=["custom", "values"]):
        if mode == "custom" and isinstance(chunk, dict):
            events.append(chunk)
    return await graph.aget_state(config), events


async def _to_first_cycle(graph, config, **extra):
    state = _base(
        phase="craft",
        user_id=str(_USER),
        drafts={"text": "이력서"},
        inputs={"requirements": "Python"},
    )
    state.update(extra)
    _snap, _events = await _pull(graph, state, config)
    return await _pull(graph, Command(resume={"option_id": "continue"}), config)


async def test_next_score_is_computed_between_cycles(monkeypatch):
    gate = SimpleNamespace(_reserve=object())
    seen, token = _script(monkeypatch, [1.0, 2.0, 3.0, 9.0], gate)
    graph = _graph(_Approvals(), model=_PhaseModel())
    config = _config()
    try:
        snap, events = await _to_first_cycle(graph, config)
        first = _cycle(snap)
        choice = next(event for event in events if event.get("gate") == "boost")
        assert _score(first) == {"cycle": 1, "before": 1.0, "after": 2.0, "gain": 1.0}
        assert first["kind"] == "RESUME_GATE"
        assert first["awaiting"] == "choice"
        assert first["gate"] == "boost"
        assert first["approval_id"] == choice["id"] == _gate_id(1)
        assert choice["title"] == "점수를 한 번 더 올릴까요?"
        assert choice["detail"] == "적합도 1.0 → 2.0 (+1.0)"
        assert [item["id"] for item in choice["options"]] == ["continue", "stop", "cancel"]
        assert len(seen) == 2
        assert seen[0]["gate"] is gate
        assert seen[0]["user_id"] == _USER
        assert seen[0]["job_id"] == "job-1"
        async for _mode, _chunk in graph.astream(
            Command(resume={"option_id": "continue"}), config, stream_mode=["custom", "values"],
        ):
            pass
        second = _cycle(await graph.aget_state(config))
        assert _score(second) == {"cycle": 2, "before": 2.0, "after": 3.0, "gain": 1.0}
        assert second["approval_id"] == _gate_id(2)
        assert len(seen) == 3
    finally:
        bound_services.reset(token)


async def test_boost_loop_stops_at_five_cycles(monkeypatch):
    seen, token = _script(monkeypatch, [5.0, 5.1, 5.2, 5.3, 5.4, 5.5, 9.0], object())
    graph = _graph(_Approvals(), model=_PhaseModel())
    config = _config()
    try:
        snap, _events = await _to_first_cycle(graph, config)
        first = _cycle(snap)
        assert _score(first) == {"cycle": 1, "before": 5.0, "after": 5.1, "gain": 0.1}
        hits = [first]
        for _ in range(6):
            async for _mode, _chunk in graph.astream(
                Command(resume={"option_id": "continue"}), config, stream_mode=["custom", "values"],
            ):
                pass
            snap = await graph.aget_state(config)
            hit = _cycle(snap)
            if hit is None:
                break
            hits.append(hit)
        assert [item["cycle"] for item in hits] == [1, 2, 3, 4, 5]
        assert snap.values["boost_stopped"] == "max"
        assert snap.values["phase"] == "review"
        assert snap.values["scores"] == []
        assert snap.values["boost_acked"] == 0
        assert len(seen) == 6
        assert snap.next == ()
    finally:
        bound_services.reset(token)


async def test_boost_loop_stops_on_stall(monkeypatch):
    seen, token = _script(monkeypatch, [4.0, 4.0, 4.0, 9.0], object())
    graph = _graph(_Approvals(), model=_PhaseModel())
    config = _config()
    try:
        snap, _events = await _to_first_cycle(graph, config)
        assert _score(_cycle(snap)) == {"cycle": 1, "before": 4.0, "after": 4.0, "gain": 0.0}
        async for _mode, _chunk in graph.astream(
            Command(resume={"option_id": "continue"}), config, stream_mode=["custom", "values"],
        ):
            pass
        snap = await graph.aget_state(config)
        assert _score(_cycle(snap)) == {"cycle": 2, "before": 4.0, "after": 4.0, "gain": 0.0}
        async for _mode, _chunk in graph.astream(
            Command(resume={"option_id": "continue"}), config, stream_mode=["custom", "values"],
        ):
            pass
        snap = await graph.aget_state(config)
        assert _cycle(snap) is None
        assert snap.values["boost_stopped"] == "stall"
        assert snap.values["phase"] == "review"
        assert snap.values["scores"] == []
        assert snap.values["boost_acked"] == 0
        assert len(seen) == 3
    finally:
        bound_services.reset(token)


async def test_cancel_at_the_cycle_gate_returns_to_the_agent(monkeypatch):
    _seen, token = _script(monkeypatch, [1.0, 2.0, 9.0], SimpleNamespace(_reserve=object()))
    tool = next(tool for tool in REGISTRY["personal"].tools if tool.name == "start_document")
    graph = build_harness_graph(
        HarnessSpec(id="personal", prompt="p", tools=[tool]),
        MemorySaver(),
        model=ScriptedChat([{"content": "다른 걸 도와드릴까요?"}]),
        db=None,
        core=CoreClient("http://core.test", "secret"),
    )
    config = {"configurable": {"thread_id": "conv-boost"}}
    try:
        async for _event in astream_harness(graph, {
            "messages": [{"role": "user", "content": "서류 써줘"}],
            "user_id": str(_USER),
            "conversation_id": "conv-boost",
            "job_id": "job-1",
            "access_mode": "AUTO",
            "resume": {
                "status": "active",
                "phase": "craft",
                "conversation_id": "conv-boost",
                "user_id": str(_USER),
                "job_id": "job-1",
                "access_mode": "AUTO",
                "drafts": {"text": "이력서"},
                "inputs": {"requirements": "Python"},
            },
        }, config):
            pass
        paused = await graph.aget_state(config)
        assert paused.next == ("resume_flow",)
        async for _event in astream_harness(
            graph, Command(resume={"option_id": "continue"}), config,
        ):
            pass
        at_cycle = await graph.aget_state(config)
        assert at_cycle.next == ("resume_flow",)
        paused_cycle = _cycle(at_cycle)
        assert _score(paused_cycle) == {"cycle": 1, "before": 1.0, "after": 2.0, "gain": 1.0}
        assert paused_cycle["kind"] == "RESUME_GATE"
        events = []
        async for event in astream_harness(
            graph, Command(resume={"option_id": "cancel"}), config,
        ):
            events.append(event)
        done = await graph.aget_state(config)
        assert done.next == ()
        assert done.values["resume"]["status"] == "cancelled"
        assert any(event.get("token") == "다른 걸 도와드릴까요?" for event in events)
        assert any(
            getattr(message, "content", "") == "서류 작성을 그만뒀어요."
            for message in done.values["messages"]
        )
    finally:
        bound_services.reset(token)


async def test_stop_ends_the_boost_and_saves_history(monkeypatch):
    seen, token = _script(monkeypatch, [1.0, 2.0, 9.0], object())
    db = _Approvals()
    graph = _graph(db, model=_PhaseModel())
    config = _config()
    try:
        _snap, _events = await _to_first_cycle(graph, config)
        assert len(seen) == 2
        await _pull(graph, Command(resume={"option_id": "stop"}), config)
        snap = await graph.aget_state(config)
        assert _cycle(snap) is None
        assert snap.values["status"] == "active"
        assert snap.values["phase"] == "review"
        assert snap.values["boost_stopped"] == "stop"
        assert snap.values["scores"] == []
        assert snap.values["boost_acked"] == 0
        assert len(seen) == 2
        saved = json.loads(db.files["05_boost_history.json"])
        assert saved["history"][0]["cycle"] == 1
        assert saved["history"][0]["after"] == 2.0
    finally:
        bound_services.reset(token)


async def test_bypass_auto_continues_without_a_boost_interrupt(monkeypatch):
    _seen, token = _script(monkeypatch, [4.0, 4.0, 4.0, 9.0], object())
    graph = _graph(_Approvals(), model=_PhaseModel())
    config = _config()
    try:
        snap, events = await _pull(graph, _base(
            phase="craft",
            access_mode="BYPASS",
            user_id=str(_USER),
            drafts={"text": "이력서"},
        ), config)
        boosts = [event for event in events if event.get("gate") == "boost"]
        assert [event.get("auto") for event in boosts] == [True, True]
        assert boosts[0]["detail"] == "적합도 4.0 → 4.0 (+0.0)"
        assert _cycle(snap) is None
        assert snap.values["phase"] == "review"
        assert snap.values["boost_stopped"] == "stall"
    finally:
        bound_services.reset(token)


async def test_judge_fit_receives_a_posting_built_from_analysis(monkeypatch):
    seen, token = _script(monkeypatch, [1.0, 2.0, 3.0], object())
    graph = _graph(_Approvals(), model=_PhaseModel())
    config = _config()
    page = "본문" + ("가" * 7000)
    try:
        await _pull(graph, _base(
            phase="craft",
            goto="p3c_boost",
            user_id=str(_USER),
            drafts={"resume": "경력 요약"},
            analysis={"jobs": {
                "requirements": ["Kafka"],
                "required": ["Python"],
                "preferred": "not-a-list",
                "keywords": ["FastAPI"],
            }},
            inputs={"pages": {"https://jobs.example/1": page}},
        ), config)
        requirements, keywords, description, content, _plan = seen[0]["args"]
        assert requirements == ["Kafka", "Python", "FastAPI"]
        assert keywords == requirements
        assert description.startswith("{")
        assert "Kafka" in description
        assert "본문" in description
        assert len(description) == 6000
        assert content == "경력 요약"
    finally:
        bound_services.reset(token)
