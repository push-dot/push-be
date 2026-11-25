from __future__ import annotations

from types import SimpleNamespace

from app.harness.runtime import HarnessRuntime

COMPANY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
CONV = "11111111-1111-4111-8111-111111111111"


class Db:
    def __init__(self, row=None, fail=False):
        self.row, self.fail = row, fail

    def q(self):
        return self

    async def fetchrow(self, *_args):
        if self.fail:
            raise RuntimeError("db down")
        return self.row


def _runtime(db) -> HarnessRuntime:
    runtime = HarnessRuntime.__new__(HarnessRuntime)
    runtime.svc = SimpleNamespace(db=db)
    return runtime


PAYLOAD = {"conversation_id": CONV, "company_id": COMPANY, "context": {"company_id": COMPANY}}


async def test_a_job_cannot_name_its_company():
    found = await _runtime(Db(fail=True))._conversation(PAYLOAD)
    assert found["company_id"] is None


async def test_the_company_is_the_conversation_rows():
    row = {"company_id": COMPANY, "resume_state": None, "posting_id": None,
           "application_id": None, "bot_kind": None}
    found = await _runtime(Db(row=row))._conversation({"conversation_id": CONV})
    assert found["company_id"] == COMPANY
