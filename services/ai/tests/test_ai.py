from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.ai import AIGate, AIService
from tests.stubs import (FakeDB, StubAiUsageStore,
                         StubApplicationStore, StubChatCompleter,
                         StubConversationStore, StubOperationStore,
                         StubUserStore)
from tests.test_conversation import _conv, _svc as conv_svc


def _now():
    return datetime.now(timezone.utc)


def _managed():
    return ent.AiOptions(provider="OPENAI", model="gpt-4o-mini",
                         effort="LOW")


def _user(plan="ULTRA"):
    return ent.User(id=uuid4(), provider="dev", provider_subject="d",
                    display_name="d", created_at=_now(), plan=plan)


def _gate(managed_key="", chat=None):
    g = AIGate(FakeDB(), managed_key, chat)
    g.users = StubUserStore(_user())
    g.usage = StubAiUsageStore()
    return g


async def test_gate_complete_managed():
    chat = StubChatCompleter(text="hello", in_tokens=3, out_tokens=5)
    g = _gate(managed_key="sk-managed", chat=chat)
    c = await g.complete(uuid4(), _managed(), "sys", "hi")
    assert c.text == "hello" and c.input_tokens == 3 and c.output_tokens == 5
    assert chat.got == {"key": "sk-managed",
                       "model": "anthropic/claude-opus-5-5",
                       "system": "sys", "user": "hi", "reasoning": "high"}


async def test_gate_complete_managed_not_configured():
    g = _gate(chat=StubChatCompleter())
    with pytest.raises(DomainError) as e:
        await g.complete(uuid4(), _managed(), "", "hi")
    assert e.value.code == "NOT_CONFIGURED"


async def test_gate_complete_provider_failure():
    chat = StubChatCompleter(err=RuntimeError("boom"))
    g = _gate(managed_key="sk", chat=chat)
    with pytest.raises(DomainError) as e:
        await g.complete(uuid4(), _managed(), "", "hi")
    assert e.value.code == "PROVIDER_ERROR"


async def test_gate_ultra_resume_requires_ultra_plan():
    user_id = uuid4()
    g = _gate("sk-managed", chat=StubChatCompleter())
    g.users = StubUserStore(ent.User(id=user_id, provider="dev",
                                   provider_subject="d", display_name="d",
                                   created_at=_now(), plan="FREE"))
    ai = ent.AiOptions(provider="OPENAI", model="m", effort="LOW", ultra_resume=True)
    with pytest.raises(DomainError) as e:
        await g.check(user_id, ai)
    assert e.value.code == "FEATURE_DISABLED"

    g.users = StubUserStore(ent.User(id=user_id, provider="dev",
                                   provider_subject="d", display_name="d",
                                   created_at=_now(), plan="ULTRA"))
    await g.check(user_id, ai)


async def test_gate_managed_monthly_limit():
    user_id = uuid4()
    g = _gate("sk-managed", chat=StubChatCompleter())
    g.users = StubUserStore(_user("FREE"))
    await g.check(user_id, _managed())
    g.usage = StubAiUsageStore([
        ent.AiUsage(id=uuid4(), user_id=user_id, provider="OPENAI",
                    model="m", managed=True, input_tokens=1, output_tokens=1,
                    cost_micro_credits=1_800_000,
                    status="SETTLED", created_at=_now())])
    with pytest.raises(DomainError) as e:
        await g.check(user_id, _managed())
    assert e.value.code == "FEATURE_DISABLED"
    assert "FREE" in e.value.message
    g.usage = StubAiUsageStore()
    g.users = StubUserStore(_user("PRO"))
    await g.check(user_id, _managed())
    g.usage = StubAiUsageStore([
        ent.AiUsage(id=uuid4(), user_id=user_id, provider="OPENAI",
                    model="m", managed=True, input_tokens=1, output_tokens=1,
                    cost_micro_credits=ent.PLAN_CREDITS_MICRO["PRO"],
                    status="SETTLED", created_at=_now())])
    with pytest.raises(DomainError) as e:
        await g.check(user_id, _managed())
    assert e.value.code == "FEATURE_DISABLED"


async def test_gate_routes_go_model_to_go_client():
    user_id = uuid4()
    managed_chat = StubChatCompleter(text="router")
    go_chat = StubChatCompleter(text="go")
    g = AIGate(FakeDB(), "sk-managed", managed_chat,
               go_chat=go_chat, go_key="sk-go")
    g.users = StubUserStore(_user())
    g.usage = StubAiUsageStore()
    ai = ent.AiOptions(provider="OPENAI",
                       model="opencode-go/deepseek-v4.1-flash",
                       effort="LOW")
    c = await g.complete(user_id, ai, "", "hi")
    assert c.text == "router"
    assert managed_chat.got["model"] == "anthropic/claude-opus-5-5"
    assert go_chat.got == {}


async def test_managed_plan_go_model_routes_to_go_client():
    from app.config import Config
    user_id = uuid4()
    managed_chat = StubChatCompleter(text="router")
    go_chat = StubChatCompleter(text="go")
    g = AIGate(FakeDB(), "sk-managed", managed_chat,
               go_chat=go_chat, go_key="sk-go",
               config=Config(model_ultra="opencode-go/deepseek-v4.1-flash"))
    g.users = StubUserStore(_user("ULTRA"))
    g.usage = StubAiUsageStore()
    ai = ent.AiOptions(provider="OPENAI", model="client-model",
                       effort="LOW")
    c = await g.complete(user_id, ai, "", "hi")
    assert c.text == "go"
    assert go_chat.got["key"] == "sk-go"
    assert go_chat.got["model"] == "deepseek-v4.1-flash"
    assert managed_chat.got == {}


