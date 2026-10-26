from uuid import UUID, uuid4

import pytest

from app.claimctx import LostClaim, claim_job, claim_token
from app.infrastructure.store_chat_jobs import (
    STALE_RUNNING_S, ChatJobStore, QueueJobs, _affected, user_message_id,
)
from tests.cov_fakes import NOW, USER, fake_db

JOB = uuid4()


@pytest.fixture
def claimed():
    t1, t2 = claim_token.set("tok"), claim_job.set(str(JOB))
    yield "tok"
    claim_token.reset(t1)
    claim_job.reset(t2)


def test_affected_parses_command_tags():
    assert _affected(None) == 0 and _affected("") == 0
    assert _affected("UPDATE 3") == 3
    assert _affected("UPDATE x") == 0


def test_user_message_id_is_stable_per_job():
    assert user_message_id(JOB) == user_message_id(UUID(str(JOB)))
    assert user_message_id(JOB) != user_message_id(uuid4())


async def test_claim_returns_dict_or_none():
    db, conn = fake_db({"id": JOB}, None)
    s = ChatJobStore(db)
    assert await s.claim() == {"id": JOB}
    assert "FOR UPDATE SKIP LOCKED" in conn.last[1]
    assert await s.claim() is None


async def test_finish_unclaimed_does_not_reopen_terminal():
    db, conn = fake_db()
    await ChatJobStore(db).finish(JOB, "DONE", "e")
    _, sql, args = conn.last
    assert "status NOT IN ('DONE', 'FAILED', 'CANCELLED')" in sql
    assert args[:3] == (JOB, "DONE", "e")


async def test_finish_claimed_checks_token(claimed):
    db, conn = fake_db("UPDATE 1", "UPDATE 0")
    s = ChatJobStore(db)
    await s.finish(JOB, "DONE")
    assert conn.last[2][-1] == "tok"
    with pytest.raises(LostClaim):
        await s.finish(JOB, "DONE")


async def test_requeue_clears_events_only_when_row_changed():
    db, conn = fake_db("UPDATE 1", "DELETE 2", "UPDATE 0")
    s = ChatJobStore(db)
    await s.requeue(JOB, 1.5)
    assert conn.calls[0][2][:2] == (JOB, 1.5)
    assert conn.calls[1][1].startswith("DELETE FROM chat_events")
    await s.requeue(JOB, 0)
    assert len(conn.calls) == 3


async def test_reset_stale_default_and_explicit_age():
    db, conn = fake_db(None, 4, None, None)
    s = ChatJobStore(db)
    assert await s.reset_stale() == 4
    assert conn.calls[0][2][1] == STALE_RUNNING_S
    assert conn.calls[1][2][1] == STALE_RUNNING_S
    assert await s.reset_stale(0) == 0
    assert conn.calls[3][2][1] == 0


async def test_emit_paths_without_claim():
    db, conn = fake_db()
    s = ChatJobStore(db)
    await s.emit(JOB, "error", {"at": NOW})
    assert "status NOT IN ('DONE', 'FAILED')" in conn.last[1]
    assert conn.last[2] == (JOB, "error", {"at": "2026-01-02T03:04:05Z"})
    await s.emit(JOB, "token", {"t": "a"})
    assert "VALUES ($1,$2,$3)" in conn.last[1]


async def test_emit_with_claim(claimed):
    db, conn = fake_db("INSERT 0 1", "INSERT 0 0")
    s = ChatJobStore(db)
    await s.emit(JOB, "token", {})
    assert conn.last[2][-1] == "tok"
    with pytest.raises(LostClaim):
        await s.emit(JOB, "token", {})


async def test_reads_are_scoped():
    conv = uuid4()
    db, conn = fake_db(JOB, "RUNNING", 9, None, [{"id": 1, "type": "t", "payload": {}}])
    s = ChatJobStore(db)
    assert await s.active_for_conversation(USER, conv) == JOB
    assert conn.last[2] == (USER, conv) and "user_id=$1" in conn.last[1]
    assert await s.status(JOB) == "RUNNING"
    assert await s.max_event_id(JOB) == 9
    assert await s.max_event_id(JOB) == 0
    assert await s.events_since(JOB, 3) == [{"id": 1, "type": "t", "payload": {}}]
    assert conn.last[2] == (JOB, 3)


