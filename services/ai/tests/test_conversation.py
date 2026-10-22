from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.conversation import ConversationService
from tests.stubs import (FakeDB, StubAiUsageStore, StubApplicationStore,
                         StubChatJobStore, StubConversationStore,
                         StubDocumentStore, StubEvidenceStore,
                         StubOperationStore)


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


async def test_create_requires_application():
    svc = _svc(StubConversationStore())
    with pytest.raises(DomainError) as e:
        await svc.create(uuid4(), uuid4(), "")
    assert e.value.code == "NOT_FOUND"


async def test_create_without_application():
    store = StubConversationStore()
    c = await _svc(store).create(uuid4(), None, "hello")
    assert c.revision == 1 and c.title == "hello" and c.application_id is None
    assert len(store.created) == 1


async def test_patch_conflict():
    user_id = uuid4()
    conv = _conv(user_id=user_id, revision=3)
    with pytest.raises(DomainError) as e:
        await _svc(StubConversationStore(conv=conv)).patch(
            user_id, conv.id, 1, title=None, pinned=True)
    assert e.value.code == "REVISION_CONFLICT"


async def test_post_message_rejects_bad_access_mode():
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    with pytest.raises(DomainError) as e:
        await _svc(StubConversationStore(conv=conv)).post_message(
            user_id, conv.id, "hi", {}, None, "YOLO")
    assert e.value.code == "VALIDATION_ERROR"


async def test_post_message_archived_conversation():
    user_id = uuid4()
    conv = _conv(user_id=user_id, archived=True)
    with pytest.raises(DomainError) as e:
        await _svc(StubConversationStore(conv=conv)).post_message(
            user_id, conv.id, "hi", {}, None, "SUGGEST")
    assert e.value.code == "INVALID_TRANSITION"


async def test_post_message_evidence_ownership():
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    with pytest.raises(DomainError) as e:
        await _svc(StubConversationStore(conv=conv)).post_message(
            user_id, conv.id, "hi", {"evidenceIds": [str(uuid4())]}, None,
            "SUGGEST")
    assert e.value.code == "VALIDATION_ERROR"


async def test_post_message_document_without_version():
    user_id = uuid4()
    app_id = uuid4()
    conv = _conv(user_id=user_id, application_id=app_id)
    doc = ent.Document(id=uuid4(), user_id=user_id, application_id=app_id,
                       title="resume", kind="RESUME", template="CLASSIC",
                       created_at=_now(), updated_at=_now())
    svc = _svc(StubConversationStore(conv=conv),
               docs=StubDocumentStore(doc=doc))
    with pytest.raises(DomainError) as e:
        await svc.post_message(user_id, conv.id, "hi",
                               {"documentId": str(doc.id)}, None, "SUGGEST")
    assert e.value.code == "VALIDATION_ERROR"


async def test_post_message_document_scope_mismatch():
    user_id = uuid4()
    app_id, other = uuid4(), uuid4()
    conv = _conv(user_id=user_id, application_id=app_id)
    version_id = uuid4()
    doc = ent.Document(id=uuid4(), user_id=user_id, application_id=other,
                       title="resume", kind="RESUME", template="CLASSIC",
                       latest_version_id=version_id,
                       created_at=_now(), updated_at=_now())
    svc = _svc(StubConversationStore(conv=conv),
               docs=StubDocumentStore(doc=doc))
    with pytest.raises(DomainError) as e:
        await svc.post_message(user_id, conv.id, "hi",
                               {"documentId": str(doc.id)}, None, "SUGGEST")
    assert e.value.code == "VALIDATION_ERROR"