async def test_gate_go_model_requires_go_key():
    from app.config import Config
    g = AIGate(FakeDB(), "sk-managed", StubChatCompleter(),
               config=Config(model_ultra="opencode-go/deepseek-v4.1-flash"))
    g.users = StubUserStore(_user())
    g.usage = StubAiUsageStore()
    ai = ent.AiOptions(provider="OPENAI", model="client-model",
                       effort="LOW")
    with pytest.raises(DomainError) as e:
        await g.check(uuid4(), ai)
    assert e.value.code == "NOT_CONFIGURED"


async def test_gate_web_search_managed_uses_online_suffix():
    user_id = uuid4()
    chat = StubChatCompleter(text="answer")
    g = _gate("sk-managed", chat=chat)
    ai = ent.AiOptions(provider="OPENAI", model="m", effort="LOW", web_search=True)
    await g.complete(user_id, ai, "sys", "hi")
    assert chat.got["model"] == "anthropic/claude-opus-5-5:online"


async def test_gate_ignores_client_provider_and_model():
    user_id = uuid4()
    chat = StubChatCompleter(text="managed")
    g = _gate("sk-managed", chat=chat)
    g.users = StubUserStore(_user("PRO"))
    ai = ent.AiOptions(provider="CLAUDE", model="claude-sonnet-4",
                       effort="LOW")
    c = await g.complete(user_id, ai, "", "hi")
    assert c.text == "managed" and chat.got["key"] == "sk-managed"
    assert chat.got["model"] == "anthropic/claude-sonnet-5-5"
    assert ai.provider == "OPENAI"


async def test_gate_stream_passes_assistant_prefix():
    user_id = uuid4()

    class RecordingClient(StubChatCompleter):
        async def chat_stream(self, api_key, model, system, user, usage,
                              reasoning="", extra_headers=None,
                              assistant_prefix=""):
            self.prefix = assistant_prefix
            async for tok in super().chat_stream(
                    api_key, model, system, user, usage, reasoning,
                    extra_headers, assistant_prefix):
                yield tok

    chat = RecordingClient(text="ok")
    g = _gate("sk-managed", chat=chat)
    usage = {}
    toks = [t async for t in g.stream(
        user_id, _managed(), "sys", "hi", usage,
        assistant_prefix="partial-")]
    assert toks == ["ok"] and chat.prefix == "partial-"


def _ai_svc(gate, ops, usage, apps):
    svc = AIService(FakeDB(), gate)
    svc.ops = ops
    svc.usage = usage
    svc.applications = apps
    return svc


async def test_generate_creates_operation_and_usage():
    user_id, app_id = uuid4(), uuid4()
    ops, usage = StubOperationStore(), StubAiUsageStore()
    chat = StubChatCompleter(text="generated", in_tokens=10, out_tokens=20)
    gate = _gate(managed_key="sk", chat=chat)
    gate.usage = usage
    app = ent.Application(id=app_id, user_id=user_id, job_id=uuid4(),
                          company="c", title="t", created_at=_now(),
                          updated_at=_now())
    svc = _ai_svc(gate, ops, usage, StubApplicationStore(app=app))
    op = await svc.generate(user_id, _managed(), "write", app_id, [])
    assert op.type == ent.OP_AI_GENERATE and op.status == ent.OP_SUCCEEDED
    assert len(usage.items) == 1
    u = usage.items[0]
    assert (u.input_tokens == 10 and u.output_tokens == 20 and u.managed
            and u.provider == "OPENAI" and u.status == ent.USAGE_SETTLED)
    assert u.operation_id == op.id


async def test_generate_bad_application():
    svc = _ai_svc(AIGate(FakeDB(), "", None), StubOperationStore(),
                  StubAiUsageStore(), StubApplicationStore())
    with pytest.raises(DomainError) as e:
        await svc.generate(uuid4(), _managed(), "x", uuid4(), [])
    assert e.value.code == "NOT_FOUND"


async def test_post_message_ai_completion():
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    convs = StubConversationStore(conv=conv)
    usage = StubAiUsageStore()
    chat = StubChatCompleter(text="real answer", in_tokens=7, out_tokens=9)
    gate = _gate(managed_key="sk", chat=chat)
    gate.usage = usage
    svc = conv_svc(convs, gate=gate, usage=usage)
    op = await svc.post_message(user_id, conv.id, "question", {},
                                _managed(), "SUGGEST")
    assert len(convs.messages) == 2
    assert convs.messages[1].text == "real answer"
    assert len(usage.items) == 1 and usage.items[0].operation_id == op.id


async def test_post_message_no_ai_keeps_stub():
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    convs = StubConversationStore(conv=conv)
    chat = StubChatCompleter(text="should not be used")
    svc = conv_svc(convs, gate=_gate(managed_key="sk", chat=chat))
    await svc.post_message(user_id, conv.id, "hi", {}, None, "SUGGEST")
    assert convs.messages[1].text != "should not be used"
