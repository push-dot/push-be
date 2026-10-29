from __future__ import annotations

import json

from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from app.graphs.resume_prompt import phase_prompt_for_harness
from app.harness.registry import REGISTRY
from app.harness.personal.resume.graph import build_resume_graph
from app.harness.router import select_harness
from app.harness.tools import ToolContext
from app.harness.core_client import CoreClient

_ORDER = (
    "mode_select", "output_targets", "tone", "intake",
    "analyze", "strategy", "craft", "review", "publish", "present",
)


class _Approvals:
    def __init__(self):
        self.rows = {}
        self.files = {}

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        return self.rows.get(str(args[0]))

    async def execute(self, sql, *args):
        if "workspace_files" in sql:
            self.files[args[1]] = args[2]
            return "INSERT 1"
        self.rows[str(args[0])] = {"id": args[0]}
        return "INSERT 1"


class _PhaseModel:
    def __init__(self, outputs=None):
        self.outputs = outputs or {}
        self.calls = []

    async def ainvoke(self, messages, **kwargs):
        phase = json.loads(messages[-1].content)["phase"]
        self.calls.append(phase)
        return AIMessage(content=json.dumps(self.outputs.get(phase) or {"summary": phase}))


def _graph(db, poster=None, model=None):
    return build_resume_graph(MemorySaver(), model=model or _PhaseModel(), db=db)


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
    for _ in range(24):
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


_VOICE = "합니다체. 담백한 1인칭 설명형. 주어를 반복하지 않는다."


def test_craft_prompt_includes_writing_voice():
    assert _VOICE in phase_prompt_for_harness("craft")


def test_analyze_prompt_excludes_writing_voice():
    assert _VOICE not in phase_prompt_for_harness("analyze")


def test_blueprint_prompt_includes_experience_blueprints():
    text = phase_prompt_for_harness("blueprints")
    assert "최소 2개의 질문" in text
    assert "최소 2개의 질문" not in phase_prompt_for_harness("strategy")


def test_phase_nodes_cover_p0_through_p6():
    graph = _graph(_Approvals())
    names = set(graph.nodes)
    assert {
        "p0_mode", "g0", "p0i_intake", "g_output_targets", "g_tone", "g_intake",
        "p1_analyze", "g1", "p2_strategy", "g2", "p3_craft", "g3", "p3c_boost",
        "p4a_review", "g4a", "p5_publish", "g5", "p6_present", "g6",
    } <= names


async def test_two_targets_produce_two_finals_and_two_pdfs():
    db = _Approvals()
    graph = _graph(db, model=_PhaseModel({"publish": {"markdown": "# 서류"}}))
    config = _config()
    await _run(graph, _base(phase="publish", output_targets=["resume", "portfolio"]), config)
    snap = await graph.aget_state(config)
    assert "05_final_resume.md" in snap.values["artifacts"]
    assert "05_final_portfolio.md" in snap.values["artifacts"]
    assert "05_final_resume.pdf" in db.files
    assert "05_final_portfolio.pdf" in db.files


async def test_output_targets_gate_keeps_option_ids():
    graph = _graph(_Approvals())
    config = _config()
    await _run(graph, _base(), config)
    await _run(graph, Command(resume={"option_id": "resume_based"}), config)
    await _run(graph, {}, config)
    await _run(graph, Command(resume={"option_ids": ["portfolio", "resume"]}), config)
    snap = await graph.aget_state(config)
    assert snap.values["output_targets"] == ["portfolio", "resume"]


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


async def test_resuming_a_gate_does_not_rerun_the_phase_model():
    model = _PhaseModel()
    graph = _graph(_Approvals(), model=model)
    config = _config()
    await _run(graph, _base(), config)
    await _run(graph, Command(resume={"option_id": "resume_based"}), config)
    snap = await graph.aget_state(config)
    assert model.calls == ["mode_select"]
    assert snap.values["phase"] == "intake"


