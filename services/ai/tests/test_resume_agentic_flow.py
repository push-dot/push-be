from __future__ import annotations

import contextlib
import json

import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from app.harness.kstyle import stats
from app.harness.personal.resume.graph import build_resume_graph
from tests.fakes import data_json
from tests.test_harness_resume import _base, _config


@pytest.fixture(autouse=True)
def _flat_fit(monkeypatch):
    async def fake(*_args, **_kwargs):
        return {"fitScore": 5.0, "parts": {}, "topGap": "도메인", "plan": "FREE"}

    monkeypatch.setattr("app.framework.fit_judge.judge_fit", fake)


class _Files:
    """workspace_files kept in memory and read back, so 00_notes.json round-trips."""

    def __init__(self, files=None):
        self.files = dict(files or {})
        self.rows = {}

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        if "workspace_files" in sql:
            body = self.files.get(args[1])
            return None if body is None else {"body": body}
        return self.rows.get(str(args[0]))

    async def fetch(self, sql, *args):
        return []

    async def execute(self, sql, *args):
        if "workspace_files" in sql:
            self.files[args[1]] = args[2]
            return "INSERT 1"
        self.rows[str(args[0])] = {"id": args[0]}
        return "INSERT 1"


def _phase_of(messages) -> str:
    for message in reversed(messages):
        if message.type == "human":
            try:
                return str(data_json(message.content).get("phase") or "")
            except (ValueError, AttributeError):
                continue
    return ""


# The first line of each reviewer stance names who they are; the fake answers by role.
_REVIEW_ROLES = {"거르는 사람": "review_reader", "면접관": "review_interviewer", "편집자": "review_editor"}


class _FlowModel:
    """One JSON answer per phase; analyze may first raise a question through the note tool."""

    def __init__(self, outputs=None, ask_once=False, reviews=None):
        self.outputs = outputs or {}
        self.ask_once = ask_once
        self.reviews = reviews or {}
        self.calls: list[str] = []
        self.feedback: list = []
        self.payloads: list[dict] = []
        self.last: dict[str, list] = {}
        self.turn = {"input_tokens": 0}
        self.tokens_per_call = 0
        self.tier = "main"

    def spend(self):
        """What GateModel._add_usage does with one reply's usage."""
        self.turn["input_tokens"] += self.tokens_per_call
        stats.record(self.turn, self.tier, self.tokens_per_call, 0)

    def bind_tools(self, tools, **kwargs):
        return self

    async def ainvoke(self, messages, **kwargs):
        system = next((str(message.content) for message in messages if message.type == "system"), "")
        reviewer = next((role for role in _REVIEW_ROLES if role in system.split("\n", 1)[0]), None)
        if reviewer is not None:
            self.calls.append(_REVIEW_ROLES[reviewer])
            return AIMessage(content=json.dumps(self.reviews.get(_REVIEW_ROLES[reviewer]) or {"objections": []}))
        phase = _phase_of(messages)
        self.calls.append(phase)
        self.last[phase] = list(messages)
        self.spend()
        for message in messages:
            if message.type == "human":
                with contextlib.suppress(ValueError, AttributeError):
                    self.payloads.append(data_json(message.content))
        if phase == "craft":
            for message in messages:
                if message.type == "human":
                    with contextlib.suppress(ValueError, AttributeError):
                        self.feedback.append(data_json(message.content).get("verify_feedback"))
        if phase == "analyze" and self.ask_once and messages[-1].type == "human":
            self.ask_once = False
            return AIMessage(content="", tool_calls=[{
                "name": "note", "id": "n1", "type": "tool_call",
                "args": {"kind": "ask", "claim": "어느 직무에 지원하나요?", "quote": "백엔드|웹"},
            }])
        output = self.outputs.get(phase)
        if callable(output):
            output = output()
        return AIMessage(content=json.dumps(output or {"summary": phase}))


async def _run(graph, payload, config):
    events = []
    async for mode, chunk in graph.astream(payload, config, stream_mode=["custom", "values"]):
        if mode == "custom" and isinstance(chunk, dict):
            events.append(chunk)
    return await graph.aget_state(config), events


