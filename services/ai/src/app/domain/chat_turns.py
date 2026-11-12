from __future__ import annotations

import json

_PROGRESS = frozenset({"status", "done"})
_CARDS = frozenset({"approval", "choice"})


def _object(raw) -> dict:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return raw if isinstance(raw, dict) else {}


def _markdown_file(kind: str, payload: dict) -> bool:
    if kind != "file":
        return False
    name = str(payload.get("name") or payload.get("fileName") or "")
    mime = str(payload.get("mime") or payload.get("mimeType") or "")
    return name.lower().endswith(".md") or mime.lower() == "text/markdown"


def turn_events(rows: list[dict], resolutions: dict[str, dict]) -> list[dict]:
    events: list[dict] = []
    for row in rows:
        kind = str(row["type"])
        payload = _object(row["payload"])
        if kind in _PROGRESS or _markdown_file(kind, payload):
            continue
        if kind == "token" and events and events[-1]["type"] == "token":
            events[-1]["text"] += str(payload.get("text") or "")
            continue
        event = {"type": kind, **payload, "seq": int(row["id"])}
        resolution = resolutions.get(str(payload.get("id") or ""))
        if kind in _CARDS and resolution is not None:
            event["resolution"] = resolution
        events.append(event)
    return events


def card_ids(rows: list[dict]) -> list[str]:
    return [str(_object(row["payload"]).get("id") or "") for row in rows if row["type"] in _CARDS]


def card_resolution(row: dict) -> dict:
    resolution = {"status": str(row["status"]), "optionId": row["option_id"]}
    picked = _list(row.get("option_ids"))
    if picked:
        resolution["optionIds"] = picked
    return resolution


def _list(raw) -> list[str]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    return [str(item) for item in raw] if isinstance(raw, list) else []


def turn_answer(raw) -> dict | None:
    resume = _object(raw)
    if not resume.get("approvalId"):
        return None
    answer = {"approvalId": str(resume["approvalId"]), "optionId": resume.get("optionId")}
    picked = _list(resume.get("optionIds"))
    if picked:
        answer["optionIds"] = picked
    return answer


def turn_view(job: dict, events: list[dict], user_message, assistant_message) -> dict:
    return {
        "jobId": str(job["id"]),
        "status": str(job["status"]),
        "createdAt": job["created_at"],
        "userMessageId": None if user_message is None else str(user_message),
        "assistantMessageId": None if assistant_message is None else str(assistant_message),
        "answer": turn_answer(job.get("resume")),
        "events": events,
    }
