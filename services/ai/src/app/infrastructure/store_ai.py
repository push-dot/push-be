from __future__ import annotations
from datetime import datetime
from typing import Optional
from uuid import UUID

from app.domain.entities import AiUsage
from app.domain.pagination import Cursor, Page
from app.infrastructure.store_common import Conds, Store, list_page

_USAGE_COLS = ("id, user_id, operation_id, provider, model, managed, input_tokens, "
               "output_tokens, cost_micro_credits, status, created_at")


_USAGE_UPSERT = (
    " ON CONFLICT (id) DO UPDATE SET "
    "operation_id = COALESCE(EXCLUDED.operation_id, ai_usage.operation_id), "
    "provider = EXCLUDED.provider, model = EXCLUDED.model, "
    "managed = EXCLUDED.managed, "
    # Meter rows share one id per job and model, so repeated settled calls add up.
    + "".join(
        f"{c} = CASE WHEN ai_usage.status = 'SETTLED' AND EXCLUDED.status = 'SETTLED' "
        f"THEN ai_usage.{c} + EXCLUDED.{c} ELSE EXCLUDED.{c} END, "
        for c in ("input_tokens", "output_tokens", "cost_micro_credits"))
    + "status = EXCLUDED.status "
    "WHERE (ai_usage.status <> 'SETTLED' OR EXCLUDED.status = 'SETTLED')"
)
_USAGE_JOB_SQL = (
    f"INSERT INTO ai_usage ({_USAGE_COLS}, job_id) "
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)"
    + _USAGE_UPSERT.replace(
        "status = EXCLUDED.status WHERE",
        "status = EXCLUDED.status, "
        "job_id = COALESCE(ai_usage.job_id, EXCLUDED.job_id) WHERE",
        1)
)


class AiUsageStore(Store):
    async def create_for_job(self, u: AiUsage, job_id) -> None:
        await self.q().execute(
            _USAGE_JOB_SQL,
            u.id, u.user_id, u.operation_id, u.provider, u.model, u.managed,
            u.input_tokens, u.output_tokens, u.cost_micro_credits, u.status,
            u.created_at, job_id)

    async def create(self, u: AiUsage) -> None:
        from app.claimctx import LostClaim, claim_job, claim_token
        values = (
            u.id, u.user_id, u.operation_id, u.provider, u.model, u.managed,
            u.input_tokens, u.output_tokens, u.cost_micro_credits, u.status,
            u.created_at)
        token = ""
        job = ""
        if claim_token.get() and claim_job.get():
            token = claim_token.get()
            job = claim_job.get()
        if token and job:
            tag = await self.q().execute(
                f"INSERT INTO ai_usage ({_USAGE_COLS}) "
                "SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11 FROM chat_jobs "
                "WHERE id=$12::uuid AND status='RUNNING' "
                "AND checkpoint->>'claim'=$13"
                + _USAGE_UPSERT
                + " AND EXISTS (SELECT 1 FROM chat_jobs WHERE id=$12::uuid "
                "AND status='RUNNING' AND checkpoint->>'claim'=$13)",
                *values, UUID(str(job)), token)
            if str(tag).split()[-1] != "0":
                return
            owned = await self.q().fetchval(
                "SELECT EXISTS(SELECT 1 FROM chat_jobs WHERE id=$1::uuid "
                "AND status='RUNNING' AND checkpoint->>'claim'=$2)",
                UUID(str(job)), token)
            if not owned:
                raise LostClaim()
            return
        await self.q().execute(
            f"INSERT INTO ai_usage ({_USAGE_COLS}) "
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)" + _USAGE_UPSERT,
            *values)

    async def sum_cost_since(self, user_id: UUID, since: datetime) -> int:
        return await self.q().fetchval(
            "SELECT COALESCE(SUM(cost_micro_credits), 0) FROM ai_usage "
            "WHERE user_id = $1 AND managed AND created_at >= $2 AND ("
            "status = 'SETTLED' OR (status = 'RESERVED' "
            "AND created_at > now() - interval '10 minutes'))",
            user_id, since)

    async def lock_user(self, user_id: UUID) -> None:
        await self.q().execute(
            "SELECT pg_advisory_xact_lock(hashtext($1::text))", str(user_id))

    async def settle(self, id_: UUID, input_tokens: int, output_tokens: int,
                     cost_micro_credits: int) -> None:
        await self.q().execute(
            "UPDATE ai_usage SET input_tokens = $2, output_tokens = $3, "
            "cost_micro_credits = $4, status = 'SETTLED' "
            "WHERE id = $1 AND status IN ('RESERVED', 'SETTLED')",
            id_, input_tokens, output_tokens, cost_micro_credits)

    async def release(self, id_: UUID) -> None:
        await self.q().execute(
            "UPDATE ai_usage SET cost_micro_credits = 0, status = 'RELEASED' "
            "WHERE id = $1 AND status = 'RESERVED'", id_)

    async def attach_operations(self, operation_id: UUID,
                                usage_ids: list) -> int:
        if not usage_ids:
            return 0
        tag = await self.q().execute(
            "UPDATE ai_usage SET operation_id = $1 WHERE id = ANY($2) "
            "AND status = 'SETTLED' AND operation_id IS NULL",
            operation_id, usage_ids)
        return int(tag.split()[-1])

    async def expire_stale(self) -> None:
        await self.q().execute(
            "UPDATE ai_usage SET cost_micro_credits = 0, status = 'EXPIRED' "
            "WHERE status = 'RESERVED' "
            "AND created_at < now() - interval '10 minutes'")

    async def list(self, user_id: UUID, from_: Optional[datetime],
                   to: Optional[datetime], page) -> Page:
        c = Conds()
        c.add("user_id = {}", user_id)
        if from_:
            c.add("created_at >= {}", from_)
        if to:
            c.add("created_at <= {}", to)
        c.cursor(page)
        sql, args = c.query(_USAGE_COLS, "ai_usage", page.effective_limit())
        rows = await self.q().fetch(sql, *args)
        return list_page(rows, page, AiUsage, lambda u: Cursor(u.created_at, u.id))
