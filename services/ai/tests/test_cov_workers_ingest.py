from types import SimpleNamespace
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import httpx
import pytest

from app.queue.worker import JobFailed
from app.rag import readers
from app.rag.tenant import Tenant
from app.workers.handlers.ingest import make_ingest, reindex_all

USER = UUID("33333333-3333-4333-8333-333333333333")
OTHER = UUID("44444444-4444-4444-8444-444444444444")
COMPANY = UUID("77777777-7777-4777-8777-777777777777")
SOURCE = UUID("55555555-5555-4555-8555-555555555555")
POSTING = UUID("66666666-6666-4666-8666-666666666666")


class Query:
    def __init__(self, sources=None, postings=None):
        self.sources = sources or {}
        self.postings = postings or {}

    async def fetchrow(self, sql, *args):
        if "FROM sources" in sql:
            hit = self.sources.get(args[0])
            return None if hit is None else {
                "id": args[0], "user_id": hit[0], "mime_type": "text/plain", "file_name": "a.txt",
                "path": "p", "content": hit[1].encode()}
        if "FROM job_postings" in sql:
            if args[0] not in self.postings:
                return None
            return {
                "id": args[0], "company_id": self.postings[args[0]], "title": "Backend", "description": "APIs", "requirements": ["Go"]}
        raise AssertionError(sql)


class Ingestor:
    def __init__(self, model="BAAI/bge-m3"):
        self.embedder = SimpleNamespace(model=model)
        self.calls = []

    async def ingest_text(self, tenant, source_type, source_id, text):
        self.calls.append((tenant, source_type, source_id, text))
        return 3


class Store:
    """sources_missing pages through `pending` by id like the SQL does."""

    def __init__(self, pending, page=2):
        self.pending = sorted(pending, key=lambda r: r["id"])
        self.page = page
        self.calls = []

    async def sources_missing(self, model, after=None, limit=100):
        self.calls.append((model, after))
        return [r for r in self.pending if after is None or r["id"] > after][:self.page]


def ctx(payload, user_id=USER, company_id=None):
    beats = []

    async def heartbeat():
        beats.append(1)

    job = {"id": uuid4(), "user_id": str(user_id) if user_id else None, "payload": payload}
    if company_id is not None:
        job["company_id"] = str(company_id)
    return SimpleNamespace(job=job, heartbeat=heartbeat, beats=beats)


def handler(query=None, ingestor=None, store=None, client=None):
    ingestor = ingestor or Ingestor()
    return make_ingest(lambda: query or Query(), store, ingestor, client), ingestor


async def test_source_payload_indexes_owned_source_under_user_and_company():
    ingest, ingestor = handler(Query(sources={SOURCE: (USER, "이력서 본문")}))
    out = await ingest(ctx({"sourceId": str(SOURCE)}, company_id=COMPANY))
    assert out == {"nodes": 3}
    assert ingestor.calls == [(Tenant(user_id=USER, company_id=COMPANY), "source", SOURCE, "이력서 본문")]


@pytest.mark.parametrize("sources", [{}, {SOURCE: (OTHER, "secret")}])
async def test_source_payload_hides_missing_or_foreign_source_as_not_found(sources):
    ingest, ingestor = handler(Query(sources=sources))
    with pytest.raises(JobFailed) as err:
        await ingest(ctx({"sourceId": str(SOURCE)}))
    assert err.value.error == {"code": "NOT_FOUND", "message": "resource not found"}
    assert ingestor.calls == []


async def test_company_posting_is_indexed_under_the_company_only():
    ingest, ingestor = handler(Query(postings={POSTING: COMPANY}))
    assert await ingest(ctx({"postingId": str(POSTING)})) == {"nodes": 3}
    tenant, kind, source_id, text = ingestor.calls[0]
    assert tenant == Tenant(company_id=COMPANY, user_id=None)
    assert (kind, source_id, text) == ("posting", POSTING, "Backend\nAPIs\nGo")


async def test_personal_posting_without_company_is_indexed_under_the_requesting_user():
    ingest, ingestor = handler(Query(postings={POSTING: None}))
    await ingest(ctx({"postingId": str(POSTING)}))
    assert ingestor.calls[0][0] == Tenant(user_id=USER)


