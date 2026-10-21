from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Request
from starlette.datastructures import UploadFile
from fastapi.responses import FileResponse, Response

from app.db import NotFoundError
from app.domain import entities as ent
from app.domain.errors import (
    internal, invalid_transition, not_found, payload_too_large, validation_field,
)
from app.domain.pagination import Cursor, Page
from app.domain.source_list import merge_library
from app.api import schemas as s
from app.api.deps import (deps,
    bind_json, current_user, data, page_body, page_request, param_id,
)

logger = logging.getLogger(__name__)

router = APIRouter()

ALLOWED_SOURCE_MIME = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/markdown",
    "application/octet-stream",
}
MAX_SOURCE_BYTES = 20 << 20




def source_dto(src: ent.Source) -> dict:
    return {"id": src.id, "fileName": src.file_name, "mimeType": src.mime_type,
            "size": src.size, "sha256": src.sha256, "status": src.status,
            "createdAt": src.created_at}


@router.get("/career-evidence")
async def list_evidence(request: Request):
    d = deps(request)
    page = page_request(request)
    kind = request.query_params.get("kind") or None
    if kind is not None and not ent.valid_evidence_kind(kind):
        raise validation_field("kind", "unsupported kind")
    p = await d.evidence.list(current_user(request).id, kind,
                              request.query_params.get("query", ""), page)
    return page_body(p)


@router.post("/career-evidence", status_code=201)
async def create_evidence(request: Request):
    d = deps(request)
    req = await bind_json(request, s.CreateEvidenceReq)
    e = await d.evidence.create(current_user(request).id, req.kind, req.title,
                                req.source_text, req.source_url, req.skills,
                                req.supersedes_id)
    return data(201, e)


@router.get("/career-evidence/{id}")
async def get_evidence(id: str, request: Request):
    d = deps(request)
    e = await d.evidence.get(current_user(request).id, param_id(id, "id"))
    return data(200, e)


@router.post("/career-evidence/import", status_code=202)
async def import_evidence(request: Request):
    d = deps(request)
    req = await bind_json(request, s.ImportEvidenceReq)
    op = await d.evidence.import_(current_user(request).id, req.source_id,
                                  req.text, req.source_url, req.content_hash,
                                  req.format, req.kind, req.title)
    return data(202, op)


@router.post("/career-evidence/{id}/archive")
async def archive_evidence(id: str, request: Request):
    d = deps(request)
    req = await bind_json(request, s.ExpectedRevisionReq)
    e = await d.evidence.archive(current_user(request).id,
                                 param_id(id, "id"), req.expected_revision)
    return data(200, e)


@router.post("/sources", status_code=201)
async def create_source(request: Request):
    d = deps(request)
    user = current_user(request)
    form = await request.form()
    kind = form.get("kind")
    if not kind or not isinstance(kind, str):
        raise validation_field("kind", "required")
    file = form.get("file")
    if not isinstance(file, UploadFile):
        raise validation_field("file", "required")
    if file.size is not None and file.size > MAX_SOURCE_BYTES:
        raise payload_too_large()
    buf = await file.read(MAX_SOURCE_BYTES + 1)
    if len(buf) > MAX_SOURCE_BYTES:
        raise payload_too_large()
    mime = file.content_type or "application/octet-stream"
    if mime not in ALLOWED_SOURCE_MIME:
        raise validation_field("file", "unsupported file type " + mime)
    sha = hashlib.sha256(buf).hexdigest()
    src_id = uuid4()
    in_db = os.environ.get("BLOB_STORE") == "db" or os.environ.get("CF_WORKER") == "1"
    path = (f"db://sources/{src_id}" if in_db
            else os.path.join(d.storage_dir, str(user.id), str(src_id)))

    if not in_db:
        def _write():
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            with open(path, "wb") as f:
                f.write(buf)
            os.chmod(path, 0o600)

        await asyncio.to_thread(_write)
    src = ent.Source(id=src_id, user_id=user.id,
                     file_name=file.filename or "", mime_type=mime,
                     size=len(buf), sha256=sha, path=path, status="STORED",
                     created_at=datetime.now(timezone.utc))
    try:
        await d.sources.create(src, buf if in_db else None)
    except Exception:
        if not in_db:
            try:
                await asyncio.to_thread(os.unlink, path)
            except OSError:
                logger.exception("source file cleanup failed %s", src_id)
        raise internal()
    return data(201, {"id": src.id, "fileName": src.file_name,
                      "mimeType": src.mime_type, "size": src.size,
                      "sha256": src.sha256, "status": src.status})


@router.get("/sources")
async def list_sources(request: Request):
    user_id = current_user(request).id
    kind = request.query_params.get("kind") or None
    if kind not in (None, "UPLOAD", "AI"):
        raise validation_field("kind", "unsupported kind")
    page = page_request(request)
    query = request.app.state.db.q()
    uploads = []
    documents = []
    if kind in (None, "UPLOAD"):
        uploads = [dict(row) for row in await query.fetch(
            "SELECT id, file_name, mime_type, size, page_count, origin, created_at "
            "FROM sources WHERE user_id = $1 "
            "ORDER BY created_at DESC, id DESC",
            user_id)]
    if kind in (None, "AI"):
        documents = [dict(row) for row in await query.fetch(
            "SELECT id, title, created_at FROM documents WHERE user_id = $1 "
            "ORDER BY created_at DESC, id DESC",
            user_id)]
    items, has_more = merge_library(
        uploads, documents, kind, page.cursor, page.effective_limit())
    next_cursor = None
    if has_more:
        last = items[-1]
        next_cursor = Cursor(created_at=last["createdAt"], id=last["id"]).encode()
    return page_body(Page(items=items, next_cursor=next_cursor, has_more=has_more))


@router.get("/sources/{id}")
async def get_source(id: str, request: Request):
    d = deps(request)
    try:
        src = await d.sources.get(current_user(request).id,
                                  param_id(id, "id"))
    except NotFoundError:
        raise not_found()
    return data(200, source_dto(src))


@router.get("/sources/{id}/content")
async def get_source_content(id: str, request: Request):
    d = deps(request)
    try:
        src = await d.sources.get(current_user(request).id,
                                  param_id(id, "id"))
    except NotFoundError:
        raise not_found()
    if src.path.startswith("db://"):
        body = await d.sources.content(current_user(request).id, src.id)
        return Response(content=body, media_type=src.mime_type)
    return FileResponse(src.path)


@router.delete("/sources/{id}", status_code=204)
async def delete_source(id: str, request: Request):
    d = deps(request)
    user_id = current_user(request).id
    sid = param_id(id, "id")
    try:
        src = await d.sources.get(user_id, sid)
        ref = await d.sources.referenced(user_id, sid)
    except NotFoundError:
        raise not_found()
    except Exception:
        raise internal()
    if ref:
        raise invalid_transition("source is referenced by evidence")
    try:
        await d.sources.delete(user_id, sid)
    except NotFoundError:
        raise not_found()
    if not src.path.startswith("db://"):
        try:
            await asyncio.to_thread(os.unlink, src.path)
        except OSError:
            logger.exception("source file unlink failed %s", sid)
    return Response(status_code=204)
