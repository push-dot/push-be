from __future__ import annotations

import json

import httpx
from langchain_core.messages import ToolMessage

from app.harness.approval import expire_approvals
from app.harness.core_client import CoreClient, idempotency_key
from app.harness.runtime import HarnessRuntime
from tests.harness_fakes import CONV, USER, Rows, ScriptedLC, managed_ai, run, service

POSTING = "11111111-1111-4111-8111-111111111111"
JOB_A = "a0000000-0000-4000-8000-000000000001"
JOB_B = "b0000000-0000-4000-8000-000000000002"
JOB_C = "c0000000-0000-4000-8000-000000000003"


def _payload(job_id: str, text: str = "", **extra) -> dict:
    return {
        "text": text, "user_id": USER, "conversation_id": CONV, "job_id": job_id,
        "access_mode": "AUTO", "ai": managed_ai(), "context": {}, **extra,
    }


def _runtime(rows: Rows, seen: list):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": {"ok": True}})

    svc = service(rows)
    runtime = HarnessRuntime(svc, model_cls=ScriptedLC)
    runtime._core = CoreClient("http://core.test", "secret", httpx.MockTransport(handler))
    return runtime, svc


def _apply_call() -> dict:
    return {"name": "apply_to_posting", "id": "call-1", "type": "tool_call", "args": {"posting_id": POSTING}}


async def test_resume_payload_runs_the_approved_tool_once():
    ScriptedLC.replies = [{"tool_calls": [_apply_call()]}, {"content": "지원했어요"}]
    rows = Rows()
    seen: list = []
    runtime, svc = _runtime(rows, seen)
    first = await run(runtime, _payload(JOB_A, "이 공고에 지원해줘"))
    assert ("custom", {"type": "done", "awaiting": "approval"}) in first
    approval_id = next(chunk["id"] for mode, chunk in first if mode == "custom" and chunk.get("type") == "approval")
    assert seen == []

    resume = {"resume": {"approvalId": approval_id, "optionId": "approve"}}
    await run(runtime, _payload(JOB_B, **resume))
    await run(runtime, _payload(JOB_B, **resume))
    applies = [request for request in seen if request.url.path.endswith("/apply")]
    assert len(applies) == 1
    assert applies[0].headers["idempotency-key"] == idempotency_key(JOB_A, "call-1")
    assert svc.messages[-1].text == "지원했어요"


async def test_new_message_closes_the_waiting_tool_card():
    ScriptedLC.replies = [{"tool_calls": [_apply_call()]}, {"content": "다른 얘기"}]
    rows = Rows()
    seen: list = []
    runtime, svc = _runtime(rows, seen)
    await run(runtime, _payload(JOB_A, "지원해줘"))
    await run(runtime, _payload(JOB_C, "아니 그냥 공고 얘기하자"))
    assert seen == []
    assert any("SET status = 'REJECTED'" in sql for sql, _ in rows.executed)
    state = await runtime._graph(runtime_spec()).aget_state({"configurable": {"thread_id": str(CONV)}})
    rejected = [m for m in state.values["messages"] if isinstance(m, ToolMessage)]
    assert json.loads(rejected[0].content) == {"rejected": True}
    assert not state.next
    assert svc.messages[-1].text == "다른 얘기"


async def test_resume_gate_answer_queues_the_next_phase_through_core():
    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "mode_select"}})
    seen: list = []
    runtime, _svc = _runtime(rows, seen)
    first = await run(runtime, _payload(JOB_A, "서류 만들어줘", ai=None))
    gate_id = next(chunk["id"] for mode, chunk in first if mode == "custom" and chunk.get("type") == "choice")
    await run(runtime, _payload(JOB_B, ai=None, resume={"approvalId": gate_id, "optionId": "resume_based"}))
    posted = [request for request in seen if request.url.path.endswith("/resume-jobs")]
    assert len(posted) == 1
    assert json.loads(posted[0].content) == {"resume": {"gate": "intake", "auto": True}}
    assert posted[0].headers["idempotency-key"] == idempotency_key(JOB_B, "next-phase")
    saved = json.loads(rows.conversation["resume_state"])
    assert saved["phase"] == "intake"
    assert saved["work_mode"] == "resume_based"


async def test_expiry_sweep_marks_old_cards():
    rows = Rows()
    await expire_approvals(rows)
    sql = rows.executed[-1][0]
    assert "SET status = 'EXPIRED'" in sql
    assert "expires_at < now()" in sql


def runtime_spec():
    from app.harness.registry import REGISTRY
    return REGISTRY["personal"]
