"""Hard-delete accounts whose 30-day deletion grace period ended."""

import logging
import os

from app.infrastructure.images import image_dir

logger = logging.getLogger(__name__)

# Foreign keys cascade from users (migration 0018). workspace_files has no
# foreign key, so it is cleared through the user's conversations first.
# Returns the image keys (post images, avatar) the deleted users owned.
PURGE_SQL = (
    "WITH gone AS (SELECT id FROM users "
    "WHERE deletion_requested_at < now() - interval '30 days' LIMIT 50), "
    "images AS (SELECT jsonb_array_elements_text(image_keys) AS key FROM posts "
    "WHERE user_id IN (SELECT id FROM gone) AND jsonb_typeof(image_keys) = 'array' "
    "UNION SELECT avatar_key FROM profiles "
    "WHERE user_id IN (SELECT id FROM gone) AND avatar_key IS NOT NULL), "
    "files AS (DELETE FROM workspace_files WHERE conversation_id IN "
    "(SELECT id FROM conversations WHERE user_id IN (SELECT id FROM gone))), "
    "users_deleted AS (DELETE FROM users WHERE id IN (SELECT id FROM gone)) "
    "SELECT key FROM images"
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


async def purge_deleted(pool, storage_dir: str | None) -> None:
    """Called from the existing cron."""
    if pool is None:
        return
    try:
        rows = await pool.fetch(PURGE_SQL)
    except Exception:
        logger.warning("account purge failed; is migration 0018 applied?")
        return
    if storage_dir:
        remove_images(storage_dir, [r["key"] for r in rows])
