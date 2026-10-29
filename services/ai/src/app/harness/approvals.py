from __future__ import annotations

import hashlib
import json
from uuid import UUID


async def insert_chat_approval(db, user_id, conversation_id, event: dict, document_id) -> None:
    options = json.dumps(event["options"], ensure_ascii=False)
    try:
        target_id = UUID(str(document_id))
    except (ValueError, TypeError):
        target_id = UUID(str(event["id"]))
    await db.q().execute(
        "INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, "
        "conversation_id, title, options) "
        "VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$8::jsonb) "
        "ON CONFLICT (id) DO NOTHING",
        UUID(str(event["id"])),
        user_id,
        event["kind"],
        target_id,
        hashlib.sha256(options.encode()).hexdigest(),
        conversation_id,
        event["title"],
        options,
    )
