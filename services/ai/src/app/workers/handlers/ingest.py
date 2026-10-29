from uuid import NAMESPACE_URL, UUID, uuid5

from app.queue.worker import JobFailed
from app.rag.readers import (
    read_document, read_evidence, read_github, read_job, read_posting, read_source, read_web,
)
from app.rag.tenant import Tenant


def _uuid(value) -> UUID | None:
    return None if value is None else UUID(str(value))


def _missing() -> JobFailed:
    return JobFailed({"code": "NOT_FOUND", "message": "resource not found"})


async def _each(missing, heartbeat, step) -> int:
    done = 0
    after = None
    while True:
        batch = await missing(after)
        if not batch:
            return done
        for row in batch:
            await step(row)
            await heartbeat()
            done += 1
        after = batch[-1]["id"]


async def reindex_all(query, store, ingestor, heartbeat) -> int:
    model = ingestor.embedder.model

    async def sources(after):
        return await store.sources_missing(model, after)

    async def one_source(row):
        source = await read_source(query(), row["id"])
        await ingestor.ingest_text(
            Tenant(user_id=_uuid(row["user_id"])), "source", row["id"], source["text"] if source else "")

    async def evidence(after):
        return await store.evidence_missing(model, after)

    async def one_evidence(row):
        item = await read_evidence(query(), row["id"])
        await ingestor.ingest_text(
            Tenant(user_id=_uuid(row["user_id"])), "evidence", row["id"], item["text"] if item else "")

    async def documents(after):
        return await store.documents_missing(model, after)

    async def one_document(row):
        item = await read_document(query(), row["id"])
        await ingestor.ingest_text(
            Tenant(user_id=_uuid(row["user_id"])), "document", row["id"], item["text"] if item else "")

    async def jobs(after):
        return await store.jobs_missing(model, after)

    async def one_job(row):
        item = await read_job(query(), row["id"])
        await ingestor.ingest_text(
            Tenant(user_id=_uuid(row["user_id"])), "job", row["id"], item["text"] if item else "")

    async def postings(after):
        return await store.postings_missing(model, after)

    async def one_posting(row):
        posting = await read_posting(query(), row["id"])
        company_id = _uuid(posting["company_id"]) if posting else _uuid(row.get("company_id"))
        await ingestor.ingest_text(
            Tenant(company_id=company_id, user_id=None if company_id else _uuid(row.get("user_id"))),
            "posting", row["id"], posting["text"] if posting else "")

    done = await _each(sources, heartbeat, one_source)
    done += await _each(evidence, heartbeat, one_evidence)
    done += await _each(documents, heartbeat, one_document)
    done += await _each(jobs, heartbeat, one_job)
    return done + await _each(postings, heartbeat, one_posting)


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
        if payload.get("evidenceId"):
            evidence_id = UUID(payload["evidenceId"])
            evidence = await read_evidence(query(), evidence_id)
            if evidence is None or _uuid(evidence["user_id"]) != user_id:
                raise _missing()
            return {"nodes": await ingestor.ingest_text(
                Tenant(user_id=user_id, company_id=company_id), "evidence", evidence_id, evidence["text"])}
        if payload.get("documentId"):
            document_id = UUID(payload["documentId"])
            document = await read_document(query(), document_id)
            if document is None or _uuid(document["user_id"]) != user_id:
                raise _missing()
            return {"nodes": await ingestor.ingest_text(
                Tenant(user_id=user_id, company_id=company_id), "document", document_id, document["text"])}
        if payload.get("jobId"):
            job_id = UUID(payload["jobId"])
            saved = await read_job(query(), job_id)
            if saved is None or _uuid(saved["user_id"]) != user_id:
                raise _missing()
            return {"nodes": await ingestor.ingest_text(
                Tenant(user_id=user_id, company_id=company_id), "job", job_id, saved["text"])}
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
            try:
                text = await read_web(url)
            except ValueError as err:  # blocked host, 4xx, wrong type: retrying cannot help
                raise JobFailed({"code": "VALIDATION_ERROR", "message": str(err)})
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
