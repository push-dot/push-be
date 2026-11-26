from __future__ import annotations

import json

import httpx
from langchain_core.messages import ToolMessage

from app.domain.errors import DomainError
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


async def test_resume_gate_answer_resumes_personal_thread():
    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "mode_select"}})
    seen: list = []
    runtime, svc = _runtime(rows, seen)
    first = await run(runtime, _payload(JOB_A, "서류 만들어줘", ai=None))
    gate_id = next(chunk["id"] for mode, chunk in first if mode == "custom" and chunk.get("type") == "choice")
    await run(runtime, _payload(JOB_B, ai=None, resume={"approvalId": gate_id, "optionId": "resume_based"}))
    assert not any(request.url.path.endswith("/resume-jobs") for request in seen)
    assert f"{CONV}:resume" not in svc._checkpointer.storage
    assert str(CONV) in svc._checkpointer.storage
    saved = json.loads(rows.conversation["resume_state"])
    assert saved["phase"] == "intake"
    assert saved["work_mode"] == "resume_based"


def runtime_spec():
    from app.harness.registry import REGISTRY
    return REGISTRY["personal"]


class _FailsOnce(ScriptedLC):
    failures = 1

    async def ainvoke(self, messages, **kwargs):
        if _FailsOnce.failures and any(isinstance(m, ToolMessage) for m in messages):
            _FailsOnce.failures -= 1
            raise RuntimeError("provider failed")
        return await super().ainvoke(messages, **kwargs)


async def test_a_retried_gate_answer_finishes_the_run_the_failed_attempt_left():
    _FailsOnce.failures = 1
    ScriptedLC.replies = [{"tool_calls": [_apply_call()]}, {"content": "지원했어요"}]
    rows = Rows()
    seen: list = []
    runtime, svc = _runtime(rows, seen)
    runtime._model_cls = _FailsOnce
    first = await run(runtime, _payload(JOB_A, "이 공고에 지원해줘"))
    approval_id = next(chunk["id"] for mode, chunk in first if mode == "custom" and chunk.get("type") == "approval")
    resume = {"resume": {"approvalId": approval_id, "optionId": "approve"}}
    try:
        await run(runtime, _payload(JOB_B, **resume))
    except DomainError:
        pass
    await run(runtime, _payload(JOB_B, **resume))
    assert svc.messages[-1].text == "지원했어요"


async def test_a_retried_job_leaves_the_gate_it_opened_for_the_person():
    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "mode_select"}})
    seen: list = []
    runtime, _svc = _runtime(rows, seen)
    first = await run(runtime, _payload(JOB_A, "서류 만들어줘", ai=None))
    assert any(mode == "custom" and chunk.get("type") == "choice" for mode, chunk in first)
    graph = runtime._graph(runtime_spec())
    config = {"configurable": {"thread_id": str(CONV)}}
    before = await graph.aget_state(config)
    # A worker restart runs the same job again: its own text must not answer its own gate.
    rows.executed.clear()
    await run(runtime, _payload(JOB_A, "서류 만들어줘", ai=None))
    after = await graph.aget_state(config)
    assert after.next == before.next and after.next, "the gate is still waiting for the person"
    answered = [sql for sql, _args in rows.executed if "SET status = 'APPROVED'" in sql]
    assert answered == [], "the retry did not answer the gate with its own question"


async def test_a_new_message_still_answers_the_waiting_text_gate():
    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "mode_select"}})
    seen: list = []
    runtime, _svc = _runtime(rows, seen)
    first = await run(runtime, _payload(JOB_A, "서류 만들어줘", ai=None))
    gate_id = next(chunk["id"] for mode, chunk in first
                   if mode == "custom" and chunk.get("type") == "choice")
    rows.executed.clear()
    await run(runtime, _payload(JOB_B, "이력서를 바탕으로 해 주세요", ai=None))
    answered = [args for sql, args in rows.executed if "SET status = 'APPROVED'" in sql]
    assert [str(args[0]) for args in answered] == [gate_id], (
        "a person's new message answers the gate the earlier turn opened")


async def test_an_approved_apply_posts_a_json_body_core_accepts():
    import json as _json

    import httpx as _httpx

    from app.harness.personal.tools import PERSONAL_TOOLS
    from app.harness.tools import ToolContext

    seen = []

    def handler(request):
        seen.append(request)
        return _httpx.Response(201, json={"data": {"id": "app-1"}})

    core = CoreClient("http://core.test", "secret", _httpx.MockTransport(handler))
    tool = next(t for t in PERSONAL_TOOLS if t.name == "apply_to_posting")
    ctx = ToolContext(user_id=str(USER), company_id=None, conversation_id=str(CONV), job_id=JOB_A,
                      tool_call_id="call-1", db=None, core=core)
    await tool.run(ctx, tool.args_model.model_validate({"posting_id": POSTING}))
    # Staging: an empty body made core answer VALIDATION_ERROR "request body required".
    assert _json.loads(seen[0].content) == {}