def _waiting(snap) -> str | None:
    for task in snap.tasks:
        for item in getattr(task, "interrupts", ()) or ():
            if isinstance(item.value, dict):
                return item.value.get("gate")
    return None


_ANALYSIS = {"message": "분석했어요", "jobs": {"company": "예시랩", "required": ["React"], "preferred": [],
                                             "keywords": ["React"]}}


async def _until_stop(graph, payload, config):
    """The outer harness re-enters the flow after every step that ends with goto end."""
    snap, events = await _run(graph, payload, config)
    for _ in range(30):
        if _waiting(snap) or snap.values.get("status") != "active":
            break
        snap, more = await _run(graph, dict(snap.values), config)
        events += more
    return snap, events


async def test_auto_stops_only_at_strategy_and_review_after_analyze():
    db = _Files()
    model = _FlowModel({"analyze": _ANALYSIS, "craft": {"markdown": "# 이력서\nReact 개발"}})
    graph = build_resume_graph(MemorySaver(), model=model, db=db)
    config = _config()
    stops = []
    snap, events = await _until_stop(graph, _base(
        phase="analyze", access_mode="AUTO",
        inputs={"pages": {"https://jobs.example/1": "React 개발자 공고"}}), config)
    while _waiting(snap):
        stops.append(_waiting(snap))
        answer = {"option_id": "submit", "option_ids": ["submit", "CLASSIC"]} \
            if _waiting(snap) == "review" else {"option_id": "continue"}
        snap, more = await _until_stop(graph, Command(resume=answer), config)
        events += more
    assert stops == ["strategy", "review"]
    auto = [event.get("gate") for event in events if event.get("type") == "choice" and event.get("auto")]
    assert "analyze" in auto


async def test_always_ask_still_stops_at_the_analyze_gate():
    graph = build_resume_graph(MemorySaver(), model=_FlowModel({"analyze": _ANALYSIS}), db=_Files())
    snap, _events = await _until_stop(graph, _base(
        phase="analyze", access_mode="ALWAYS_ASK",
        inputs={"pages": {"https://jobs.example/1": "React 개발자 공고"}}), _config())
    assert _waiting(snap) == "analyze"


async def test_a_blocked_question_becomes_an_ask_gate_and_its_answer_steers_analyze():
    model = _FlowModel({"analyze": _ANALYSIS}, ask_once=True)
    graph = build_resume_graph(MemorySaver(), model=model, db=_Files())
    config = _config()
    snap, events = await _until_stop(graph, _base(
        phase="analyze", access_mode="AUTO",
        inputs={"pages": {"https://jobs.example/1": "React 개발자 공고"}}), config)
    assert _waiting(snap) == "ask"
    card = next(event for event in events if event.get("gate") == "ask" and event.get("type") == "choice")
    assert card["title"] == "어느 직무에 지원하나요?"
    assert [item["label"] for item in card["options"]] == ["백엔드", "웹", "닫기"]
    snap, _events = await _until_stop(graph, Command(resume={"option_id": "o1"}), config)
    assert snap.values["inputs"]["steer"] == ["어느 직무에 지원하나요? → 백엔드"]
    assert "ask" not in (snap.values.get("analysis") or {})
    assert _waiting(snap) == "strategy"
    assert model.calls.count("analyze") >= 3


def _ledger(count):
    evidence = [{"id": f"E{index}", "kind": "repo", "source": f"acme-labs/shop-api:f{index}.py",
                 "quote": f"q{index}", "claim": f"주문 기능 {index}", "verified": True}
                for index in range(1, count + 1)]
    return json.dumps({"evidence": evidence, "assumptions": [], "read": [], "steer": [], "ask": None})


