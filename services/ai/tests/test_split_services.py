"""push-bot and push-agent are two services over one shared package.

What keeps them apart: who may import whom, what each process loads, which routes each answers,
which stream each worker reads, and what happens to a job that lands on the wrong side.
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fakeredis.aioredis import FakeRedis

from app.harness.registry import REGISTRY
from app.harness.router import HarnessNotLoaded, select_harness
from app.infrastructure.store_chat_jobs import ChatJobStore, QueueJobs
from app.queue.config import QUEUE_GROUPS, TURN_QUEUES, visibility_limits
from app.queue.streams import StreamQueue
from tests.test_chat_claim import _DB, _Rec
from tests.test_queue_worker import FIRST, NOW, MemoryJobs, handler, queued, worker

SRC = Path(__file__).resolve().parents[1] / "src"
COMPANY = "55555555-5555-4555-8555-555555555555"


def _imports(package: str) -> set[str]:
    found: set[str] = set()
    for path in (SRC / package).rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                found.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                found.add(node.module)
    return found


def _reaches(imports: set[str], package: str) -> set[str]:
    return {name for name in imports if name == package or name.startswith(package + ".")}


def test_the_shared_package_imports_neither_service():
    imports = _imports("app")
    assert not _reaches(imports, "push_bot")
    assert not _reaches(imports, "push_agent")


def test_the_services_do_not_import_each_other():
    assert not _reaches(_imports("push_bot"), "push_agent")
    assert not _reaches(_imports("push_agent"), "push_bot")


def test_push_agent_reads_the_engine_not_the_personal_harness():
    assert not _reaches(_imports("push_agent"), "app.harness.personal")


def _loaded_by(module: str) -> dict:
    """What a fresh interpreter holds after importing one service's entry points."""
    code = (
        "import json, sys\n"
        f"import {module}.main, {module}.worker\n"
        "from app.harness.registry import REGISTRY\n"
        f"routes = sorted({module}.main.app.openapi()['paths'])\n"
        "tops = sorted({name.split('.')[0] for name in sys.modules if name.startswith('push_')})\n"
        "print(json.dumps({'harnesses': sorted(REGISTRY), 'services': tops, 'routes': routes,\n"
        f"                  'audience': {module}.main.app.state.audience, 'queues': {module}.worker.QUEUES}}))\n"
    )
    env = {**os.environ, "PYTHONPATH": str(SRC)}
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.fixture(scope="module")
def bot():
    return _loaded_by("push_bot")


@pytest.fixture(scope="module")
def agent():
    return _loaded_by("push_agent")


def test_push_bot_loads_no_employer_code(bot):
    assert bot["services"] == ["push_bot"]
    assert bot["harnesses"] == ["personal"]
    assert bot["audience"] == "personal"
    assert bot["queues"] == ["q:chat:priority", "q:chat", "q:document"]


def test_push_agent_loads_the_employer_harness_and_no_bot_code(agent):
    assert agent["services"] == ["push_agent"]
    assert "employer" in agent["harnesses"]
    assert agent["audience"] == "company"
    assert agent["queues"] == ["q:agent:priority", "q:agent"]


def test_push_bot_answers_every_ai_route_the_gateway_forwards(bot):
    for path in (
        "/api/v1/bots/{id}/transcript", "/api/v1/approvals", "/api/v1/ai/generate",
        "/api/v1/conversations/{id}/turns", "/api/v1/documents/{id}/revisions",
        "/api/v1/me/profile/pdf", "/internal/chat/schedule", "/healthz", "/api/v1/healthz",
    ):
        assert path in bot["routes"], path


def test_push_agent_answers_only_a_conversations_read_routes_the_wake_and_health(agent):
    api = {path for path in agent["routes"] if path.startswith("/api/v1/")}
    assert api == {
        "/api/v1/conversations/{id}/share", "/api/v1/conversations/shared/{token}",
        "/api/v1/conversations/{id}/artifacts", "/api/v1/conversations/{id}/turns", "/api/v1/healthz",
    }
    assert {"/internal/chat/schedule", "/healthz"} <= set(agent["routes"])


def test_a_company_conversation_needs_the_harness_only_push_agent_registers(monkeypatch):
    assert select_harness({"company_id": COMPANY}).id == "employer"
    assert select_harness({"company_id": None}).id == "personal"
    monkeypatch.delitem(REGISTRY, "employer")
    assert select_harness({}).id == "personal"
    with pytest.raises(HarnessNotLoaded):
        select_harness({"company_id": COMPANY})


def test_the_employer_spec_brings_its_own_graph_and_flow_start():
    from push_agent.harness.graph import build_employer_graph
    from push_agent.harness.spec import EMPLOYER, employer_start

    assert REGISTRY["employer"] is EMPLOYER
    assert EMPLOYER.build_graph is build_employer_graph
    assert EMPLOYER.start_flow is employer_start
    assert REGISTRY["personal"].build_graph is None and REGISTRY["personal"].start_flow is None


def test_each_stream_has_one_group_and_the_agent_streams_are_their_own():
    assert QUEUE_GROUPS["q:agent"] == QUEUE_GROUPS["q:agent:priority"] == "agent"
    assert QUEUE_GROUPS["q:chat"] == QUEUE_GROUPS["q:chat:priority"] == QUEUE_GROUPS["q:document"] == "ai"
    assert TURN_QUEUES == {"chat": "q:chat", "employer_ai": "q:agent"}
    assert set(QUEUE_GROUPS) <= set(visibility_limits())


