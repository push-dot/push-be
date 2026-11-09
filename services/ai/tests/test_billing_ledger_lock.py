"""The ai Stripe checkout writes the user ledger like core-api does.

It takes the users row lock and adds to the row with the largest seq.

Runs on a migrated Postgres (BILLING_PG_URL, set by the CI test-db job) and skips elsewhere.
"""

import asyncio
import hashlib
import hmac
import json
import os
import time
from datetime import timedelta
from uuid import uuid4

import pytest

from app.domain import entities as ent

SECRET = "whsec_test"
LEDGER = (
    "INSERT INTO billing_ledger (id, user_id, type, amount_micro_credits, balance_after, "
    "reference_id, created_at) VALUES ($1, $2, 'PURCHASE', $3, $4, $5, now() - $6::interval)"
)


@pytest.mark.asyncio
async def test_checkout_waits_for_the_user_row_lock_and_adds_to_the_last_committed_row():
    url = os.environ.get("BILLING_PG_URL")
    if not url:
        pytest.skip("BILLING_PG_URL not set")
    asyncpg = pytest.importorskip("asyncpg")
    from app.db import DB
    from app.domain.services.billing import BillingService

    pool = await asyncpg.create_pool(url, min_size=1, max_size=2)
    core = await asyncpg.connect(url)
    user, event = uuid4(), "evt_" + uuid4().hex
    try:
        await core.execute(
            "INSERT INTO users (id, provider, provider_subject, display_name) "
            "VALUES ($1, 'email', $2, 'a')",
            user,
            str(user),
        )
        await core.execute(LEDGER, uuid4(), user, 600000, 600000, "first", timedelta(0))
        # A core-api write holds the user row lock. Its request started an hour ago,
        # so its created_at is the earlier one.
        tx = core.transaction()
        await tx.start()
        await core.execute("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", user)
        await core.execute(LEDGER, uuid4(), user, 1800000, 2400000, "waited", timedelta(hours=1))
        svc = BillingService(DB(pool), None, True, {"PRO": "price_pro"}, "", "", "", SECRET)
        session = {
            "id": "cs_" + uuid4().hex,
            "client_reference_id": str(user),
            "customer": "",
            "metadata": {"planId": "PRO"},
        }
        payload = json.dumps(
            {"id": event, "type": "checkout.session.completed", "data": {"object": session}}
        ).encode()
        ts = int(time.time())
        sig = hmac.new(SECRET.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
        checkout = asyncio.create_task(svc.handle_webhook(payload, f"t={ts},v1={sig}"))
        await asyncio.sleep(0.3)
        await tx.commit()
        await checkout
        rows = await core.fetch(
            "SELECT reference_id, balance_after FROM billing_ledger "
            "WHERE user_id = $1 ORDER BY seq",
            user,
        )
        credits = ent.PLAN_CREDITS_MICRO["PRO"]
        assert [r["reference_id"] for r in rows][:2] == ["first", "waited"]
        assert rows[-1]["balance_after"] == 2400000 + credits
    finally:
        await core.execute("DELETE FROM billing_ledger WHERE user_id = $1", user)
        await core.execute("DELETE FROM stripe_events WHERE event_id = $1", event)
        await core.execute("DELETE FROM users WHERE id = $1", user)
        await core.close()
        await pool.close()
