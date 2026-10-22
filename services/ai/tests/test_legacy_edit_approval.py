from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import uuid4

from app.domain.errors import revision_conflict
from app.domain.services.conversation import ConversationService
from tests.stubs import StubChatJobStore

APPROVAL = str(uuid4())
DIFF = {"documentId": str(uuid4()), "revisionId": "", "hunks": [
    {"line": 1, "sign": "-", "text": "old"}, {"line": 1, "sign": "+", "text": "new"}]}


class _Rows:
    def __init__(self, kind="DOCUMENT_EDIT", job_id=None, claimed=True):
        self.row = {"kind": kind, "job_id": job_id, "tool_args": json.dumps(DIFF)}
        self.claimed = claimed
        self.sql = []

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        self.sql.append(sql)
        if sql.startswith("UPDATE approvals SET status = 'CONSUMED'"):
            return {"id": args[0]} if self.claimed else None
        return self.row

    async def run(self, fn):
        return await fn()


class _Docs:
    def __init__(self, error=None):
        self.applied = []
        self.error = error

    async def apply_hunks(self, user_id, diff):
        if self.error:
            raise self.error
        self.applied.append(diff)
        return None, SimpleNamespace(id="v2")


def _service(rows, docs):
    svc = ConversationService(rows, None, None)
    svc.jobs = StubChatJobStore()
    svc.document_svc = docs

    async def boom(*args, **kwargs):
        raise AssertionError("the chat graph must not run for an approved legacy edit")
        yield

    svc._compiled = SimpleNamespace(astream=boom)
    return svc


def _job():
    return {"id": uuid4(), "user_id": uuid4(), "conversation_id": uuid4(), "attempt": 1,
            "payload": {"text": "", "resume": {"approvalId": APPROVAL, "optionId": "apply"}}}


async def test_approved_legacy_edit_is_applied_once_without_a_chat_turn():
    rows, docs = _Rows(), _Docs()
    svc = _service(rows, docs)
    await svc._run_job(_job())
    assert docs.applied == [DIFF]
    assert [event["type"] for event in svc.jobs.events] == ["diff", "done"]
    assert ("DONE", None) in svc.jobs.finished

    rows.claimed = False
    await svc._run_job(_job())
    assert len(docs.applied) == 1


async def test_conflicting_legacy_edit_reports_revision_conflict():
    svc = _service(_Rows(), _Docs(revision_conflict(5)))
    await svc._run_job(_job())
    tool = next(event for event in svc.jobs.events if event["type"] == "tool")
    assert tool["payload"]["result"] == {"error": "REVISION_CONFLICT"}
