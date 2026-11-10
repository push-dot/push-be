"""Deletes what the privacy policy says is deleted, once its retention period ends.

Called from the dispatcher maintenance loop. Every statement deletes by a time
condition, so running it again deletes nothing new.
"""

import asyncio
import logging
import os

from app.api.errors import redact
from app.infrastructure.images import image_dir

logger = logging.getLogger(__name__)

# Retention periods, one row per line of the 개인정보처리방침 보관 기간 table.
# Change the policy text in the same change. Values are Postgres interval text.
RETENTION = {
    "account": "30 days",        # users: after DELETE /me (deletion_requested_at)
    "company": "30 days",        # companies: after the sole admin deletes the account
    "phone_code": "30 days",     # phone_codes: after the SMS was sent
    "expired_token": "1 day",    # login, OAuth, email and invite tokens: after expires_at
    "idempotency_key": "1 day",  # idempotency_keys and their cached responses: after created_at
    "search_query": "30 days",   # search_queries (term only, no user): after created_at
    "email_signup": "1 day",     # unverified email signups with no live verify mail left
    "payment": "5 years",        # billing_ledger rows whose owner was purged (전자상거래법)
    "report": "3 years",         # offer_reports (전자상거래법 불만·분쟁 기록)
    "document": "30 days",      # documents the user archived (status ARCHIVED)
}

# Foreign keys cascade from users (migration 0018). workspace_files has no
# foreign key, so it is cleared through the user's conversations first.
# Returns the image keys (post images, avatar) the deleted users owned.
PURGE_SQL = (
    "WITH gone AS (SELECT id FROM users "
    "WHERE deletion_requested_at < now() - $1::text::interval LIMIT 50), "
    "images AS (SELECT jsonb_array_elements_text(image_keys) AS key FROM posts "
    "WHERE user_id IN (SELECT id FROM gone) AND jsonb_typeof(image_keys) = 'array' "
    "UNION SELECT avatar_key FROM profiles "
    "WHERE user_id IN (SELECT id FROM gone) AND avatar_key IS NOT NULL), "
    "files AS (DELETE FROM workspace_files WHERE conversation_id IN "
    "(SELECT id FROM conversations WHERE user_id IN (SELECT id FROM gone))), "
    "users_deleted AS (DELETE FROM users WHERE id IN (SELECT id FROM gone)) "
    "SELECT key FROM images"
)

# Company rows cascade from companies (migrations 0019, 0028): members, invites,
# postings and their views and bookmarks, employer conversations with their messages
# and attachments, reviews, interview kits and rag_nodes. Payment rows keep their
# amounts with company_id NULL. The rows without a foreign key go first:
# conversation files and the logo upload.
# fits is redundant after 0048: posting_fit_cache.posting_id references job_postings
# ON DELETE CASCADE, so deleting the company already removes those rows. Left in
# place; deleting them first is harmless.
# Returns the logo keys.
COMPANY_PURGE_SQL = (
    "WITH gone AS (SELECT id, logo_key FROM companies "
    "WHERE deletion_requested_at < now() - $1::text::interval LIMIT 50), "
    "files AS (DELETE FROM workspace_files WHERE conversation_id IN "
    "(SELECT id FROM conversations WHERE company_id IN (SELECT id FROM gone))), "
    "fits AS (DELETE FROM posting_fit_cache WHERE posting_id IN "
    "(SELECT id FROM job_postings WHERE company_id IN (SELECT id FROM gone))), "
    "logos AS (DELETE FROM upload_images WHERE key IN (SELECT logo_key FROM gone)), "
    "companies_deleted AS (DELETE FROM companies WHERE id IN (SELECT id FROM gone)) "
    "SELECT logo_key AS key FROM gone WHERE logo_key IS NOT NULL"
)

# Sweeps delete at most SWEEP_BATCH rows ($2) per statement, SWEEP_ROUNDS times per pass.
# The pass holds the dispatcher lock, so a backlog (the first run) drains over several passes.
SWEEP_BATCH = 5000
SWEEP_ROUNDS = 10

