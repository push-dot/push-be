from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import UUID, uuid4

from langgraph.types import Command

from app.graphs.resume_prompt import phase_prompt_for_harness
from app.harness.graph import quick_start_resume
from app.harness.personal.resume.drafts import drafts_from_chosen
from app.harness.runtime import HarnessRuntime
from tests.harness_fakes import CONV, Rows, run, service
from tests.test_harness_resume import (
    _Approvals, _PhaseModel, _base, _config, _drive, _graph, _run,
)

_DOC = "11111111-1111-4111-8111-111111111111"
_SAVING = "Push 프로필에 저장하는 중…"
_NOTE = "PDF는 Push 프로필에서 내보낼 수 있어요."
_PRESENT = "Push 프로필에 저장했어요. 결과를 확인할까요?"


def _flat(monkeypatch):
    seen: list[str] = []

    async def fake(*args, **_kwargs):
        seen.append(args[3] if len(args) > 3 else "")
        return {"fitScore": 5.0, "parts": {}, "topGap": "도메인", "plan": "FREE"}

    monkeypatch.setattr("app.framework.fit_judge.judge_fit", fake)
    return seen


async def _events(graph, payload, config):
    found = []
    async for mode, chunk in graph.astream(payload, config, stream_mode=["custom", "values"]):
        if mode == "custom" and isinstance(chunk, dict):
            found.append(chunk)
    return found


def _choice(events):
    for event in events:
        if event.get("type") == "choice":
            return event
    raise AssertionError(events)


async def _reach_intake():
    graph = _graph(_Approvals())
    config = _config()
    payload = _base()
    first = None
    for _ in range(8):
        events = await _events(graph, payload, config)
        snap = await graph.aget_state(config)
        choice = next((event for event in events if event.get("type") == "choice"), None)
        if choice is not None and snap.next:
            if first is None:
                first = choice
            if choice["gate"] == "intake":
                return graph, config, choice, first
            payload = Command(resume={"option_id": choice["recommended"]})
            continue
        payload = {}
    raise AssertionError("intake")


async def test_intake_options_are_the_three_sentences():
    _graph_obj, _config_obj, choice, mode = await _reach_intake()
    assert choice["title"] == "입력한 자료를 확인했어요. 분석을 시작할까요?"
    assert choice["options"] == [
        {"id": "ready", "label": "네, 시작해 주세요"},
        {"id": "change", "label": "자료를 바꿀래요"},
        {"id": "cancel", "label": "그만할게요"},
    ]
    assert choice["recommended"] == "ready"
    assert mode["options"][-1] == {"id": "cancel", "label": "그만하기"}


async def test_intake_ready_starts_analyze():
    graph, config, _choice_event, _mode = await _reach_intake()
    await _events(graph, Command(resume={"option_id": "ready"}), config)
    choice = _choice(await _events(graph, {}, config))
    assert choice["gate"] == "analyze"


async def test_intake_change_reopens_intake():
    graph, config, _choice_event, _mode = await _reach_intake()
    await _events(graph, Command(resume={"option_id": "change"}), config)
    choice = _choice(await _events(graph, {}, config))
    snap = await graph.aget_state(config)
    assert choice["gate"] == "intake"
    assert choice["options"][1]["label"] == "자료를 바꿀래요"
    assert snap.values["status"] == "active"
    assert snap.values.get("scenario") != "C"
    assert snap.next


async def test_intake_cancel_stops():
    graph, config, _choice_event, _mode = await _reach_intake()
    await _events(graph, Command(resume={"option_id": "cancel"}), config)
    snap = await graph.aget_state(config)
    assert snap.values["status"] == "cancelled"
    assert snap.next == ()


async def test_fit_report_continues_into_boost(monkeypatch):
    seen = _flat(monkeypatch)
    graph = _graph(_Approvals(), model=_PhaseModel({"analyze": {"scenario": "E"}}))
    config = _config()
    events = await _events(graph, _base(
        phase="analyze", scenario="E", inputs={"document": "선택한 서류 본문"},
    ), config)
    assert not any(event.get("gate") == "analyze" for event in events)
    snap = await graph.aget_state(config)
    assert "02_fit_score.json" in snap.values["artifacts"]
    assert snap.values["phase"] == "craft"
    choice = _choice(await _events(graph, {}, config))
    assert choice["gate"] == "boost"
    assert choice["title"] == "점수를 한 번 더 올릴까요?"
    assert seen[0] == "선택한 서류 본문"


