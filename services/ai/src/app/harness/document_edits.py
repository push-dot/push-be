from __future__ import annotations

import json
import os
from uuid import NAMESPACE_URL, uuid5

import httpx

from app.domain.errors import DomainError
from app.harness.core_client import CoreClient, CoreError


def env_core() -> CoreClient:
    return CoreClient(os.environ.get("CORE_ORIGIN", ""), os.environ.get("INTERNAL_API_SECRET", ""))


async def apply_edit(core: CoreClient, user_id, diff: dict) -> dict:
    """Apply chat diff hunks through core (POST /documents/{id}/edits), the only writer of document versions."""
    key = str(uuid5(NAMESPACE_URL, "push:doc-edit:" + str(user_id) + ":" + json.dumps(diff, sort_keys=True, ensure_ascii=False)))
    try:
        return await core.call(
            "POST", f"/api/v1/documents/{diff.get('documentId')}/edits", user_id=str(user_id),
            json={"revisionId": diff.get("revisionId"), "hunks": diff.get("hunks") or []},
            idempotency_key=key)
    except CoreError as err:
        raise DomainError(err.status, err.code, err.message)
    except httpx.HTTPError:
        raise DomainError(502, "PROVIDER_ERROR", "core request failed")
