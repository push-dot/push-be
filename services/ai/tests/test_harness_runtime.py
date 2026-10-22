from __future__ import annotations

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
    assert ("custom", {"type": "done", "awaiting": "choice"}) in items
    choice = next(chunk for mode, chunk in items if mode == "custom" and chunk.get("type") == "choice")
    assert choice["gate"] == "mode_select"
    assert select_harness(rows.conversation).id == "resume"
    await run(runtime, _payload("그만할래", ai=None, job_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
    assert select_harness(rows.conversation).id == "personal"
    assert any("UPDATE approvals SET status = 'APPROVED'" in sql for sql, _ in rows.executed)
    chat = await runtime._graph(select_harness({})).aget_state({"configurable": {"thread_id": str(CONV)}})
    assert not chat.values
