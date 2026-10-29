from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from uuid import UUID

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.domain import entities as ent
from app.domain.errors import DomainError
from app.harness import jobs
from app.harness import model as model_module
from app.harness import runtime as runtime_module
from app.harness.model import GateModel, settle_turn
from app.harness.registry import REGISTRY
from app.harness.runtime import HarnessRuntime
from app.queue.worker import JobCancelled
from tests.harness_fakes import CONV, USER, Gate, ScriptedLC, managed_ai, run, service


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
    tools = {tool.name: tool for tool in ScriptedLC.bound[0]}
    assert "posting_id" in tools["bookmark_posting"].args_schema.model_fields


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
    assert select_harness(rows.conversation).id == "personal"
    await run(runtime, _payload("그만할래", ai=None, job_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
    assert select_harness(rows.conversation).id == "personal"
    assert any("UPDATE approvals SET status = 'APPROVED'" in sql for sql, _ in rows.executed)
    chat = await runtime._graph(REGISTRY["personal"]).aget_state({"configurable": {"thread_id": str(CONV)}})
    assert chat.values["resume"]["status"] == "cancelled"
    assert f"{CONV}:resume" not in svc._checkpointer.storage


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


def test_gate_answer_forwards_option_ids():
    from app.harness.runtime import _gate_answer

    assert _gate_answer({"optionId": "resume"}) == {"option_id": "resume"}
    assert _gate_answer({"optionId": "resume", "optionIds": ["portfolio", "resume"]}) == {
        "option_id": "resume",
        "option_ids": ["portfolio", "resume"],
    }


async def test_bypass_intake_with_a_page_does_not_stop():
    from app.harness.personal.resume.graph import _must_stop
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


async def test_start_document_cancel_choice_resets_flow():
    from app.harness.personal import tools
    from app.harness.router import select_harness
    from app.harness.tools import ToolContext
    from tests.harness_fakes import Rows

    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "craft"}})
    svc = service(rows)
    tool = next(item for item in tools.PERSONAL_TOOLS if item.name == "start_document")
    result = await tool.run(ToolContext(
        user_id=str(USER), company_id=None, conversation_id=str(CONV),
        job_id="job-1", tool_call_id="call-1", db=rows, core=None,
    ), tool.args_model.model_validate({}))
    choice = result["choice"]
    assert choice["kind"] == "RESUME_GATE"
    assert choice["gate"] == "start_document"
    assert [item["id"] for item in choice["options"]] == ["continue", "cancel"]
    assert rows.approvals[choice["id"]]["kind"] == "RESUME_GATE"
    assert not any("resume_state" in sql for sql, _args in rows.executed)
    await run(HarnessRuntime(svc), _payload(
        "", ai=None, resume={"approvalId": choice["id"], "optionId": "cancel"}))
    saved = rows.conversation["resume_state"]
    if isinstance(saved, str):
        saved = json.loads(saved)
    assert saved["status"] == "cancelled"
    assert select_harness(rows.conversation).id == "personal"


def _saved_resume(rows):
    saved = rows.conversation["resume_state"]
    if isinstance(saved, str):
        saved = json.loads(saved)
    return saved


async def _ask_start(tool, rows, job_id):
    from app.harness.tools import ToolContext

    return await tool.run(ToolContext(
        user_id=str(USER), company_id=None, conversation_id=str(CONV),
        job_id=job_id, tool_call_id="call-" + job_id, db=rows, core=None,
    ), tool.args_model.model_validate({}))


async def test_start_document_second_ask_can_be_answered():
    from app.harness.personal import tools
    from tests.harness_fakes import Rows

    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "craft"}})
    runtime = HarnessRuntime(service(rows))
    tool = next(item for item in tools.PERSONAL_TOOLS if item.name == "start_document")
    first = await _ask_start(tool, rows, "job-1")
    await run(runtime, _payload(
        "", ai=None, resume={"approvalId": first["choice"]["id"], "optionId": "cancel"}))
    assert _saved_resume(rows)["status"] == "cancelled"

    restarted = await _ask_start(tool, rows, "job-2")
    from langgraph.types import Command
    assert isinstance(restarted, Command)
    assert restarted.goto == "resume_flow"
    assert restarted.update["resume"] == {"status": "active", "phase": "mode_select"}
    assert _saved_resume(rows)["status"] == "active"

    second = await _ask_start(tool, rows, "job-3")
    assert second["choice"]["id"] != first["choice"]["id"]
    await run(runtime, _payload(
        "", ai=None, job_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        resume={"approvalId": second["choice"]["id"], "optionId": "cancel"}))
    assert _saved_resume(rows)["status"] == "cancelled"