async def test_delete_events_after_unclaimed_and_claimed(claimed):
    db, conn = fake_db({"ok": 1}, None)
    s = ChatJobStore(db)
    await s.delete_events_after(JOB, 5)
    assert conn.last[2] == (JOB, 5, "tok")
    with pytest.raises(LostClaim):
        await s.delete_events_after(JOB, 5)


async def test_delete_events_after_without_claim():
    db, conn = fake_db()
    await ChatJobStore(db).delete_events_after(JOB, 5)
    assert conn.last == ("execute", "DELETE FROM chat_events WHERE job_id=$1 AND id>$2", (JOB, 5))


async def test_emit_many_empty_and_unclaimed():
    db, conn = fake_db()
    s = ChatJobStore(db)
    await s.emit_many(JOB, [])
    assert conn.calls == []
    await s.emit_many(JOB, [("a", {"x": 1}), ("b", {})])
    assert conn.last[0] == "executemany"
    assert conn.last[2][0] == [(JOB, "a", {"x": 1}), (JOB, "b", {})]


async def test_emit_many_claimed(claimed):
    db, conn = fake_db("INSERT 0 1", "INSERT 0 0")
    s = ChatJobStore(db)
    await s.emit_many(JOB, [("a", {"x": 1})])
    assert conn.last[2][1] == '[{"type": "a", "payload": {"x": 1}}]'
    with pytest.raises(LostClaim):
        await s.emit_many(JOB, [("a", {})])


async def test_claim_variants_and_get():
    db, conn = fake_db({"id": JOB}, None, {"id": JOB}, None, {"id": JOB}, None)
    s = ChatJobStore(db)
    assert await s.claim_with_token(JOB, "c") == {"id": JOB}
    assert conn.last[2][0] == JOB and conn.last[2][2] == "c"
    assert await s.claim_with_token(JOB, "c") is None
    assert await s.claim_id(JOB) == {"id": JOB}
    assert await s.claim_id(JOB) is None
    assert await s.get(JOB) == {"id": JOB}
    assert await s.get(JOB) is None


async def test_touch_owner():
    db, conn = fake_db("UPDATE 1", "UPDATE 0")
    s = ChatJobStore(db)
    assert await s.touch_owner(JOB, "c") is True
    assert conn.last[2][:2] == (JOB, "c")
    assert await s.touch_owner(JOB, "c") is False


async def test_save_checkpoint_unclaimed():
    db, conn = fake_db()
    await ChatJobStore(db).save_checkpoint(JOB, {"a": 1})
    assert conn.last[2][:2] == (JOB, {"a": 1})


async def test_save_checkpoint_claimed_keeps_token(claimed):
    db, conn = fake_db("UPDATE 1", "UPDATE 0")
    s = ChatJobStore(db)
    await s.save_checkpoint(JOB, {"a": 1})
    assert conn.last[2][1] == {"a": 1, "claim": "tok"} and conn.last[2][-1] == "tok"
    with pytest.raises(LostClaim):
        await s.save_checkpoint(JOB, {})


async def test_pending_ids():
    db, conn = fake_db([{"id": JOB}])
    assert await ChatJobStore(db).pending_ids(3, 10) == [JOB]
    assert conn.last[2] == (3, 10)


async def test_queue_jobs_delegate_to_worker_sql():
    row = {"status": "RETRY"}
    db, conn = fake_db({"id": JOB}, None, None, row, None, None, None, None, None, "DONE", None)
    q = QueueJobs(ChatJobStore(db))
    assert await q.claim(JOB, NOW) == {"id": JOB}
    assert "ai_jobs" in conn.last[1] and conn.last[2] == (JOB, NOW)
    assert await q.claim(JOB, NOW) is None
    await q.finish(JOB, {"r": 1}, NOW)
    assert conn.last[2] == (JOB, {"r": 1}, NOW)
    assert await q.fail(JOB, {"e": 1}, NOW) == row
    await q.fail_final(JOB, {"e": 1}, NOW)
    assert "'FAILED'" in conn.last[1]
    await q.release_claim(JOB, NOW)
    assert "'QUEUED'" in conn.last[1]
    await q.touch(JOB, NOW)
    assert "heartbeat_at=$2" in conn.last[1]
    await q.emit(JOB, "token", {})
    assert "chat_events" in conn.last[1]
    await q.cancel(JOB, NOW)
    assert "'CANCELLED'" in conn.last[1]
    s = q.store
    assert await s.worker_status(JOB) == "DONE"
    await s.worker_set_state(JOB, "idle")
    assert conn.last[2][:2] == (JOB, "idle")
