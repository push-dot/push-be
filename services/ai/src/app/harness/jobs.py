from __future__ import annotations

import json
from uuid import UUID

from app.domain.errors import DomainError


class _ApprovedEdit:
    def __init__(self, svc, user_id, diff: dict):
        self.svc = svc
        self.user_id = user_id
        self.diff = diff

    async def astream(self, *args, **kwargs):
        try:
            await self.svc.document_svc.apply_hunks(self.user_id, self.diff)
        except DomainError as err:
            yield "custom", {"type": "tool", "name": "edit_document", "state": "err",
                             "summary": "서류 수정", "result": {"error": err.code}}
        else:
            yield "custom", {"type": "diff", **self.diff}
        yield "custom", {"type": "done"}


async def approved_edit(svc, payload: dict, user_id):
    resume = payload.get("resume") or {}
    if resume.get("optionId") != "apply" or getattr(svc, "document_svc", None) is None:
        return None
    approval_id = UUID(str(resume.get("approvalId")))
    row = await svc.db.q().fetchrow(
        "SELECT kind, job_id, tool_args FROM approvals WHERE id = $1 AND user_id = $2",
        approval_id, user_id)
    if row is None or row["kind"] != "DOCUMENT_EDIT" or row["job_id"] is not None:
        return None
    claimed = await svc.db.q().fetchrow(
        "UPDATE approvals SET status = 'CONSUMED', updated_at = now() "
        "WHERE id = $1 AND status = 'APPROVED' RETURNING id", approval_id)
    raw = row["tool_args"]
    diff = json.loads(raw) if isinstance(raw, str) else raw
    if claimed is None or not isinstance(diff, dict):
        return _Done()
    return _ApprovedEdit(svc, user_id, diff)


class _Done:
    async def astream(self, *args, **kwargs):
        yield "custom", {"type": "done"}
