from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.config import load_config
from app.db import NotFoundError
from app.domain import entities as ent
from app.domain.employer_chat import apply_employer_turn, posting_system_prompt
from app.domain.errors import DomainError
from app.domain.pagination import PageRequest
from app.domain.plan_levers import levers_for
from app.graphs.chat import bind_chat_nodes, event_sink
from app.infrastructure.store_chat_jobs import ChatJobStore
from app.infrastructure.store_conversations import ConversationStore
from tests.stubs import StubConversationStore
from tests.test_conversation import _svc


def _ai() -> ent.AiOptions:
    return ent.AiOptions(
        provider="OPENAI", model="client-model",
        credential_mode="MANAGED", effort="LOW", web_search=False,
    )


def test_interview_on_basic_is_403_required_plan_pro():
    cfg = load_config()
    for plan in ("BASIC", None, ""):
        with pytest.raises(DomainError) as err:
            apply_employer_turn(_ai(), plan, "interview", cfg)
        assert err.value.status == 403
        assert err.value.code == "PLAN_REQUIRED"
        assert err.value.details["requiredPlan"] == "PRO"


def test_posting_intent_turns_web_search_on():
    cfg = load_config()
    out = apply_employer_turn(_ai(), "BASIC", "posting", cfg)
    levers = levers_for("EMPLOYER", "BASIC", cfg)
    assert out.web_search is True
    assert out.model == levers.model
    assert out.model != "client-model"
    assert out.effort == levers.effort
    null_plan = apply_employer_turn(_ai(), None, "posting", cfg)
    assert null_plan.web_search is True
    assert null_plan.model == levers_for("EMPLOYER", None, cfg).model


def test_posting_prompt_contains_posting_draft():
    prompt = posting_system_prompt()
    assert "```posting-draft" in prompt
    assert "title" in prompt
    assert "description" in prompt
    assert "requirements" in prompt
    assert "preferred" in prompt
    assert "workConditions" in prompt


async def test_prepare_reply_puts_the_posting_fence_in_the_prompt():
    user_id = uuid4()
    conv = SimpleNamespace(
        id=uuid4(), user_id=user_id, company_id=uuid4(),
        application_id=None, archived=False, title="", revision=1,
    )
    svc = _svc(StubConversationStore())

    async def company_plan(_company_id):
        return "BASIC"

    svc.conversations.company_plan = company_plan
    nodes = bind_chat_nodes(svc)
    token = event_sink.set([])
    try:
        out = await nodes["prepare_reply"]({
            "user_id": user_id,
            "text": "백엔드 공고를 써 줘",
            "conversation": conv,
            "context": {},
            "attachments": [],
            "intent": "posting",
            "ai": {
                "provider": "OPENAI", "model": "client-model",
                "credential_mode": "MANAGED", "effort": "LOW",
                "web_search": False,
            },
        })
    finally:
        event_sink.reset(token)
    assert "```posting-draft" in out["prompt_system"]
    assert out["ai"]["webSearch"] is True or out["ai"]["web_search"] is True


async def test_prepare_reply_without_ai_still_sets_web_search_and_the_fence():
    user_id = uuid4()
    conv = SimpleNamespace(
        id=uuid4(), user_id=user_id, company_id=uuid4(),
        application_id=None, archived=False, title="", revision=1,
    )
    svc = _svc(StubConversationStore())

    async def company_plan(_company_id):
        return "BASIC"

    svc.conversations.company_plan = company_plan
    nodes = bind_chat_nodes(svc)
    token = event_sink.set([])
    try:
        out = await nodes["prepare_reply"]({
            "user_id": user_id,
            "text": "백엔드 공고를 써 줘",
            "conversation": conv,
            "context": {},
            "attachments": [],
            "intent": "posting",
        })
    finally:
        event_sink.reset(token)
    assert "```posting-draft" in out["prompt_system"]
    assert out["prompt_user"]
    assert out["ai"]["webSearch"] is True


class _Capture:
    def __init__(self):
        self.sql = ""

    async def fetchrow(self, sql, *args):
        self.sql = sql
        return None

    async def fetch(self, sql, *args):
        self.sql = sql
        return []


class _DB:
    def __init__(self, conn):
        self.pool = conn

    def q(self):
        return self.pool


async def test_company_member_load_and_enqueue_sql_uses_membership():
    captured = _Capture()
    store = ConversationStore(_DB(captured))
    with pytest.raises(NotFoundError):
        await store.get(uuid4(), uuid4())
    assert "company_members" in captured.sql
    await store.list_messages(uuid4(), uuid4(), PageRequest(limit=12))
    assert "company_members" in captured.sql
    jobs = ChatJobStore(_DB(captured))
    await jobs.enqueue_started(uuid4(), uuid4(), {"text": "이어서"}, "대기 중")
    assert "company_members" in captured.sql
    assert "user_id = $1" in captured.sql
