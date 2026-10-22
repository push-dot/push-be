from __future__ import annotations

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from app.graphs.resume_prompt import phase_prompt_for_harness
from app.harness.registry import REGISTRY
from app.harness.resume.graph import build_resume_graph
from app.harness.router import select_harness
from app.harness.tools import ToolContext
from app.harness.core_client import CoreClient

_ORDER = (
    "mode_select", "intake", "analyze", "strategy", "craft", "review", "publish", "present",
)


class _Approvals:
    def __init__(self):
        self.rows = {}

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        return self.rows.get(str(args[0]))

    async def execute(self, sql, *args):
        self.rows[str(args[0])] = {"id": args[0]}
        return "INSERT 1"


class _PhaseModel:
    def __init__(self, outputs=None):
        self.outputs = outputs or {}

    def with_structured_output(self, _schema):
        return self

    async def ainvoke(self, messages, **kwargs):
        phase = "mode_select"
        for message in messages:
            if isinstance(message, dict) and message.get("phase"):
                phase = message["phase"]
        return dict(self.outputs.get(phase) or {"summary": phase})


def _graph(db, poster, model=None):
    return build_resume_graph(MemorySaver(), model=model or _PhaseModel(), db=db, poster=poster)


def _config():
    return {"configurable": {"thread_id": "conv-1:resume"}}


def _base(**extra):
    state = {
        "status": "active",
        "phase": "mode_select",
        "access_mode": "AUTO",
        "conversation_id": "conv-1",
        "user_id": "user-1",
        "job_id": "job-1",
        "inputs": {},
    }
    state.update(extra)
    return state


async def _run(graph, payload, config):
    async for _mode, _chunk in graph.astream(payload, config, stream_mode=["custom", "values"]):
        pass
    snap = await graph.aget_state(config)
    events = []
    for task in snap.tasks:
        for item in getattr(task, "interrupts", ()) or ():
            pass
    # custom events are not on the snapshot; collect them from a second pass? no.
    return snap


async def _drive(graph, config, first):
    posted = []
    seen = []
    payload = first
    for _ in range(16):
        events = []
        async for mode, chunk in graph.astream(payload, config, stream_mode=["custom", "values"]):
            if mode == "custom" and isinstance(chunk, dict):
                events.append(chunk)
        snap = await graph.aget_state(config)
        seen.append((events, snap))
        if snap.next:
            choice = next(event for event in events if event.get("type") == "choice")
            payload = Command(resume={"option_id": choice["recommended"]})
            continue
        if snap.values.get("status") in {"done", "cancelled"}:
            break
        payload = {}
    return seen


def test_harness_prompt_skips_file_rules():
    text = phase_prompt_for_harness("analyze")
    assert "파일시스템 도구가 있는" not in text
    assert "resume-parser" in text or "Phase 1" in text


async def test_stops_at_every_gate_in_auto():
    posted = []

    async def poster(payload):
        posted.append(payload)

    graph = _graph(_Approvals(), poster)
    seen = await _drive(graph, _config(), _base())
    gates = [
        event["gate"]
        for events, snap in seen
        for event in events
        if event.get("type") == "choice" and snap.next
    ]
    assert gates == list(_ORDER)
    assert seen[-1][1].values["status"] == "done"
    assert posted[-1]["resume"]["auto"] is True


async def test_bypass_auto_picks_recommended():
    graph = _graph(_Approvals(), None)
    config = _config()
    events = []
    async for mode, chunk in graph.astream(
        _base(access_mode="BYPASS", inputs={"attachments": ["resume.pdf"]}),
        config,
        stream_mode=["custom", "values"],
    ):
        if mode == "custom":
            events.append(chunk)
    snap = await graph.aget_state(config)
    assert snap.next
    assert events[0]["gate"] == "mode_select"
    assert "auto" not in events[0]
    await _run(graph, Command(resume={"option_id": "resume_based"}), config)
    later = []
    for _ in range(8):
        step = []
        async for mode, chunk in graph.astream({}, config, stream_mode=["custom", "values"]):
            if mode == "custom" and isinstance(chunk, dict):
                step.append(chunk)
        snap = await graph.aget_state(config)
        later.extend(step)
        if snap.values.get("status") == "done" or snap.next:
            break
    assert any(event.get("auto") is True for event in later)
    assert not any(event.get("gate") == "intake" and event.get("auto") is not True for event in later)


async def test_bypass_empty_inputs_stops_at_intake():
    graph = _graph(_Approvals(), None)
    config = _config()
    await _run(graph, _base(access_mode="BYPASS", inputs={}), config)
    await _run(graph, Command(resume={"option_id": "resume_based"}), config)
    events = []
    async for mode, chunk in graph.astream({}, config, stream_mode=["custom", "values"]):
        if mode == "custom" and isinstance(chunk, dict):
            events.append(chunk)
    snap = await graph.aget_state(config)
    assert snap.next
    assert events[0]["gate"] == "intake"
    assert "auto" not in events[0]


async def test_scenario_c_skips_strategy():
    posted = []

    async def poster(payload):
        posted.append(payload)

    graph = _graph(_Approvals(), poster)
    config = _config()
    answers = {"intake": "C"}
    payload = _base()
    gates = []
    for _ in range(16):
        events = []
        async for mode, chunk in graph.astream(payload, config, stream_mode=["custom", "values"]):
            if mode == "custom" and isinstance(chunk, dict):
                events.append(chunk)
        snap = await graph.aget_state(config)
        if snap.next:
            choice = next(event for event in events if event.get("type") == "choice")
            gates.append(choice["gate"])
            option = answers.get(choice["gate"], choice["recommended"])
            payload = Command(resume={"option_id": option})
            continue
        if snap.values.get("status") == "done":
            break
        payload = {}
    assert "strategy" not in gates
    assert "craft" not in gates
    assert "review" in gates


async def test_cancel_text_ends_flow():
    graph = _graph(_Approvals(), None)
    config = _config()
    await _run(graph, _base(), config)
    await _run(graph, Command(resume={"text": "그만할래"}), config)
    snap = await graph.aget_state(config)
    assert snap.values["status"] == "cancelled"
    assert select_harness({"resume_state": {"status": snap.values["status"]}}).id == "personal"


async def test_free_text_answers_gate():
    graph = _graph(_Approvals(), None)
    config = _config()
    await _run(graph, _base(), config)
    await _run(graph, Command(resume={"option_id": "resume_based"}), config)
    await _run(graph, {}, config)
    snap = await graph.aget_state(config)
    assert snap.next
    await _run(graph, Command(resume={"text": "경력 두 개만"}), config)
    snap = await graph.aget_state(config)
    assert snap.values["inputs"]["gate_text"] == "경력 두 개만"
    assert snap.values["phase"] == "intake"


async def test_new_document_while_active_asks():
    tool = next(tool for tool in REGISTRY["personal"].tools if tool.name == "start_document")

    class DB:
        def q(self):
            return self

        async def fetchrow(self, sql, *args):
            return {"resume_state": {"status": "active", "phase": "intake"}}

        async def execute(self, sql, *args):
            raise AssertionError("active flow must ask before reset")

    result = await tool.run(ToolContext(
        user_id="user-1",
        company_id=None,
        conversation_id="conv-1",
        job_id="job-1",
        tool_call_id="call-1",
        db=DB(),
        core=CoreClient("http://core.test", "secret"),
    ), tool.args_model.model_validate({}))
    assert result["choice"]["options"][-1] == {"id": "cancel", "label": "그만하기"}