async def test_post_message_success_creates_operation():
    user_id = uuid4()
    app_id = uuid4()
    conv = _conv(user_id=user_id, application_id=app_id)
    version_id = uuid4()
    doc = ent.Document(id=uuid4(), user_id=user_id, application_id=app_id,
                       title="resume", kind="RESUME", template="CLASSIC",
                       latest_version_id=version_id,
                       created_at=_now(), updated_at=_now())
    version = ent.DocumentVersion(
        id=version_id, user_id=user_id, document_id=doc.id,
        application_id=app_id, number=1, content={}, created_at=_now())
    ev_id = uuid4()
    ev = StubEvidenceStore({ev_id: ent.CareerEvidence(
        id=ev_id, user_id=user_id, revision=1, kind="CAREER", title="ev",
        source_text="x", created_at=_now(), updated_at=_now())})
    convs = StubConversationStore(conv=conv)
    ops = StubOperationStore()
    svc = _svc(convs, docs=StubDocumentStore(doc=doc, version=version),
               ev=ev, ops=ops)
    op = await svc.post_message(
        user_id, conv.id, "도와줘",
        {"documentId": str(doc.id), "evidenceIds": [str(ev_id)]},
        None, "CONFIRM_ACTIONS")
    assert op.status == ent.OP_SUCCEEDED and op.type == ent.OP_CHAT_MESSAGE
    assert len(convs.messages) == 2
    user_msg, ai_msg = convs.messages
    assert user_msg.role == "USER" and ai_msg.role == "ASSISTANT"
    assert user_msg.operation_id == op.id
    assert len(user_msg.attachments) == 2
    assert (user_msg.attachments[0].type == "DOCUMENT_VERSION"
            and user_msg.attachments[0].id == version_id)
    assert len(ops.created) == 1


async def test_external_post_message_returns_queued_without_polling(monkeypatch):
    monkeypatch.setattr(
        "app.domain.services.conversation.external_jobs", lambda: True)
    scheduled = []

    async def schedule(job_id, byok):
        scheduled.append((str(job_id), byok))

    monkeypatch.setattr(
        "app.domain.services.conversation.schedule_chat_job", schedule)
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    convs = StubConversationStore(conv=conv)
    svc = _svc(convs)
    jobs = StubChatJobStore()
    polls = {"n": 0}

    async def enqueue_started(uid, cid, payload, status_text):
        jobs.payload = payload
        jobs.status_text = status_text
        return jobs.job_id

    async def events_since(job_id, after):
        polls["n"] += 1
        return []

    jobs.enqueue_started = enqueue_started
    jobs.events_since = events_since
    svc.jobs = jobs
    op = await svc.post_message(
        user_id, conv.id, "hi", {}, None, "SUGGEST", "")
    assert op.status == ent.OP_QUEUED
    assert op.id == jobs.job_id
    assert op.result is not None
    assert op.result.value == {"jobId": str(jobs.job_id)}
    assert scheduled == [(str(jobs.job_id), "")]
    assert jobs.status_text == "대기 중"
    assert polls["n"] == 0
    assert convs.messages == []
    assert svc._compiled is None


def _managed_ai():
    return ent.AiOptions(provider="OPENAI", model="openai/gpt-5.6-luna",
                         credential_mode="MANAGED", effort="LOW")


def _gate_for(user_id, plan, embeds):
    from app.domain.services.ai import AIGate
    from tests.stubs import StubChatCompleter, StubUserStore

    gate = AIGate(FakeDB(), "sk-managed", None, StubChatCompleter())
    gate.users = StubUserStore(ent.User(
        id=user_id, provider="dev", provider_subject="d", display_name="Ada",
        created_at=_now(), plan=plan))
    gate.usage = StubAiUsageStore()

    async def embed(*args, **kwargs):
        embeds["n"] += 1
        return []

    gate.embed = embed
    return gate