async def test_phase_output_is_saved_to_workspace_files():
    db = _Approvals()
    graph = _graph(db, model=_PhaseModel({"analyze": {"name": "김"}}))
    config = _config()
    await _run(graph, _base(phase="analyze"), config)
    snap = await graph.aget_state(config)
    file_id = snap.values["artifacts"]["01_parsed_resume.json"]
    assert db.files["01_parsed_resume.json"]
    assert len(file_id) == 36


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
    choices = [event for event in events if event.get("type") == "choice"]
    assert choices[0]["gate"] == "mode_select"
    assert "auto" not in choices[0]
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
    choices = [event for event in events if event.get("type") == "choice"]
    assert choices[0]["gate"] == "intake"
    assert "auto" not in choices[0]


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
        def __init__(self):
            self.wrote = []

        def q(self):
            return self

        async def fetchrow(self, sql, *args):
            return {"resume_state": {"status": "active", "phase": "intake"}}

        async def execute(self, sql, *args):
            if "resume_state" in sql:
                raise AssertionError("active flow must ask before reset")
            self.wrote.append(sql)

    db = DB()
    result = await tool.run(ToolContext(
        user_id="user-1",
        company_id=None,
        conversation_id="conv-1",
        job_id="job-1",
        tool_call_id="call-1",
        db=db,
        core=CoreClient("http://core.test", "secret"),
    ), tool.args_model.model_validate({}))
    assert result["choice"]["options"][-1] == {"id": "cancel", "label": "그만하기"}
    assert any("INSERT INTO approvals" in sql for sql in db.wrote)


_GATE_QUESTIONS = {
    "mode_select": "어떤 방식으로 진행할까요?",
    "output_targets": "어떤 산출물을 만들까요?",
    "tone": "어떤 말투로 쓸까요?",
    "intake": "입력한 자료를 확인했어요. 분석을 시작할까요?",
    "analyze": "이 공고에 맞춰 고칠까요?",
    "strategy": "이 전략대로 초안을 쓸까요?",
    "craft": "첫 번째 초안(v1)이에요. 이대로 검토할까요?",
    "review": "검증을 마쳤어요. 어떤 디자인을 적용할까요?",
    "publish": "디자인을 적용했어요. PDF로 만들까요?",
    "present": "PDF를 만들었어요. 결과를 확인할까요?",
}


async def test_gate_title_is_the_question():
    graph = _graph(_Approvals())
    seen = await _drive(graph, _config(), _base())
    titles = {
        event["gate"]: event["title"]
        for events, snap in seen
        for event in events
        if event.get("type") == "choice" and snap.next
    }
    assert titles == _GATE_QUESTIONS


async def _until_done(graph, config, payload):
    gates = []
    titles = {}
    for _ in range(16):
        events = []
        async for mode, chunk in graph.astream(payload, config, stream_mode=["custom", "values"]):
            if mode == "custom" and isinstance(chunk, dict):
                events.append(chunk)
        snap = await graph.aget_state(config)
        if snap.next:
            choice = next(event for event in events if event.get("type") == "choice")
            gates.append(choice["gate"])
            titles[choice["gate"]] = choice["title"]
            payload = Command(resume={"option_id": choice["recommended"]})
            continue
        if snap.values.get("status") == "done":
            return gates, titles, snap
        payload = {}
    snap = await graph.aget_state(config)
    return gates, titles, snap


async def test_scenario_e_ends_after_fit_report():
    db = _Approvals()
    graph = _graph(db, model=_PhaseModel({"analyze": {"scenario": "E", "fit": {"score": 3}}}))
    config = _config()
    gates, _titles, snap = await _until_done(graph, config, _base(phase="analyze"))
    assert gates == ["analyze", "present"]
    assert snap.values["status"] == "done"
    assert snap.values["scenario"] == "E"
    assert "02_fit_score.json" in snap.values["artifacts"]
    for name in ("01_parsed_resume.json", "01_github_findings.json", "01_job_analyses.json"):
        assert name in snap.values["artifacts"]
        assert name in db.files


async def test_scenario_c_goes_to_design():
    model = _PhaseModel()
    graph = _graph(_Approvals(), model=model)
    config = _config()
    gates, titles, snap = await _until_done(graph, config, _base(phase="analyze", scenario="C"))
    assert "strategy" not in gates
    assert "craft" not in gates
    assert titles["review"] == "검증을 마쳤어요. 어떤 디자인을 적용할까요?"
    assert "review" not in model.calls
    assert "p4b_design" in graph.nodes
    assert snap.values["status"] == "done"


