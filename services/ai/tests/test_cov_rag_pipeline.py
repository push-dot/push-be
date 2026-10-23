import sys
import types
from contextlib import asynccontextmanager
from uuid import UUID

import pytest

from app.db import DB
from app.domain.errors import DomainError
from app.rag import pipeline
from app.rag.pipeline import CHUNK_OVERLAP, CHUNK_SIZE, Ingestor, approx_tokens, split_nodes
from app.rag.store import RagNodeStore, vector_literal
from app.rag.tenant import Tenant

USER = UUID("33333333-3333-4333-8333-333333333333")
COMPANY = UUID("77777777-7777-4777-8777-777777777777")
SOURCE = UUID("55555555-5555-4555-8555-555555555555")
DOCUMENT = UUID("88888888-8888-4888-8888-888888888888")


class FakeNode:
    def __init__(self, text, node_id):
        self.text = text
        self.node_id = node_id

    def get_content(self):
        return self.text


@pytest.fixture
def llama(monkeypatch):
    """Stand-in for llama_index (optional `local` extra): one node per blank-line paragraph."""
    seen = {"splitters": [], "documents": []}

    class Document:
        def __init__(self, text, metadata):
            self.text = text
            self.metadata = metadata

    class SentenceSplitter:
        def __init__(self, **kwargs):
            seen["splitters"].append(kwargs)

        def get_nodes_from_documents(self, docs):
            seen["documents"].extend(docs)
            parts = [p for d in docs for p in d.text.split("\n\n")]
            return [FakeNode(p, f"node-{i}") for i, p in enumerate(parts)]

    core = types.ModuleType("llama_index.core")
    core.Document = Document
    parser = types.ModuleType("llama_index.core.node_parser")
    parser.SentenceSplitter = SentenceSplitter
    root = types.ModuleType("llama_index")
    root.core = core
    core.node_parser = parser
    monkeypatch.setitem(sys.modules, "llama_index", root)
    monkeypatch.setitem(sys.modules, "llama_index.core", core)
    monkeypatch.setitem(sys.modules, "llama_index.core.node_parser", parser)
    return seen


class Embedder:
    model = "BAAI/bge-m3"

    def __init__(self):
        self.calls = []

    async def embed(self, texts):
        self.calls.append(list(texts))
        return [[float(i), float(len(t))] for i, t in enumerate(texts)]


class MemoryStore:
    def __init__(self):
        self.calls = []

    async def replace(self, source_type, source_id, model, rows):
        self.calls.append((source_type, source_id, model, rows))


def test_approx_tokens_counts_hangul_syllables_latin_words_and_symbols():
    assert approx_tokens("결제 API v2, 99% 개선!") == ["결", "제", "API", "v2", ",", "99", "%", "개", "선", "!"]
    assert approx_tokens("   \n\t") == []


def test_split_nodes_uses_512_64_sentence_splitter_with_tokenizer(llama):
    def tok(text):
        return text.split()

    nodes = split_nodes("a\n\nb", {"source_id": "s"}, tok)
    assert [n.get_content() for n in nodes] == ["a", "b"]
    assert llama["splitters"] == [{"chunk_size": CHUNK_SIZE, "chunk_overlap": CHUNK_OVERLAP, "tokenizer": tok}]
    assert (CHUNK_SIZE, CHUNK_OVERLAP) == (512, 64)
    doc = llama["documents"][0]
    assert (doc.text, doc.metadata) == ("a\n\nb", {"source_id": "s"})


async def test_ingest_text_builds_rows_with_tenant_metadata_and_embeddings(llama):
    store, embedder = MemoryStore(), Embedder()
    count = await Ingestor(store, embedder).ingest_text(
        Tenant(user_id=USER), "source", SOURCE, "  first\n\nsecond  ", document_id=DOCUMENT, plan="PRO")
    assert count == 2
    assert embedder.calls == [["first", "second"]]
    assert llama["documents"][0].text == "first\n\nsecond"
    assert llama["splitters"][0]["tokenizer"] is approx_tokens
    source_type, source_id, model, rows = store.calls[0]
    assert (source_type, source_id, model) == ("source", SOURCE, "BAAI/bge-m3")
    assert [r["seq"] for r in rows] == [0, 1]
    assert [r["text"] for r in rows] == ["first", "second"]
    assert [r["embedding"] for r in rows] == [[0.0, 5.0], [1.0, 6.0]]
    assert len({r["id"] for r in rows}) == 2
    first = rows[0]
    assert (first["user_id"], first["company_id"], first["document_id"], first["plan"]) == (USER, None, DOCUMENT, "PRO")
    assert (first["source_type"], first["source_id"]) == ("source", SOURCE)
    assert first["metadata"] == {
        "user_id": str(USER), "company_id": None, "source_type": "source", "source_id": str(SOURCE),
        "document_id": str(DOCUMENT), "plan": "PRO", "node_id": "node-0"}
    assert rows[1]["metadata"]["node_id"] == "node-1"


