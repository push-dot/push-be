"""A run starts only while the user gives reference-data consent and the read switch is on."""

from __future__ import annotations

import os
from uuid import uuid4

import pytest

from app.domain.errors import DomainError
from app.harness.consent import CONSENT_REQUIRED, require_consent

asyncpg = pytest.importorskip("asyncpg")
URL = os.environ.get("BILLING_PG_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="BILLING_PG_URL is not set")


@pytest.fixture
async def db():
    from app.db import DB, _init_conn

    pool = await asyncpg.create_pool(URL, init=_init_conn, min_size=0, max_size=2)
    try:
        yield DB(pool)
    finally:
        await pool.close()


async def person(db, *, consent: bool | None, switch: bool | None):
    user = uuid4()
    q = db.q()
    await q.execute(
        "INSERT INTO users (id, provider, provider_subject, display_name) "
        "VALUES ($1, 'test', $2, 'consent')",
        user,
        str(user),
    )
    if consent is not None:
        await q.execute(
            "INSERT INTO user_consents (user_id, reference_data) VALUES ($1, $2)", user, consent
        )
    if switch is not None:
        await q.execute(
            "INSERT INTO user_settings (user_id, allow_ai_read_my_files) VALUES ($1, $2)",
            user,
            switch,
        )
    return user


@pytest.mark.parametrize(
    ("consent", "switch", "allowed"),
    [
        (True, None, True),
        (True, True, True),
        (True, False, False),
        (False, None, False),
        (False, True, False),
        (None, None, False),
    ],
)
async def test_a_run_needs_consent_and_a_switch_that_is_not_off(db, consent, switch, allowed):
    user = await person(db, consent=consent, switch=switch)
    try:
        if allowed:
            await require_consent(db, user)
            return
        with pytest.raises(DomainError) as refused:
            await require_consent(db, user)
        assert (refused.value.status, refused.value.code) == (403, CONSENT_REQUIRED)
    finally:
        await db.q().execute("DELETE FROM users WHERE id = $1", user)
