from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.conversation import ConversationService
from tests.stubs import (
    FakeDB, StubAiUsageStore, StubApplicationStore, StubConversationStore,
    StubDocumentStore, StubEvidenceStore, StubOperationStore,
)


def _now():
    return datetime.now(timezone.utc)


def _conv(user_id=None, application_id=None, archived=False, revision=1):
    return ent.Conversation(
        id=uuid4(), user_id=user_id or uuid4(), revision=revision,
        application_id=application_id, archived=archived,
        created_at=_now(), updated_at=_now())


def _svc(convs, apps=None, docs=None, ev=None, ops=None, gate=None,
         usage=None):
    svc = ConversationService(FakeDB(), gate, None)
    svc.conversations = convs
    svc.applications = apps or StubApplicationStore()
    svc.documents = docs or StubDocumentStore()
    svc.evidence = ev or StubEvidenceStore()
    svc.ops = ops or StubOperationStore()
    if usage is not None:
        svc.usage = usage
    return svc


def _managed_ai():
    return ent.AiOptions(provider="OPENAI", model="openai/gpt-5.6-luna",
                         effort="LOW")


def _gate_for(user_id, plan, embeds):
    from app.domain.services.ai import AIGate
    from tests.stubs import StubChatCompleter, StubUserStore

    gate = AIGate(FakeDB(), "sk-managed", StubChatCompleter())
    gate.users = StubUserStore(ent.User(
        id=user_id, provider="dev", provider_subject="d", display_name="Ada",
        created_at=_now(), plan=plan))
    gate.usage = StubAiUsageStore()

    async def embed(*args, **kwargs):
        embeds["n"] += 1
        return []

    gate.embed = embed
    return gate


class _Chunks:
    def __init__(self, chunks):
        self.chunks = chunks

    async def astream(self, _state, config=None, stream_mode=None):
        for chunk in self.chunks:
            yield chunk


async def test_feature_disabled_does_not_save_user_message(monkeypatch):
    from app.domain.errors import feature_disabled

    monkeypatch.setenv("LLM_STREAM", "0")
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    store = StubConversationStore(conv=conv)

    class Gate:
        async def complete(self, *args, **kwargs):
            raise feature_disabled("monthly managed AI usage limit reached")

    svc = _svc(store, gate=Gate())
    from app.graphs.chat import event_sink
    sink = event_sink.set([])
    state = {
        "user_id": user_id,
        "text": "hi",
        "conversation": conv,
        "context": {},
        "attachments": [],
        "job_id": str(uuid4()),
        "ai": {
            "provider": "OPENAI",
            "model": "openai/gpt-5.6-luna",
            "effort": "LOW",
        },
    }
    try:
        with pytest.raises(DomainError) as e:
            _ = svc.graph
            await svc.chat_nodes["generate_reply"](state)
    finally:
        event_sink.reset(sink)
    assert e.value.code == "FEATURE_DISABLED"
    assert store.messages == []


async def test_flush_chat_events_publishes_status_and_token_chunks():
    import asyncio
    from app.domain.services.conversation import flush_chat_events

    calls = []

    async def emit_many(job_id, events):
        calls.append(list(events))

    queue: asyncio.Queue = asyncio.Queue()
    job_id = uuid4()
    task = asyncio.create_task(flush_chat_events(
        emit_many, job_id, queue, batch_chars=5, flush_s=0.02))
    queue.put_nowait({"status": "응답 작성 중"})
    queue.put_nowait({"token": "a"})
    queue.put_nowait({"token": "bb"})
    queue.put_nowait({"token": "ccc"})
    queue.put_nowait({"token": "d"})
    await asyncio.sleep(0.08)
    queue.put_nowait(None)
    await task
    assert calls[0] == [("status", {"text": "응답 작성 중"})]
    assert calls[1] == [("token", {"text": "a"})]
    assert calls[2] == [("token", {"text": "bb"}), ("token", {"text": "ccc"})]
    assert calls[3] == [("token", {"text": "d"})]


async def test_flush_chat_events_forwards_a_tool_and_flushes_the_token_batch():
    import asyncio
    from app.domain.services.conversation import flush_chat_events

    calls = []

    async def emit_many(job_id, events):
        calls.append(list(events))

    queue: asyncio.Queue = asyncio.Queue()
    task = asyncio.create_task(flush_chat_events(
        emit_many, uuid4(), queue, batch_chars=100, flush_s=5))
    queue.put_nowait({"token": "aa"})
    queue.put_nowait({"token": "bb"})
    queue.put_nowait({
        "type": "tool", "name": "read", "state": "run", "summary": "file"})
    queue.put_nowait(None)
    await task
    flat = [event for batch in calls for event in batch]
    assert flat == [
        ("token", {"text": "aa"}),
        ("token", {"text": "bb"}),
        ("tool", {"name": "read", "state": "run", "summary": "file"}),
    ]

