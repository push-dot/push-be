from __future__ import annotations

import json

from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from app.harness.personal.resume.graph import build_resume_graph
from tests.test_harness_resume import _Approvals, _base, _config, _PhaseModel
from tests.test_resume_flow_decisions import _events

_POSTING = "12345678-1234-5678-1234-567812345678"


class _Reread(_PhaseModel):
    def __init__(self):
        super().__init__()
        self.payloads = []

    async def ainvoke(self, messages, **kwargs):
        payload = json.loads(messages[-1].content)
        self.payloads.append(payload)
        phase = payload.get("phase")
        analyze_calls = [item for item in self.payloads if item.get("phase") == "analyze"]
        if phase == "analyze" and len(analyze_calls) > 1:
            body = {
                "jobs": {"company": "모아페이", "title": "백엔드", "required": ["Kotlin"]},
                "message": "다시 읽었어요",
            }
        elif phase == "analyze":
            body = {
                "jobs": {
                    "company": "모아페이",
                    "title": "백엔드 엔지니어",
                    "read_error": "로그인이 필요한 영역이에요",
                },
                "message": "못 읽었어요",
            }
        else:
            body = {"summary": phase or "done"}
        return AIMessage(content=json.dumps(body, ensure_ascii=False))


def _open():
    model = _Reread()
    graph = build_resume_graph(MemorySaver(), model=model, db=_Approvals())
    state = _base(
        phase="analyze",
        inputs={"pages": {"https://moapay.kr/jobs/1": "공고 본문"}},
    )
    return graph, model, state


def _marks(events):
    found = []
    for event in events:
        if event.get("type") == "fit" or event.get("name") == "fit_score":
            found.append("fit")
        elif event.get("type") == "tool" and event.get("name") == "analyze_posting":
            found.append(("tool", event.get("state"), event.get("resultLine")))
        elif "token" in event:
            found.append(("token", event["token"]))
        elif event.get("type") == "choice":
            found.append(("choice", event.get("gate"), event.get("id")))
    return found


async def test_missing_requirements_routes_to_read_failed_gate_and_skips_fit():
    graph, _model, state = _open()
    events = await _events(graph, state, _config())
    marks = _marks(events)
    assert "fit" not in marks
    tool = next(item for item in marks if item[0] == "tool")
    token = next(item for item in marks if item[0] == "token" and "자격 요건이 빠지면" in item[1])
    choice = next(item for item in marks if item[0] == "choice")
    assert marks.index(tool) < marks.index(token) < marks.index(choice)
    assert tool[1] == "err"
    assert "로그인이 필요한 영역이에요" in tool[2]
    assert choice[1] == "read_failed"
    assert [event["text"] for event in events if event.get("type") == "notice"] == [tool[2]]


async def test_proceed_continues_to_analyze_gate():
    graph, _model, state = _open()
    config = _config()
    await _events(graph, state, config)
    events = await _events(graph, Command(resume={"option_id": "proceed"}), config)
    assert any(event.get("type") == "choice" and event.get("gate") == "analyze" for event in events)
    snap = await graph.aget_state(config)
    assert snap.values.get("fit_from") is None


async def test_paste_answer_reruns_analyze_with_pasted_page():
    graph, model, state = _open()
    config = _config()
    opened = await _events(graph, state, config)
    first = next(event["id"] for event in opened if event.get("gate") == "read_failed")
    stayed = await _events(graph, Command(resume={"option_id": "paste"}), config)
    snap = await graph.aget_state(config)
    assert snap.next
    again = next(event for event in stayed if event.get("gate") == "read_failed")
    assert again["id"] != first
    assert any(event.get("token") == "공고 내용을 붙여 넣어 주세요." for event in stayed)
    text = "자격 요건: Kotlin, Spring"
    await _events(graph, Command(resume={"text": text}), config)
    saved = await graph.aget_state(config)
    assert saved.values["inputs"]["pages"]["붙여넣은 공고"] == text
    assert saved.next == ()
    followed = await _events(graph, {}, config)
    assert any(
        item.get("inputs", {}).get("pages", {}).get("붙여넣은 공고") == text
        for item in model.payloads
    )
    assert any(
        event.get("type") == "choice" and event.get("gate") == "analyze" for event in followed
    )


async def test_typed_answer_counts_as_paste():
    graph, _model, state = _open()
    config = _config()
    await _events(graph, state, config)
    text = "자격 요건: Kotlin"
    await _events(graph, Command(resume={"text": text}), config)
    snap = await graph.aget_state(config)
    assert snap.values["inputs"]["pages"]["붙여넣은 공고"] == text
    assert snap.values["phase"] == "analyze"
    assert snap.next == ()


async def test_pick_answer_stores_a_posting_id_from_the_next_message():
    graph, _model, state = _open()
    config = _config()
    await _events(graph, state, config)
    await _events(graph, Command(resume={"option_id": "pick"}), config)
    await _events(graph, Command(resume={"text": f"@{_POSTING} 이 공고로"}), config)
    snap = await graph.aget_state(config)
    assert snap.values["inputs"]["postingId"] == _POSTING
    assert "붙여넣은 공고" not in (snap.values["inputs"].get("pages") or {})
