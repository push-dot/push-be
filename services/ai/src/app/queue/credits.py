import logging
from uuid import uuid4

logger = logging.getLogger(__name__)

# Keep in step with core-api jobs/credits.ts availableMicro: ledger credits - settled usage - open reservations.
_USER = (
    "SELECT COALESCE((SELECT balance_after FROM billing_ledger WHERE user_id = $1 ORDER BY seq DESC LIMIT 1), 0)"
    " - (SELECT COALESCE(SUM(cost_micro_credits), 0) FROM ai_usage WHERE user_id = $1 AND status = 'SETTLED')"
    " - (SELECT COALESCE(")
_USER_HOLDS = ", 0) FROM credit_reservations r WHERE user_id = $1 AND status = 'RESERVED')"
_COMPANY = (
    "SELECT (SELECT COALESCE(SUM(amount_micro_credits), 0) FROM billing_ledger WHERE company_id = $1 AND user_id IS NULL)"
    " - (SELECT COALESCE(SUM(cost_micro_credits), 0) FROM ai_usage WHERE status = 'SETTLED'"
    " AND user_id IN (SELECT user_id FROM company_members WHERE company_id = $1))"
    " - (SELECT COALESCE(")
_COMPANY_HOLDS = ", 0) FROM credit_reservations r WHERE company_id = $1 AND status = 'RESERVED')"
_HELD = "SUM(r.amount_micro)"
# A running job's settled usage is already subtracted above, so only the part of its hold it has not used is still owed.
_UNUSED = ("SUM(GREATEST(r.amount_micro - (SELECT COALESCE(SUM(u.cost_micro_credits), 0) FROM ai_usage u "
           "WHERE u.job_id = r.job_id AND u.status = 'SETTLED'), 0))")
_AVAILABLE_USER = _USER + _HELD + _USER_HOLDS
_AVAILABLE_COMPANY = _COMPANY + _HELD + _COMPANY_HOLDS
_UNCOMMITTED_USER = _USER + _UNUSED + _USER_HOLDS
_UNCOMMITTED_COMPANY = _COMPANY + _UNUSED + _COMPANY_HOLDS
_WRITE_OFFS_USER = "SELECT count(*) FROM billing_ledger WHERE user_id = $1 AND type = 'WRITE_OFF' AND reference_id LIKE $2"
_WRITE_OFFS_COMPANY = (
    "SELECT count(*) FROM billing_ledger WHERE company_id = $1 AND type = 'WRITE_OFF' AND reference_id LIKE $2")
_WRITE_OFF_USER = (
    "INSERT INTO billing_ledger (id, user_id, type, amount_micro_credits, balance_after, reference_id, created_at) "
    "SELECT $1, $2, 'WRITE_OFF', $3::bigint, COALESCE((SELECT balance_after FROM billing_ledger WHERE user_id = $2 "
    "ORDER BY seq DESC LIMIT 1), 0) + $3::bigint, $4, $5")
_WRITE_OFF_COMPANY = (
    "INSERT INTO billing_ledger (id, user_id, company_id, type, amount_micro_credits, balance_after, reference_id, "
    "created_at) SELECT $1, NULL, $2::uuid, 'WRITE_OFF', $3::bigint, (SELECT COALESCE(SUM(amount_micro_credits), 0) "
    "FROM billing_ledger WHERE company_id = $2 AND user_id IS NULL) + $3::bigint, $4, $5")
# Settle, retry and reconcile run in the worker and the dispatcher's maintain pass. A webhook can hold the company row
# for several Stripe calls, so they give up after this (55P03) and the reconcile pass closes the reservation later.
LOCK_TIMEOUT = "3s"


class ShortBalance(Exception):
    """The owner's available balance does not cover the reservation."""


def lock_busy(err: BaseException) -> bool:
    return getattr(err, "sqlstate", None) == "55P03"


async def unless_busy(close) -> bool:
    """Await a settle or release; False when the owner row stayed locked, leaving the reservation to reconcile."""
    try:
        await close
    except Exception as err:
        if not lock_busy(err):
            raise
        logger.warning("credit reservation left open, owner row busy: %s", err)
        return False
    return True


