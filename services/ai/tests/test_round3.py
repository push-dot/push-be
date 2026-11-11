from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from langgraph.checkpoint.memory import MemorySaver

from app.domain import entities as ent
from app.domain.services.ai import record_usage
from app.domain.services.conversation import ConversationService
from app.domain.services.document import DocumentService
from tests.stubs import (FakeDB, StubAiUsageStore, StubApplicationStore,
                         StubChatJobStore, StubConversationStore,
                         StubDocumentStore, StubOperationStore)


def _now():
    return datetime.now(timezone.utc)


async def test_record_usage_attaches_by_usage_id_not_model():
    user_id, op_id, usage_id = uuid4(), uuid4(), uuid4()
    row = ent.AiUsage(
        id=usage_id, user_id=user_id, provider="OPENAI",
        model="openai/override-model", managed=True, input_tokens=10,
        output_tokens=5, cost_micro_credits=100,
        status=ent.USAGE_SETTLED, created_at=_now())
    usage = StubAiUsageStore([row])
    ai = ent.AiOptions(provider="OPENAI", model="openai/base-model",
                       effort="LOW",
                       models={"generate": "openai/override-model"})
    c = ent.AICompletion(text="ok", input_tokens=10, output_tokens=5)
    await record_usage(usage, user_id, op_id, ai, c, [usage_id])
    assert len(usage.items) == 1
    assert usage.items[0].operation_id == op_id


async def test_record_usage_skips_unsettled_row():
    user_id, op_id, usage_id = uuid4(), uuid4(), uuid4()
    row = ent.AiUsage(
        id=usage_id, user_id=user_id, provider="OPENAI",
        model="openai/m", managed=True, input_tokens=10,
        output_tokens=5, cost_micro_credits=0,
        status=ent.USAGE_RELEASED, created_at=_now())
    usage = StubAiUsageStore([row])
    ai = ent.AiOptions(provider="OPENAI", model="openai/m",
                       effort="LOW")
    c = ent.AICompletion(text="ok", input_tokens=10, output_tokens=5)
    await record_usage(usage, user_id, op_id, ai, c, [usage_id])
    assert len(usage.items) == 1
    assert usage.items[0].operation_id is None


class _StubApprovals:
    async def consume(self, *args, **kwargs):
        return None

    async def require_evidence_use(self, *args, **kwargs):
        return None


def _doc(user_id, application_id=None):
    return ent.Document(
        id=uuid4(), user_id=user_id, revision=2,
        application_id=application_id, title="doc", kind="RESUME",
        template="CLASSIC", status=ent.DOC_DRAFT,
        created_at=_now(), updated_at=_now())


def _version(user_id, doc):
    return ent.DocumentVersion(
        id=uuid4(), user_id=user_id, document_id=doc.id,
        application_id=doc.application_id, number=1,
        content={"type": "doc", "content": []}, blocks=[],
        created_at=_now())


async def test_finalize_without_application_succeeds():
    user_id = uuid4()
    doc = _doc(user_id, application_id=None)
    ver = _version(user_id, doc)
    apps = StubApplicationStore()
    svc = DocumentService(FakeDB(), _StubApprovals(), None)
    svc.documents = StubDocumentStore(doc=doc, version=ver)
    svc.applications = apps
    out = await svc.finalize(user_id, doc.id, 2, ver.id, uuid4())
    assert out.status == ent.DOC_FINALIZED
    assert apps.events == []


async def test_finalize_with_application_records_event():
    user_id = uuid4()
    app_id = uuid4()
    doc = _doc(user_id, application_id=app_id)
    ver = _version(user_id, doc)
    apps = StubApplicationStore()
    svc = DocumentService(FakeDB(), _StubApprovals(), None)
    svc.documents = StubDocumentStore(doc=doc, version=ver)
    svc.applications = apps
    out = await svc.finalize(user_id, doc.id, 2, ver.id, uuid4())
    assert out.status == ent.DOC_FINALIZED
    assert len(apps.events) == 1
    assert apps.events[0].application_id == app_id


class _JobRunner:
    def __init__(self, convs):
        self.svc = ConversationService(FakeDB(), None, MemorySaver())
        self.svc.conversations = convs
        self.svc.ops = StubOperationStore()
        self.jobs = StubChatJobStore()
        self.svc.jobs = self.jobs

    def job(self, conv_id, attempt=1):
        return {"id": uuid4(), "user_id": uuid4(),
                "conversation_id": conv_id, "attempt": attempt,
                "payload": {"text": "hi", "context": {}, "ai": None,
                            "access_mode": "SUGGEST"}}


class _FailMessageStore(StubConversationStore):
    async def create_message(self, m):
        raise RuntimeError("db down")


async def test_failed_job_is_requeued():
    conv = ent.Conversation(id=uuid4(), user_id=uuid4(), revision=1,
                            title="t", created_at=_now(), updated_at=_now())
    convs = _FailMessageStore(conv=conv)
    r = _JobRunner(convs)
    job = r.job(conv.id, attempt=1)
    job["user_id"] = conv.user_id
    await r.svc._run_job(job)
    assert r.jobs.requeued == [job["id"]]


async def test_job_finishes_done():
    conv = ent.Conversation(id=uuid4(), user_id=uuid4(), revision=1,
                            title="t", created_at=_now(), updated_at=_now())
    convs = StubConversationStore(conv=conv)
    r = _JobRunner(convs)
    job = r.job(conv.id, attempt=1)
    job["user_id"] = conv.user_id
    await r.svc._run_job(job)
    assert ("DONE", None) in r.jobs.finished