async def test_craft_reruns_once_when_the_draft_makes_up_a_number():
    drafts = [
        {"markdown": "# 이력서\n응답 시간 70% 단축", "used_evidence": ["E1"]},
        {"markdown": "# 이력서\n응답 시간 단축", "used_evidence": ["E1"]},
    ]
    model = _FlowModel({"craft": lambda: drafts.pop(0) if len(drafts) > 1 else drafts[0]})
    db = _Files({"00_notes.json": _ledger(3)})
    graph = build_resume_graph(MemorySaver(), model=model, db=db)
    await _until_stop(graph, _base(phase="craft", access_mode="AUTO", user_id="user-1",
                                    inputs={"pages": {"https://jobs.example/1": "React"}}), _config())
    with_feedback = [item for item in model.feedback if item]
    assert len(with_feedback) == 1
    assert with_feedback[0][0]["rule"] == "unsupported_number"


async def test_a_draft_that_still_fails_says_what_to_check():
    model = _FlowModel({"craft": {"markdown": "# 이력서\n매출 3배 성장", "used_evidence": ["E9"]}})
    db = _Files({"00_notes.json": _ledger(3)})
    graph = build_resume_graph(MemorySaver(), model=model, db=db)
    _snap, events = await _until_stop(graph, _base(phase="craft", access_mode="AUTO", user_id="user-1",
                                                    inputs={"pages": {"https://jobs.example/1": "React"}}), _config())
    # Craft v1 and the boost redraft are each checked and redone once.
    assert len([item for item in model.feedback if item]) == 2
    assert any("확인이 필요한 점" in str(event.get("token") or "") for event in events)


def _plan(monkeypatch, plan):
    async def read_plan(*_args, **_kwargs):
        return plan

    monkeypatch.setattr("app.infrastructure.posting_fit_cache.read_plan", read_plan)


_STRATEGY = {"message": "전략을 세웠어요", "sections": [
    {"section": "경력", "action": "expand", "reason": "공고와 맞아요", "suggested_keywords": ["React"]},
    {"section": "자격증", "action": "condense", "reason": "공고와 멀어요"}]}
_REDONE = {"message": "다시 세웠어요", "sections": [
    {"section": "경력", "action": "expand", "reason": "확인된 근거만 강조해요"}]}


async def _strategy_run(model):
    graph = build_resume_graph(MemorySaver(), model=model, db=_Files({"00_notes.json": _ledger(2)}))
    return await _until_stop(graph, _base(phase="strategy", access_mode="AUTO", analysis=_ANALYSIS,
                                          inputs={"pages": {"https://jobs.example/1": "React"}}), _config())


async def test_objections_trigger_exactly_one_strategy_redo(monkeypatch):
    _plan(monkeypatch, "PRO")
    outputs = [_STRATEGY, _REDONE]
    model = _FlowModel({"strategy": lambda: outputs.pop(0)},
                       reviews={"review_reader": {"objections": [{"target": "s2", "objection": "읽기를 멈춰요"},
                                                                  {"target": "s9", "objection": "없는 항목"}]}})
    snap, events = await _strategy_run(model)
    assert _waiting(snap) == "strategy"
    assert model.calls.count("strategy") == 2
    # PRO runs two of the three stances, together.
    assert sorted(call for call in model.calls if call.startswith("review_")) == ["review_interviewer",
                                                                                   "review_reader"]
    redo = [payload for payload in model.payloads if payload.get("review_objections")]
    assert len(redo) == 1
    assert redo[0]["review_objections"] == [{"by": "review_reader", "target": "s2", "objection": "읽기를 멈춰요"}]
    assert [item["section"] for item in snap.values["strategy"]["sections"]] == ["경력"]
    assert any(event.get("name") == "review_reader" and event.get("state") == "ok" for event in events)


async def test_an_invalid_redo_keeps_the_first_strategy(monkeypatch):
    _plan(monkeypatch, "ULTRA")
    outputs = [_STRATEGY, {"message": "x", "sections": []}]
    model = _FlowModel({"strategy": lambda: outputs.pop(0)},
                       reviews={"review_editor": {"objections": [{"target": "s1", "objection": "길어요"}]}})
    snap, _events = await _strategy_run(model)
    assert model.calls.count("strategy") == 2
    assert len([call for call in model.calls if call.startswith("review_")]) == 3
    assert [item["section"] for item in snap.values["strategy"]["sections"]] == ["경력", "자격증"]


