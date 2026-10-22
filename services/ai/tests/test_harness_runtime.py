from __future__ import annotations

import json

from app.harness.runtime import HarnessRuntime
from tests.harness_fakes import CONV, USER, ScriptedLC, managed_ai, run, service


def _payload(text: str = "안녕", **extra) -> dict:
    return {
        "text": text,
        "user_id": USER,
        "conversation_id": CONV,
        "job_id": "99999999-9999-4999-8999-999999999999",
        "access_mode": "AUTO",
        "ai": managed_ai(),
        "context": {},
        **extra,
    }


async def test_turn_uses_gate_model_and_persists_reply():
    ScriptedLC.replies = [{"content": "안녕하세요"}]
    ScriptedLC.bound = []
    svc = service()
    items = await run(HarnessRuntime(svc, model_cls=ScriptedLC), _payload())
    assert ("custom", {"token": "안녕하세요"}) in items
    operation = items[-1][1]["operation"]
    assert operation.result.value["assistantMessage"]["text"] == "안녕하세요"
    assert [m.role for m in svc.messages] == ["USER", "ASSISTANT"]
    assert svc.ai.settled == [("gate-model", 10, 5)]
    schemas = {tool["function"]["name"]: tool for tool in ScriptedLC.bound[0]}
    assert "posting_id" in schemas["bookmark_posting"]["function"]["parameters"]["properties"]


async def test_no_ai_options_gives_the_stub_reply():
    svc = service()
    items = await run(HarnessRuntime(svc), _payload(ai=None))
    assert svc.messages[-1].text.startswith("(로컬 스텁)")
    assert items[-1][0] == "values"


async def test_resume_flow_saves_state_and_text_answers_the_gate():
    from app.harness.router import select_harness
    from tests.harness_fakes import Rows
    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "mode_select"}})
    svc = service(rows)
    runtime = HarnessRuntime(svc)
    items = await run(runtime, _payload("서류 만들어줘", ai=None))
    assert any(mode == "custom" and chunk.get("type") == "done" and chunk["awaiting"] == "choice"
               for mode, chunk in items)
    choice = next(chunk for mode, chunk in items if mode == "custom" and chunk.get("type") == "choice")
    assert choice["gate"] == "mode_select"
    assert select_harness(rows.conversation).id == "resume"
    await run(runtime, _payload("그만할래", ai=None, job_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
    assert select_harness(rows.conversation).id == "personal"
    assert any("UPDATE approvals SET status = 'APPROVED'" in sql for sql, _ in rows.executed)
    chat = await runtime._graph(select_harness({})).aget_state({"configurable": {"thread_id": str(CONV)}})
    assert not chat.values


async def test_resume_turn_prefetches_pages_and_keeps_attachments(monkeypatch):
    from app.harness import runtime as runtime_module
    from tests.harness_fakes import Rows

    async def fake_fetch(url):
        return "백엔드 공고 본문"

    monkeypatch.setattr(runtime_module, "fetch_page_text", fake_fetch)
    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "intake"}})
    evidence = "13131313-1313-4313-8313-131313131313"
    await run(HarnessRuntime(service(rows)), _payload(
        "이 공고 https://jobs.example/1 로 써줘", ai=None, context={"evidenceIds": [evidence]}))
    saved = json.loads(rows.conversation["resume_state"])
    assert saved["inputs"]["pages"] == {"https://jobs.example/1": "백엔드 공고 본문"}
    assert saved["inputs"]["attachments"] == [evidence]


async def test_bypass_intake_with_a_page_does_not_stop():
    from app.harness.resume.graph import _must_stop
    assert not _must_stop({"access_mode": "BYPASS", "inputs": {"pages": {"u": "t"}}}, "intake")
    assert _must_stop({"access_mode": "BYPASS", "inputs": {}}, "intake")


async def test_resume_turn_saves_the_assistant_message():
    from tests.harness_fakes import Rows
    ScriptedLC.replies = [{"content": json.dumps({"message": "어떤 방식으로 쓸지 골라 주세요"})}]
    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "mode_select"}})
    svc = service(rows)
    items = await run(HarnessRuntime(svc, model_cls=ScriptedLC), _payload("서류 만들어줘"))
    assert [(m.role, m.text) for m in svc.messages] == [
        ("USER", "서류 만들어줘"), ("ASSISTANT", "어떤 방식으로 쓸지 골라 주세요")]
    done = [chunk for mode, chunk in items if mode == "custom" and chunk.get("type") == "done"]
    assert len(done) == 1
    assert done[0]["awaiting"] == "choice"
    assert done[0]["operation"]["result"]["value"]["assistantMessage"]["text"] == "어떤 방식으로 쓸지 골라 주세요"
    assert ("custom", {"token": "어떤 방식으로 쓸지 골라 주세요"}) in items


async def test_answering_a_gate_without_new_work_saves_nothing():
    from tests.harness_fakes import Rows
    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "mode_select"}})
    svc = service(rows)
    runtime = HarnessRuntime(svc)
    first = await run(runtime, _payload("서류", ai=None))
    gate_id = next(chunk["id"] for mode, chunk in first if mode == "custom" and chunk.get("type") == "choice")
    before = len(svc.messages)
    await run(runtime, _payload("", ai=None, job_id="dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                                resume={"approvalId": gate_id, "optionId": "resume_based"}))
    assert len(svc.messages) == before
