from uuid import NAMESPACE_URL, UUID, uuid5

from app.queue.worker import JobFailed
from app.rag.readers import read_github, read_posting, read_source, read_web
from app.rag.tenant import Tenant


def _uuid(value) -> UUID | None:
    return None if value is None else UUID(str(value))


def _missing() -> JobFailed:
    return JobFailed({"code": "NOT_FOUND", "message": "resource not found"})


async def reindex_all(query, store, ingestor, heartbeat) -> int:
    done = 0
    after = None
    while True:
        batch = await store.sources_missing(ingestor.embedder.model, after)
        if not batch:
            return done
        for row in batch:
            source = await read_source(query(), row["id"])
            await ingestor.ingest_text(
                Tenant(user_id=_uuid(row["user_id"])), "source", row["id"], source["text"] if source else "")
            await heartbeat()
            done += 1
        after = batch[-1]["id"]


def make_ingest(query, store, ingestor, github_client):
    async def ingest(ctx) -> dict:
        job = ctx.job
        payload = job["payload"]
        user_id = _uuid(job["user_id"])
        company_id = _uuid(job.get("company_id"))
        if payload.get("reindex"):
            return {"sources": await reindex_all(query, store, ingestor, ctx.heartbeat)}
        if payload.get("sourceId"):
            source_id = UUID(payload["sourceId"])
            source = await read_source(query(), source_id)
            if source is None or _uuid(source["user_id"]) != user_id:
                raise _missing()
            nodes = await ingestor.ingest_text(
                Tenant(user_id=user_id, company_id=company_id), "source", source_id, source["text"])
            return {"nodes": nodes}
        if payload.get("postingId"):
            posting_id = UUID(payload["postingId"])
            posting = await read_posting(query(), posting_id)
            if posting is None:
                raise _missing()
            nodes = await ingestor.ingest_text(
                Tenant(company_id=_uuid(posting["company_id"]), user_id=None if posting["company_id"] else user_id),
                "posting", posting_id, posting["text"])
            return {"nodes": nodes}
        tenant = Tenant(user_id=user_id, company_id=company_id)
        if payload.get("url"):
            url = payload["url"]
            text = await read_web(url)
            return {"nodes": await ingestor.ingest_text(tenant, "link", uuid5(NAMESPACE_URL, url), text)}
        if payload.get("githubRepo"):
            repo = payload["githubRepo"]
            try:
                text = await read_github(github_client, repo)
            except ValueError as err:
                raise JobFailed({"code": "VALIDATION_ERROR", "message": str(err)})
            source_id = uuid5(NAMESPACE_URL, "https://github.com/" + repo)
            return {"nodes": await ingestor.ingest_text(tenant, "github", source_id, text)}
        raise JobFailed({"code": "VALIDATION_ERROR", "message": "unknown ingest payload"})
    return ingest
