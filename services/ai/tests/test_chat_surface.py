from __future__ import annotations

from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from app.harness.approvals import insert_chat_approval

DOC = "11111111-1111-4111-8111-111111111111"
USER_ID = UUID("00000000-0000-4000-8000-0000000000aa")
CONV_ID = UUID("00000000-0000-4000-8000-0000000000bb")
OPTIONS = [
    {"id": "apply", "label": "적용"},
    {"id": "skip", "label": "그대로 두기"},
]


def _approval_id(job_id) -> str:
    return str(uuid5(NAMESPACE_URL, "push:chat-approval:" + str(job_id)))


class _Duplicate:
    def __init__(self):
        self.calls = []
        self.seen = set()

    def q(self):
        return self

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        if "ON CONFLICT (id) DO NOTHING" not in sql and args[0] in self.seen:
            raise RuntimeError("duplicate key")
        self.seen.add(args[0])


async def test_insert_chat_approval_same_job_does_not_raise():
    job_id = uuid4()
    event = {
        "id": _approval_id(job_id),
        "kind": "DOCUMENT_EDIT",
        "title": "이 수정을 적용할까요?",
        "options": OPTIONS,
    }
    db = _Duplicate()
    await insert_chat_approval(db, USER_ID, CONV_ID, event, DOC)
    await insert_chat_approval(db, USER_ID, CONV_ID, event, DOC)
    assert len(db.calls) == 2
    assert "ON CONFLICT (id) DO NOTHING" in db.calls[0][0]
    assert db.calls[0][1][0] == UUID(event["id"])
    assert db.calls[1][1][0] == UUID(event["id"])
