"""A cron nudge must not start a second Workflow for a live chat."""

from __future__ import annotations

import asyncio
import os
import socket
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.claimctx import LostClaim, claim_job, claim_token
from app.domain import entities as ent
from app.domain.services.ai import usage_row_id
from app.domain.services.conversation import ConversationService
from app.infrastructure.store_ai import AiUsageStore
from app.infrastructure.store_chat_jobs import (
    NUDGE_PENDING_AGE_S,
    STALE_RUNNING_S,
    ChatJobStore,
)
from app.jobs import schedule_chat_job, set_job_scheduler
from app.pgproto import PgPool

DSN = os.environ.get(
    "PGPROTO_DSN", "postgresql://push:push@127.0.0.1:5432/push?sslmode=disable")


def _postgres_up() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", 5432), timeout=1):
            return True
    except OSError:
        return False


class _Rec:
    def __init__(self):
        self.calls = []

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        return "UPDATE 1"

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        return 0

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        return []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return None


class _DB:
    def __init__(self, conn):
        self.pool = conn

    def q(self):
        return self.pool


def test_stale_threshold_outlasts_the_workflow():
    budget = 6 * (3 + 3 + 1) * 60 + 3 * (2 + 4 + 8 + 16 + 32)
    assert STALE_RUNNING_S > budget
    assert NUDGE_PENDING_AGE_S == 60


@pytest.mark.asyncio
async def test_reset_and_nudge_sql_require_age():
    rec = _Rec()
    store = ChatJobStore(_DB(rec))
    await store.reset_stale()
    fail_sql, fail_args = rec.calls[0]
    reset_sql, reset_args = rec.calls[1]
    assert "make_interval" in fail_sql
    assert "make_interval" in reset_sql
    assert "- 'claim'" in reset_sql
    assert fail_args[1] == STALE_RUNNING_S
    assert reset_args[1] == STALE_RUNNING_S
    await store.pending_ids(5)
    pending_sql, pending_args = rec.calls[2]
    assert "created_at" in pending_sql
    assert pending_args == (5, NUDGE_PENDING_AGE_S)
    await store.reset_stale(0)
    assert rec.calls[3][1][1] == 0


@pytest.mark.asyncio
async def test_schedule_gives_each_run_its_own_claim():
    seen = []

    async def sched(job_id, claim):
        seen.append((job_id, claim))

    set_job_scheduler(sched)
    try:
        await schedule_chat_job("job-1")
        await schedule_chat_job("job-1")
    finally:
        set_job_scheduler(None)
    assert seen[0][0] == "job-1"
    assert seen[0][1] and seen[0][1] != seen[1][1]


@pytest.mark.asyncio
async def test_a_type_error_inside_the_scheduler_is_not_retried():
    # The old 1-argument fallback re-ran the scheduler on any TypeError,
    # starting a second run with no claim.
    calls = []

    async def sched(job_id, claim=""):
        calls.append((job_id, claim))
        raise TypeError("binding rejected the payload")

    set_job_scheduler(sched)
    try:
        with pytest.raises(TypeError):
            await schedule_chat_job("job-2")
    finally:
        set_job_scheduler(None)
    assert len(calls) == 1 and calls[0][1]


@pytest.mark.asyncio
async def test_workflow_params_carry_the_claim():
    from worker import _create_workflow
    seen = {}

    class Binding:
        async def create(self, body):
            seen["body"] = body

    await _create_workflow(SimpleNamespace(CHAT_WORKFLOW=Binding()), "job", "claim-1")
    assert seen["body"]["params"] == {"jobId": "job", "claim": "claim-1"}


@pytest.mark.asyncio
async def test_local_restart_resets_without_waiting():
    seen = []

    class Jobs:
        async def reset_stale(self, max_age_s=None):
            seen.append(max_age_s)
            return 0

        async def claim(self):
            await asyncio.sleep(30)

    svc = ConversationService.__new__(ConversationService)
    svc.jobs = Jobs()
    svc._inflight = set()
    await svc.start_worker()
    await svc.stop_worker()
    assert seen == [0]


@pytest.mark.asyncio
async def test_production_persist_retries_when_completion_is_missing(monkeypatch):
    monkeypatch.setenv("CHAT_EXECUTOR", "workflow")
    ran = []

    class DB:
        async def run(self, fn):
            ran.append(fn)

    from app.graphs.chat import bind_chat_nodes
    nodes = bind_chat_nodes(SimpleNamespace(db=DB()))
    with pytest.raises(RuntimeError, match="chat completion missing"):
        await nodes["persist"]({
            "user_id": uuid4(),
            "text": "안녕",
            "attachments": [],
            "completion": None,
            "conversation": SimpleNamespace(id=uuid4()),
            "job_id": str(uuid4()),
        })
    assert ran == []


def test_usage_ids_are_stable_per_job():
    job = uuid4()
    assert usage_row_id(job, "chat") == usage_row_id(job, "chat")
    assert usage_row_id(job, "chat") != usage_row_id(job, "meter:embed")
    assert usage_row_id(job, "chat") != usage_row_id(uuid4(), "chat")
    assert usage_row_id(None, "chat") != usage_row_id(None, "chat")