async def test_boost_choice_answer_resumes_the_cycle(monkeypatch):
    scores = iter([1.0, 2.0, 3.0, 4.0])

    async def fake(*_args, **_kwargs):
        return {"fitScore": next(scores), "parts": {}, "topGap": "도메인", "plan": "FREE"}

    monkeypatch.setattr("app.framework.fit_judge.judge_fit", fake)
    from tests.harness_fakes import Rows

    rows = Rows({"company_id": None, "resume_state": {
        "status": "done",
        "drafts": {"markdown": "백엔드 경력"},
        "analysis": {"jobs": {"requirements": ["Python"], "keywords": ["Kafka"]}},
        "inputs": {"pages": {"https://jobs.example/1": "백엔드 공고"}},
    }})
    runtime = HarnessRuntime(service(rows))
    first = await run(runtime, _payload("점수 올려줘", ai=None, intent="boost"))
    boost = next(
        chunk for mode, chunk in first
        if mode == "custom" and chunk.get("gate") == "boost"
    )
    assert boost["kind"] == "RESUME_GATE"
    assert any(
        mode == "custom" and chunk.get("type") == "done" and chunk.get("awaiting") == "choice"
        for mode, chunk in first
    )
    assert boost["title"] == "점수를 한 번 더 올릴까요?"
    assert boost["detail"] == "적합도 1.0 → 2.0 (+1.0)"
    assert [item["id"] for item in boost["options"]] == ["continue", "stop", "cancel"]
    second = await run(runtime, _payload(
        "", ai=None, job_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        resume={"approvalId": boost["id"], "optionId": "continue"}))
    again = next(
        chunk for mode, chunk in second
        if mode == "custom" and chunk.get("gate") == "boost"
    )
    assert again["id"] != boost["id"]
    assert again["detail"] == "적합도 2.0 → 3.0 (+1.0)"


async def test_start_document_continue_choice_keeps_the_flow():
    from app.harness.personal import tools
    from app.harness.router import select_harness
    from app.harness.tools import ToolContext
    from tests.harness_fakes import Rows

    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "mode_select"}})
    svc = service(rows)
    runtime = HarnessRuntime(svc)
    await run(runtime, _payload("서류", ai=None))
    tool = next(item for item in tools.PERSONAL_TOOLS if item.name == "start_document")
    result = await tool.run(ToolContext(
        user_id=str(USER), company_id=None, conversation_id=str(CONV),
        job_id="job-1", tool_call_id="call-1", db=rows, core=None,
    ), tool.args_model.model_validate({}))
    phase_before = json.loads(rows.conversation["resume_state"])["phase"]
    await run(runtime, _payload(
        "", ai=None, job_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        resume={"approvalId": result["choice"]["id"], "optionId": "continue"}))
    saved = json.loads(rows.conversation["resume_state"])
    assert saved["status"] == "active"
    assert saved["phase"] == phase_before == "mode_select"
    assert select_harness(rows.conversation).id == "personal"


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


def _fit_call(call_id: str) -> dict:
    return {"name": "get_fit_score", "args": {}, "id": call_id, "type": "tool_call"}


async def test_new_turn_heals_tool_calls_a_crashed_turn_left_open():
    svc = service()
    runtime = HarnessRuntime(svc, model_cls=ScriptedLC)
    config = {"configurable": {"thread_id": str(CONV)}}
    graph = runtime._graph(REGISTRY["personal"])
    dangling = AIMessage(content="", tool_calls=[_fit_call("dead-1")])
    await graph.aupdate_state(config, {"messages": [HumanMessage("점수 봐줘"), dangling]}, as_node="agent")
    ScriptedLC.replies = [{"content": "다시 왔어요"}]
    await run(runtime, _payload("다시"))
    messages = (await graph.aget_state(config)).values["messages"]
    healed = [i for i, m in enumerate(messages) if isinstance(m, ToolMessage) and m.tool_call_id == "dead-1"]
    assert len(healed) == 1
    assert json.loads(messages[healed[0]].content) == {"error": "TOOL_FAILED"}
    assert isinstance(messages[healed[0] + 1], HumanMessage)


async def test_runaway_tool_loop_becomes_a_clean_domain_error(monkeypatch):
    monkeypatch.setattr(runtime_module, "RECURSION_LIMIT", 2)
    ScriptedLC.replies = [{"tool_calls": [_fit_call(f"f{i}")]} for i in range(5)]
    with pytest.raises(DomainError) as err:
        await run(HarnessRuntime(service(), model_cls=ScriptedLC), _payload("점수"))
    assert err.value.code == "INTERNAL"
    ScriptedLC.replies = []


