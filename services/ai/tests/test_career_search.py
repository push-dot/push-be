from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import pytest
from langchain_core.tools import StructuredTool

from app.framework import rag as framework_rag
from app.harness.personal.tools import CareerQuery, PERSONAL_TOOLS, bound_services
from app.harness.policy import Tier
from app.harness.tools import ToolContext, call_structured, to_structured_tool
from app.rag.retriever import Retriever
from tests.test_rag_retriever import Embedder, FakeDb

MINE = UUID("33333333-3333-4333-8333-333333333333")
OTHER = UUID("44444444-4444-4444-8444-444444444444")
ROOT = Path(__file__).resolve().parents[1]


def _row(n, text, user_id, similarity):
    return {
        "id": n, "user_id": user_id, "company_id": None, "source_type": "source",
        "source_id": UUID(int=n), "document_id": None, "seq": n, "text": text,
        "similarity": similarity,
    }


class _Reranker:
    async def rerank(self, query, texts):
        scores = {"keyword": 0.9, "vector": 0.2, "secret": 1.0}
        return [scores[text] for text in texts]


@pytest.mark.asyncio
async def test_search_career_context_returns_reranked_nodes_for_the_caller_only(monkeypatch):
    monkeypatch.setenv("RAG_ENGINE", "legacy")
    rows = [
        _row(1, "vector", MINE, 0.9),
        _row(2, "keyword", MINE, 0.2),
        _row(3, "secret", OTHER, 0.99),
    ]
    retriever = Retriever(FakeDb(rows), Embedder(), _Reranker())
    monkeypatch.setattr(framework_rag, "_retriever", lambda svc: retriever)

    section = await framework_rag.search_career_context(
        object(), {"user_id": MINE, "text": "경력"}, set())
    assert section.index("keyword") < section.index("vector")
    assert "secret" not in section
    fetches = [args for kind, _sql, args in retriever.db.calls if kind == "fetch"]
    assert fetches
    assert all(args[1] == MINE and args[2] is None for args in fetches)

    spec = next(tool for tool in PERSONAL_TOOLS if tool.name == "search_career_context")
    structured = to_structured_tool(spec)
    assert isinstance(structured, StructuredTool)
    assert structured.metadata["tier"] is Tier.READ

    ctx = ToolContext(
        user_id=str(MINE), company_id=None, conversation_id="conv", job_id="job-1",
        tool_call_id="call-1", db=object(), core=object())
    token = bound_services.set(SimpleNamespace(ai=object()))
    try:
        result, ok = await call_structured(spec, CareerQuery(query="경력"), ctx)
    finally:
        bound_services.reset(token)
    assert ok is True
    assert result["text"] == section

    chat = (ROOT / "src" / "app" / "graphs" / "chat.py").read_text()
    assert "search_career_context" in chat