def _employer(id_, queue):
    return {**queued(id_, queue), "type": "employer_ai", "company_id": COMPANY}


BOT_QUEUES = ["q:chat:priority", "q:chat", "q:document"]
AGENT_QUEUES = ["q:agent:priority", "q:agent"]


@pytest.mark.asyncio
@pytest.mark.parametrize(("landed", "home"), [("q:chat", "q:agent"), ("q:chat:priority", "q:agent:priority")])
async def test_push_bot_forwards_an_employer_turn_to_the_agent_stream(landed, home):
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    db = MemoryJobs()
    db.jobs[FIRST] = _employer(FIRST, landed)
    await queue.add(landed, FIRST)
    ran = []

    async def chat(ctx):
        ran.append(ctx.job["id"])
        return {}

    bot_worker = worker(redis, db, {"chat": chat}, queues=BOT_QUEUES)
    (msg,) = await bot_worker.next_messages()
    assert await bot_worker.process(msg) == "forwarded"
    assert ran == []
    assert (db.jobs[FIRST]["status"], db.jobs[FIRST]["queue"]) == ("QUEUED", home)
    assert await queue.live_job_ids(landed, "ai") == set()

    agent_worker = worker(redis, db, {"employer_ai": handler}, queues=AGENT_QUEUES)
    agent_worker.group = "agent"
    (msg,) = await agent_worker.next_messages()
    assert msg.queue == home
    assert await agent_worker.process(msg) == "done"
    assert db.jobs[FIRST]["status"] == "DONE"


@pytest.mark.asyncio
async def test_push_agent_forwards_a_personal_turn_back_to_the_bot_stream():
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    db = MemoryJobs()
    db.jobs[FIRST] = queued(FIRST, "q:agent")
    await queue.add("q:agent", FIRST)
    agent_worker = worker(redis, db, {"employer_ai": handler}, queues=AGENT_QUEUES)
    agent_worker.group = "agent"
    (msg,) = await agent_worker.next_messages()
    assert await agent_worker.process(msg) == "forwarded"
    assert (db.jobs[FIRST]["status"], db.jobs[FIRST]["queue"]) == ("QUEUED", "q:chat")
    assert await queue.live_job_ids("q:chat", "ai") == {str(FIRST)}


@pytest.mark.asyncio
async def test_a_worker_that_reads_the_home_stream_does_not_forward_to_itself():
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    db = MemoryJobs()
    db.jobs[FIRST] = _employer(FIRST, "q:agent")
    await queue.add("q:agent", FIRST)
    lone = worker(redis, db, {"fit": handler}, queues=AGENT_QUEUES)
    lone.group = "agent"
    (msg,) = await lone.next_messages()
    assert await lone.process(msg) == "failed"
    assert db.jobs[FIRST]["queue"] == "q:agent"
    assert db.jobs[FIRST]["status"] == "RETRY"


@pytest.mark.asyncio
async def test_a_job_type_with_no_home_stream_still_fails_instead_of_moving():
    redis = FakeRedis(decode_responses=True)
    queue = StreamQueue(redis)
    db = MemoryJobs()
    db.jobs[FIRST] = {**queued(FIRST, "q:chat"), "type": "document"}
    await queue.add("q:chat", FIRST)
    agent_like = worker(redis, db, {"chat": handler}, queues=BOT_QUEUES)
    (msg,) = await agent_like.next_messages()
    assert await agent_like.process(msg) == "failed"
    assert db.jobs[FIRST]["queue"] == "q:chat"


@pytest.mark.asyncio
async def test_forward_moves_the_row_to_the_new_stream():
    rec = _Rec()
    await QueueJobs(ChatJobStore(_DB(rec))).forward(FIRST, "q:agent", NOW)
    (sql, args), = rec.calls
    assert "UPDATE ai_jobs SET status='QUEUED', queue=$2" in sql and "status='RUNNING'" in sql
    assert args == (FIRST, "q:agent", NOW)


@pytest.mark.asyncio
@pytest.mark.parametrize(("audience", "clause"), [
    ("personal", " AND NOT EXISTS (SELECT 1 FROM conversations c"),
    ("company", " AND EXISTS (SELECT 1 FROM conversations c"),
])
async def test_the_in_process_worker_claims_and_requeues_only_its_audience(audience, clause):
    rec = _Rec()
    store = ChatJobStore(_DB(rec), audience)
    await store.claim()
    await store.reset_stale()
    assert len(rec.calls) == 3
    for sql, _args in rec.calls:
        assert clause in sql
        assert "c.id = chat_jobs.conversation_id AND c.company_id IS NOT NULL" in sql


@pytest.mark.asyncio
async def test_without_an_audience_the_in_process_worker_takes_every_job():
    rec = _Rec()
    store = ChatJobStore(_DB(rec))
    await store.claim()
    await store.reset_stale()
    assert all("conversations" not in sql for sql, _args in rec.calls)


def test_each_service_tells_its_app_whose_jobs_to_claim():
    from app.main import create_app

    assert create_app().state.audience is None
    assert create_app(audience="company").state.audience == "company"
