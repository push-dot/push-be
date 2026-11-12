from __future__ import annotations

import json

_PROGRESS = frozenset({"status", "done"})
_CARDS = frozenset({"approval", "choice"})
_TERMINAL = frozenset({"done", "error", "cancelled"})
_STATUS_FIELDS = ("phase", "since", "ahead", "for", "cardId")
_MATERIAL_KINDS = frozenset({"file", "document", "posting", "link"})


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


def _hidden(kind: str, payload: dict) -> bool:
    """A row the bot stream does not send (gateway conversations.ts `hidden`)."""
    if kind == "status":
        return payload.get("phase") is None
    return _markdown_file(kind, payload)


def text_pieces(rows: list[dict]) -> list[list[dict]]:
    """Token rows grouped into the pieces of text a reader sees, in id order.

    Two tokens are one piece when nothing but status rows, or rows no reader sees, lies between
    them. The app's reducer splits live frames by the same rule, and compaction rewrites by it.
    """
    pieces: list[list[dict]] = []
    piece: list[dict] | None = None
    for row in rows:
        kind = str(row["type"])
        if kind == "token":
            if piece is None:
                piece = []
                pieces.append(piece)
            piece.append(row)
        elif kind != "status" and not _hidden(kind, _object(row["payload"])):
            piece = None
    return pieces


def _text(piece: list[dict]) -> str:
    return "".join(str(_object(row["payload"]).get("text") or "") for row in piece)


def compaction(rows: list[dict]) -> tuple[dict[int, str], list[int]]:
    """What compacting a finished bot turn changes: each piece of text is kept on its last row
    with the joined text, and its other rows go with every status row that is not a wait."""
    pieces = text_pieces(rows)
    merged = {int(piece[-1]["id"]): _text(piece) for piece in pieces if len(piece) > 1}
    dropped = [int(row["id"]) for piece in pieces for row in piece[:-1]]
    dropped += [
        int(row["id"]) for row in rows
        if row["type"] == "status" and _object(row["payload"]).get("phase") != "waiting"
    ]
    return merged, sorted(dropped)


def _frame(kind: str, payload: dict) -> dict:
    """The body the bot stream sends for a stored row (gateway conversations.ts `sseFrame`)."""
    if kind == "token":
        return {"type": "token", "text": str(payload.get("text") or "")}
    if kind == "status":
        return {"type": "status", "text": str(payload.get("text") or ""),
                **{field: payload[field] for field in _STATUS_FIELDS if payload.get(field) is not None}}
    if kind == "error":
        return {"type": "error", "error": payload.get("error") or {}}
    if kind == "cancelled":
        return {"type": "cancelled", "resumable": payload.get("resumable") is True}
    return {**payload, "type": kind}


def bot_turn_events(rows: list[dict], cards: dict[str, dict], active: bool) -> list[dict]:
    """A bot turn's events as its stream sent them, with seq and at, without done.

    Each piece of text is one token at its last row. Rows after the first terminal event never
    reached a stream. A finished turn keeps only the status rows of a wait. `cards` holds the
    facts of each card's approvals row by card id.
    """
    pieces = {int(piece[-1]["id"]): _text(piece) for piece in text_pieces(rows)}
    events: list[dict] = []
    for row in rows:
        kind, payload, seq = str(row["type"]), _object(row["payload"]), int(row["id"])
        if kind == "done":
            break
        if _hidden(kind, payload) or (kind == "token" and seq not in pieces):
            continue
        waiting = kind == "status" and payload.get("phase") == "waiting"
        if kind == "status" and not (active or waiting):
            continue
        event = _frame(kind, {**payload, "text": pieces[seq]} if kind == "token" else payload)
        if kind in _CARDS:
            event.update(cards.get(str(payload.get("id") or "")) or {**_UNSTORED_CARD, "openedAt": row["created_at"]})
        elif waiting and str(payload.get("cardId") or "") in cards:
            event["since"] = cards[str(payload["cardId"])]["openedAt"]
        events.append({**event, "seq": seq, "at": row["created_at"]})
        if kind in _TERMINAL:
            break
    return events


# A card with no approvals row is a gate the server answered itself (`auto`): nobody can answer it.
_UNSTORED_CARD = {
    "resolution": {"status": "APPROVED", "optionId": None},
    "expiresAt": None,
    "retryable": False,
}


def bot_card(row: dict) -> dict:
    return {
        "resolution": card_resolution(row),
        "openedAt": row["opened_at"],
        "expiresAt": row["expires_at"],
        "retryable": bool(row["retryable"]),
    }


def card_ids(rows: list[dict]) -> list[str]:
    return [str(_object(row["payload"]).get("id") or "") for row in rows if row["type"] in _CARDS]


def card_resolution(row: dict) -> dict:
    resolution = {"status": str(row["status"]), "optionId": row["option_id"]}
    picked = _list(row.get("option_ids"))
    if picked:
        resolution["optionIds"] = picked
    return resolution


def _json_list(raw) -> list:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    return raw if isinstance(raw, list) else []


def _list(raw) -> list[str]:
    return [str(item) for item in _json_list(raw)]


def turn_answer(raw) -> dict | None:
    resume = _object(raw)
    if not resume.get("approvalId"):
        return None
    answer = {"approvalId": str(resume["approvalId"]), "optionId": resume.get("optionId")}
    picked = _list(resume.get("optionIds"))
    if picked:
        answer["optionIds"] = picked
    return answer


def _attachments(raw) -> list[dict]:
    return [
        {"kind": item["kind"], "id": str(item["id"]), "title": str(item.get("title") or "")}
        for item in _json_list(raw)
        if isinstance(item, dict) and item.get("kind") in _MATERIAL_KINDS and item.get("id")
    ]


def bot_turn(job: dict, events: list[dict], user: dict | None, assistant: dict | None) -> dict:
    """One chat job of a bot's thread. Its id is the job id, which the stream sends as `turn`."""
    return {
        "id": str(job["id"]),
        "status": str(job["status"]),
        "createdAt": job["created_at"],
        "user": None if user is None else {
            "messageId": str(user["id"]), "text": user["text"], "attachments": _attachments(user["attachments"])},
        "answer": turn_answer(job.get("resume")),
        "events": events,
        "assistant": None if assistant is None else {
            "messageId": str(assistant["id"]), "text": assistant["text"],
            "sources": _attachments(assistant["attachments"])},
    }


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
