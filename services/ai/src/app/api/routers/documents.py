from __future__ import annotations

from fastapi import APIRouter, Request

from app.domain import entities as ent
from app.api import schemas as s
from app.api.deps import ai_options, bind_json, current_user, deps, data, param_id

router = APIRouter()

# Document CRUD, versions, chat edits, review, finalize, archive and export
# records moved to push-be-core (services/core-api/src/routes/documents.ts).
# Rendering a PDF/DOCX and the AI revision proposal stay here.


async def _avatar_bytes(request: Request) -> bytes | None:
    from app.infrastructure.images import image_bytes

    db = getattr(request.app.state, "db", None)
    if db is None:
        return None
    row = await db.q().fetchrow(
        "SELECT avatar_key FROM profiles WHERE user_id = $1",
        current_user(request).id)
    key = None if row is None else row["avatar_key"]
    if not key:
        return None
    return await image_bytes(db, key)


@router.get("/documents/{id}/versions/{versionId}/export")
async def export_version(id: str, versionId: str, request: Request):
    from fastapi.responses import Response

    from app.domain.errors import document_not_finalized, validation_field
    from app.infrastructure.doc_render import (
        render_docx, render_pdf, tiptap_to_lines)

    d = deps(request)
    fmt = (request.query_params.get("format") or "PDF").upper()
    if fmt not in ("PDF", "DOCX"):
        raise validation_field("format", "must be PDF or DOCX")
    raw_template = request.query_params.get("template")
    if raw_template is not None and not ent.valid_document_template(raw_template):
        raise validation_field("template", ent.DOC_TEMPLATE_MESSAGE)
    doc = await d.documents.get(current_user(request).id, param_id(id, "id"))
    v = await d.documents.get_version(current_user(request).id,
                                      param_id(id, "id"),
                                      param_id(versionId, "versionId"))
    if doc.finalized_version_id is None or doc.finalized_version_id != v.id:
        raise document_not_finalized(
            "only the finalized version can be exported")
    lines = tiptap_to_lines(v.content or {})
    import asyncio
    if fmt == "PDF":
        template = raw_template if raw_template is not None else doc.template
        photo = None
        if request.query_params.get("photo") == "1":
            photo = await _avatar_bytes(request)
        body = await asyncio.to_thread(render_pdf, lines, template, photo)
        media, ext = "application/pdf", "pdf"
    else:
        body = await asyncio.to_thread(render_docx, lines)
        media = ("application/vnd.openxmlformats-officedocument"
                 ".wordprocessingml.document")
        ext = "docx"
    title = getattr(doc, "title", None) or "document"
    from urllib.parse import quote
    filename = quote(f"{title}.{ext}")
    return Response(
        content=body, media_type=media,
        headers={"Content-Disposition":
                 f"attachment; filename=doc.{ext}; "
                 f"filename*=UTF-8''{filename}"})


@router.post("/documents/{id}/revisions", status_code=202)
async def create_revision(id: str, request: Request):
    d = deps(request)
    req = await bind_json(request, s.ReviseReq)
    sel = ent.Selection(from_=req.selection.from_, to=req.selection.to,
                        text=req.selection.text)
    op = await d.documents.create_revision(
        current_user(request).id, param_id(id, "id"), req.expected_revision,
        req.version_id, sel, req.action, req.instruction, ai_options(req.ai))
    return data(202, op)
