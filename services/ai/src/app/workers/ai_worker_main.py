import asyncio
import os

AI_WORKER_QUEUES = ["q:chat:priority", "q:chat", "q:document"]


def ai_handlers(deps, query) -> dict:
    from app.workers.handlers.chat import chat
    from app.workers.handlers.document import make_document
    from app.workers.handlers.fit import make_fit

    gate = getattr(getattr(deps, "ai", None), "gate", None)
    return {
        "chat": chat,
        "employer_ai": chat,
        "document": make_document(deps.documents),
        "fit": make_fit(query, gate),
    }


async def build_chat(svc) -> None:
    from app.harness.jobs import run_queue_turn
    from app.workers.handlers.chat import configure_harness

    async def cancelled(job_id):
        return await svc.jobs.worker_status(job_id) == "CANCELLED"

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
    from app.workers.shutdown import stop_on_signals

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
    stop_on_signals(worker.stop)
    runs = [worker.run_forever()]
    if os.environ.get("SERVE_API") == "1":
        runs.append(serve_api(app, worker))
    try:
        await asyncio.gather(*runs)
    finally:
        await redis.aclose()


if __name__ == "__main__":
    asyncio.run(main())
