from uuid import UUID

from app.infrastructure.posting_fit_cache import load_fit
from app.queue.worker import JobFailed


def make_fit(query, gate=None):
    async def fit(ctx) -> dict:
        payload = ctx.job["payload"]
        view = await load_fit(
            query(), UUID(str(ctx.job["user_id"])),
            UUID(payload["postingId"]), UUID(payload["documentId"]),
            gate=gate, job_id=ctx.job.get("id"))
        if view is None:
            raise JobFailed({"code": "NOT_FOUND", "message": "resource not found"})
        return view
    return fit