async def test_boost_uses_the_chosen_document_body(monkeypatch):
    seen = _flat(monkeypatch)

    class DB(_Approvals):
        async def fetchrow(self, sql, *args):
            if "document_versions" in sql:
                return {"content": {"type": "doc", "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "문서 본문"}]},
                ]}}
            return self.rows.get(str(args[0])) if args else None

    user_id = str(uuid4())
    graph = _graph(DB(), model=_PhaseModel({"analyze": {"scenario": "E"}}))
    config = _config()
    await _run(graph, _base(
        phase="analyze", scenario="E", user_id=user_id,
        inputs={"documentId": _DOC},
    ), config)
    await _events(graph, {}, config)
    assert seen[0] == "문서 본문"


async def test_auto_flow_has_no_publish_gate(monkeypatch):
    _flat(monkeypatch)
    seen = await _drive(_graph(_Approvals()), _config(), _base())
    titles = [
        event["title"]
        for events, snap in seen
        for event in events
        if event.get("type") == "choice" and snap.next
    ]
    gates = [
        event["gate"]
        for events, snap in seen
        for event in events
        if event.get("type") == "choice" and snap.next
    ]
    assert "디자인을 적용했어요. PDF로 만들까요?" not in titles
    assert "publish" not in gates
    assert _PRESENT in titles


async def test_present_card_points_at_the_profile(monkeypatch):
    _flat(monkeypatch)
    from app.db import NotFoundError
    from app.domain.services.document import DocumentService
    from app.harness.personal.tools import bound_services
    from tests.stubs import FakeDB

    class Store:
        def __init__(self):
            self.docs = {}
            self.versions = []

        async def create(self, doc):
            self.docs[doc.id] = doc

        async def get(self, user_id, id_):
            doc = self.docs.get(id_)
            if doc is None or doc.user_id != user_id:
                raise NotFoundError()
            return doc

        async def update(self, doc, expected):
            current = self.docs[doc.id]
            if current.revision != expected:
                raise RuntimeError("revision")
            self.docs[doc.id] = doc

        async def next_version_number(self, document_id):
            return 1 + sum(1 for v in self.versions if v.document_id == document_id)

        async def create_version(self, version):
            self.versions.append(version)

    user_id = str(uuid4())
    store = Store()
    docs = DocumentService(FakeDB(), None, None)
    docs.documents = store
    token = bound_services.set(SimpleNamespace(document_svc=docs))
    try:
        graph = _graph(_Approvals(), model=_PhaseModel({"present": {"summary": "끝"}}))
        config = _config()
        events = await _events(graph, _base(
            phase="present", user_id=user_id, drafts={"markdown": "# 프로필\n백엔드"},
        ), config)
    finally:
        bound_services.reset(token)
    choice = _choice(events)
    assert choice["title"] == _PRESENT
    assert choice["options"] == [
        {"id": "done", "label": "확인했어요"},
        {"id": "cancel", "label": "그만하기"},
    ]
    assert choice["note"] == _NOTE
    assert any(event.get("token") == _SAVING for event in events)
    assert choice["documentId"]
    saved = next(iter(store.docs.values()))
    assert saved.kind == "HUB_PROFILE"
    assert saved.application_id is None
    assert choice["documentId"] == str(saved.id)
    assert store.versions


_ANALYZE_TITLE = "이 공고에 맞춰 이력서를 고칠까요?"
_FEEDBACK_TITLE = "피드백을 반영해서 수정할까요?"
_FIX_LABEL = "네, 맞춰서 고쳐 주세요"
_FEEDBACK_ONLY = "피드백만 받을게요"
_SCORE_ONLY = "점수만 보고 끝낼게요"
_APPLY_FEEDBACK = "반영해서 수정할게요"


class _RecordingModel(_PhaseModel):
    def __init__(self, outputs=None):
        super().__init__(outputs)
        self.payloads = []

    async def ainvoke(self, messages, **kwargs):
        self.payloads.append(json.loads(messages[-1].content))
        return await super().ainvoke(messages, **kwargs)


async def _open_analyze():
    model = _RecordingModel({"analyze": {"scenario": "A", "message": "키워드가 부족해요"}})
    graph = _graph(_Approvals(), model=model)
    config = _config()
    events = await _events(graph, _base(phase="analyze"), config)
    return graph, config, model, events


async def test_analyze_gate_offers_the_three_design_options():
    _graph_obj, _config_obj, _model, events = await _open_analyze()
    choice = _choice(events)
    assert choice["title"] == _ANALYZE_TITLE
    assert choice["recommended"] == "continue"
    assert choice["options"] == [
        {"id": "continue", "label": _FIX_LABEL},
        {"id": "feedback", "label": _FEEDBACK_ONLY},
        {"id": "score", "label": _SCORE_ONLY},
    ]