async def test_free_runs_no_reviewers(monkeypatch):
    _plan(monkeypatch, "FREE")
    model = _FlowModel({"strategy": _STRATEGY},
                       reviews={"review_reader": {"objections": [{"target": "s1", "objection": "x"}]}})
    snap, _events = await _strategy_run(model)
    assert _waiting(snap) == "strategy"
    assert model.calls.count("strategy") == 1
    assert not [call for call in model.calls if call.startswith("review_")]


async def test_no_objections_means_no_redo(monkeypatch):
    _plan(monkeypatch, "PRO")
    model = _FlowModel({"strategy": _STRATEGY})
    await _strategy_run(model)
    assert model.calls.count("strategy") == 1


async def test_the_present_reply_has_the_four_part_shape_with_leftovers(monkeypatch):
    _plan(monkeypatch, "PRO")
    notes = json.loads(_ledger(1))
    notes["assumptions"] = ["경력 기간은 서류에 적힌 대로 썼어요"]
    db = _Files({"00_notes.json": json.dumps(notes)})
    graph = build_resume_graph(MemorySaver(), model=_FlowModel({"present": {"message": "끝났어요"}}), db=db)
    drafts = {"markdown": "# 이력서\nReact 개발", "verify_left": [
        {"level": "P0", "rule": "unsupported_number", "detail": "70%"}]}
    snap, events = await _until_stop(graph, _base(
        phase="present", access_mode="AUTO", drafts=drafts, analysis={"stage_late": ["company"]},
        inputs={"pages": {"https://jobs.example/1": "React"}}), _config())
    reply = snap.values["reply"]
    heads = [line for line in reply.split("\n") if line and not line.startswith("• ")]
    assert heads == ["만든 것", "대신 정한 것", "확인이 필요한 점", "다음"]
    assert "• 경력 기간은 서류에 적힌 대로 썼어요" in reply
    assert "• 출처를 찾지 못한 숫자가 있어요: 70%" in reply
    assert "• 회사 조사: 시간 안에 끝나지 않아 빼고 진행했어요" in reply
    assert "끝났어요" not in reply
    assert any(event.get("token") == reply for event in events)
    # The result card is unchanged.
    assert any(event.get("type") == "result" for event in events)


class _Sources(_Files):
    """Also answers the attachment reader: career_evidence rows by id."""

    def __init__(self, files=None, evidence=None):
        super().__init__(files)
        self.evidence = dict(evidence or {})

    async def fetchrow(self, sql, *args):
        if "career_evidence" in sql:
            text = self.evidence.get(str(args[0]))
            return None if text is None else {"title": "포트폴리오", "source_text": text}
        return await super().fetchrow(sql, *args)


_USER = "6f1e2c3a-1b2d-4e5f-8a9b-0c1d2e3f4a5b"
_PAGE = {"https://jobs.example.com/1": "주문 API 백엔드 개발자 모집"}
_SUBMIT = {"option_id": "submit", "option_ids": ["submit"]}


def _start(phase, **state):
    return _base(**{"phase": phase, "access_mode": "AUTO", "user_id": _USER,
                    "inputs": {"pages": _PAGE}, **state})


async def _to_review(model, db, **state):
    graph = build_resume_graph(MemorySaver(), model=model, db=db)
    config = _config()
    snap, events = await _until_stop(graph, _start("craft", **state), config)
    return graph, config, snap, events


def _left(snap) -> list[dict]:
    return snap.values["drafts"]["verify_left"]


def _draft(text, *used, **extra):
    return {"markdown": f"# 이력서\n{text}", "used_evidence": list(used), **extra}


async def test_a_boost_redraft_that_makes_up_a_number_is_redone_or_reported():
    drafts = [_draft("주문 API 개발", "E1"), _draft("주문 API 개발로 매출 300% 증가", "E1")]
    model = _FlowModel({"craft": lambda: drafts.pop(0) if len(drafts) > 1 else drafts[0]})
    graph, config, snap, _events = await _to_review(model, _Files({"00_notes.json": _ledger(1)}))
    assert _waiting(snap) == "review"
    assert int(snap.values["draft_version"]) >= 2
    assert [item["detail"] for item in _left(snap)] == ["300%"]
    snap, _events = await _until_stop(graph, Command(resume=_SUBMIT), config)
    assert "출처를 찾지 못한 숫자가 있어요: 300%" in snap.values["reply"]


