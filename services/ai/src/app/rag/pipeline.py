import re
from uuid import UUID, uuid4

from app.rag.tenant import Tenant

CHUNK_SIZE = 512
CHUNK_OVERLAP = 64

_TOKEN = re.compile(r"[가-힣]|[A-Za-z0-9]+|[^\sA-Za-z0-9가-힣]")


def approx_tokens(text: str) -> list[str]:
    # shortcut: one Hangul syllable or one Latin word per token, offline; swap for the bge-m3 tokenizer if chunk sizes drift
    return _TOKEN.findall(text)


def split_nodes(text: str, metadata: dict, tokenizer=approx_tokens) -> list:
    from llama_index.core import Document
    from llama_index.core.node_parser import SentenceSplitter

    splitter = SentenceSplitter(
        chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP, tokenizer=tokenizer)
    return splitter.get_nodes_from_documents([Document(text=text, metadata=metadata)])


class Ingestor:
    def __init__(self, store, embedder, tokenizer=approx_tokens):
        self.store = store
        self.embedder = embedder
        self.tokenizer = tokenizer

    async def ingest_text(self, tenant: Tenant, source_type: str, source_id: UUID, text: str,
                          *, document_id: UUID | None = None, plan: str | None = None) -> int:
        metadata = {
            "user_id": str(tenant.user_id) if tenant.user_id else None,
            "company_id": str(tenant.company_id) if tenant.company_id else None,
            "source_type": source_type,
            "source_id": str(source_id),
            "document_id": str(document_id) if document_id else None,
            "plan": plan,
        }
        nodes = split_nodes(text.strip(), metadata, self.tokenizer) if text.strip() else []
        vectors = await self.embedder.embed([n.get_content() for n in nodes]) if nodes else []
        rows = [{
            "id": uuid4(),
            "user_id": tenant.user_id,
            "company_id": tenant.company_id,
            "source_type": source_type,
            "source_id": source_id,
            "document_id": document_id,
            "plan": plan,
            "seq": seq,
            "text": node.get_content(),
            "metadata": {**metadata, "node_id": node.node_id},
            "embedding": vector,
        } for seq, (node, vector) in enumerate(zip(nodes, vectors))]
        await self.store.replace(source_type, source_id, self.embedder.model, rows)
        return len(rows)
