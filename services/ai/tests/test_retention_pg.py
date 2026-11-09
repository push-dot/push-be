"""The retention purge on a migrated Postgres (CI job test-db sets RETENTION_PG_URL).

Each test runs inside a transaction that is rolled back.
"""

import json
import os
import uuid

import pytest

from app.account_purge import purge_deleted

asyncpg = pytest.importorskip("asyncpg")
URL = os.environ.get("RETENTION_PG_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="RETENTION_PG_URL is not set")

# Every foreign key in the schema, as (child table, child column, parent table,
# parent column, delete action). Single-column keys only; the schema has no other kind.
FKS_SQL = (
    "SELECT c.conrelid::regclass::text AS child, a.attname AS col, "
    "c.confrelid::regclass::text AS parent, pa.attname AS pcol, c.confdeltype::text AS action "
    "FROM pg_constraint c "
    "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] "
    "JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1] "
    "WHERE c.contype = 'f'"
)


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


async def owned_rows(conn, company_id) -> dict[str, list[str]]:
    """Rows reachable from the company through ON DELETE CASCADE keys, as JSON text per table."""
    fks = [fk for fk in await conn.fetch(FKS_SQL) if fk["action"] == "c"]
    rows = {
        "companies": [
            r["j"]
            for r in await conn.fetch(
                "SELECT to_jsonb(t)::text AS j FROM companies t WHERE id = $1", company_id
            )
        ]
    }
    changed = True
    while changed:
        changed = False
        for fk in fks:
            if fk["parent"] not in rows:
                continue
            keys = [str(json.loads(r)[fk["pcol"]]) for r in rows[fk["parent"]]]
            found = await conn.fetch(
                f"SELECT to_jsonb(t)::text AS j FROM {fk['child']} t "
                f"WHERE {fk['col']}::text = ANY($1::text[])",
                keys,
            )
            seen = rows.setdefault(fk["child"], [])
            new = [r["j"] for r in found if r["j"] not in seen]
            if new:
                seen += new
                changed = True
    return {table: sorted(found) for table, found in rows.items() if found}


async def seed_company(conn, days_ago: int) -> dict:
    ids = {
        k: uuid.uuid4()
        for k in ("admin", "candidate", "company", "posting", "conversation", "document")
    }
    logo = f"logo-{ids['company']}.png"
    await conn.execute(
        "INSERT INTO users (id, provider, provider_subject, display_name) VALUES "
        "($1, 'test', md5(random()::text), 'admin'), "
        "($2, 'test', md5(random()::text), 'candidate')",
        ids["admin"],
        ids["candidate"],
    )
    await conn.execute(
        "INSERT INTO companies (id, name, logo_key, deletion_requested_at) "
        "VALUES ($1, 'co', $2, now() - make_interval(days => $3))",
        ids["company"],
        logo,
        days_ago,
    )
    await conn.execute(
        "INSERT INTO upload_images (key, user_id, mime_type, content) "
        "VALUES ($1, $2, 'image/png', 'x')",
        logo,
        ids["admin"],
    )
    await conn.execute(
        "INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'ADMIN')",
        ids["company"],
        ids["admin"],
    )
    await conn.execute(
        "INSERT INTO company_invites (id, company_id, email, token_hash, expires_at) "
        "VALUES ($1, $2, 'a@b.c', md5(random()::text), now() + interval '1 day')",
        uuid.uuid4(),
        ids["company"],
    )
    await conn.execute(
        "INSERT INTO job_postings (id, company_id, company, title, job_category, career_min, "
        "location, employment_type, description) "
        "VALUES ($1, $2, 'co', 'dev', 'dev', 0, 'Seoul', 'full_time', 'd')",
        ids["posting"],
        ids["company"],
    )
    await conn.execute(
        "INSERT INTO posting_views (user_id, posting_id, viewed_on) VALUES ($1, $2, current_date)",
        ids["candidate"],
        ids["posting"],
    )
    await conn.execute(
        "INSERT INTO bookmarks (user_id, posting_id) VALUES ($1, $2)",
        ids["candidate"],
        ids["posting"],
    )
    await conn.execute(
        "INSERT INTO posting_fit_cache (user_id, posting_id, document_id, fit_score, parts) "
        "VALUES ($1, $2, $3, 1, '{}')",
        ids["candidate"],
        ids["posting"],
        ids["document"],
    )
    await conn.execute(
        "INSERT INTO jobs (id, user_id, company, title, source_kind, source_text, "
        "source_posting_id) "
        "VALUES ($1, $2, 'co', 'dev', 'posting', 't', $3)",
        uuid.uuid4(),
        ids["candidate"],
        ids["posting"],
    )
    await conn.execute(
        "INSERT INTO conversations (id, user_id, company_id, posting_id) VALUES ($1, $2, $3, $4)",
        ids["conversation"],
        ids["admin"],
        ids["company"],
        ids["posting"],
    )
    await conn.execute(
        "INSERT INTO messages (id, user_id, conversation_id, role, text) "
        "VALUES ($1, $2, $3, 'USER', 'hi')",
        uuid.uuid4(),
        ids["admin"],
        ids["conversation"],
    )
    await conn.execute(
        "INSERT INTO conversation_attachments (id, conversation_id, company_id, file_name, "
        "mime_type, content) VALUES ($1, $2, $3, 'a.pdf', 'application/pdf', 'x')",
        uuid.uuid4(),
        ids["conversation"],
        ids["company"],
    )
    await conn.execute(
        "INSERT INTO conversation_shares (conversation_id, token_hash) "
        "VALUES ($1, md5(random()::text))",
        ids["conversation"],
    )
    await conn.execute(
        "INSERT INTO workspace_files (conversation_id, name, body) VALUES ($1, 'notes.md', 'x')",
        ids["conversation"],
    )
    review = uuid.uuid4()
    await conn.execute(
        "INSERT INTO employer_reviews (id, company_id, conversation_id, attachment_name, report) "
        "VALUES ($1, $2, $3, 'a.pdf', '{}')",
        review,
        ids["company"],
        ids["conversation"],
    )
    await conn.execute(
        "INSERT INTO employer_interview_kits (id, company_id, conversation_id, kit, review_id) "
        "VALUES ($1, $2, $3, '{}', $4)",
        uuid.uuid4(),
        ids["company"],
        ids["conversation"],
        review,
    )
    await conn.execute(
        "INSERT INTO rag_nodes (id, company_id, source_type, source_id, seq, text, embedding, "
        "embedding_model) VALUES ($1, $2, 'posting', $3, 0, 't', "
        "array_fill(0::real, ARRAY[1024])::vector, 'm')",
        uuid.uuid4(),
        ids["company"],
        ids["posting"],
    )
    ids["ledger"] = uuid.uuid4()
    await conn.execute(
        "INSERT INTO billing_ledger (id, company_id, type, amount_micro_credits, balance_after) "
        "VALUES ($1, $2, 'TOPUP', 1, 1)",
        ids["ledger"],
        ids["company"],
    )
    ids["logo"] = logo
    return ids


async def test_company_rows_are_gone_30_days_after_deletion(db):
    gone = await seed_company(db, days_ago=31)
    kept = await seed_company(db, days_ago=29)
    before = await owned_rows(db, gone["company"])
    kept_before = await owned_rows(db, kept["company"])
    # The seed reaches every table a company owns through a cascading key.
    assert {
        "company_members",
        "company_invites",
        "job_postings",
        "posting_views",
        "bookmarks",
        "conversations",
        "messages",
        "conversation_attachments",
        "conversation_shares",
        "employer_reviews",
        "employer_interview_kits",
        "rag_nodes",
    } <= set(before)

    await purge_deleted(db, None)

    for table, rows in before.items():
        left = await db.fetchval(
            f"SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text = ANY($1::text[])", rows
        )
        assert left == 0, table
    # No key anywhere still points at the company.
    for fk in await db.fetch(FKS_SQL):
        if fk["parent"] == "companies":
            assert (
                await db.fetchval(
                    f"SELECT count(*) FROM {fk['child']} WHERE {fk['col']} = $1", gone["company"]
                )
                == 0
            )
    # Rows without a foreign key.
    assert (
        await db.fetchval(
            "SELECT count(*) FROM workspace_files WHERE conversation_id = $1", gone["conversation"]
        )
        == 0
    )
    assert (
        await db.fetchval(
            "SELECT count(*) FROM posting_fit_cache WHERE posting_id = $1", gone["posting"]
        )
        == 0
    )
    assert await db.fetchval("SELECT count(*) FROM upload_images WHERE key = $1", gone["logo"]) == 0
    # Kept: payment record without the company, the candidate's own job, the younger company.
    assert (
        await db.fetchval(
            "SELECT company_id IS NULL FROM billing_ledger WHERE id = $1", gone["ledger"]
        )
        is True
    )
    assert (
        await db.fetchval(
            "SELECT count(*) FROM jobs WHERE user_id = $1 AND source_posting_id IS NULL",
            gone["candidate"],
        )
        == 1
    )
    assert await owned_rows(db, kept["company"]) == kept_before
    assert (
        await db.fetchval(
            "SELECT count(*) FROM workspace_files WHERE conversation_id = $1", kept["conversation"]
        )
        == 1
    )

    # Idempotent: a second run changes nothing.
    await purge_deleted(db, None)
    assert await owned_rows(db, kept["company"]) == kept_before


async def test_sweeps_delete_only_rows_past_their_period(db):
    user = uuid.uuid4()
    await db.execute(
        "INSERT INTO users (id, provider, provider_subject, display_name) "
        "VALUES ($1, 'test', md5(random()::text), 'u')",
        user,
    )

    async def ages(sql, *args):
        await db.execute(sql, *args)

    old, new = "now() - interval '31 days'", "now() - interval '29 days'"
    for at in (old, new):
        await ages(
            f"INSERT INTO phone_codes (id, phone, code_hash, expires_at, sent_at) "
            f"VALUES ($1, '010', 'h', {at}, {at})",
            uuid.uuid4(),
        )
        await ages(
            f"INSERT INTO search_queries (id, term, created_at) VALUES ($1, 't', {at})",
            uuid.uuid4(),
        )
    for at in ("now() - interval '25 hours'", "now() - interval '23 hours'"):
        refresh = uuid.uuid4()
        await ages(
            f"INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) "
            f"VALUES ($1, $2, md5(random()::text), {at})",
            refresh,
            user,
        )
        await ages(
            "INSERT INTO access_tokens (id, user_id, token_hash, refresh_token_id, "
            "expires_at) VALUES ($1, $2, md5(random()::text), $3, now() + interval '1 hour')",
            uuid.uuid4(),
            user,
            refresh,
        )
        await ages(
            f"INSERT INTO oauth_states (state, provider, code_challenge, redirect_uri, "
            f"expires_at) VALUES ($1, 'g', 'c', 'r', {at})",
            str(uuid.uuid4()),
        )
        await ages(
            f"INSERT INTO idempotency_keys (id, user_id, method, path, key, request_hash, "
            f"created_at) VALUES ($1, $2, 'POST', '/x', $1, 'h', {at})",
            uuid.uuid4(),
            user,
        )
    # Unverified signups: old with no token (gone), old with a live resent token (kept), new (kept).
    signups = [uuid.uuid4() for _ in range(3)]
    for signup, at in zip(
        signups, ("now() - interval '2 days'", "now() - interval '2 days'", "now()"), strict=True
    ):
        await ages(
            f"INSERT INTO email_signups (id, email, password_hash, is_employer, "
            f"display_name, created_at) VALUES ($1, md5(random()::text), 'h', false, 'n', {at})",
            signup,
        )
    await ages(
        "INSERT INTO email_tokens (id, signup_id, kind, token_hash, expires_at) "
        "VALUES ($1, $2, 'VERIFY', md5(random()::text), now() + interval '1 hour')",
        uuid.uuid4(),
        signups[1],
    )
    # Payments: purged owner and 5+ years old (gone), purged owner and younger (kept),
    # live owner and 5+ years old (kept: balances read it).
    for owner, at in (
        (None, "now() - interval '5 years 1 day'"),
        (None, "now() - interval '4 years'"),
        (user, "now() - interval '5 years 1 day'"),
    ):
        await ages(
            f"INSERT INTO billing_ledger (id, user_id, type, amount_micro_credits, "
            f"balance_after, created_at) VALUES ($1, $2, 'TOPUP', 1, 1, {at})",
            uuid.uuid4(),
            owner,
        )
    for at in ("now() - interval '3 years 1 day'", "now() - interval '2 years'"):
        await ages(
            f"INSERT INTO offer_reports (id, reporter_id, created_at) VALUES ($1, $2, {at})",
            uuid.uuid4(),
            user,
        )

    async def counts():
        return {
            t: await db.fetchval(f"SELECT count(*) FROM {t}")
            for t in (
                "phone_codes",
                "search_queries",
                "refresh_tokens",
                "access_tokens",
                "oauth_states",
                "idempotency_keys",
                "email_signups",
                "billing_ledger",
                "offer_reports",
            )
        }

    start = await counts()
    await purge_deleted(db, None)
    after = await counts()
    assert {t: start[t] - after[t] for t in start} == {
        "phone_codes": 1,
        "search_queries": 1,
        "refresh_tokens": 1,
        "access_tokens": 1,
        "oauth_states": 1,
        "idempotency_keys": 1,
        "email_signups": 1,
        "billing_ledger": 1,
        "offer_reports": 1,
    }
    assert (
        await db.fetchval(
            "SELECT count(*) FROM email_signups WHERE id = ANY($1::uuid[])", signups[1:]
        )
        == 2
    )

    await purge_deleted(db, None)
    assert await counts() == after
