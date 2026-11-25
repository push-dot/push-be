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
from tests.harness_fakes import CONV, USER, Gate, Rows, ScriptedLC, managed_ai, run, service


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
    user, assistant = svc.messages
    assert (user.role, assistant.role, assistant.text) == ("USER", "ASSISTANT", "안녕하세요")
    assert operation.result.value == {
        "assistantMessageId": str(assistant.id), "userMessageId": str(user.id), "approvalIds": []}
    assert svc.ai.settled == [("anthropic/claude-sonnet-5-5", 10, 5)]
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


async def test_intake_text_followup_sends_the_choice_with_done():
    from tests.harness_fakes import Rows

    rows = Rows({"company_id": None, "resume_state": None})
    runtime = HarnessRuntime(service(rows))
    first = await run(runtime, _payload(
        "내 프로필로 점수 올려 줘", ai=None, intent="boost", access_mode="BYPASS"))
    assert any(
        mode == "custom" and chunk.get("type") == "choice" and chunk.get("gate") == "intake"
        for mode, chunk in first)
    assert any(
        mode == "custom" and chunk.get("type") == "done" and chunk.get("awaiting") == "choice"
        for mode, chunk in first)
    second = await run(runtime, _payload(
        "이력서 만들기만 할게요. 자료는 지금 없어요.",
        ai=None,
        access_mode="BYPASS",
        job_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ))
    assert any(
        mode == "custom" and chunk.get("type") == "choice" and chunk.get("gate") == "intake"
        for mode, chunk in second)
    assert any(
        mode == "custom" and chunk.get("type") == "done" and chunk.get("awaiting") == "choice"
        for mode, chunk in second)


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
    assert done[0]["operation"]["result"]["value"]["assistantMessageId"] == str(svc.messages[-1].id)
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
    first = await run(runtime, _payload("점수 올려줘", ai=None, intent="boost", access_mode="ALWAYS_ASK"))
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


