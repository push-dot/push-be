from __future__ import annotations

import json
import logging
from uuid import uuid4

logger = logging.getLogger(__name__)

_EFFORTS = frozenset({"LOW", "MEDIUM", "HIGH", "MAX"})
_DEFAULTS = {"default_effort": "MEDIUM", "confirm_before_edit": True}
_SELECT = (
    "SELECT default_effort, confirm_before_edit "
    "FROM user_settings WHERE user_id = $1"
)
_INSERT = (
    "INSERT INTO notifications (id, user_id, type, title, body, target) "
    "VALUES ($1, $2, 'AI_DONE', $3, $4, $5::jsonb)"
)
_TITLE = "AI 작업이 끝났어요"


def _stored_effort(value) -> str:
    if isinstance(value, str):
        text = value.strip()
        if text in _EFFORTS:
            return text
    return "MEDIUM"


def _confirm(row) -> bool:
    if not isinstance(row, dict) or "confirm_before_edit" not in row:
        return True
    return row.get("confirm_before_edit") is not False


def resolve_chat_settings(row) -> dict:
    source = row if isinstance(row, dict) else None
    raw = source.get("default_effort") if source is not None else None
    return {"effort": _stored_effort(raw), "confirm_before_edit": _confirm(source)}


def apply_chat_settings(state, row) -> dict:
    resolved = resolve_chat_settings(row)
    out = {"confirm_before_edit": resolved["confirm_before_edit"]}
    ai = state.get("ai") if isinstance(state, dict) else None
    if not isinstance(ai, dict):
        return out
    effort = ai.get("effort")
    if isinstance(effort, str) and effort.strip() in _EFFORTS:
        return out
    out["ai"] = {**ai, "effort": resolved["effort"]}
    return out


async def load_chat_settings(query, user_id) -> dict:
    try:
        row = await query.fetchrow(_SELECT, user_id)
    except Exception:
        return dict(_DEFAULTS)
    if not isinstance(row, dict):
        return dict(_DEFAULTS)
    return row


async def insert_ai_done(query, user_id, conversation_id) -> None:
    try:
        target = json.dumps(
            {"kind": "conversation", "id": str(conversation_id)},
            separators=(",", ":"),
        )
        await query.execute(
            _INSERT, uuid4(), user_id, _TITLE, "", target)
    except Exception:
        logger.exception("AI_DONE insert failed")
