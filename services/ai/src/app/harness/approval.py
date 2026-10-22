from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from uuid import NAMESPACE_URL, UUID, uuid5

from app.clock import utcnow

_OPTIONS = (
    {"id": "approve", "label": "실행"},
    {"id": "reject", "label": "취소"},
)


def approval_id_for(job_id: str, tool_call_id: str) -> str:
    return str(uuid5(NAMESPACE_URL, "push:tool-approval:" + job_id + ":" + tool_call_id))


def tool_action_event(approval_id: str, summary: str, tool_name: str, args: dict) -> dict:
    return {
        "type": "approval",
        "id": approval_id,
        "kind": "TOOL_ACTION",
        "title": summary,
        "summary": summary,
        "toolName": tool_name,
        "args": args,
        "options": [dict(option) for option in _OPTIONS],
    }


async def create_tool_approval(db, *, user_id, conversation_id, job_id, tool, args, tool_call_id) -> tuple[dict, bool]:
    approval_id = approval_id_for(str(job_id), str(tool_call_id))
    payload = args if isinstance(args, dict) else args.model_dump(mode="json")
    event = tool_action_event(approval_id, tool.summarize(args) if not isinstance(args, dict) else tool.summarize(tool.args_model.model_validate(args)), tool.name, payload)
    existing = await db.q().fetchrow("SELECT id FROM approvals WHERE id = $1", UUID(approval_id))
    if existing is not None:
        return event, False
    options = json.dumps(event["options"], ensure_ascii=False)
    await db.q().execute(
        "INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, "
        "conversation_id, title, options, tool_name, tool_args, tool_call_id, job_id, expires_at) "
        "VALUES ($1,$2,'TOOL_ACTION',$3,$4,'PENDING',$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12) "
        "ON CONFLICT (id) DO NOTHING",
        UUID(approval_id),
        user_id,
        UUID(approval_id),
        hashlib.sha256(options.encode()).hexdigest(),
        conversation_id,
        event["title"],
        options,
        tool.name,
        json.dumps(payload, ensure_ascii=False),
        tool_call_id,
        job_id,
        utcnow() + timedelta(hours=24),
    )
    return event, True


# shortcut: runs on the chat worker stale sweep (15 min) until feat/be-queue-rag merges, then move it to the dispatcher sweep
async def expire_approvals(db) -> None:
    await db.q().execute(
        "UPDATE approvals SET status = 'EXPIRED', updated_at = now() "
        "WHERE status = 'PENDING' AND expires_at < now()")
