from __future__ import annotations

import hashlib
import io
from uuid import UUID, uuid4

from app.harness.personal.resume.drafts import draft_text
from app.infrastructure.doc_render import tiptap_to_lines

_TITLE = "Push 프로필"
_SOURCE_SQL = (
    "INSERT INTO sources (id, user_id, file_name, mime_type, size, sha256, path, status, "
    "created_at, content, page_count, origin) "
    "VALUES ($1,$2,$3,$4,$5,$6,$7,'STORED',now(),$8,$9,'AI')"
)


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


def _clean(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _size_label(size: int) -> str:
    if size < 1_000_000:
        return f"{max(1, round(size / 1000))}KB"
    return f"{size / 1_000_000:.1f}MB"


def _pdf_bytes(text: str, template: str | None) -> bytes:
    from app.infrastructure.resume_workspace import md_to_pdf

    buf = io.BytesIO()
    md_to_pdf(text, buf, template)
    return buf.getvalue()


def _page_count(pdf: bytes) -> int:
    from pypdf import PdfReader

    try:
        count = len(PdfReader(io.BytesIO(pdf)).pages)
    except Exception:
        return 1
    return count or 1


def _row_text(row, key: str) -> str:
    try:
        return _clean(row[key])
    except (KeyError, IndexError, TypeError):
        return ""


async def profile_card_names(db, state: dict) -> tuple[str, str]:
    inputs = state.get("inputs") if isinstance(state.get("inputs"), dict) else {}
    name = _clean(inputs.get("name") or inputs.get("displayName"))
    headline = _clean(inputs.get("headline") or inputs.get("role"))
    if (name and headline) or db is None:
        return name, headline
    try:
        user_id = UUID(str(state.get("user_id") or ""))
    except (TypeError, ValueError):
        return name, headline
    try:
        row = await db.q().fetchrow(
            "SELECT u.display_name, p.headline FROM users u "
            "LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1",
            user_id,
        )
    except Exception:
        return name, headline
    if not row:
        return name, headline
    return name or _row_text(row, "display_name"), headline or _row_text(row, "headline")


async def _insert_source(db, state: dict, file_name: str, pdf: bytes, pages: int) -> bool:
    if db is None:
        return False
    try:
        user_id = UUID(str(state.get("user_id") or ""))
    except (TypeError, ValueError):
        return False
    source_id = uuid4()
    try:
        await db.q().execute(
            _SOURCE_SQL,
            source_id,
            user_id,
            file_name,
            "application/pdf",
            len(pdf),
            hashlib.sha256(pdf).hexdigest(),
            f"db://sources/{source_id}",
            pdf,
            pages,
        )
    except Exception:
        return False
    return True


def _document_title(file_name: str) -> str:
    if file_name.lower().endswith(".pdf"):
        stem = file_name[:-4].strip()
        return stem or file_name
    return file_name


async def save_edited_file(db, state: dict, file_name: str) -> dict:
    text = draft_text(state.get("drafts")) or file_name
    pdf = _pdf_bytes(text, state.get("template"))
    pages = _page_count(pdf)
    document_id = await save_profile_document(state, _document_title(file_name))
    stored = await _insert_source(db, state, file_name, pdf, pages)
    return {
        "documentId": document_id,
        "fileName": file_name,
        "pageLine": f"A4 {pages}쪽 · {_size_label(len(pdf))}",
        "stored": stored,
    }


async def save_profile_document(state: dict, title: str | None = None) -> str:
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
    label = title or _TITLE
    text = draft_text(state.get("drafts")) or label
    content, blocks = md_to_doc(text)
    template = state.get("template") or "CLASSIC"
    try:
        doc = await document_svc.create(
            user_id, None, label, "HUB_PROFILE", template, "ko")
        await document_svc.create_version(
            user_id, doc.id, doc.revision, content, blocks, "resume flow")
    except Exception:
        return ""
    return str(doc.id)