async def test_a_flow_reply_made_in_a_job_that_resumed_from_a_card_is_stored():
    from tests.harness_fakes import Rows
    ScriptedLC.replies = [
        {"content": json.dumps({"message": "어떤 방식으로 쓸지 골라 주세요"})},
        {"content": json.dumps({"message": "자료를 받았어요. 이력서 1개와 공고 1개예요."})},
    ]
    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "mode_select"}})
    svc = service(rows)
    runtime = HarnessRuntime(svc, model_cls=ScriptedLC)
    first = await run(runtime, _payload("서류 만들어줘"))
    gate_id = next(chunk["id"] for mode, chunk in first if mode == "custom" and chunk.get("type") == "choice")
    before = len(svc.messages)

    resumed = await run(runtime, _payload(
        "", job_id="dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        resume={"approvalId": gate_id, "optionId": "resume_based"}))

    streamed = [chunk["token"] for mode, chunk in resumed if mode == "custom" and "token" in chunk]
    assert streamed == ["자료를 받았어요. 이력서 1개와 공고 1개예요."]
    assert [(m.role, m.text) for m in svc.messages[before:]] == [("ASSISTANT", streamed[0])]
    done = next(c for mode, c in resumed if mode == "custom" and c.get("type") == "done")
    assert done["operation"]["result"]["value"]["assistantMessageId"] == str(svc.messages[-1].id)

    targets = next(c for mode, c in resumed if mode == "custom" and c.get("type") == "choice")
    quiet = await run(runtime, _payload("", job_id="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                                        resume={"approvalId": targets["id"], "optionId": "submit",
                                                "optionIds": ["submit", "resume"]}))
    assert not [chunk for mode, chunk in quiet if mode == "custom" and "token" in chunk]
    assert len(svc.messages) == before + 1, "a job going from card to card stores no old reply"


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
    assert built[0]["extra_body"]["provider"] == {
        "only": ["together", "fireworks", "novita"], "allow_fallbacks": False,
        "data_collection": "deny"}


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

    ctx = _JobCtx()
    with pytest.raises(JobCancelled):
        await jobs.run_queue_turn(SimpleNamespace(graph=Graph()), ctx, cancelled)
    assert closed == [True]
    assert ctx.events == [], "the cancel's own status change writes the one cancelled event (0055)"


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


async def test_queue_turn_stores_a_graph_result_for_the_stream_and_replay():
    card = {
        "type": "result",
        "source": "external",
        "taskLine": "이력서 수정",
        "documentId": "doc-1",
        "fileName": "이력서.pdf",
    }

    class Graph:
        async def astream(self, *args, **kwargs):
            yield "custom", card
            yield "values", {}

    async def cancelled(_job_id):
        return False

    ctx = _JobCtx()
    await jobs.run_queue_turn(SimpleNamespace(graph=Graph()), ctx, cancelled)
    ((kind, stored),) = ctx.events
    legacy = {key: value for key, value in card.items() if key != "type"}
    assert kind == "result"
    assert {key: stored[key] for key in legacy} == legacy
    assert stored["a2ui"]["1.0"]["surfaceId"] == stored["a2ui"]["v0.9.1"]["surfaceId"] == stored["sid"]


async def test_queue_turn_stores_status_and_notice_frames_whole():
    since = "2026-11-13T00:00:00.000000Z"
    status = {"type": "status", "text": "공고 요건을 읽는 중", "phase": "working", "since": since}
    notice = {"type": "notice", "text": "“자격 요건”은 로그인이 필요한 영역이라 읽지 못했어요."}

    class Graph:
        async def astream(self, *args, **kwargs):
            yield "custom", status
            yield "custom", notice
            yield "values", {}

    async def cancelled(_job_id):
        return False

    ctx = _JobCtx()
    await jobs.run_queue_turn(SimpleNamespace(graph=Graph()), ctx, cancelled)
    assert ctx.events == [
        ("status", {key: value for key, value in status.items() if key != "type"}),
        ("notice", {"text": notice["text"]}),
    ]


async def test_turn_inputs_keep_github_links_out_of_the_page_reads(monkeypatch):
    fetched = []

    async def fetch(url):
        fetched.append(url)
        return "공고 본문"

    monkeypatch.setattr(runtime_module, "fetch_page_text", fetch)
    inputs = await runtime_module._turn_inputs({
        "text": "https://github.com/me https://a.example/1 https://b.example/2",
        "context": {"urls": ["https://github.com/me/repo"]},
    })
    assert inputs["github"] == ["https://github.com/me", "https://github.com/me/repo"]
    assert list(inputs["pages"]) == fetched == ["https://a.example/1", "https://b.example/2"]


async def test_turn_inputs_keep_links_past_the_prefetch_for_open_page(monkeypatch):
    async def fetch(url):
        return "본문"

    monkeypatch.setattr(runtime_module, "fetch_page_text", fetch)
    inputs = await runtime_module._turn_inputs(
        {"text": "https://a.example/1 https://b.example/2 https://c.example/3"})
    assert list(inputs["pages"]) == ["https://a.example/1", "https://b.example/2"]
    assert inputs["links"] == ["https://c.example/3"]


def test_merge_inputs_unions_links():
    from app.harness.personal.resume.graph import merge_inputs

    merged = merge_inputs({"links": ["https://a.example"]}, {"links": ["https://b.example", "https://a.example"]})
    assert merged["links"] == ["https://a.example", "https://b.example"]


def _saved_flow(rows) -> dict:
    saved = rows.conversation["resume_state"]
    return json.loads(saved) if isinstance(saved, str) else saved


async def _plain_request(monkeypatch, intent):
    from tests.harness_fakes import Rows

    async def fetch(url):
        return "공고 본문"

    monkeypatch.setattr(runtime_module, "fetch_page_text", fetch)
    rows = Rows({"company_id": None, "resume_state": None})
    context = {"evidenceIds": ["e1", "e2", "e3"]}
    text = "공고 맞춤 이력서 만들어줘 https://jobs.example/1 https://github.com/me"
    payload = _payload(text, ai=None, intent=intent, context=context)
    await run(HarnessRuntime(service(rows)), payload)
    return _saved_flow(rows)


async def test_plain_resume_request_with_attachments_starts_the_posting_flow(monkeypatch):
    saved = await _plain_request(monkeypatch, None)
    assert (saved["status"], saved["scenario"], saved["phase"]) == ("active", "A", "intake")
    assert saved["inputs"]["attachments"] == ["e1", "e2", "e3"]
    assert list(saved["inputs"]["pages"]) == ["https://jobs.example/1"]


async def test_a_set_intent_wins_over_the_plain_request(monkeypatch):
    saved = await _plain_request(monkeypatch, "fit")
    assert saved["scenario"] == "E"


async def _steer_state(monkeypatch, *, resume, tasks=(), text="회사 기술 위주로 봐줘"):
    from tests.harness_fakes import Rows

    snapshot = SimpleNamespace(values={"resume": resume}, tasks=tasks, next=())

    class FakeGraph:
        async def aget_state(self, config, subgraphs=False):
            return snapshot

    sent = []

    async def stream(self, graph, state, config, stream_mode):
        sent.append(state)
        return
        yield

    async def persist(self, *args):
        return None

    monkeypatch.setattr(HarnessRuntime, "_stream_graph", stream)
    monkeypatch.setattr(HarnessRuntime, "_persist", persist)
    runtime = HarnessRuntime(service(Rows({"company_id": None, "resume_state": resume})))
    _ = [item async for item in runtime._chat_turn(
        FakeGraph(), _payload(text, ai=None), {"resume_state": resume}, {}, None, None, {},
        REGISTRY["personal"])]
    return sent[0]


async def test_text_mid_flow_with_no_gate_open_steers_the_flow(monkeypatch):
    state = await _steer_state(monkeypatch, resume={"status": "active", "phase": "analyze"})
    assert state["steer"] == "회사 기술 위주로 봐줘"


async def test_no_steer_outside_a_flow_or_for_blank_text(monkeypatch):
    assert "steer" not in await _steer_state(monkeypatch, resume={"status": "done"})
    assert "steer" not in await _steer_state(
        monkeypatch, resume={"status": "active"}, text="  ")


async def test_text_at_a_resume_gate_still_answers_it_not_steers(monkeypatch):
    from langgraph.types import Command

    gate = SimpleNamespace(interrupts=[SimpleNamespace(value={
        "kind": "RESUME_GATE", "approval_id": "11111111-1111-4111-8111-111111111111"})])
    state = await _steer_state(monkeypatch, resume={"status": "active"}, tasks=(gate,))
    assert isinstance(state, Command)
    assert state.resume["text"] == "회사 기술 위주로 봐줘"


@pytest.mark.parametrize(("model", "cached"), [
    ("anthropic/claude-sonnet-5-5", True),
    ("anthropic/claude-sonnet-5-5:online", True),
    ("deepseek/deepseek-v4.1-flash", False),
])
def test_prompt_caching_is_asked_only_for_anthropic_models(model, cached):
    from app.framework.llm import chat_model_for

    config = SimpleNamespace(managed_ai_key="k", ai_base_url="https://openrouter.ai/api/v1")
    chat = chat_model_for(SimpleNamespace(model=model, effort=""), config=config)
    assert ("cache_control" in chat.extra_body) is cached
    if cached:
        assert chat.extra_body["cache_control"] == {"type": "ephemeral"}
    assert chat.model_name == model


# ---- employer flow events through the runtime stream ---------------------------------------------
_COMPANY = "3c000000-0000-4000-8000-000000000003"
_POSTING_SCRIPT = {
    "CompanyProfile": {"name": "회사 C", "summary": "창고 재고 웹 서비스"},
    "RoleOptions": {"options": [{"id": "fe", "label": "재고 화면 개발자"}]},
    "RoleSpec": {"need": "재고 화면 개발", "career_min": 1, "career_max": 3},
    "PostingDraft": {"title": "프론트엔드 개발자", "description": ["재고 화면을 만들어요"],
                     "requirements": ["웹 화면 개발 경험"], "preferred": []},
    "PostingReview": {"draft": {"title": "프론트엔드 개발자", "description": ["재고 화면"],
                                "requirements": ["웹 화면 개발 경험"], "preferred": []}},
}


def _employer(script: dict):
    from tests.loop.scripted import model_cls
    from tests.loop.scripted import service as loop_service

    svc = loop_service({"conversation": {"company_id": _COMPANY, "resume_state": None}})
    return svc, HarnessRuntime(svc, model_cls=model_cls(script))


def _custom(items, kind: str) -> list[dict]:
    return [chunk for mode, chunk in items if mode == "custom" and chunk.get("type") == kind]


def _answer(card: dict, option: str, job: str) -> dict:
    return _payload("", job_id=job, resume={"approvalId": card["id"], "optionId": option})


async def test_an_employer_gate_streams_its_card_once_and_the_answer_turn_does_not_resend_it():
    _svc, runtime = _employer(dict(_POSTING_SCRIPT))
    first = await run(runtime, _payload("공고 초안 만들어 줘", intent="posting"))
    cards = _custom(first, "choice")
    assert [card["gate"] for card in cards] == ["pf_role"]
    assert [chunk["awaiting"] for chunk in _custom(first, "done")] == ["choice"]
    second = await run(runtime, _answer(cards[0], "fe", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
    assert [card["gate"] for card in _custom(second, "choice")] == ["pf_confirm_1"]
    assert len(_custom(second, "done")) == 1


class _ReviewStore:
    async def application(self, app_id, company_id):
        return {"user_id": "u9", "job_category": "", "title": "주문 백엔드",
                "description": "주문 API", "requirements": [], "preferred": []}

    async def snapshots(self, app_id, company_id):
        return [{"title": "이력서", "content": "주문 API를 3년 운영했어요."}]

    async def applicant_context(self, user_id):
        return None

    async def save_review(self, *args, **kwargs):
        return "rev-1"


async def test_a_review_reply_said_before_its_gate_is_stored_once_on_that_turn(monkeypatch):
    from app.harness.employer import flows as flows_module

    monkeypatch.setattr(flows_module, "EmployerStore", lambda _db: _ReviewStore())
    svc, runtime = _employer({
        "Matches": {"matches": [
            {"requirement": "API 운영", "status": "MET", "evidence": "주문 API를 3년 운영했어요"}]},
        "ReviewReport": {"summary": "", "flags": [
            {"title": "역할", "level": "CHECK", "reason": "직접 한 일이 짧아요."}]},
        "서류 주장 읽기": {"claims": []},
    })
    first = await run(runtime, _payload(
        "서류 봐 줘", intent="review", application_id="a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1"))
    said = "".join(chunk["token"] for mode, chunk in first if mode == "custom" and "token" in chunk)
    [card] = _custom(first, "choice")
    [done] = _custom(first, "done")
    assert card["gate"] == "rv_report" and done.get("operation") is not None
    assert said.startswith("만든 것\n• 요건 1개") and svc.messages[-1].text == said
    second = await run(runtime, _answer(card, "later", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
    assert _custom(second, "choice") == []
    assert svc.messages[-1].text == "서류 검토를 마쳤어요." != said


async def test_a_personal_resume_turn_still_streams_each_event_once():
    rows = Rows({"company_id": None, "resume_state": {"status": "active", "phase": "mode_select"}})
    items = await run(HarnessRuntime(service(rows)), _payload("서류 만들어줘", ai=None))
    custom = [json.dumps(chunk, sort_keys=True, default=str)
              for mode, chunk in items if mode == "custom"]
    assert len(custom) == len(set(custom))
    assert len(_custom(items, "choice")) == len(_custom(items, "done")) == 1


# ---- the notes ledger lives as long as the flow's posting ----------------------------------------
_POSTING_A = "a0000000-0000-4000-8000-00000000000a"
_POSTING_B = "b0000000-0000-4000-8000-00000000000b"


class _FileRows(Rows):
    """Rows that keep workspace_files, seeded with what a finished flow for posting A left."""

    def __init__(self):
        super().__init__({"company_id": None, "resume_state": json.dumps({
            "status": "done", "phase": "done", "inputs": {"postingId": _POSTING_A}})})
        self.files = {"00_notes.json": "posting-a ledger",
                      "01_agent_company.json": "posting-a company", "resume.md": "draft"}

    async def execute(self, sql, *args):
        if sql.lstrip().startswith("DELETE FROM workspace_files"):
            self.files = {name: body for name, body in self.files.items()
                          if name != args[1] and not name.startswith("01_agent_")}
        return await super().execute(sql, *args)


@pytest.mark.parametrize(("posting", "kept"), [(_POSTING_B, False), (_POSTING_A, True)])
async def test_a_quick_start_on_another_posting_starts_with_an_empty_ledger(posting, kept):
    rows = _FileRows()
    await run(HarnessRuntime(service(rows)), _payload(
        "이 공고로 이력서 만들어줘", ai=None, intent="match_posting",
        context={"postingId": posting}))
    left = {name for name, body in rows.files.items() if body.startswith("posting-a")}
    assert left == ({"00_notes.json", "01_agent_company.json"} if kept else set())
    assert "resume.md" in rows.files