async def lock_owner(conn, user_id, company_id) -> None:
    # The owner row lock core-api takes for every ledger write and charged enqueue (billing/credits.ts lockOwner).
    await conn.execute("SELECT set_config('lock_timeout', $1, true)", LOCK_TIMEOUT)
    if company_id is None:
        await conn.execute("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", user_id)
    else:
        await conn.execute("SELECT id FROM companies WHERE id = $1 FOR NO KEY UPDATE", company_id)


async def available_micro(conn, user_id, company_id, *, unused_holds: bool = False) -> int:
    """unused_holds: count an open hold only past the usage its job already settled (a write-off's shortfall)."""
    if company_id is None:
        return int(await conn.fetchval(_UNCOMMITTED_USER if unused_holds else _AVAILABLE_USER, user_id))
    return int(await conn.fetchval(_UNCOMMITTED_COMPANY if unused_holds else _AVAILABLE_COMPANY, company_id))


async def _close(conn, job_id, now, status: str) -> tuple[int, int] | None:
    """Close the job's open reservation as SETTLED or RELEASED; returns (held, used), None when none was open.

    The job's usage stays charged either way. Usage past the reservation and the owner's available balance is
    written off (a WRITE_OFF ledger row and a log line), so the user is never charged into a negative balance for an
    overrun they could not see.
    """
    async with conn.transaction():
        owner = await conn.fetchrow(
            "SELECT user_id, company_id FROM credit_reservations WHERE job_id = $1 AND status = 'RESERVED'", job_id)
        if owner is None:
            return None
        user_id, company_id = owner["user_id"], owner["company_id"]
        await lock_owner(conn, user_id, company_id)
        # A usage write holds the open reservation FOR SHARE (store_ai.py _OPEN_JOB). Waiting for it in its own statement
        # lets the sum below, on a fresh snapshot, count that usage; once closed, later writes are refused.
        await conn.execute(
            "SELECT 1 FROM credit_reservations WHERE job_id = $1 AND status = 'RESERVED' FOR NO KEY UPDATE", job_id)
        row = await conn.fetchrow(
            "UPDATE credit_reservations SET status = $3, updated_at = $2, settled_micro = "
            "(SELECT COALESCE(SUM(cost_micro_credits), 0) FROM ai_usage WHERE job_id = $1 AND status = 'SETTLED') "
            "WHERE job_id = $1 AND status = 'RESERVED' RETURNING amount_micro, settled_micro",
            job_id, now, status)
        if row is None:
            return None
        amount, used = int(row["amount_micro"]), int(row["settled_micro"])
        if used > amount:
            excess = min(used - amount, -await available_micro(conn, user_id, company_id, unused_holds=True))
            if excess > 0:
                owner_id = user_id if company_id is None else company_id
                ref = f"writeoff:{job_id}"
                # A retried job can be closed again; its later write-offs get a numbered reference.
                if n := await conn.fetchval(_WRITE_OFFS_USER if company_id is None else _WRITE_OFFS_COMPANY,
                                            owner_id, ref + "%"):
                    ref = f"{ref}:{n}"
                await conn.execute(_WRITE_OFF_USER if company_id is None else _WRITE_OFF_COMPANY,
                                   uuid4(), owner_id, excess, ref, now)
                logger.warning("%s job %s wrote off %d micro-credits past reservation %d and the balance",
                               status.lower(), job_id, excess, amount)
        return amount, used


async def settle_job(conn, job_id, now) -> int:
    """Settle the reservation at actual usage; returns credits handed back."""
    closed = await _close(conn, job_id, now, "SETTLED")
    return 0 if closed is None else max(closed[0] - closed[1], 0)


async def release_job(conn, job_id, now) -> None:
    """Release the hold of a job that failed, died or was cancelled; usage it already ran stays charged."""
    await _close(conn, job_id, now, "RELEASED")


async def close_each(conn, rows, now) -> int:
    """Settle (DONE) or release each row's reservation (job_id, user_id, company_id, status); returns how many closed.

    After one owner's row stays locked, that owner's other rows wait for the next pass instead of each waiting out
    LOCK_TIMEOUT, so the pass (and dispatch behind it) stalls for one timeout per busy owner, not per reservation.
    """
    busy, closed = set(), 0
    for row in rows:
        owner = row["company_id"] or row["user_id"]
        if owner in busy:
            continue
        close = settle_job if row["status"] == "DONE" else release_job
        if await unless_busy(close(conn, row["job_id"], now)):
            closed += 1
        else:
            busy.add(owner)
    return closed