async def test_a_number_in_the_second_target_is_checked_too():
    letter = {"cover_letter": "전환율 45% 개선을 이끌었습니다."}
    model = _FlowModel({"craft": _draft("주문 API 개발", documents=letter)})
    *_rest, snap, _events = await _to_review(model, _Files({"00_notes.json": _ledger(1)}),
                                             output_targets=["resume", "cover_letter"])
    found = [(item["rule"], item["detail"]) for item in _left(snap)]
    assert found == [("unsupported_number", "45%")]
    assert next(item for item in model.feedback if item)[0]["detail"] == "45%"


async def test_a_fact_from_an_attachment_beside_the_chosen_document_is_not_made_up():
    attachment = "c0ffee00-0000-4000-8000-000000000001"
    model = _FlowModel({"craft": _draft("주문 처리량 3배 개선")})
    db = _Sources({"00_notes.json": _ledger(1)}, {attachment: "주문 서버를 고쳐 처리량 3배"})
    inputs = {"pages": _PAGE, "document": "# 이력서\n백엔드 개발 경력", "documentId": attachment,
              "attachments": [attachment]}
    *_rest, snap, _events = await _to_review(model, db, inputs=inputs)
    assert not [item for item in model.feedback if item]
    assert _left(snap) == []


async def test_publish_with_an_unsupported_metric_is_redone_and_then_reported():
    model = _FlowModel({"publish": _draft("주문 API 개발로 매출 70% 증가")})
    graph = build_resume_graph(MemorySaver(), model=model, db=_Files({"00_notes.json": _ledger(1)}))
    snap, _events = await _until_stop(graph, _start(
        "publish", drafts={"markdown": "# 이력서\n주문 API 개발", "verify_left": []}), _config())
    redo = [payload for payload in model.payloads
            if payload.get("phase") == "publish" and payload.get("verify_feedback")]
    assert len(redo) == 1
    assert "출처를 찾지 못한 숫자가 있어요: 70%" in snap.values["reply"]


async def test_a_fact_check_that_cannot_run_is_said_not_hidden(monkeypatch):
    from app.harness.personal.resume import graph as resume_graph

    async def broken(*_args, **_kwargs):
        raise ValueError("fact check answer unreadable")

    monkeypatch.setattr(resume_graph, "light_model", lambda chat: chat)
    monkeypatch.setattr(resume_graph, "fact_check_agent", broken)
    model = _FlowModel({"craft": _draft("주문 API 개발", "E1")})
    *_rest, snap, events = await _to_review(model, _Files({"00_notes.json": _ledger(1)}))
    assert not [item for item in model.feedback if item]
    tokens = [str(event.get("token") or "") for event in events]
    assert any("사실 대조를 끝내지 못했어요" in token for token in tokens)
    assert [item["rule"] for item in _left(snap)] == ["fact_unchecked"]


async def test_auto_answers_a_feedback_only_request_by_keeping_the_document():
    model = _FlowModel({"craft": _draft("새 초안")})
    db = _Files()
    graph = build_resume_graph(MemorySaver(), model=model, db=db)
    analysis = {**_ANALYSIS, "scenario": "B", "improvements": ["주문 API 성과를 숫자로 적어요"]}
    snap, events = await _until_stop(graph, _start("feedback", analysis=analysis), _config())
    assert "craft" not in model.calls
    assert not [name for name in db.files if name.startswith("03_draft_")]
    assert snap.values["status"] == "done"
    auto = next(event for event in events if event.get("gate") == "feedback" and event.get("auto"))
    assert auto["recommended"] == "keep"


async def test_present_without_a_document_service_does_not_claim_a_save():
    graph = build_resume_graph(MemorySaver(), model=_FlowModel(), db=_Files())
    snap, _events = await _until_stop(graph, _start("present", drafts=_draft("주문 API 개발")),
                                      _config())
    assert "Push 프로필에 저장" not in snap.values["reply"]
    assert "저장하지 못했어요" in snap.values["reply"]