def test_user_turn_message_id_is_stable_across_retries():
    from app.harness.runtime import _stable_ids
    payload = _payload("안녕")
    first = runtime_module._state(payload, {})["messages"][0]
    again = runtime_module._state(payload, {})["messages"][0]
    assert first.id == again.id == str(_stable_ids(payload["job_id"])[0])
    assert runtime_module._state({**payload, "job_id": "job-2"}, {})["messages"][0].id is None


async def test_turn_inputs_fetches_pages_concurrently_and_logs_failures(monkeypatch, caplog):
    started = asyncio.Event()

    async def fetch(url):
        if url.endswith("/1"):
            await started.wait()  # only finishes if the second fetch runs at the same time
            return "첫 공고"
        started.set()
        raise RuntimeError("down")

    monkeypatch.setattr(runtime_module, "fetch_page_text", fetch)
    async with asyncio.timeout(1):
        inputs = await runtime_module._turn_inputs({"text": "https://a.example/1 https://b.example/2"})
    assert inputs["pages"] == {"https://a.example/1": "첫 공고"}
    assert "page prefetch failed" in caplog.text


async def test_failed_turn_settles_tokens_already_spent():
    gate = Gate()
    await settle_turn(gate, {"usage_id": "u1", "model": "m", "input_tokens": 10, "output_tokens": 0}, False)
    assert gate.settled == [("m", 10, 0)] and gate.released == []
    await settle_turn(gate, {"usage_id": "u2", "model": "m"}, False)
    assert gate.released == ["u2"]


def _gate_model(gate, cls) -> GateModel:
    return GateModel(gate, USER, ent.AiOptions(**managed_ai()), "job", {}, cls=cls)


async def test_gate_model_times_out_a_hung_llm_call(monkeypatch):
    monkeypatch.setattr(model_module, "_CALL_TIMEOUT_SECONDS", 0.01)

    class Hung(ScriptedLC):
        async def ainvoke(self, messages, **kwargs):
            await asyncio.sleep(1)
            return AIMessage(content="late")

    with pytest.raises(DomainError) as err:
        await _gate_model(Gate(), Hung).ainvoke([HumanMessage("hi")])
    assert err.value.code == "PROVIDER_ERROR"


async def test_gate_model_sends_openrouter_provider_routing_for_the_free_model():
    built = []

    class Recording(ScriptedLC):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            built.append(kwargs)

    class FreeGate(Gate):
        async def check(self, user_id, ai):
            ai.model = "deepseek/deepseek-v4.1-flash"

        async def _route(self, user_id, ai):
            chat = SimpleNamespace(base_url="http://llm.test", config=SimpleNamespace())
            return chat, "key", ai.model, None

    await _gate_model(FreeGate(), Recording).ainvoke([HumanMessage("hi")])
    assert built[0]["extra_body"]["provider"]["ignore"] == ["DeepSeek"]


class _JobCtx:
    def __init__(self):
        self.job = {"id": UUID("99999999-9999-4999-8999-999999999999"), "user_id": USER,
                    "conversation_id": CONV, "payload": {"text": "hi"}}
        self.events: list = []

    async def emit(self, kind, data):
        self.events.append((kind, data))


async def test_queue_turn_closes_the_graph_stream_when_cancelled(monkeypatch):
    # Closing later, from GC in another Context, broke the stream's contextvar resets.
    closed = []

    class Graph:
        async def astream(self, *args, **kwargs):
            try:
                yield "custom", {"token": "a"}
                yield "custom", {"token": "b"}
            finally:
                closed.append(True)

    async def cancelled(job_id):
        return True

    with pytest.raises(JobCancelled):
        await jobs.run_queue_turn(SimpleNamespace(graph=Graph()), _JobCtx(), cancelled)
    assert closed == [True]


async def test_queue_turn_checks_cancellation_once_per_second_and_before_done(monkeypatch):
    monkeypatch.setattr(jobs, "monotonic", lambda: 100.0)

    class Graph:
        async def astream(self, *args, **kwargs):
            for i in range(50):
                yield "custom", {"token": str(i)}
            yield "values", {"operation": {"id": "op-1"}}

    checks = []

    async def cancelled(job_id):
        checks.append(job_id)
        return False

    ctx = _JobCtx()
    assert await jobs.run_queue_turn(SimpleNamespace(graph=Graph()), ctx, cancelled) == {"operationId": "op-1"}
    assert len(checks) == 2
    assert [kind for kind, _ in ctx.events].count("token") == 50
    assert ctx.events[0] == ("token", {"text": "0"}) and ctx.events[-1][0] == "done"