@pytest.mark.asyncio
async def test_usage_insert_is_idempotent_and_claim_gated():
    rec = _Rec()
    store = AiUsageStore(_DB(rec))
    row = ent.AiUsage(
        id=usage_row_id("job", "chat"), user_id=uuid4(), provider="OPENAI",
        model="m", managed=True, input_tokens=1, output_tokens=2,
        cost_micro_credits=3, status=ent.USAGE_SETTLED,
        created_at=datetime.now(timezone.utc))
    await store.create(row)
    assert "ON CONFLICT" in rec.calls[0][0]
    token = claim_token.set("claim-a")
    job = claim_job.set(str(uuid4()))
    try:
        await store.create(row)
    finally:
        claim_token.reset(token)
        claim_job.reset(job)
    sql = rec.calls[1][0]
    assert "chat_jobs" in sql
    assert "checkpoint->>'claim'" in sql
    assert "ON CONFLICT" in sql


@pytest.mark.skipif(not _postgres_up(), reason="postgres not reachable")
@pytest.mark.asyncio
async def test_cron_and_second_workflow_cannot_steal_a_live_job():
    pool = PgPool(DSN, transport="tcp")
    schema = "claim_" + uuid4().hex[:8]
    store = ChatJobStore(_DB(pool))
    usage = AiUsageStore(_DB(pool))
    try:
        await pool.execute(f"CREATE SCHEMA {schema}")
        await pool.execute(f"SET search_path TO {schema}")
        await pool.execute(
            "CREATE TABLE chat_jobs ("
            "id uuid PRIMARY KEY, user_id uuid NOT NULL, "
            "conversation_id uuid NOT NULL, payload jsonb NOT NULL DEFAULT '{}', "
            "status text NOT NULL DEFAULT 'PENDING', attempt int NOT NULL DEFAULT 0, "
            "run_at timestamptz NOT NULL DEFAULT now(), "
            "created_at timestamptz NOT NULL DEFAULT now(), "
            "updated_at timestamptz NOT NULL DEFAULT now(), error text, "
            "checkpoint jsonb NOT NULL DEFAULT '{}')")
        await pool.execute(
            "CREATE TABLE chat_events ("
            "id bigserial PRIMARY KEY, job_id uuid NOT NULL, "
            "type text NOT NULL, payload jsonb NOT NULL)")
        await pool.execute(
            "CREATE TABLE ai_usage ("
            "id uuid PRIMARY KEY, user_id uuid NOT NULL, operation_id uuid, "
            "provider text NOT NULL, model text NOT NULL, managed boolean NOT NULL, "
            "input_tokens int NOT NULL, output_tokens int NOT NULL, "
            "cost_micro_credits int NOT NULL, status text NOT NULL, "
            "created_at timestamptz NOT NULL)")
        uid = uuid4()
        fresh = uuid4()
        aged = uuid4()
        young_attempt = uuid4()
        dead = uuid4()
        await pool.execute(
            "INSERT INTO chat_jobs (id, user_id, conversation_id, payload) "
            "VALUES ($1,$2,$3,$4)", fresh, uid, uuid4(), {"text": "hi"})
        assert await store.pending_ids(5) == []

        await pool.execute(
            "INSERT INTO chat_jobs (id, user_id, conversation_id, payload, created_at) "
            "VALUES ($1,$2,$3,$4, now() - interval '2 minutes')",
            aged, uid, uuid4(), {"text": "old"})
        assert await store.pending_ids(5) == [aged]

        assert await store.claim_with_token(fresh, "claim-a") is not None
        assert await store.claim_with_token(fresh, "claim-b") is None
        assert await store.reset_stale() == 0
        assert (await store.get(fresh))["status"] == "RUNNING"

        await pool.execute(
            "INSERT INTO chat_jobs (id, user_id, conversation_id, status, attempt) "
            "VALUES ($1,$2,$3,'RUNNING',5)", young_attempt, uid, uuid4())
        assert await store.reset_stale() == 0
        assert (await store.get(young_attempt))["status"] == "RUNNING"

        await pool.execute(
            "INSERT INTO chat_jobs (id, user_id, conversation_id, status, attempt, "
            "updated_at) VALUES ($1,$2,$3,'RUNNING',5, now() - interval '2 hours')",
            dead, uid, uuid4())
        assert await store.reset_stale() == 0
        assert (await store.get(dead))["status"] == "FAILED"

        token = claim_token.set("claim-a")
        bound = claim_job.set(str(fresh))
        try:
            await store.emit(fresh, "status", {"text": "응답 작성 중"})
            await store.save_checkpoint(fresh, {"state": {"completion": "real"}, "node": "generate_reply"})
            claim_token.set("claim-b")
            with pytest.raises(LostClaim):
                await store.emit(fresh, "token", {"text": "다른 실행"})
            with pytest.raises(LostClaim):
                await store.save_checkpoint(fresh, {"state": {}})
            with pytest.raises(LostClaim):
                await store.finish(fresh, "FAILED", "PROVIDER_ERROR")
            claim_token.set("claim-a")
            row_id = usage_row_id(fresh, "chat")
            now = datetime.now(timezone.utc)
            usage_row = ent.AiUsage(
                id=row_id, user_id=uid, provider="OPENAI", model="m",
                managed=True, input_tokens=3, output_tokens=4,
                cost_micro_credits=5, status=ent.USAGE_RESERVED, created_at=now)
            await usage.create(usage_row)
            usage_row.status = ent.USAGE_SETTLED
            usage_row.output_tokens = 9
            await usage.create(usage_row)
            claim_token.set("claim-b")
            with pytest.raises(LostClaim):
                await usage.create(usage_row)
            claim_token.set("claim-a")
            usage_row.status = ent.USAGE_RESERVED
            usage_row.output_tokens = 1
            await usage.create(usage_row)
            await store.emit(fresh, "done", {"operation": {"status": "SUCCEEDED"}})
            await store.finish(fresh, "DONE")
            with pytest.raises(LostClaim):
                await store.emit(fresh, "error", {"error": {"code": "PROVIDER_ERROR"}})
            with pytest.raises(LostClaim):
                await store.finish(fresh, "FAILED", "PROVIDER_ERROR")
        finally:
            claim_token.reset(token)
            claim_job.reset(bound)

        job = await store.get(fresh)
        assert job["status"] == "DONE"
        assert job["checkpoint"]["claim"] == "claim-a"
        assert job["checkpoint"]["state"]["completion"] == "real"
        types = [e["type"] for e in await store.events_since(fresh, 0)]
        assert types == ["status", "done"]
        assert await pool.fetchval("SELECT count(*) FROM ai_usage WHERE user_id=$1", uid) == 1
        saved = await pool.fetchrow("SELECT status, output_tokens FROM ai_usage WHERE id=$1", row_id)
        assert saved["status"] == "SETTLED"
        assert saved["output_tokens"] == 9

        claim_token.set("")
        claim_job.set("")
        await store.finish(fresh, "FAILED", "late")
        await store.emit(fresh, "error", {"error": {"code": "PROVIDER_ERROR"}})
        assert (await store.get(fresh))["status"] == "DONE"
        assert [e["type"] for e in await store.events_since(fresh, 0)] == ["status", "done"]

        racing = uuid4()
        await pool.execute(
            "INSERT INTO chat_jobs (id, user_id, conversation_id, payload, "
            "created_at) VALUES ($1,$2,$3,$4, now() - interval '2 minutes')",
            racing, uid, uuid4(), {"text": "race"})
        called = []

        async def node(state):
            called.append(state["job_id"])
            from app.graphs.chat import event_sink
            event_sink.get().append({"status": "응답 작성 중"})
            return {}

        svc = ConversationService.__new__(ConversationService)
        svc.jobs = store
        svc.ai = SimpleNamespace()
        svc.chat_nodes = {"generate_reply": node, "persist": node}
        assert await svc.claim_for_workflow(str(racing), "run-a") == "ok"
        assert await svc.claim_for_workflow(str(racing), "run-b") == "skip"
        assert await svc.exec_chat_node(str(racing), "generate_reply", "run-b") == "skip"
        assert called == []
        assert await svc.exec_chat_node(str(racing), "generate_reply", "run-a") == "ok"
        assert called == [str(racing)]
        assert any(e["type"] == "status" for e in await store.events_since(racing, 0))

        await pool.execute(
            "UPDATE chat_jobs SET updated_at = now() - interval '2 hours' WHERE id=$1",
            racing)
        assert await store.reset_stale() == 1
        assert (await store.get(racing))["status"] == "PENDING"
        assert "claim" not in ((await store.get(racing))["checkpoint"] or {})
        assert await store.events_since(racing, 0) == []
        before = len(called)
        assert await svc.exec_chat_node(str(racing), "persist", "run-a") == "skip"
        assert len(called) == before
        assert (await store.get(racing))["status"] == "PENDING"
        assert await svc.claim_for_workflow(str(racing), "run-c") == "ok"
        assert (await store.get(racing))["checkpoint"]["claim"] == "run-c"

        scheduled = []

        async def sched(job_id, claim):
            scheduled.append((job_id, claim))

        set_job_scheduler(sched)
        try:
            nudged = await svc.nudge_pending()
        finally:
            set_job_scheduler(None)
        # fresh RUNNING and the just-claimed race stay put. The aged PENDING
        # job is the only one old enough to schedule again.
        assert nudged == 1
        assert scheduled[0][0] == str(aged)
        assert scheduled[0][1]
    finally:
        set_job_scheduler(None)
        claim_token.set("")
        claim_job.set("")
        try:
            await pool.execute("SET search_path TO public")
            await pool.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
        finally:
            await pool.close()
