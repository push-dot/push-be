from __future__ import annotations

from uuid import UUID

from app.domain.errors import DomainError

CONSENT_REQUIRED = "CONSENT_REQUIRED"

_SQL = (
    "SELECT COALESCE((SELECT c.reference_data FROM user_consents c WHERE c.user_id = $1), false) "
    "AND COALESCE((SELECT s.allow_ai_read_my_files FROM user_settings s WHERE s.user_id = $1), true) "
    "AS given"
)


async def require_consent(db, user_id) -> None:
    """core-api refuses a send without consent; this stops a job queued before the user withdrew it."""
    row = await db.q().fetchrow(_SQL, UUID(str(user_id)))
    if row is not None and not row["given"]:
        raise DomainError(403, CONSENT_REQUIRED, "reference data consent is required")
