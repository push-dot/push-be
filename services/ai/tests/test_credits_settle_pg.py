"""Settle, release and admin retry keep the available balance at or above zero.

Runs on a migrated Postgres (BILLING_PG_URL, set by the CI test-db job) and skips elsewhere.
"""

import asyncio
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.queue.admin import AdminJobs
from app.queue.credits import ShortBalance, available_micro, release_job, settle_job
from app.queue.dispatcher import PgJobs

NOW = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
async def pg():
    url = os.environ.get("BILLING_PG_URL")
    if not url:
        pytest.skip("BILLING_PG_URL not set")
    asyncpg = pytest.importorskip("asyncpg")
    pool = await asyncpg.create_pool(url, min_size=1, max_size=4)
    users, companies = [], []

    async def user():
        uid = uuid4()
        await pool.execute(
            "INSERT INTO users (id, provider, provider_subject, display_name) VALUES ($1, 'email', $2, 'a')",
            uid, str(uid))
        users.append(uid)
        return uid

    async def company(member):
        cid = uuid4()
        await pool.execute("INSERT INTO companies (id, name) VALUES ($1, 'c')", cid)
        await pool.execute(
            "INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'ADMIN')", cid, member)
        companies.append(cid)
        return cid

    yield pool, user, company
    for cid in companies:
        await pool.execute("DELETE FROM billing_ledger WHERE company_id = $1", cid)
    for uid in users:
        await pool.execute("DELETE FROM ai_usage WHERE user_id = $1", uid)
        await pool.execute("DELETE FROM ai_jobs WHERE user_id = $1", uid)
        await pool.execute("DELETE FROM billing_ledger WHERE user_id = $1", uid)
        await pool.execute("DELETE FROM company_members WHERE user_id = $1", uid)
    for cid in companies:
        await pool.execute("DELETE FROM companies WHERE id = $1", cid)
    for uid in users:
        await pool.execute("DELETE FROM users WHERE id = $1", uid)
    await pool.close()


async def grant(pool, amount, user=None, company=None):
    await pool.execute(
        "INSERT INTO billing_ledger (id, user_id, company_id, type, amount_micro_credits, balance_after, reference_id) "
        "SELECT $1, $2, $3, 'PURCHASE', $4, COALESCE((SELECT balance_after FROM billing_ledger WHERE user_id = $2 "
        "ORDER BY seq DESC LIMIT 1), 0) + $4, $5", uuid4(), user, company, amount, "grant:" + str(uuid4()))


async def job(pool, user, reserve, used, *, company=None, status="RUNNING", reservation="RESERVED"):
    jid = uuid4()
    await pool.execute(
        "INSERT INTO ai_jobs (id, type, queue, user_id, company_id, status, max_attempts, payload, updated_at) "
        "VALUES ($1, 'chat', 'q:chat', $2, $3, $4, 3, '{}', $5)", jid, user, company, status, NOW - timedelta(hours=1))
    await pool.execute(
        "INSERT INTO credit_reservations (job_id, user_id, company_id, amount_micro, status) VALUES ($1, $2, $3, $4, $5)",
        jid, user, company, reserve, reservation)
    if used:
        await pool.execute(
            "INSERT INTO ai_usage (id, user_id, provider, model, managed, input_tokens, output_tokens, "
            "cost_micro_credits, status, job_id) VALUES ($1, $2, 'OPENAI', 'm', true, 1, 1, $3, 'SETTLED', $4)",
            uuid4(), user, used, jid)
    return jid


async def write_offs(pool, owner_col, owner):
    return [int(r["amount_micro_credits"]) for r in await pool.fetch(
        f"SELECT amount_micro_credits FROM billing_ledger WHERE {owner_col} = $1 AND type = 'WRITE_OFF' ORDER BY seq",
        owner)]


async def use(pool, user, jid, used):
    await pool.execute(
        "INSERT INTO ai_usage (id, user_id, provider, model, managed, input_tokens, output_tokens, "
        "cost_micro_credits, status, job_id) VALUES ($1, $2, 'OPENAI', 'm', true, 1, 1, $3, 'SETTLED', $4)",
        uuid4(), user, used, jid)


async def settle(pool, jid):
    async with pool.acquire() as conn:
        return await settle_job(conn, jid, NOW)


async def available(pool, user, company=None):
    async with pool.acquire() as conn:
        return await available_micro(conn, user, company)


