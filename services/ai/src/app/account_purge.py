"""Hard-delete accounts whose 30-day deletion grace period ended."""

import logging

logger = logging.getLogger(__name__)

# Foreign keys cascade from users (migration 0018). workspace_files has no
# foreign key, so it is cleared through the user's conversations first.
# shortcut: uploaded images on disk have no owner column and are not removed; add one when images move to R2.
PURGE_SQL = (
    "WITH gone AS (SELECT id FROM users "
    "WHERE deletion_requested_at < now() - interval '30 days' LIMIT 50), "
    "files AS (DELETE FROM workspace_files WHERE conversation_id IN "
    "(SELECT id FROM conversations WHERE user_id IN (SELECT id FROM gone))) "
    "DELETE FROM users WHERE id IN (SELECT id FROM gone)"
)


async def purge_deleted(pool) -> None:
    """Called from the existing cron."""
    if pool is None:
        return
    try:
        await pool.execute(PURGE_SQL)
    except Exception:
        logger.warning("account purge failed; is migration 0018 applied?")
