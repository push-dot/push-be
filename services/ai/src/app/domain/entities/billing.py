from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field

from app.domain.entities.base import Model

PLAN_FREE = "FREE"
PLAN_PRO = "PRO"
PLAN_ULTRA = "ULTRA"
SUB_NONE = "NONE"
SUB_ACTIVE = "ACTIVE"
SUB_CANCELED = "CANCELED"
LEDGER_PURCHASE = "PURCHASE"
LEDGER_REFUND = "REFUND"
PLAN_CREDITS_MICRO = {
    PLAN_FREE: 1_800_000, PLAN_PRO: 27_000_000, PLAN_ULTRA: 108_000_000}


class LedgerEntry(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    type: str
    amount_micro_credits: int
    balance_after: int
    reference_id: Optional[str] = None
    created_at: datetime


class BillingStatus(Model):
    subscription_status: str
    plan: Optional[str] = None
    period_ends_at: Optional[datetime] = None
    balance_micro_credits: int
    reserved_micro_credits: int = 0


class StripeCheckout(BaseModel):
    url: str
    expires_at: Optional[datetime] = None


def valid_plan(p: str) -> bool:
    return p in (PLAN_FREE, PLAN_PRO, PLAN_ULTRA)