@pytest.mark.asyncio
async def test_settle_writes_off_only_the_overrun_past_the_balance(pg):
    pool, new_user, _ = pg
    user = await new_user()
    await grant(pool, 100, user=user)
    jid = await job(pool, user, 80, 150)
    assert await settle(pool, jid) == 0
    # 150 used against 80 held and 20 free: 50 is written off, not charged.
    assert await write_offs(pool, "user_id", user) == [50]
    assert await available(pool, user) == 0
    assert await settle(pool, jid) == 0
    assert await write_offs(pool, "user_id", user) == [50]


@pytest.mark.asyncio
async def test_settle_charges_an_overrun_the_balance_covers(pg):
    pool, new_user, _ = pg
    user = await new_user()
    await grant(pool, 1000, user=user)
    jid = await job(pool, user, 80, 150)
    await settle(pool, jid)
    assert await write_offs(pool, "user_id", user) == []
    assert await available(pool, user) == 850


@pytest.mark.asyncio
async def test_settle_caps_a_company_overrun(pg):
    pool, new_user, new_company = pg
    user = await new_user()
    company = await new_company(user)
    await grant(pool, 100, company=company)
    jid = await job(pool, user, 80, 300, company=company)
    await settle(pool, jid)
    assert await write_offs(pool, "company_id", company) == [200]
    assert await available(pool, user, company) == 0


@pytest.mark.asyncio
async def test_concurrent_overruns_of_one_owner_write_off_exactly_the_shortfall(pg):
    pool, new_user, _ = pg
    user = await new_user()
    await grant(pool, 200, user=user)
    jobs = [await job(pool, user, 50, 120) for _ in range(4)]
    await asyncio.gather(*(settle(pool, jid) for jid in jobs))
    # 480 used against 200 credits: 280 written off in total, whatever the order.
    assert sum(await write_offs(pool, "user_id", user)) == 280
    assert await available(pool, user) == 0


@pytest.mark.asyncio
async def test_reconcile_settles_a_finished_job_through_the_same_cap(pg):
    pool, new_user, _ = pg
    user = await new_user()
    await grant(pool, 100, user=user)
    jid = await job(pool, user, 80, 150, status="DONE")
    async with pool.acquire() as conn:
        assert await PgJobs(conn).reconcile_credits(NOW) >= 1
    assert await pool.fetchval("SELECT status FROM credit_reservations WHERE job_id = $1", jid) == "SETTLED"
    assert await write_offs(pool, "user_id", user) == [50]


@pytest.mark.asyncio
async def test_retry_reserves_again_only_when_the_balance_covers_it(pg):
    pool, new_user, _ = pg
    user = await new_user()
    await grant(pool, 100, user=user)
    await job(pool, user, 70, 0)
    dead = await job(pool, user, 50, 0, status="DEAD", reservation="RELEASED")
    async with pool.acquire() as conn:
        with pytest.raises(ShortBalance):
            await AdminJobs(conn).retry(dead, NOW)
    # Nothing changed: the job stays DEAD and its hold released, so the balance cannot go below zero.
    assert await pool.fetchval("SELECT status FROM ai_jobs WHERE id = $1", dead) == "DEAD"
    assert await pool.fetchval("SELECT status FROM credit_reservations WHERE job_id = $1", dead) == "RELEASED"
    assert await pool.fetchval("SELECT count(*) FROM outbox WHERE job_id = $1", dead) == 0
    assert await available(pool, user) == 30
    await grant(pool, 20, user=user)
    async with pool.acquire() as conn:
        assert await AdminJobs(conn).retry(dead, NOW) is True
    assert await pool.fetchval("SELECT status FROM credit_reservations WHERE job_id = $1", dead) == "RESERVED"
    assert await available(pool, user) == 0


async def release_directly(pool, jid):
    async with pool.acquire() as conn:
        await release_job(conn, jid, NOW)


async def release_by_reconcile(pool, jid):
    async with pool.acquire() as conn:
        await PgJobs(conn).reconcile_credits(NOW)


async def release_by_lost_heartbeat(pool, jid):
    await pool.execute("UPDATE ai_jobs SET status = 'RUNNING', attempts = max_attempts - 1 WHERE id = $1", jid)
    async with pool.acquire() as conn:
        assert (await PgJobs(conn).mark_retry([jid], NOW))[0]["status"] == "DEAD"


@pytest.mark.asyncio
@pytest.mark.parametrize("status,release", [
    ("FAILED", release_directly), ("CANCELLED", release_directly), ("FAILED", release_by_reconcile),
    ("DEAD", release_by_reconcile), ("CANCELLED", release_by_reconcile), ("RUNNING", release_by_lost_heartbeat)])
