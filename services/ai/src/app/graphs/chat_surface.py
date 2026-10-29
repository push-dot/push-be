from __future__ import annotations

import hashlib
import json
import logging
from uuid import NAMESPACE_URL, UUID, uuid5

from app.domain.errors import DomainError

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
            "techStack": _fit_part(parts, "techStack"),
            "experienceLink": _fit_part(parts, "experienceLink"),
            "careerLevel": _fit_part(parts, "careerLevel"),
            "keyword": _fit_part(parts, "keyword"),
            "domain": _fit_part(parts, "domain"),
        },
        "topGap": raw.get("topGap") or "",
    }


def _fit_part(parts: dict, key: str) -> float:
    return round(float(parts.get(key) or 0), 1)


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
            try:
                await apply(diff_event)
            except DomainError:
                logging.getLogger(__name__).warning("chat edit not applied", exc_info=True)
        return False
    conv = state.get("conversation")
    user_id = state.get("user_id")
    if conv is None or user_id is None:
        return True
    diff = state.get("diff") or {}
    await insert_chat_approval(
        db, user_id, conv.id, approval, diff.get("documentId"))
    if diff:
        try:
            await db.q().execute(
                "UPDATE approvals SET tool_args = $2::jsonb WHERE id = $1",
                UUID(str(approval["id"])), json.dumps(diff, ensure_ascii=False))
        except Exception:
            logging.getLogger(__name__).warning("chat edit diff not stored", exc_info=True)
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
