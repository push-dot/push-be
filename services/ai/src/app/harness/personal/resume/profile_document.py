from __future__ import annotations

from uuid import UUID

from app.harness.personal.resume.drafts import draft_text
from app.infrastructure.doc_render import tiptap_to_lines

_TITLE = "Push 프로필"


async def load_document_markdown(db, state: dict) -> str:
    inputs = state.get("inputs") if isinstance(state.get("inputs"), dict) else {}
    raw = inputs.get("documentId")
    if not raw or db is None:
        return ""
    try:
        user_id = UUID(str(state.get("user_id") or ""))
        doc_id = UUID(str(raw))
    except (TypeError, ValueError):
        return ""
    try:
        row = await db.q().fetchrow(
            "SELECT v.content FROM documents d "
            "JOIN document_versions v ON v.id = COALESCE(d.latest_version_id, d.finalized_version_id) "
            "WHERE d.id = $1 AND d.user_id = $2",
            doc_id,
            user_id,
        )
    except Exception:
        return ""
    if not row:
        return ""
    try:
        content = row["content"]
    except (KeyError, TypeError):
        return ""
    if not isinstance(content, dict):
        return ""
    return "\n".join(line for line in tiptap_to_lines(content) if line).strip()


async def save_profile_document(state: dict) -> str:
    from app.harness.personal.tools import bound_services
    from app.infrastructure.resume_workspace import md_to_doc

    svc = bound_services.get()
    document_svc = getattr(svc, "document_svc", None) if svc else None
    if document_svc is None:
        return ""
    try:
        user_id = UUID(str(state.get("user_id") or ""))
    except (TypeError, ValueError):
        return ""
    text = draft_text(state.get("drafts")) or _TITLE
    content, blocks = md_to_doc(text)
    template = state.get("template") or "CLASSIC"
    try:
        doc = await document_svc.create(
            user_id, None, _TITLE, "HUB_PROFILE", template, "ko")
        await document_svc.create_version(
            user_id, doc.id, doc.revision, content, blocks, "resume flow")
    except Exception:
        return ""
    return str(doc.id)