async def test_external_free_plan_chat_is_rejected_before_enqueue(monkeypatch):
    monkeypatch.setattr(
        "app.domain.services.conversation.external_jobs", lambda: True)
    scheduled = []

    async def schedule(job_id, byok):
        scheduled.append(job_id)

    monkeypatch.setattr(
        "app.domain.services.conversation.schedule_chat_job", schedule)
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    convs = StubConversationStore(conv=conv)
    embeds = {"n": 0}
    gate = _gate_for(user_id, "FREE", embeds)
    gate.usage.items.append(ent.AiUsage(
        id=uuid4(), user_id=user_id, provider="OPENAI", model="m",
        managed=True, input_tokens=1, output_tokens=1,
        cost_micro_credits=1_800_000, status="SETTLED", created_at=_now()))
    spent = list(gate.usage.items)
    svc = _svc(convs, gate=gate, usage=gate.usage)
    jobs = StubChatJobStore()
    enqueued = {"n": 0}

    async def enqueue_started(*args, **kwargs):
        enqueued["n"] += 1
        return jobs.job_id

    jobs.enqueue_started = enqueue_started
    svc.jobs = jobs
    with pytest.raises(DomainError) as e:
        await svc.post_message(
            user_id, conv.id, "이력서 도와줘", {}, _managed_ai(), "SUGGEST", "")
    assert e.value.status == 403
    assert e.value.code == "FEATURE_DISABLED"
    assert "FREE" in e.value.message
    assert enqueued["n"] == 0
    assert scheduled == []
    assert embeds["n"] == 0
    assert gate.usage.items == spent
    assert convs.messages == []


async def test_external_stream_rejects_free_plan_before_enqueue(monkeypatch):
    monkeypatch.setattr(
        "app.domain.services.conversation.external_jobs", lambda: True)
    scheduled = []

    async def schedule(job_id, byok):
        scheduled.append(job_id)

    monkeypatch.setattr(
        "app.domain.services.conversation.schedule_chat_job", schedule)
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    embeds = {"n": 0}
    gate = _gate_for(user_id, "FREE", embeds)
    gate.usage.items.append(ent.AiUsage(
        id=uuid4(), user_id=user_id, provider="OPENAI", model="m",
        managed=True, input_tokens=1, output_tokens=1,
        cost_micro_credits=1_800_000, status="SETTLED", created_at=_now()))
    svc = _svc(StubConversationStore(conv=conv), gate=gate, usage=gate.usage)
    jobs = StubChatJobStore()
    enqueued = {"n": 0}

    async def enqueue_started(*args, **kwargs):
        enqueued["n"] += 1
        return jobs.job_id

    jobs.enqueue_started = enqueue_started
    svc.jobs = jobs
    with pytest.raises(DomainError) as e:
        async for _ in svc.stream_message(
                user_id, conv.id, "이력서 도와줘", {}, _managed_ai(), "SUGGEST"):
            pass
    assert e.value.status == 403
    assert e.value.code == "FEATURE_DISABLED"
    assert enqueued["n"] == 0
    assert scheduled == []
    assert embeds["n"] == 0


async def test_external_paid_plan_still_enqueues(monkeypatch):
    monkeypatch.setattr(
        "app.domain.services.conversation.external_jobs", lambda: True)

    async def schedule(job_id, byok):
        return None

    monkeypatch.setattr(
        "app.domain.services.conversation.schedule_chat_job", schedule)
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    embeds = {"n": 0}
    gate = _gate_for(user_id, "PRO", embeds)
    svc = _svc(StubConversationStore(conv=conv), gate=gate, usage=gate.usage)
    jobs = StubChatJobStore()
    svc.jobs = jobs
    op = await svc.post_message(
        user_id, conv.id, "이력서 도와줘", {}, _managed_ai(), "SUGGEST", "")
    assert op.status == ent.OP_QUEUED
    assert embeds["n"] == 0
    assert gate.usage.items == []


class _Chunks:
    def __init__(self, chunks):
        self.chunks = chunks

    async def astream(self, _state, config=None, stream_mode=None):
        for chunk in self.chunks:
            yield chunk


