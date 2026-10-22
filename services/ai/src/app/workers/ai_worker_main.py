import asyncio
import os

AI_WORKER_QUEUES = ["q:chat:priority", "q:chat", "q:document"]


def ai_handlers(deps, query) -> dict:
    from app.workers.handlers.chat import chat
    from app.workers.handlers.document import make_document
    from app.workers.handlers.fit import make_fit

    return {
        "chat": chat,
        "employer_ai": chat,
        "document": make_document(deps.documents),
        "fit": make_fit(query),
    }


async def build_chat(svc) -> None:
    from uuid import UUID

    from app.queue.worker import JobCancelled
    from app.harness.jobs import run_queue_turn
    from app.workers.handlers.chat import configure_chat, configure_harness

    async def cancelled(job_id):
        return await svc.jobs.worker_status(job_id) == "CANCELLED"

    async def set_state(job_id, state):
        await svc.jobs.worker_set_state(job_id, state)

    async def run_node(ctx, name):
        jid = ctx.job["id"]
        if not isinstance(jid, UUID):
            jid = UUID(str(jid))
        result = await svc.exec_chat_node(str(jid), name, "")
        if result == "skip":
            raise JobCancelled()
        if result != "ok":
            raise RuntimeError("chat node " + name + " failed")
        job = await svc.jobs.get(jid)
        checkpoint = (job or {}).get("checkpoint") or {}
        if isinstance(checkpoint, str):
            import json
            checkpoint = json.loads(checkpoint)
        state = checkpoint.get("state") or {}
        if not isinstance(state, dict):
            state = {}
        return {
            "messageId": str(state.get("messageId") or ""),
            "needs_approval": bool(state.get("needs_approval")),
        }

    configure_chat(run_node=run_node, cancelled=cancelled, set_state=set_state)
    configure_harness(lambda ctx: run_queue_turn(svc, ctx, cancelled))


async def serve_api(app, worker) -> None:
    import uvicorn

    server = uvicorn.Server(uvicorn.Config(
        app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), log_level="info"))
    try:
        await server.serve()
    finally:
        worker.stop()


async def main() -> None:
    import logging

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    from redis.asyncio import Redis

    from app.clock import utcnow
    from app.infrastructure.store_chat_jobs import QueueJobs
    from app.main import app, ensure_ready
    from app.queue.credits import release_job, settle_job
    from app.queue.streams import StreamQueue
    from app.queue.worker import Worker

    await ensure_ready(app)
    svc = app.state.deps.conversations
    await build_chat(svc)
    redis = Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    pool = app.state.db.pool

    async def settle(_db, job_id):
        await settle_job(pool, job_id, utcnow())

    async def release(_db, job_id):
        await release_job(pool, job_id, utcnow())

    worker = Worker(
        StreamQueue(redis),
        QueueJobs(svc.jobs),
        os.environ.get("QUEUE_GROUP", "ai"),
        os.environ.get("QUEUE_CONSUMER", "ai-worker"),
        AI_WORKER_QUEUES,
        ai_handlers(app.state.deps, app.state.db.q),
        int(os.environ.get("QUEUE_CONCURRENCY", "4")),
        settle=settle,
        release=release,
    )
    runs = [worker.run_forever()]
    if os.environ.get("SERVE_API") == "1":
        runs.append(serve_api(app, worker))
    try:
        await asyncio.gather(*runs)
    finally:
        await redis.aclose()


if __name__ == "__main__":
    asyncio.run(main())