async def test_release_writes_off_the_overrun_of_a_job_that_did_not_finish(pg, status, release):
    pool, new_user, _ = pg
    user = await new_user()
    await grant(pool, 100, user=user)
    jid = await job(pool, user, 80, 150, status=status)
    await release(pool, jid)
    assert await pool.fetchval("SELECT status FROM credit_reservations WHERE job_id = $1", jid) == "RELEASED"
    # The usage it ran stays charged up to the 80 held and 20 free; the 50 past that is written off.
    assert await write_offs(pool, "user_id", user) == [50]
    assert await available(pool, user) == 0


@pytest.mark.asyncio
async def test_release_caps_a_company_overrun(pg):
    pool, new_user, new_company = pg
    user = await new_user()
    company = await new_company(user)
    await grant(pool, 100, company=company)
    jid = await job(pool, user, 80, 300, company=company, status="FAILED")
    await release_directly(pool, jid)
    assert await write_offs(pool, "company_id", company) == [200]
    assert await available(pool, user, company) == 0


@pytest.mark.asyncio
async def test_release_within_the_hold_writes_nothing_off(pg):
    pool, new_user, _ = pg
    user = await new_user()
    await grant(pool, 100, user=user)
    jid = await job(pool, user, 80, 30, status="FAILED")
    await release_directly(pool, jid)
    assert await write_offs(pool, "user_id", user) == []
    assert await available(pool, user) == 70


@pytest.mark.asyncio
async def test_a_running_jobs_hold_is_not_counted_twice_in_the_shortfall(pg):
    pool, new_user, _ = pg
    user = await new_user()
    await grant(pool, 110, user=user)
    running = await job(pool, user, 80, 70)
    over = await job(pool, user, 20, 40)
    await settle(pool, over)
    # 110 credits less the 80 the running job may still use leave 30 for a 40 job: 10 is short, not 20.
    assert await write_offs(pool, "user_id", user) == [10]
    await use(pool, user, running, 10)
    assert await settle(pool, running) == 0
    assert await write_offs(pool, "user_id", user) == [10]
    assert await available(pool, user) == 0


@pytest.mark.asyncio
async def test_a_retried_job_is_written_off_again_under_a_new_reference(pg):
    pool, new_user, _ = pg
    user = await new_user()
    await grant(pool, 100, user=user)
    jid = await job(pool, user, 80, 150, status="FAILED")
    await release_directly(pool, jid)
    await grant(pool, 80, user=user)
    async with pool.acquire() as conn:
        assert await AdminJobs(conn).retry(jid, NOW) is True
    await use(pool, user, jid, 100)
    await settle(pool, jid)
    assert await write_offs(pool, "user_id", user) == [50, 20]
    assert [r["reference_id"] for r in await pool.fetch(
        "SELECT reference_id FROM billing_ledger WHERE user_id = $1 AND type = 'WRITE_OFF' ORDER BY seq", user)] == [
        f"writeoff:{jid}", f"writeoff:{jid}:1"]
    assert await available(pool, user) == 0


@pytest.mark.asyncio
async def test_reconcile_skips_an_owner_whose_row_stays_locked(pg):
    pool, new_user, _ = pg
    busy, free = await new_user(), await new_user()
    for user in (busy, free):
        await grant(pool, 100, user=user)
    held = await job(pool, busy, 80, 30, status="DONE")
    done = await job(pool, free, 80, 30, status="DONE")
    async with pool.acquire() as webhook, webhook.transaction():
        await webhook.execute("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", busy)
        async with pool.acquire() as conn:
            # The lock timeout gives up on the busy owner instead of stalling the maintain pass behind the webhook.
            await asyncio.wait_for(PgJobs(conn).reconcile_credits(NOW), 10)
            with pytest.raises(Exception) as err:
                await asyncio.wait_for(settle_job(conn, held, NOW), 10)
            assert getattr(err.value, "sqlstate", None) == "55P03"
    assert await pool.fetchval("SELECT status FROM credit_reservations WHERE job_id = $1", held) == "RESERVED"
    assert await pool.fetchval("SELECT status FROM credit_reservations WHERE job_id = $1", done) == "SETTLED"
    async with pool.acquire() as conn:
        assert await PgJobs(conn).reconcile_credits(NOW) >= 1
    assert await pool.fetchval("SELECT status FROM credit_reservations WHERE job_id = $1", held) == "SETTLED"