async def test_bypass_logs_the_named_section_the_plan_cut(monkeypatch):
    _plan(monkeypatch, "FREE")
    db = _Files({"00_notes.json": _ledger(1)})
    graph = build_resume_graph(MemorySaver(), model=_FlowModel({"strategy": _STRATEGY}), db=db)
    inputs = {"pages": _PAGE, "steer": ["자격증도 꼭 넣어 주세요"]}
    await _until_stop(graph, _start("strategy", access_mode="BYPASS", analysis=_ANALYSIS,
                                    inputs=inputs), _config())
    assumptions = json.loads(db.files["00_notes.json"])["assumptions"]
    assert "말씀하신 항목을 줄이거나 뺐어요: 자격증" in assumptions


def _first_analyze_call(model, reply):
    """The first analyze step answers `reply`; the rest go to the model as usual."""
    real, pending = model.ainvoke, [reply]

    async def ainvoke(messages, **kwargs):
        if _phase_of(messages) == "analyze" and messages[-1].type == "human" and pending:
            model.calls.append("analyze")
            model.spend()
            return pending.pop()
        return await real(messages, **kwargs)

    model.ainvoke = ainvoke


def _tool_call(name, args):
    return AIMessage(content="", tool_calls=[{"name": name, "id": "t1", "type": "tool_call",
                                              "args": args}])


@pytest.mark.parametrize(("tier", "stopped"), [("main", True), ("light", False)])
async def test_explore_stops_on_its_own_input_token_budget(monkeypatch, tier, stopped):
    from app.harness.personal.resume import explore

    _plan(monkeypatch, "FREE")
    model = _FlowModel({"analyze": _ANALYSIS})
    # Tokens spent before explore started are not its own.
    stats.record(model.turn, "main", 5_000_000, 0)
    model.turn["input_tokens"] = 5_000_000
    model.tokens_per_call = 100_000
    # Subagents on the light tier share the turn's counter; only the explore loop's own reads count.
    model.tier = tier
    _first_analyze_call(model, _tool_call("note", {"kind": "assumption", "claim": "백엔드 직무"}))
    graph = build_resume_graph(MemorySaver(), model=model, db=_Files())
    await _until_stop(graph, _start("analyze"), _config())
    assert (model.last["analyze"][-1].content == explore._FINAL) is stopped
    assert model.calls.count("analyze") == 2


async def test_a_github_agent_repo_with_a_query_is_refused_before_any_request(monkeypatch):
    from app.harness.personal.resume import graph as resume_graph

    called = []

    async def agent(*args, **kwargs):
        called.append(args)
        return {}

    monkeypatch.setattr(resume_graph, "github_agent", agent)
    model = _FlowModel({"analyze": _ANALYSIS})
    _first_analyze_call(model, _tool_call("github_agent", {"repo": "me/x?y=1"}))
    graph = build_resume_graph(MemorySaver(), model=model, db=_Files())
    await _until_stop(graph, _start("analyze"), _config())
    results = [data_json(message.content) for message in model.last["analyze"]
               if message.type == "tool"]
    assert results == [{"error": "INVALID_REPO"}]
    assert called == []


@pytest.mark.parametrize(("links", "logins"), [
    (["https://github.com/acme-labs/shop-api"], []),
    (["https://github.com/acme-labs/shop-api", "https://github.com/example-user"],
     ["example-user"]),
])
async def test_only_an_account_link_names_the_users_github_login(monkeypatch, links, logins):
    from app.harness.personal.resume import graph as resume_graph

    seen = []

    async def agent(*args, **kwargs):
        seen.append(kwargs["logins"])
        return {"error": "GITHUB_UNAVAILABLE"}

    monkeypatch.setattr(resume_graph, "github_agent", agent)
    model = _FlowModel({"analyze": _ANALYSIS})
    _first_analyze_call(model, _tool_call("github_agent", {"repo": "acme-labs/shop-api"}))
    graph = build_resume_graph(MemorySaver(), model=model, db=_Files())
    await _until_stop(graph, _start("analyze", inputs={"pages": _PAGE, "github": links}), _config())
    assert seen == [logins]
