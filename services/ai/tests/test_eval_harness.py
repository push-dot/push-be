import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "eval" / "rag" / "run_eval.py"
spec = importlib.util.spec_from_file_location("run_eval", SCRIPT)
run_eval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_eval)


class BigramEmbedder:
    model = "bigram"
    dim = 64

    async def embed(self, texts):
        out = []
        for text in texts:
            vec = [0.0] * self.dim
            for i in range(len(text) - 1):
                vec[int(hashlib.md5(text[i:i + 2].encode()).hexdigest(), 16) % self.dim] += 1.0
            out.append(vec)
        return out


class LengthFreeReranker:
    async def rerank(self, query, texts):
        return [run_eval.word_similarity(query, t) for t in texts]


TINY_DOCS = [
    {"id": "d1", "tenant": "t", "kind": "resume", "title": "", "text": "결제 서버 지연을 210ms로 줄였습니다."},
    {"id": "d2", "tenant": "t", "kind": "resume", "title": "", "text": "디자인 시스템을 Figma로 만들었습니다."},
    {"id": "d3", "tenant": "other", "kind": "resume", "title": "", "text": "결제 서버 지연을 줄인 다른 사람"},
]
TINY_QUERIES = [
    {"id": "q1", "tenant": "t", "query": "결제 서버 지연", "relevant": ["d1"], "answerTerms": ["210ms"]},
    {"id": "q2", "tenant": "t", "query": "Figma 디자인 시스템", "relevant": ["d2"], "answerTerms": ["Figma"]},
]


def test_eval_computes_recall_and_mrr_on_tiny_fixture():
    assert run_eval.recall_at_k(["a", "b", "c"], ["b", "z"], 5) == 0.5
    assert run_eval.recall_at_k(["a", "b"], ["b"], 1) == 0.0
    assert run_eval.reciprocal_rank(["a", "b", "c"], ["c"]) == pytest.approx(1 / 3)
    assert run_eval.reciprocal_rank(["a"], ["c"]) == 0.0
    assert run_eval.grounded(["x 210ms"], ["210ms"]) is True


@pytest.mark.asyncio
async def test_llamaindex_engine_runs_end_to_end_offline():
    pytest.importorskip("llama_index.core")
    engine = run_eval.Engine(BigramEmbedder(), LengthFreeReranker())
    out = await run_eval.evaluate(engine, TINY_DOCS, TINY_QUERIES, 1)
    assert out["recall@1"] == 1.0
    assert out["mrr"] == 1.0


def test_synthetic_set_has_50_queries_grounded_in_same_tenant_docs():
    docs, queries = run_eval.load()
    by_id = {d["id"]: d for d in docs}
    assert len(queries) >= 50
    for q in queries:
        assert q["relevant"]
        for doc_id in q["relevant"]:
            assert by_id[doc_id]["tenant"] == q["tenant"]
        assert any(term in by_id[d]["text"] for d in q["relevant"] for term in q["answerTerms"])
    assert len({q["tenant"] for q in queries}) >= 3
    assert json.dumps(docs, ensure_ascii=False).count("@") == 0
