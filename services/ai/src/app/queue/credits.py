class CreditBook:
    def __init__(self):
        self.ledger = {}
        self.reservations = {}

    def reserve(self, job_id, user_id, amount: int) -> None:
        self.reservations[job_id] = {
            "status": "RESERVED",
            "amount": int(amount),
            "user_id": user_id,
            "settled": 0,
            "usage": 0,
        }

    def add_usage(self, job_id, amount: int) -> None:
        self.reservations[job_id]["usage"] = int(self.reservations[job_id].get("usage", 0)) + int(amount)

    def available(self, user_id) -> int:
        reserved = 0
        settled = 0
        for row in self.reservations.values():
            if row["user_id"] != user_id:
                continue
            if row["status"] == "RESERVED":
                reserved += int(row["amount"])
            elif row["status"] == "SETTLED":
                settled += int(row["settled"])
        return int(self.ledger.get(user_id, 0)) - settled - reserved


def apply_settle(status, amount: int, actual: int):
    if status != "RESERVED":
        return None
    returned = int(amount) - int(actual)
    if returned < 0:
        return 0, int(actual)
    return returned, int(actual)


async def settle(book: CreditBook, job_id) -> int:
    row = book.reservations.get(job_id)
    if row is None:
        return 0
    decision = apply_settle(row["status"], row["amount"], row.get("usage", 0))
    if decision is None:
        return 0
    returned, settled_micro = decision
    row["status"] = "SETTLED"
    row["settled"] = settled_micro
    return returned


async def release(book: CreditBook, job_id) -> None:
    row = book.reservations.get(job_id)
    if row is None or row["status"] != "RESERVED":
        return
    row["status"] = "RELEASED"


async def settle_job(conn, job_id, now) -> int:
    row = await conn.fetchrow(
        "SELECT status, amount_micro, user_id FROM credit_reservations WHERE job_id = $1",
        job_id)
    if row is None:
        return 0
    actual = await conn.fetchval(
        "SELECT COALESCE(SUM(cost_micro_credits), 0) FROM ai_usage "
        "WHERE job_id = $1 AND status = 'SETTLED'",
        job_id)
    decision = apply_settle(row["status"], row["amount_micro"], int(actual or 0))
    if decision is None:
        return 0
    returned, settled_micro = decision
    await conn.execute(
        "UPDATE credit_reservations SET status = 'SETTLED', settled_micro = $2, updated_at = $3 "
        "WHERE job_id = $1 AND status = 'RESERVED'",
        job_id, settled_micro, now)
    return returned


async def release_job(conn, job_id, now) -> None:
    await conn.execute(
        "UPDATE credit_reservations SET status = 'RELEASED', updated_at = $2 "
        "WHERE job_id = $1 AND status = 'RESERVED'",
        job_id, now)
