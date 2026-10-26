async def settle_job(conn, job_id, now) -> int:
    """Settle the reservation at actual usage in one round trip; returns credits handed back."""
    row = await conn.fetchrow(
        "UPDATE credit_reservations SET status = 'SETTLED', updated_at = $2, settled_micro = "
        "(SELECT COALESCE(SUM(cost_micro_credits), 0) FROM ai_usage WHERE job_id = $1 AND status = 'SETTLED') "
        "WHERE job_id = $1 AND status = 'RESERVED' RETURNING amount_micro, settled_micro",
        job_id, now)
    if row is None:
        return 0
    return max(int(row["amount_micro"]) - int(row["settled_micro"]), 0)


async def release_job(conn, job_id, now) -> None:
    await conn.execute(
        "UPDATE credit_reservations SET status = 'RELEASED', updated_at = $2 "
        "WHERE job_id = $1 AND status = 'RESERVED'",
        job_id, now)
