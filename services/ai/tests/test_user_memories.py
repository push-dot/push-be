from uuid import uuid4

import pytest

from app.harness.personal import memories
from app.harness.policy import Decision, Exposure, Tier, decide
from app.domain.access_mode import AccessMode

USER = uuid4()


class Rows:
    """user_memories for one user, in the order the SQL keeps them."""

    def __init__(self):
        self.texts: list[str] = []

    def q(self):
        return self

    async def fetch(self, sql, user_id, limit):
        assert "ORDER BY updated_at DESC" in sql
        return [{"text": text} for text in self.texts[:limit]]

    async def fetchval(self, sql, _id, user_id, text):
        assert "ON CONFLICT (user_id, text)" in sql
        added = text not in self.texts
        if not added:
            self.texts.remove(text)
        self.texts.insert(0, text)
        return added

    async def execute(self, sql, *args):
        assert sql.startswith("DELETE")
        del self.texts[args[1]:]


@pytest.mark.asyncio
async def test_remember_keeps_one_copy_newest_first_and_caps_the_list():
    db = Rows()
    assert await memories.remember(db, USER, "  원격 근무를   원해요 ") == {"saved": True, "text": "원격 근무를 원해요"}
    await memories.remember(db, USER, "연봉은 6천 이상")
    await memories.remember(db, USER, "원격 근무를 원해요")
    assert await memories.memory_lines(db, USER) == ["원격 근무를 원해요", "연봉은 6천 이상"]
    for i in range(memories.KEEP_LIMIT + 5):
        await memories.remember(db, USER, f"사실 {i}")
    assert len(db.texts) == memories.KEEP_LIMIT
    assert len(await memories.memory_lines(db, USER)) == memories.PROMPT_LIMIT


@pytest.mark.asyncio
async def test_remember_saves_nothing_without_a_user_or_text():
    assert await memories.remember(Rows(), "not-a-uuid", "x") == {"saved": False}
    assert await memories.remember(Rows(), USER, "   ") == {"saved": False}
    assert await memories.memory_lines(None, USER) == []


def test_remember_waits_for_the_user_after_untrusted_text_in_the_run():
    assert decide(AccessMode.AUTO, Tier.SAFE_WRITE, "remember") is Decision.EXECUTE
    assert decide(AccessMode.AUTO, Tier.SAFE_WRITE, "remember", exposure=Exposure.RUN) is Decision.ASK
    assert decide(AccessMode.ALWAYS_ASK, Tier.SAFE_WRITE, "remember") is Decision.ASK


@pytest.mark.asyncio
async def test_a_personal_turn_sends_the_memories_after_the_fixed_prompt(monkeypatch):
    from langchain_core.messages import SystemMessage

    from app.framework.untrusted import as_data
    from app.harness.runtime import HarnessRuntime
    from tests.harness_fakes import CONV, USER as FAKE_USER, managed_ai, run, service
    from tests.test_thread_memory import UsageLC

    async def kept(_db, _user_id):
        return ["원격 근무를 원해요", "연봉은 6천 이상"]

    monkeypatch.setattr(memories, "memory_lines", kept)
    UsageLC.calls, UsageLC.models, UsageLC.seen = [], [], []
    runtime = HarnessRuntime(service(), model_cls=UsageLC)
    await run(runtime, {
        "text": "새 공고 찾아 줘", "user_id": FAKE_USER, "conversation_id": CONV,
        "job_id": "00000001-0000-4000-8000-000000000000", "access_mode": "AUTO",
        "ai": managed_ai(), "context": {},
    })
    sent = UsageLC.seen[-1]
    assert isinstance(sent[0], SystemMessage) and "원격 근무" not in str(sent[0].content)
    assert sent[1] == SystemMessage(content=as_data("원격 근무를 원해요\n연봉은 6천 이상", "user_memories", None))