async def test_pump_job_events_yields_a_tool_then_done_and_stops():
    svc = _svc(StubConversationStore())
    jobs = StubChatJobStore()
    rows = [
        {"id": 2, "type": "tool", "payload": {
            "name": "read", "state": "run", "summary": "file"}},
        {"id": 3, "type": "done", "payload": {"operation": {"status": "SUCCEEDED"}}},
        {"id": 4, "type": "token", "payload": {"text": "after-done"}},
    ]

    async def events_since(job_id, after):
        return [row for row in rows if row["id"] > after]

    jobs.events_since = events_since
    svc.jobs = jobs
    events = [event async for event in svc._pump_job_events(jobs.job_id)]
    assert events == [
        ("tool", {"name": "read", "state": "run", "summary": "file"}, 2),
        ("done", {"status": "SUCCEEDED"}, 3),
    ]


async def test_pump_job_events_returns_on_error():
    svc = _svc(StubConversationStore())
    jobs = StubChatJobStore()
    rows = [
        {"id": 1, "type": "error", "payload": {"error": {
            "code": "INTERNAL", "message": "no"}}},
        {"id": 2, "type": "token", "payload": {"text": "after-error"}},
    ]

    async def events_since(job_id, after):
        return [row for row in rows if row["id"] > after]

    jobs.events_since = events_since
    svc.jobs = jobs
    events = [event async for event in svc._pump_job_events(jobs.job_id)]
    assert events == [("error", {"code": "INTERNAL", "message": "no"}, 1)]


async def test_pump_job_events_cancelled_returns(monkeypatch):
    monkeypatch.setenv("SSE_MAX_POLLS", "3")

    async def _asleep(*_args, **_kwargs):
        return None

    monkeypatch.setattr(
        "app.domain.services.conversation.asyncio.sleep", _asleep)
    svc = _svc(StubConversationStore())
    jobs = StubChatJobStore()
    rows = [
        {"id": 4, "type": "cancelled", "payload": {}},
        {"id": 5, "type": "token", "payload": {"text": "after-cancel"}},
    ]

    async def events_since(job_id, after):
        return [row for row in rows if row["id"] > after]

    jobs.events_since = events_since
    svc.jobs = jobs
    events = [event async for event in svc._pump_job_events(jobs.job_id)]
    assert events == [("cancelled", {}, 4)]


async def test_stream_message_yields_a_diff_chunk():
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    svc = _svc(StubConversationStore(conv=conv))
    hunks = [{"line": 1, "sign": "+", "text": "new"}]
    svc._compiled = _Chunks([
        ("custom", {"token": "hi"}),
        ("custom", {"status": "working"}),
        ("custom", {
            "type": "diff", "documentId": "doc-1", "revisionId": "rev-1",
            "hunks": hunks}),
        ("custom", {"type": "future", "note": "no"}),
        ("values", {"operation": {"status": "SUCCEEDED"}}),
    ])
    events = [event async for event in svc.stream_message(
        user_id, conv.id, "hi", {}, None, "SUGGEST")]
    assert [event[0] for event in events] == ["token", "status", "diff", "done"]
    assert events[0][1] == "hi"
    assert events[1][1] == "working"
    assert events[2][1] == {
        "documentId": "doc-1", "revisionId": "rev-1", "hunks": hunks}
    assert events[2][2] is None
    assert events[3] == ("done", {"status": "SUCCEEDED"}, None)


async def test_stream_message_stub_tokens_and_done():
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    convs = StubConversationStore(conv=conv)
    svc = _svc(convs)
    events = [e async for e in svc.stream_message(
        user_id, conv.id, "hello", {}, None, "SUGGEST")]
    kinds = [k for k, _, _ in events]
    assert kinds == ["token", "done"]
    assert events[0][1].startswith("(로컬 스텁)")
    assert events[0][2] is None
    op = events[1][1]
    assert op.status == ent.OP_SUCCEEDED
    assert len(convs.messages) == 2


