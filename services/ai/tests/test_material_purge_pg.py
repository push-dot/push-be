"""The retention purge of deleted materials on a migrated Postgres (CI job test-db sets BILLING_PG_URL).

The app says a deleted material is kept 30 days and then erased. Each test runs inside a transaction
that is rolled back.
"""

import os
import uuid

import pytest

from app.account_purge import purge_deleted

asyncpg = pytest.importorskip("asyncpg")
URL = os.environ.get("BILLING_PG_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="BILLING_PG_URL is not set")

OLD, RECENT = "now() - interval '31 days'", "now() - interval '29 days'"


@pytest.fixture
async def db():
    conn = await asyncpg.connect(URL)
    tx = conn.transaction()
    await tx.start()
    try:
        yield conn
    finally:
        await tx.rollback()
        await conn.close()


async def test_deleted_links_files_and_bookmarks_are_erased_after_30_days(db):
    user = uuid.uuid4()
    await db.execute(
        "INSERT INTO users (id, provider, provider_subject, display_name) "
        "VALUES ($1, 'test', md5(random()::text), 'u')",
        user,
    )
    links = {}
    for name, deleted in (("old", OLD), ("recent", RECENT), ("live", "NULL")):
        links[name] = uuid.uuid4()
        await db.execute(
            "INSERT INTO user_links (id, user_id, kind, url, deleted_at) "
            f"VALUES ($1, $2, 'other', 'https://example.com', {deleted})",
            links[name],
            user,
        )
    binned = {}
    for name, deleted in (("old", OLD), ("recent", RECENT)):
        binned[name] = uuid.uuid4()
        await db.execute(
            "INSERT INTO material_bin (user_id, kind, id, deleted_at, snapshot) "
            f"VALUES ($1, 'file', $2, {deleted}, '{{}}')",
            user,
            binned[name],
        )

    await purge_deleted(db, None)

    kept_links = await db.fetch("SELECT id FROM user_links WHERE user_id = $1", user)
    assert {row["id"] for row in kept_links} == {links["recent"], links["live"]}
    kept_bin = await db.fetch("SELECT id FROM material_bin WHERE user_id = $1", user)
    assert [row["id"] for row in kept_bin] == [binned["recent"]]