async def test_ingest_text_for_company_tenant_has_no_user(llama):
    store = MemoryStore()
    await Ingestor(store, Embedder()).ingest_text(Tenant(company_id=COMPANY), "posting", SOURCE, "JD")
    row = store.calls[0][3][0]
    assert (row["user_id"], row["company_id"]) == (None, COMPANY)
    assert row["metadata"]["user_id"] is None
    assert row["metadata"]["company_id"] == str(COMPANY)
    assert row["metadata"]["document_id"] is None and row["metadata"]["plan"] is None


async def test_ingest_blank_text_clears_existing_nodes_without_splitting_or_embedding(monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("must not split blank text")

    monkeypatch.setattr(pipeline, "split_nodes", boom)
    store, embedder = MemoryStore(), Embedder()
    assert await Ingestor(store, embedder).ingest_text(Tenant(user_id=USER), "link", SOURCE, " \n\t ") == 0
    assert embedder.calls == []
    assert store.calls == [("link", SOURCE, "BAAI/bge-m3", [])]


async def test_ingest_uses_custom_tokenizer(monkeypatch):
    seen = []

    def fake_split(text, metadata, tokenizer):
        seen.append(tokenizer)
        return [FakeNode(text, "n")]

    def tok(text):
        return list(text)

    monkeypatch.setattr(pipeline, "split_nodes", fake_split)
    await Ingestor(MemoryStore(), Embedder(), tokenizer=tok).ingest_text(Tenant(user_id=USER), "source", SOURCE, "x")
    assert seen == [tok]


# --- RagNodeStore -------------------------------------------------------------

class Conn:
    def __init__(self, fail_on_insert=None):
        self.executed = []
        self.fetched = []
        self.fail_on_insert = fail_on_insert
        self.inserts = 0
        self.committed = False
        self.rolled_back = False

    async def execute(self, sql, *args):
        if sql.startswith("INSERT"):
            self.inserts += 1
            if self.inserts == self.fail_on_insert:
                raise RuntimeError("disk full")
        self.executed.append((sql, args))
        return "OK"

    async def fetch(self, sql, *args):
        self.fetched.append((sql, args))
        return self.rows

    @asynccontextmanager
    async def transaction(self):
        try:
            yield
        except BaseException:
            self.rolled_back = True
            raise
        self.committed = True


class Pool:
    def __init__(self, conn):
        self.conn = conn
        self.executed = []

    @asynccontextmanager
    async def acquire(self):
        yield self.conn

    async def execute(self, sql, *args):
        self.executed.append(sql)

    async def fetch(self, sql, *args):
        return await self.conn.fetch(sql, *args)


def node_row(seq, embedding):
    return {"id": UUID(int=seq + 1), "user_id": USER, "company_id": None, "source_type": "source",
            "source_id": SOURCE, "document_id": None, "plan": "FREE", "seq": seq, "text": f"t{seq}",
            "metadata": {"seq": seq}, "embedding": embedding}


def test_vector_literal_formats_pgvector_text():
    assert vector_literal([1, 0.5, -2.25]) == "[1.0,0.5,-2.25]"
    assert vector_literal([]) == "[]"


async def test_replace_deletes_then_inserts_in_one_transaction():
    conn = Conn()
    pool = Pool(conn)
    await RagNodeStore(DB(pool)).replace("source", SOURCE, "BAAI/bge-m3", [node_row(0, [0.1, 0.2]), node_row(1, [1, 2])])
    assert pool.executed == []
    assert conn.committed and not conn.rolled_back
    (delete_sql, delete_args), *inserts = conn.executed
    assert delete_sql.startswith("DELETE FROM rag_nodes")
    assert "embedding_model = $3" in delete_sql
    assert delete_args == ("source", SOURCE, "BAAI/bge-m3")
    assert len(inserts) == 2
    sql, args = inserts[0]
    assert "INSERT INTO rag_nodes" in sql and "$11::vector" in sql
    assert args == (UUID(int=1), USER, None, "source", SOURCE, None, "FREE", 0, "t0", {"seq": 0},
                    "[0.1,0.2]", "BAAI/bge-m3")
    assert inserts[1][1][10] == "[1.0,2.0]"


async def test_replace_with_no_rows_only_deletes():
    conn = Conn()
    await RagNodeStore(DB(Pool(conn))).replace("link", SOURCE, "m", [])
    assert [sql.split()[0] for sql, _ in conn.executed] == ["DELETE"]


async def test_replace_rolls_back_when_an_insert_fails():
    conn = Conn(fail_on_insert=2)
    with pytest.raises(DomainError):
        await RagNodeStore(DB(Pool(conn))).replace("source", SOURCE, "m", [node_row(0, [1]), node_row(1, [2])])
    assert conn.rolled_back and not conn.committed


async def test_sources_missing_pages_by_model_and_cursor():
    conn = Conn()
    conn.rows = [{"id": SOURCE, "user_id": USER}]
    store = RagNodeStore(DB(Pool(conn)))
    assert await store.sources_missing("BAAI/bge-m3") == [{"id": SOURCE, "user_id": USER}]
    await store.sources_missing("m2", after=SOURCE, limit=5)
    (sql, first), (_, second) = conn.fetched
    assert "NOT EXISTS" in sql and "n.embedding_model = $1" in sql and "s.id > $2" in sql
    assert "ORDER BY s.id LIMIT $3" in sql
    assert first == ("BAAI/bge-m3", None, 100)
    assert second == ("m2", SOURCE, 5)