async def test_stream_message_ai_tokens_concat():
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    convs = StubConversationStore(conv=conv)
    usage = StubAiUsageStore()

    class _Gate:
        async def stream(self, _uid, _ai, _sys, _user, out, byok_key="", search_query="", assistant_prefix="", job_id=None):
            for t in ["Hel", "lo"]:
                yield t
            out["input_tokens"] = 3
            out["output_tokens"] = 2

    svc = _svc(convs, gate=_Gate(), usage=usage)
    ai = ent.AiOptions(provider="OPENAI", model="m",
                       credential_mode="MANAGED", effort="LOW")
    events = [e async for e in svc.stream_message(
        user_id, conv.id, "hi", {}, ai, "SUGGEST")]
    tokens = [p for k, p, _ in events if k == "token"]
    assert tokens == ["Hel", "lo"]
    assert events[-1][0] == "done"
    ai_msg = convs.messages[-1]
    assert ai_msg.text == "Hello" and ai_msg.role == "ASSISTANT"


async def test_stream_active_replays_only_events_after_cursor():
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    svc = _svc(StubConversationStore(conv=conv))
    svc.jobs = StubChatJobStore(events=[
        {"id": 1, "type": "token", "payload": {"text": "he"}},
        {"id": 2, "type": "token", "payload": {"text": "llo"}},
        {"id": 3, "type": "token", "payload": {"text": " world"}},
        {"id": 4, "type": "done",
         "payload": {"operation": {"status": "SUCCEEDED"}}},
    ])
    events = [e async for e in svc.stream_active(user_id, conv.id, after=2)]
    assert events == [
        ("token", " world", 3),
        ("done", {"status": "SUCCEEDED"}, 4),
    ]


async def test_stream_message_validates_text():
    svc = _svc(StubConversationStore())
    with pytest.raises(DomainError) as e:
        async for _ in svc.stream_message(
                uuid4(), uuid4(), "", {}, None, "SUGGEST"):
            pass
    assert e.value.code == "VALIDATION_ERROR"


async def test_archive():
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    out = await _svc(StubConversationStore(conv=conv)).archive(
        user_id, conv.id, 1)
    assert out.archived and out.revision == 2


async def test_archive_cascades_evidence():
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    e1 = ent.CareerEvidence(id=uuid4(), user_id=user_id, kind="RESUME",
                            title="a", source_text="t",
                            created_at=_now(), updated_at=_now())
    e2 = ent.CareerEvidence(id=uuid4(), user_id=user_id, kind="RESUME",
                            title="b", source_text="t",
                            created_at=_now(), updated_at=_now())
    convs = StubConversationStore(conv=conv)
    convs.cascade_ids = [e1.id, e2.id]
    convs.elsewhere = {e2.id: 1}
    ev = StubEvidenceStore({e1.id: e1, e2.id: e2})
    await _svc(convs, ev=ev).archive(user_id, conv.id, 1)
    assert e1.archived and not e2.archived


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
            "credential_mode": "MANAGED",
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


async def test_external_post_message_missing_conversation(monkeypatch):
    monkeypatch.setattr(
        "app.domain.services.conversation.external_jobs", lambda: True)

    async def schedule(job_id, byok):
        return None

    monkeypatch.setattr(
        "app.domain.services.conversation.schedule_chat_job", schedule)
    user_id = uuid4()
    conv = _conv(user_id=user_id)
    svc = _svc(StubConversationStore(conv=conv))
    jobs = StubChatJobStore()

    async def enqueue_started(uid, cid, payload, status_text):
        return None

    jobs.enqueue_started = enqueue_started
    svc.jobs = jobs
    with pytest.raises(DomainError) as e:
        await svc.post_message(user_id, conv.id, "hi", {}, None, "SUGGEST", "")
    assert e.value.code == "NOT_FOUND"


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


async def test_pump_job_events_keeps_done_awaiting():
    svc = _svc(StubConversationStore())
    jobs = StubChatJobStore()

    async def events_since(job_id, after):
        rows = [{"id": 5, "type": "done", "payload": {"awaiting": "approval"}}]
        return [row for row in rows if row["id"] > after]

    jobs.events_since = events_since
    svc.jobs = jobs
    events = [event async for event in svc._pump_job_events(jobs.job_id)]
    assert events == [("done", {"awaiting": "approval"}, 5)]
