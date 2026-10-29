from types import SimpleNamespace
from uuid import UUID

import pytest

from app.domain.services.conversation import ConversationService
from app.framework import rag as framework_rag
from app.rag.tenant import Tenant

USER = UUID("33333333-3333-4333-8333-333333333333")
EVIDENCE = UUID("55555555-5555-4555-8555-555555555555")


class RecordingDb:
    def __init__(self):
        self.sql = []

    def q(self):
        return self

    async def fetch(self, sql, *args):
        self.sql.append((sql, args))
        if "career_evidence" in sql:
            return [{"id": EVIDENCE}]
        return []

    async def execute(self, sql, *args):
        self.sql.append((sql, args))

    async def run(self, fn):
        return await fn()

    async def do(self, fn):
        return await fn()


class Embedder:
    model = "BAAI/bge-m3"

    async def embed(self, texts):
        return [[0.1, 0.2] for _ in texts]


class Retriever:
    def __init__(self):
        self.embedder = Embedder()
        self.tenants = []

    async def _search_llamaindex(self, query, tenant, k, kinds):
        self.tenants.append(tenant)
        return []


class Evidence:
    async def get(self, user_id, evidence_id):
        assert user_id == USER and evidence_id == EVIDENCE
        return SimpleNamespace(source_text="shipped the billing worker")


def _touching(sqls, table):
    return [(sql, args) for sql, args in sqls if table in sql]


@pytest.mark.asyncio
async def test_conversation_evidence_flow_reads_and_writes_rag_nodes_for_the_user(monkeypatch):
    db = RecordingDb()
    retriever = Retriever()
    monkeypatch.setattr(framework_rag, "_retriever", lambda svc: retriever)
    svc = ConversationService(db, object())
    svc.evidence = Evidence()

    await framework_rag.collect_evidence(svc, {"user_id": USER, "text": "billing"}, set())

    reads = [
        (sql, args) for sql, args in _touching(db.sql, "rag_nodes")
        if "SELECT" in sql.upper() and "career_evidence" in sql]
    writes = [
        (sql, args) for sql, args in _touching(db.sql, "rag_nodes")
        if sql.lstrip().startswith("DELETE") or sql.lstrip().startswith("INSERT")]
    assert reads and all(USER in args and "user_id" in sql for sql, args in reads)
    assert writes and all(USER in args and "user_id" in sql for sql, args in writes)
    assert retriever.tenants == [Tenant(user_id=USER)]
    assert not _touching(db.sql, "evidence" + "_chunks")
