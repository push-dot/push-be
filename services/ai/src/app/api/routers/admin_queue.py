import hmac
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from app.queue.config import QUEUE_GROUPS


def admin_router(dispatcher) -> APIRouter:
    def authorized(request: Request) -> None:
        token = dispatcher.admin_token
        header = request.headers.get("authorization") or ""
        got = header[7:] if header.startswith("Bearer ") else ""
        if not token or len(got) != len(token) or not hmac.compare_digest(got, token):
            raise HTTPException(status_code=401)

    router = APIRouter(prefix="/admin", dependencies=[Depends(authorized)])

    async def with_db(fn):
        db = await dispatcher.open_db()
        try:
            return await fn(db)
        finally:
            await db.close()

    def ok(data, status: int = 200):
        return JSONResponse(status_code=status, content={"data": data})

    def job_id(raw: str) -> UUID:
        try:
            return UUID(raw)
        except ValueError:
            raise HTTPException(status_code=404)

    def known(name: str) -> str:
        if name not in QUEUE_GROUPS:
            raise HTTPException(status_code=404)
        return name

    @router.get("/queue/stats")
    async def stats():
        now = dispatcher.now()
        streams = {name: await dispatcher.queue.stream_stats(name, group, now)
                   for name, group in QUEUE_GROUPS.items()}

        async def read(db):
            return await db.type_stats(now), await db.neon_stats()

        types, neon = await with_db(read)
        return ok({"streams": streams, "types": types, "neon": neon})

    @router.get("/jobs")
    async def jobs(status: str = "DEAD", limit: int = 50):
        return ok(await with_db(lambda db: db.dead_jobs(status, min(max(limit, 1), 200))))

    @router.post("/jobs/{id}/retry")
    async def retry(id: str):
        target = job_id(id)
        done = await with_db(lambda db: db.retry(target, dispatcher.now()))
        if not done:
            raise HTTPException(status_code=409)
        await dispatcher.run_once(dispatcher.now())
        return ok({"id": id, "status": "QUEUED"})

    @router.post("/jobs/{id}/cancel")
    async def cancel(id: str):
        target = job_id(id)
        done = await with_db(lambda db: db.cancel(target, dispatcher.now()))
        if not done:
            raise HTTPException(status_code=409)
        return ok({"id": id, "status": "CANCELLED"})

    @router.post("/queues/{name}/pause")
    async def pause(name: str):
        await dispatcher.queue.pause(known(name))
        return ok({"queue": name, "paused": True})

    @router.post("/queues/{name}/resume")
    async def resume(name: str):
        await dispatcher.queue.resume(known(name))
        return ok({"queue": name, "paused": False})

    return router
