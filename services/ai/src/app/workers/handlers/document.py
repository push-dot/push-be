from uuid import UUID

from pydantic import ValidationError

from app.api import schemas as s
from app.api.deps import ai_options
from app.domain.errors import DomainError
from app.jsonutil import to_jsonable
from app.queue.worker import JobFailed


def make_document(documents):
    async def document(ctx) -> dict:
        payload = ctx.job["payload"]
        try:
            req = s.GenerateDocReq.model_validate(payload.get("body") or {})
            op = await documents.generate(
                UUID(str(ctx.job["user_id"])), UUID(payload["documentId"]),
                req.expected_revision, req.evidence_ids, req.analysis_id,
                ai_options(req.ai), req.language)
        except ValidationError as err:
            raise JobFailed({"code": "VALIDATION_ERROR", "message": str(err.errors()[0]["msg"])})
        except DomainError as err:
            raise JobFailed({"code": err.code, "message": err.message, "details": err.details})
        return to_jsonable({"operationId": op.id, **op.result.value})
    return document
