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