async def test_missing_posting_is_not_found():
    ingest, ingestor = handler(Query())
    with pytest.raises(JobFailed) as err:
        await ingest(ctx({"postingId": str(POSTING)}))
    assert err.value.error["code"] == "NOT_FOUND"
    assert ingestor.calls == []


async def test_url_payload_fetches_page_and_uses_stable_link_id(monkeypatch):
    fetched = []

    async def fetch(url):
        fetched.append(url)
        return "page text"

    monkeypatch.setattr(readers, "fetch_page_text", fetch)
    ingest, ingestor = handler()
    url = "https://blog.example.com/post"
    assert await ingest(ctx({"url": url}, company_id=COMPANY)) == {"nodes": 3}
    assert fetched == [url]
    assert ingestor.calls == [(Tenant(user_id=USER, company_id=COMPANY), "link", uuid5(NAMESPACE_URL, url), "page text")]


async def test_github_payload_reads_repo_and_uses_stable_github_id():
    def respond(request):
        if request.url.path.endswith("/readme"):
            return httpx.Response(200, text="# Repo")
        return httpx.Response(200, json=[{"commit": {"message": "init"}}])

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        ingest, ingestor = handler(client=client)
        assert await ingest(ctx({"githubRepo": "octo/repo"})) == {"nodes": 3}
    assert ingestor.calls == [
        (Tenant(user_id=USER), "github", uuid5(NAMESPACE_URL, "https://github.com/octo/repo"), "# Repo\n- init")]


async def test_github_payload_with_bad_repo_fails_validation_without_retry():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: pytest.fail("no request"))) as client:
        ingest, ingestor = handler(client=client)
        with pytest.raises(JobFailed) as err:
            await ingest(ctx({"githubRepo": "not a repo"}))
    assert err.value.error == {"code": "VALIDATION_ERROR", "message": "repo must be owner/name"}
    assert ingestor.calls == []


async def test_unknown_payload_fails_validation():
    ingest, _ = handler()
    with pytest.raises(JobFailed) as err:
        await ingest(ctx({"sourceId": "", "url": ""}))
    assert err.value.error == {"code": "VALIDATION_ERROR", "message": "unknown ingest payload"}


async def test_reindex_payload_walks_every_page_and_heartbeats_per_source():
    ids = [UUID(int=i) for i in (3, 1, 2)]
    rows = [{"id": i, "user_id": USER if i != ids[0] else OTHER} for i in ids]
    store = Store(rows, page=2)
    query = Query(sources={ids[1]: (USER, "one"), ids[0]: (OTHER, "three")})
    ingest, ingestor = handler(query, Ingestor(model="m2"), store)
    c = ctx({"reindex": True})
    assert await ingest(c) == {"sources": 3}
    assert store.calls == [("m2", None), ("m2", UUID(int=2)), ("m2", UUID(int=3))]
    assert [(t.user_id, sid, text) for t, _, sid, text in ingestor.calls] == [
        (USER, UUID(int=1), "one"), (USER, UUID(int=2), ""), (OTHER, UUID(int=3), "three")]
    assert all(kind == "source" for _, kind, _, _ in ingestor.calls)
    assert len(c.beats) == 3


async def test_reindex_all_with_nothing_missing_returns_zero():
    async def never():
        raise AssertionError("no heartbeat expected")

    store = Store([])
    assert await reindex_all(lambda: Query(), store, Ingestor(), never) == 0
    assert store.calls == [("BAAI/bge-m3", None)]


async def test_url_payload_blocked_or_broken_page_fails_without_retry(monkeypatch):
    async def fetch(url):
        raise ValueError("host resolves to a private address")

    monkeypatch.setattr(readers, "fetch_page_text", fetch)
    ingest, ingestor = handler()
    with pytest.raises(JobFailed) as err:
        await ingest(ctx({"url": "https://intranet.example/"}))
    assert err.value.error["code"] == "VALIDATION_ERROR"
    assert ingestor.calls == []
