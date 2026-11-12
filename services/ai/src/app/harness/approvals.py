from __future__ import annotations

import hashlib
import json
from uuid import UUID


def card_options(event: dict) -> list[dict]:
    """Ids the approval route will accept. The emitted event keeps its own options list."""
    stored: list[dict] = []
    seen: set[str] = set()

    def add(item: dict) -> None:
        if not isinstance(item, dict):
            return
        raw_id = item.get("id")
        if not isinstance(raw_id, str) or not raw_id or raw_id in seen:
            return
        seen.add(raw_id)
        stored.append(dict(item))

    for item in event.get("options") or []:
        add(item)
    for section in event.get("sections") or []:
        if not isinstance(section, dict) or section.get("kind") == "rows":
            continue
        for item in section.get("options") or []:
            add(item)
    submit = event.get("submit")
    if isinstance(submit, dict) and "submit" not in seen:
        label = submit.get("label")
        stored.append(
            {
                "id": "submit",
                "label": label if isinstance(label, str) and label.strip() else "submit",
            }
        )
    return stored


async def insert_chat_approval(db, user_id, conversation_id, event: dict, document_id) -> None:
    options = json.dumps(card_options(event), ensure_ascii=False)
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
