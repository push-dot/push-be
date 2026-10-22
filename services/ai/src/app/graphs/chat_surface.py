from __future__ import annotations

import hashlib
import json
from uuid import NAMESPACE_URL, UUID, uuid5

from app.domain.errors import DomainError, not_found, validation_field

_TOOL_STATES = {"run", "ok", "err", "wait"}
_TODO_STATES = {"todo", "now", "done"}
_SIGNS = {"+", "-", ""}
_APPROVAL_OPTIONS = (
    {"id": "apply", "label": "적용"},
    {"id": "skip", "label": "그대로 두기"},
)


def surface_events(state: dict | None) -> list[dict]:
    if not isinstance(state, dict):
        return []
    events: list[dict] = []
    tool = _tool_event(state)
    if tool:
        events.append(tool)
    todo = _todo_event(state)
    if todo:
        events.append(todo)
    diff = _diff_event(state)
    if diff:
        events.append(diff)
        if state.get("confirm_before_edit", True) is not False:
            events.append(_approval_event(diff, state))
    fit = _fit_event(state)
    if fit:
        events.append(fit)
    choice = _choice_event(state)
    if choice:
        events.append(choice)
    return events


def _tool_event(state: dict) -> dict | None:
    raw = None
    if state.get("tool_name"):
        raw = {
            "name": state["tool_name"],
            "state": state.get("tool_state") or "run",
            "summary": state.get("tool_summary") or "",
        }
    elif isinstance(state.get("posting_read"), dict):
        raw = state["posting_read"]
    if not isinstance(raw, dict):
        return None
    if raw.get("state") not in _TOOL_STATES or not raw.get("name"):
        return None
    event = {
        "type": "tool",
        "name": raw["name"],
        "state": raw["state"],
        "summary": raw.get("summary") or "",
    }
    if raw.get("tier"):
        event["tier"] = raw["tier"]
    if "result" in raw:
        event["result"] = raw["result"]
    return event


def _todo_event(state: dict) -> dict | None:
    raw = state.get("todos")
    if not isinstance(raw, list) or not raw:
        return None
    items = []
    for item in raw:
        if not isinstance(item, dict) or item.get("state") not in _TODO_STATES:
            continue
        if "id" not in item or "text" not in item:
            continue
        items.append({"id": item["id"], "text": item["text"], "state": item["state"]})
    if not items:
        return None
    return {"type": "todo", "items": items}


def _diff_event(state: dict) -> dict | None:
    raw = state.get("diff")
    if not isinstance(raw, dict) or not raw.get("documentId"):
        return None
    hunks = []
    for hunk in raw.get("hunks") or []:
        if not isinstance(hunk, dict):
            continue
        sign = hunk.get("sign", "")
        if sign not in _SIGNS:
            continue
        hunks.append({
            "line": hunk.get("line"),
            "sign": sign,
            "text": hunk.get("text") or "",
        })
    return {
        "type": "diff",
        "documentId": raw["documentId"],
        "revisionId": raw.get("revisionId") or "",
        "hunks": hunks,
    }


def _fit_event(state: dict) -> dict | None:
    raw = state.get("fit")
    if not isinstance(raw, dict) or raw.get("score") is None:
        return None
    parts = raw.get("parts") or {}
    return {
        "type": "fit",
        "score": round(float(raw["score"]), 1),
        "parts": {
            "techStack": int(parts.get("techStack") or 0),
            "experienceLink": int(parts.get("experienceLink") or 0),
            "keyword": int(parts.get("keyword") or 0),
        },
        "topGap": raw.get("topGap") or "",
    }


def _choice_event(state: dict) -> dict | None:
    raw = state.get("choice")
    if not isinstance(raw, dict) or not raw.get("id"):
        return None
    options = []
    for option in raw.get("options") or []:
        if isinstance(option, dict) and option.get("id") and option.get("label"):
            options.append({"id": option["id"], "label": option["label"]})
    if not options:
        return None
    return {"type": "choice", "id": raw["id"], "options": options}


def _approval_event(diff: dict, state: dict) -> dict:
    job_id = state.get("job_id")
    if job_id:
        name = "push:chat-approval:" + str(job_id)
    else:
        name = (
            "push:chat-approval:"
            + str(diff["documentId"]) + ":" + str(diff["revisionId"]))
    approval_id = str(uuid5(NAMESPACE_URL, name))
    return {
        "type": "approval",
        "id": approval_id,
        "kind": "DOCUMENT_EDIT",
        "title": "이 수정을 적용할까요?",
        "options": [dict(option) for option in _APPROVAL_OPTIONS],
    }


def _option_ids(options) -> set:
    if isinstance(options, str):
        options = json.loads(options)
    if not isinstance(options, list):
        return set()
    return {
        item.get("id") for item in options
        if isinstance(item, dict) and item.get("id") is not None
    }


async def resolve_chat_approval(db, user_id, conversation_id, approval_id, option_id: str) -> dict:
    row = await db.q().fetchrow(
        "SELECT id, status, options FROM approvals "
        "WHERE id = $1 AND conversation_id = $2 AND user_id = $3",
        approval_id, conversation_id, user_id)
    if row is None:
        raise not_found()
    if option_id not in _option_ids(row["options"]):
        raise validation_field("optionId", "unknown option")
    if row["status"] != "PENDING":
        raise DomainError(409, "CONFLICT", "approval already decided")
    tag = await db.q().execute(
        "UPDATE approvals SET status = 'APPROVED', option_id = $1, "
        "decided_at = now(), updated_at = now(), revision = revision + 1 "
        "WHERE id = $2 AND conversation_id = $3 AND user_id = $4 AND status = 'PENDING'",
        option_id, approval_id, conversation_id, user_id)
    if not isinstance(tag, str) or tag.split()[-1] == "0":
        raise DomainError(409, "CONFLICT", "approval already decided")
    return {"id": str(approval_id), "status": "APPROVED", "optionId": option_id}


async def publish_persisted_surface(state, db, emit, apply) -> bool:
    events = [
        event for event in surface_events(state)
        if event["type"] in ("diff", "approval", "fit")]
    approval = next((event for event in events if event["type"] == "approval"), None)
    for event in events:
        if event["type"] != "approval":
            emit(event)
    if approval is None:
        diff_event = next((event for event in events if event["type"] == "diff"), None)
        if diff_event is not None and apply is not None:
            await apply(diff_event)
        return False
    conv = state.get("conversation")
    user_id = state.get("user_id")
    if conv is None or user_id is None:
        return True
    diff = state.get("diff") or {}
    await insert_chat_approval(
        db, user_id, conv.id, approval, diff.get("documentId"))
    emit(approval)
    return True


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
