from __future__ import annotations

import hashlib
import hmac as hmac_mod
import json
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.db import NotFoundError
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.ai import record_usage
from app.domain.services.billing import BillingService
from app.domain.services.conversation import ConversationService
from app.domain.services.document import DocumentService
from tests.stubs import (FakeDB, StubAiUsageStore, StubApplicationStore,
                         StubChatJobStore, StubConversationStore,
                         StubDocumentStore, StubOperationStore)


def _now():
    return datetime.now(timezone.utc)


def _sign(payload: bytes, secret: str, ts: datetime) -> str:
    t = int(ts.timestamp())
    mac = hmac_mod.new(secret.encode(), f"{t}.".encode() + payload,
                       hashlib.sha256).hexdigest()
    return f"t={t},v1={mac}"


async def test_record_usage_attaches_by_usage_id_not_model():
    user_id, op_id, usage_id = uuid4(), uuid4(), uuid4()
    row = ent.AiUsage(
        id=usage_id, user_id=user_id, provider="OPENAI",
        model="openai/override-model", managed=True, input_tokens=10,
        output_tokens=5, cost_micro_credits=100,
        status=ent.USAGE_SETTLED, created_at=_now())
    usage = StubAiUsageStore([row])
    ai = ent.AiOptions(provider="OPENAI", model="openai/base-model",
                       credential_mode="MANAGED", effort="LOW",
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
                       credential_mode="MANAGED", effort="LOW")
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
        self.svc = ConversationService(FakeDB(), None, None)
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


async def test_byok_key_survives_requeue():
    conv = ent.Conversation(id=uuid4(), user_id=uuid4(), revision=1,
                            title="t", created_at=_now(), updated_at=_now())
    convs = _FailMessageStore(conv=conv)
    r = _JobRunner(convs)
    job = r.job(conv.id, attempt=1)
    job["user_id"] = conv.user_id
    r.svc._byok_keys[job["id"]] = "sk-test"
    await r.svc._run_job(job)
    assert r.jobs.requeued == [job["id"]]
    assert r.svc._byok_keys.get(job["id"]) == "sk-test"


async def test_byok_key_deleted_on_terminal():
    conv = ent.Conversation(id=uuid4(), user_id=uuid4(), revision=1,
                            title="t", created_at=_now(), updated_at=_now())
    convs = StubConversationStore(conv=conv)
    r = _JobRunner(convs)
    job = r.job(conv.id, attempt=1)
    job["user_id"] = conv.user_id
    r.svc._byok_keys[job["id"]] = "sk-test"
    await r.svc._run_job(job)
    assert job["id"] not in r.svc._byok_keys
    assert ("DONE", None) in r.jobs.finished


class _LedgerStore:
    def __init__(self):
        self.events = set()
        self.ledger = []
        self.seen = set()
        self.calls = []
        self.balance = 0
        self.customers = set()
        self.sub_updates = []

    async def record_stripe_event(self, event_id, typ, at):
        if event_id in self.events:
            return False
        self.events.add(event_id)
        return True

    async def delete_stripe_event(self, event_id):
        self.events.discard(event_id)

    async def lock_user(self, user_id):
        self.calls.append("lock")

    async def update_subscription(self, user_id, plan, status, customer_id,
                                  period_ends_at):
        if customer_id:
            self.customers.add(customer_id)

    async def update_subscription_by_customer(self, customer_id, plan, status,
                                              period_ends_at):
        if customer_id not in self.customers:
            raise NotFoundError()
        self.sub_updates.append((customer_id, plan, status))

    async def append_ledger(self, e):
        self.calls.append("append")
        key = (e.user_id, e.type, e.reference_id)
        if key in self.seen:
            return
        self.seen.add(key)
        self.ledger.append(e)

    async def last_balance(self, user_id):
        self.calls.append("balance")
        return self.balance


def _billing(store):
    svc = BillingService(FakeDB(), None, True,
                         {ent.PLAN_PRO: "price_pro"}, "https://app/ok",
                         "https://app/cancel", "https://app", "whsec_test")
    svc.billing = store
    return svc


def _event(event_id, typ, obj):
    return json.dumps({"id": event_id, "type": typ,
                       "data": {"object": obj}}).encode()


async def test_checkout_ledger_dedup_and_lock():
    store = _LedgerStore()
    svc = _billing(store)
    user_id = uuid4()
    obj = {"id": "cs_dup", "client_reference_id": str(user_id),
           "customer": "cus_1", "metadata": {"planId": "PRO"}}
    for eid in ("evt_a", "evt_b"):
        payload = _event(eid, "checkout.session.completed", obj)
        await svc.handle_webhook(payload, _sign(payload, "whsec_test", _now()))
    assert len(store.ledger) == 1
    assert "lock" in store.calls
    assert store.calls.index("lock") < store.calls.index("append")


async def test_subscription_update_before_checkout_retries():
    store = _LedgerStore()
    svc = _billing(store)
    sub = _event("evt_sub", "customer.subscription.updated",
                 {"customer": "cus_late", "status": "active",
                  "items": {"data": [{"price": {"id": "price_pro"}}]}})
    with pytest.raises(DomainError):
        await svc.handle_webhook(sub, _sign(sub, "whsec_test", _now()))
    assert "evt_sub" not in store.events
    checkout = _event("evt_co", "checkout.session.completed",
                      {"id": "cs_1", "client_reference_id": str(uuid4()),
                       "customer": "cus_late",
                       "metadata": {"planId": "PRO"}})
    await svc.handle_webhook(checkout, _sign(checkout, "whsec_test", _now()))
    await svc.handle_webhook(sub, _sign(sub, "whsec_test", _now()))
    assert store.sub_updates == [("cus_late", ent.PLAN_PRO, ent.SUB_ACTIVE)]
