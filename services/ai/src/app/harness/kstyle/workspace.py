"""Per-conversation state files in workspace_files: the notes ledger and any JSON a stage hands on."""
from __future__ import annotations

import json

from app.harness.kstyle.ledger import Notes, empty_notes
from app.harness.tools import ToolContext

NOTES_FILE = "00_notes.json"


async def put_body(ctx: ToolContext, name: str, body: str) -> None:
    await ctx.db.q().execute(
        "INSERT INTO workspace_files (conversation_id, name, body, updated_at) "
        "VALUES ($1,$2,$3,now()) "
        "ON CONFLICT (conversation_id, name) DO UPDATE "
        "SET body=EXCLUDED.body, updated_at=now()",
        ctx.conversation_id, name, body,
    )


async def load_json(ctx: ToolContext, name: str) -> dict:
    if ctx.db is None:
        return {}
    row = await ctx.db.q().fetchrow(
        "SELECT body FROM workspace_files WHERE conversation_id=$1 AND name=$2",
        ctx.conversation_id, name)
    try:
        saved = json.loads(row["body"]) if row is not None and row["body"] else {}
    except ValueError:
        saved = {}
    return saved if isinstance(saved, dict) else {}


async def save_json(ctx: ToolContext, name: str, data: dict) -> None:
    if ctx.db is None:
        return
    await put_body(ctx, name, json.dumps(data, ensure_ascii=False))


async def load_notes(ctx: ToolContext, name: str = NOTES_FILE) -> Notes:
    notes = empty_notes()
    saved = await load_json(ctx, name)
    notes.update({key: saved[key] for key in notes if key in saved})
    return notes


async def save_notes(ctx: ToolContext, notes: Notes, name: str = NOTES_FILE) -> None:
    await save_json(ctx, name, notes)