async def test_analyze_fix_goes_to_strategy():
    graph, config, model, _opened = await _open_analyze()
    await _events(graph, Command(resume={"option_id": "continue"}), config)
    choice = _choice(await _events(graph, {}, config))
    assert choice["gate"] == "strategy"
    assert "craft" not in model.calls


async def test_analyze_score_ends_at_the_score():
    graph, config, model, _opened = await _open_analyze()
    snap = await graph.aget_state(config)
    assert "02_fit_score.json" in snap.values["artifacts"]
    await _events(graph, Command(resume={"option_id": "score"}), config)
    done = await graph.aget_state(config)
    assert done.values["status"] == "done"
    assert done.values["phase"] == "analyze"
    assert done.next == ()
    assert "strategy" not in model.calls
    assert "craft" not in model.calls


async def test_analyze_feedback_shows_fixes_then_the_feedback_card():
    graph, config, model, _opened = await _open_analyze()
    await _events(graph, Command(resume={"option_id": "feedback"}), config)
    events = await _events(graph, {}, config)
    assert any(event.get("token") == "키워드가 부족해요" for event in events)
    choice = _choice(events)
    assert choice["title"] == _FEEDBACK_TITLE
    assert choice["options"] == [
        {"id": "continue", "label": _APPLY_FEEDBACK},
        {"id": "cancel", "label": "그만하기"},
    ]
    assert "craft" not in model.calls


async def test_feedback_continue_rewrites_with_the_feedback():
    graph, config, model, _opened = await _open_analyze()
    await _events(graph, Command(resume={"option_id": "feedback"}), config)
    card = _choice(await _events(graph, {}, config))
    assert card["gate"] == "feedback"
    assert card["title"] == _FEEDBACK_TITLE
    await _events(graph, Command(resume={"option_id": "continue"}), config)
    await _events(graph, {}, config)
    craft = next(item for item in model.payloads if item.get("phase") == "craft")
    assert craft["analysis"]["message"] == "키워드가 부족해요"
    assert "strategy" not in model.calls


async def test_feedback_cancel_ends_without_a_rewrite():
    graph, config, model, _opened = await _open_analyze()
    await _events(graph, Command(resume={"option_id": "feedback"}), config)
    card = _choice(await _events(graph, {}, config))
    assert card["gate"] == "feedback"
    await _events(graph, Command(resume={"option_id": "cancel"}), config)
    snap = await graph.aget_state(config)
    assert snap.values["status"] == "cancelled"
    assert snap.next == ()
    assert "craft" not in model.calls
    assert "strategy" not in model.calls


def test_fit_seed_uses_the_chosen_document_without_dropping_a_draft():
    kept = quick_start_resume("fit", {
        "inputs": {"job": "backend", "document": "본문"},
        "drafts": {"resume": "기존 초안"},
    })
    assert kept["scenario"] == "E"
    assert kept["drafts"]["resume"] == "기존 초안"
    seeded = quick_start_resume("fit", {"inputs": {"document": "본문"}})
    assert seeded["phase"] == "analyze"
    assert seeded["scenario"] == "E"
    assert seeded["drafts"]["markdown"] == "본문"
    assert drafts_from_chosen({"resume": "기존"}, {"document": "다른"})["resume"] == "기존"


def test_publish_prompt_does_not_ask_for_a_pdf():
    text = phase_prompt_for_harness("publish")
    assert "PDF로 만들지 묻지 않는다" in text
    assert "pdf-publisher" not in text
    assert _NOTE in phase_prompt_for_harness("present")


async def test_fit_quick_start_copies_context_document_id(monkeypatch):
    _flat(monkeypatch)
    rows = Rows({"company_id": None, "resume_state": None})
    runtime = HarnessRuntime(service(rows))
    payload = {
        "text": "시작해 주세요",
        "user_id": "88888888-8888-4888-8888-888888888888",
        "conversation_id": str(CONV),
        "job_id": "99999999-9999-4999-8999-999999999999",
        "access_mode": "AUTO",
        "ai": None,
        "context": {"documentId": _DOC},
        "intent": "fit",
    }
    await run(runtime, payload)
    saved = rows.conversation["resume_state"]
    if isinstance(saved, str):
        import json
        saved = json.loads(saved)
    assert saved["inputs"]["documentId"] == _DOC
    assert saved["scenario"] == "E"
    assert saved["phase"] == "craft"
    assert UUID(saved["inputs"]["documentId"])