async def test_scenario_b_asks_before_craft():
    graph = _graph(_Approvals(), model=_PhaseModel({"analyze": {"scenario": "B"}}))
    gates, titles, _snap = await _until_done(graph, _config(), _base(phase="analyze"))
    assert "strategy" not in gates
    assert titles["feedback"] == "피드백을 반영해서 수정할까요?"
    assert "craft" in gates


async def test_scenarios_d_and_f_go_straight_to_craft():
    for scenario in ("D", "F"):
        graph = _graph(_Approvals(), model=_PhaseModel({"analyze": {"scenario": scenario}}))
        gates, _titles, _snap = await _until_done(graph, _config(), _base(phase="analyze"))
        assert "strategy" not in gates
        assert "feedback" not in gates
        assert "craft" in gates


class _PromptModel(_PhaseModel):
    def __init__(self, outputs=None):
        super().__init__(outputs)
        self.systems = []

    async def ainvoke(self, messages, **kwargs):
        first = messages[0].content if messages else ""
        self.systems.append(first if isinstance(first, str) else str(first))
        return await super().ainvoke(messages, **kwargs)


async def _blueprint(graph, config, payload, stop, answers=None):
    answers = answers or {}
    gates = []
    titles = {}
    choices = {}
    for _ in range(12):
        events = []
        async for mode, chunk in graph.astream(
            payload, config, stream_mode=["custom", "values"]):
            if mode == "custom" and isinstance(chunk, dict):
                events.append(chunk)
        snap = await graph.aget_state(config)
        if stop(snap):
            return gates, titles, choices, snap
        if snap.values.get("status") == "done":
            return gates, titles, choices, snap
        if snap.next:
            choice = next(event for event in events if event.get("type") == "choice")
            gates.append(choice["gate"])
            titles[choice["gate"]] = choice["title"]
            choices[choice["gate"]] = choice
            resume = answers.get(choice["gate"])
            if resume is None and choice["gate"] == "prevention":
                resume = {"option_ids": ["performance", "security"]}
            if resume is None:
                resume = {"option_id": choice["recommended"]}
            payload = Command(resume=resume)
            continue
        payload = {}
    snap = await graph.aget_state(config)
    return gates, titles, choices, snap


async def test_blueprint_mode_never_enters_craft():
    model = _PromptModel({
        "validate": {"valid": True},
        "blueprints": {"projects": [{"id": "01"}]},
    })
    graph = _graph(_Approvals(), model=model)
    config = _config()
    gates, titles, choices, snap = await _blueprint(
        graph, config, _base(phase="analyze", work_mode="experience_blueprint"),
        lambda _snap: False,
    )
    assert "craft" not in gates
    assert "strategy" not in gates
    assert "craft" not in model.calls
    assert titles["projects"] == "어떤 프로젝트를 구현할까요?"
    assert choices["prevention"]["multiple"] is True
    assert snap.values["approach"] == "prevention"
    assert snap.values["prevention_categories"] == ["performance", "security"]
    assert "06_experience_blueprints.json" in snap.values["artifacts"]
    assert any("최소 2개의 질문" in text for text in model.systems)
    assert snap.values["status"] == "done"
    for name in ("p2x_approach", "p2x_validate", "p2x_blueprints"):
        assert name in graph.nodes


async def test_failed_validation_returns_to_approach():
    model = _PhaseModel({"validate": {"valid": False}})
    graph = _graph(_Approvals(), model=model)
    _gates, _titles, _choices, snap = await _blueprint(
        graph, _config(), _base(phase="analyze", work_mode="experience_blueprint"),
        lambda _snap: "validate" in model.calls and not _snap.next,
        {"approach": {"option_id": "bottleneck"}, "level": {"option_id": "L2"}},
    )
    assert snap.values["phase"] == "approach"
    assert snap.values["status"] == "active"
    assert snap.values["approach"] == "bottleneck"
    assert snap.values["bottleneck_level"] == "L2"
    assert model.calls.count("validate") == 1
    assert "blueprints" not in model.calls
    assert "craft" not in model.calls