PHONE_CODES_SQL = (
    "DELETE FROM phone_codes WHERE ctid IN (SELECT ctid FROM phone_codes "
    "WHERE sent_at < now() - $1::text::interval LIMIT $2)"
)
OAUTH_STATES_SQL = (
    "DELETE FROM oauth_states WHERE ctid IN (SELECT ctid FROM oauth_states "
    "WHERE expires_at < now() - $1::text::interval LIMIT $2)"
)
EXCHANGE_CODES_SQL = (
    "DELETE FROM exchange_codes WHERE ctid IN (SELECT ctid FROM exchange_codes "
    "WHERE expires_at < now() - $1::text::interval LIMIT $2)"
)
INTEGRATION_CODES_SQL = (
    "DELETE FROM integration_codes WHERE ctid IN (SELECT ctid FROM integration_codes "
    "WHERE expires_at < now() - $1::text::interval LIMIT $2)"
)
EMAIL_TOKENS_SQL = (
    "DELETE FROM email_tokens WHERE ctid IN (SELECT ctid FROM email_tokens "
    "WHERE expires_at < now() - $1::text::interval LIMIT $2)"
)
# The policy deletes invites that expired unaccepted; an accepted one goes with its company.
INVITES_SQL = (
    "DELETE FROM company_invites WHERE ctid IN (SELECT ctid FROM company_invites "
    "WHERE accepted_at IS NULL AND expires_at < now() - $1::text::interval LIMIT $2)"
)
# A refresh token's access tokens cascade with it.
REFRESH_TOKENS_SQL = (
    "DELETE FROM refresh_tokens WHERE ctid IN (SELECT ctid FROM refresh_tokens "
    "WHERE expires_at < now() - $1::text::interval LIMIT $2)"
)
ACCESS_TOKENS_SQL = (
    "DELETE FROM access_tokens WHERE ctid IN (SELECT ctid FROM access_tokens "
    "WHERE expires_at < now() - $1::text::interval LIMIT $2)"
)
# Idempotent replays only matter while a client retries.
IDEMPOTENCY_SQL = (
    "DELETE FROM idempotency_keys WHERE ctid IN (SELECT ctid FROM idempotency_keys "
    "WHERE created_at < now() - $1::text::interval LIMIT $2)"
)
# Trending searches read the last 7 days (core-api routes/search.ts).
SEARCHES_SQL = (
    "DELETE FROM search_queries WHERE ctid IN (SELECT ctid FROM search_queries "
    "WHERE created_at < now() - $1::text::interval LIMIT $2)"
)
# A resend issues a new verify token, so a signup with a live token is kept.
EMAIL_SIGNUPS_SQL = (
    "DELETE FROM email_signups WHERE ctid IN (SELECT s.ctid FROM email_signups s "
    "WHERE s.created_at < now() - $1::text::interval "
    "AND NOT EXISTS (SELECT 1 FROM email_tokens t "
    "WHERE t.signup_id = s.id AND t.expires_at > now()) LIMIT $2)"
)
# Balances are read from the ledger, so rows of a live account or company stay.
PAYMENTS_SQL = (
    "DELETE FROM billing_ledger WHERE ctid IN (SELECT ctid FROM billing_ledger "
    "WHERE user_id IS NULL AND company_id IS NULL "
    "AND created_at < now() - $1::text::interval LIMIT $2)"
)
REPORTS_SQL = (
    "DELETE FROM offer_reports WHERE ctid IN (SELECT ctid FROM offer_reports "
    "WHERE created_at < now() - $1::text::interval LIMIT $2)"
)
# Archive (core-api documents.ts) only sets status = ARCHIVED. After the retention
# period the row is hard-deleted. Versions, exports, shares and revision proposals
# reference the document or its versions with ON DELETE CASCADE, so one parent
# delete removes them in FK order. A second pass matches nothing.
DOCUMENTS_SQL = (
    "DELETE FROM documents WHERE ctid IN (SELECT ctid FROM documents "
    "WHERE status = 'ARCHIVED' AND updated_at < now() - $1::text::interval LIMIT $2)"
)


def remove_images(storage_dir: str, keys) -> None:
    # shortcut: only clears this host's disk; delete from R2 too when images move there.
    directory = image_dir(storage_dir)
    for key in keys:
        if os.path.basename(key) != key:
            continue
        try:
            os.remove(os.path.join(directory, key))
        except OSError:
            pass


async def _purge(pool, sql: str, period: str) -> list[str]:
    try:
        rows = await pool.fetch(sql, RETENTION[period])
    except Exception as exc:
        logger.warning("%s purge failed; are the migrations applied? err=%s", period,
                       redact(f"{type(exc).__name__}: {exc}")[:400])
        return []
    return [r["key"] for r in rows]


async def _sweep(pool, sql: str, period: str) -> None:
    try:
        for _ in range(SWEEP_ROUNDS):
            tag = await pool.execute(sql, RETENTION[period], SWEEP_BATCH)
            # A short batch ("DELETE n") means nothing past the period is left.
            if not tag or int(tag.split()[-1]) < SWEEP_BATCH:
                return
    except Exception as exc:
        logger.warning("%s sweep failed; are the migrations applied? err=%s", period,
                       redact(f"{type(exc).__name__}: {exc}")[:400])


async def purge_deleted(pool, storage_dir: str | None) -> None:
    """Called from the existing cron."""
    if pool is None:
        return
    keys = await _purge(pool, PURGE_SQL, "account")
    keys += await _purge(pool, COMPANY_PURGE_SQL, "company")
    await _sweep(pool, PHONE_CODES_SQL, "phone_code")
    await _sweep(pool, OAUTH_STATES_SQL, "expired_token")
    await _sweep(pool, EXCHANGE_CODES_SQL, "expired_token")
    await _sweep(pool, INTEGRATION_CODES_SQL, "expired_token")
    await _sweep(pool, EMAIL_TOKENS_SQL, "expired_token")
    await _sweep(pool, INVITES_SQL, "expired_token")
    await _sweep(pool, REFRESH_TOKENS_SQL, "expired_token")
    await _sweep(pool, ACCESS_TOKENS_SQL, "expired_token")
    await _sweep(pool, IDEMPOTENCY_SQL, "idempotency_key")
    await _sweep(pool, SEARCHES_SQL, "search_query")
    await _sweep(pool, EMAIL_SIGNUPS_SQL, "email_signup")
    await _sweep(pool, PAYMENTS_SQL, "payment")
    await _sweep(pool, REPORTS_SQL, "report")
    await _sweep(pool, DOCUMENTS_SQL, "document")
    if storage_dir and keys:
        # Up to 50 users' files: keep the unlinks off the event loop.
        await asyncio.to_thread(remove_images, storage_dir, keys)
