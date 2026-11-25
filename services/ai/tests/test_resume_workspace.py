from __future__ import annotations

import json
from uuid import uuid4

from app.harness.personal.resume.workspace import (
    NOTES_FILE,
    add_evidence,
    empty_notes,
    ledger_text,
    load_notes,
    save_notes,
)
from app.harness.tools import ToolContext

CONV = str(uuid4())


class _Files:
    def __init__(self):
        self.files = {}

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        assert "SELECT body FROM workspace_files WHERE conversation_id=$1 AND name=$2" in sql
        body = self.files.get((args[0], args[1]))
        return None if body is None else {"body": body}

    async def execute(self, sql, *args):
        assert "ON CONFLICT (conversation_id, name)" in sql
        self.files[(args[0], args[1])] = args[2]
        return "INSERT 1"


def _ctx(db):
    return ToolContext(user_id=str(uuid4()), company_id=None, conversation_id=CONV, job_id="j",
                       tool_call_id="t", db=db, core=None)


async def test_notes_round_trip_through_workspace_files():
    db = _Files()
    ctx = _ctx(db)
    assert await load_notes(ctx) == empty_notes()
    notes = empty_notes()
    notes["steer"].append("아카이브 빼줘")
    add_evidence(notes, "repo", "acme-labs/shop-api:README.md", "FastAPI 서버", "FastAPI 씀",
                 text="FastAPI 서버")
    await save_notes(ctx, notes)
    assert json.loads(db.files[(CONV, NOTES_FILE)])["steer"] == ["아카이브 빼줘"]
    assert await load_notes(ctx) == notes


async def test_notes_without_a_db_or_with_a_broken_body_start_empty():
    ctx = _ctx(None)
    assert await load_notes(ctx) == empty_notes()
    await save_notes(ctx, empty_notes())
    db = _Files()
    db.files[(CONV, NOTES_FILE)] = "{not json"
    assert await load_notes(_ctx(db)) == empty_notes()
    db.files[(CONV, NOTES_FILE)] = json.dumps({"assumptions": ["신입"], "extra": 1})
    assert await load_notes(_ctx(db)) == {**empty_notes(), "assumptions": ["신입"]}


def test_add_evidence_numbers_caps_and_verifies_by_code():
    notes = empty_notes()
    source = "def   run():\n    return  queue.push(job)"
    first = add_evidence(notes, "repo", "a/b:x.py", "def run():\n return queue.push(job)", "큐 씀", text=source)
    assert first["id"] == "E1" and first["verified"] is True
    assert add_evidence(notes, "repo", "a/b:x.py", "DEF RUN()", "x", text=source)["verified"] is False
    assert add_evidence(notes, "repo", "a/b:x.py", "  ", "x", text=source)["verified"] is False
    notes["evidence"].pop(1)
    assert add_evidence(notes, "company", "https://x.example", "가" * 400, "y", text="")["id"] == "E4"
    assert len(notes["evidence"][-1]["quote"]) == 300


def test_ledger_lists_verified_first_and_caps_length():
    notes = empty_notes()
    add_evidence(notes, "repo", "a/b:x", "nope", "추측", text="")
    add_evidence(notes, "repo", "a/b:y", "real", "사실", text="real code")
    text = ledger_text(notes)
    assert text.index("E2") < text.index("E1")
    assert "미확인" in text.splitlines()[1]
    assert ledger_text(notes, limit=len(text.splitlines()[0]) + 1) == text.splitlines()[0]
    assert ledger_text(empty_notes()) == ""
