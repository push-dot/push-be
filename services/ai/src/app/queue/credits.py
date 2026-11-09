import logging
from uuid import uuid4

logger = logging.getLogger(__name__)

# Keep in step with core-api jobs/credits.ts availableMicro: ledger credits - settled usage - open reservations.
_AVAILABLE_USER = (
    "SELECT COALESCE((SELECT balance_after FROM billing_ledger WHERE user_id = $1 ORDER BY seq DESC LIMIT 1), 0)"
    " - (SELECT COALESCE(SUM(cost_micro_credits), 0) FROM ai_usage WHERE user_id = $1 AND status = 'SETTLED')"
    " - (SELECT COALESCE(SUM(amount_micro), 0) FROM credit_reservations WHERE user_id = $1 AND status = 'RESERVED')")
_AVAILABLE_COMPANY = (
    "SELECT (SELECT COALESCE(SUM(amount_micro_credits), 0) FROM billing_ledger WHERE company_id = $1 AND user_id IS NULL)"
    " - (SELECT COALESCE(SUM(cost_micro_credits), 0) FROM ai_usage WHERE status = 'SETTLED'"
    " AND user_id IN (SELECT user_id FROM company_members WHERE company_id = $1))"
    " - (SELECT COALESCE(SUM(amount_micro), 0) FROM credit_reservations WHERE company_id = $1 AND status = 'RESERVED')")
_WRITE_OFF_USER = (
    "INSERT INTO billing_ledger (id, user_id, type, amount_micro_credits, balance_after, reference_id, created_at) "
    "SELECT $1, $2, 'WRITE_OFF', $3::bigint, COALESCE((SELECT balance_after FROM billing_ledger WHERE user_id = $2 "
    "ORDER BY seq DESC LIMIT 1), 0) + $3::bigint, $4, $5 ON CONFLICT (user_id, type, reference_id) DO NOTHING")
_WRITE_OFF_COMPANY = (
    "INSERT INTO billing_ledger (id, user_id, company_id, type, amount_micro_credits, balance_after, reference_id, "
    "created_at) SELECT $1, NULL, $2::uuid, 'WRITE_OFF', $3::bigint, (SELECT COALESCE(SUM(amount_micro_credits), 0) "
    "FROM billing_ledger WHERE company_id = $2 AND user_id IS NULL) + $3::bigint, $4, $5 "
    "ON CONFLICT (company_id, type, reference_id) WHERE company_id IS NOT NULL DO NOTHING")


class ShortBalance(Exception):
    """The owner's available balance does not cover the reservation."""


async def lock_owner(conn, user_id, company_id) -> None:
    # The owner row lock core-api takes for every ledger write and charged enqueue (billing/credits.ts lockOwner).
    if company_id is None:
        await conn.execute("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", user_id)
    else:
        await conn.execute("SELECT id FROM companies WHERE id = $1 FOR NO KEY UPDATE", company_id)


async def available_micro(conn, user_id, company_id) -> int:
    if company_id is None:
        return int(await conn.fetchval(_AVAILABLE_USER, user_id))
    return int(await conn.fetchval(_AVAILABLE_COMPANY, company_id))


async def settle_job(conn, job_id, now) -> int:
    """Settle the reservation at actual usage; returns credits handed back.

    Usage past the reservation and the owner's available balance is written off (a WRITE_OFF ledger row and a log
    line), so the user is never charged into a negative balance for an overrun they could not see.
    """
    async with conn.transaction():
        owner = await conn.fetchrow(
            "SELECT user_id, company_id FROM credit_reservations WHERE job_id = $1 AND status = 'RESERVED'", job_id)
        if owner is None:
            return 0
        user_id, company_id = owner["user_id"], owner["company_id"]
        await lock_owner(conn, user_id, company_id)
        row = await conn.fetchrow(
            "UPDATE credit_reservations SET status = 'SETTLED', updated_at = $2, settled_micro = "
            "(SELECT COALESCE(SUM(cost_micro_credits), 0) FROM ai_usage WHERE job_id = $1 AND status = 'SETTLED') "
            "WHERE job_id = $1 AND status = 'RESERVED' RETURNING amount_micro, settled_micro",
            job_id, now)
        if row is None:
            return 0
        amount, used = int(row["amount_micro"]), int(row["settled_micro"])
        if used > amount:
            excess = min(used - amount, -await available_micro(conn, user_id, company_id))
            if excess > 0:
                await conn.execute(
                    _WRITE_OFF_USER if company_id is None else _WRITE_OFF_COMPANY,
                    uuid4(), user_id if company_id is None else company_id, excess, f"writeoff:{job_id}", now)
                logger.warning("settle_job %s wrote off %d micro-credits past reservation %d and the balance",
                               job_id, excess, amount)
        return max(amount - used, 0)


async def release_job(conn, job_id, now) -> None:
    await conn.execute(
        "UPDATE credit_reservations SET status = 'RELEASED', updated_at = $2 "
        "WHERE job_id = $1 AND status = 'RESERVED'",
        job_id, now)
