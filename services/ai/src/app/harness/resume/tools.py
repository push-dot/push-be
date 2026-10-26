from __future__ import annotations

import asyncio
import io
import re
from types import SimpleNamespace
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel

from app.domain.posting_fit import compute_fit
from app.harness.policy import Tier
from app.ingest.pdf_text import extract_pdf_bytes
from app.ingest.web_page import fetch_github_context, github_usernames
from app.harness.tools import OptionalId, ToolContext, ToolSpec, emit

_FINAL_MD = re.compile(r"05_final_\w+\.md")


GITHUB_TRANSPORT = None
_TEXT_LIMIT = 20000


class AttachmentArgs(BaseModel):
    attachment_id: UUID


class UrlArgs(BaseModel):
    url: str


class GithubArgs(BaseModel):
    username: str = ""


class PostingArgs(BaseModel):
    posting_id: UUID | None = None


class FitArgs(BaseModel):
    requirements: list[str] = []
    keywords: list[str] = []
    description: str = ""
    document_id: OptionalId = None
    content: str = ""


class ArtifactArgs(BaseModel):
    name: str
    content: str = ""


async def _parse_attachment(ctx: ToolContext, args: AttachmentArgs) -> dict:
    evidence = await ctx.db.q().fetchrow(
        "SELECT title, source_text FROM career_evidence WHERE id = $1 AND user_id = $2",
        args.attachment_id, UUID(ctx.user_id))
    if evidence is not None:
        return {"title": evidence["title"], "text": evidence["source_text"][:_TEXT_LIMIT]}
    attachment = await ctx.db.q().fetchrow(
        "SELECT file_name, mime_type, content FROM conversation_attachments "
        "WHERE id = $1 AND conversation_id = $2",
        args.attachment_id, UUID(ctx.conversation_id))
    if attachment is None:
        return {"error": "NOT_FOUND"}
    if attachment["mime_type"] != "application/pdf":
        return {"error": "UNSUPPORTED_TYPE"}
    text = await asyncio.to_thread(extract_pdf_bytes, bytes(attachment["content"]))
    return {"title": attachment["file_name"], "text": text[:_TEXT_LIMIT]}


async def _fetch_url(ctx: ToolContext, args: UrlArgs) -> dict:
    text = (ctx.inputs.get("pages") or {}).get(args.url)
    if text is None:
        return {"error": "NOT_FETCHED"}
    return {"url": args.url, "text": text[:_TEXT_LIMIT]}


async def _explore_github(ctx: ToolContext, args: GithubArgs) -> dict:
    rows = await ctx.db.q().fetch(
        "SELECT url FROM user_links WHERE user_id = $1 AND kind = 'github' AND ai_read",
        UUID(ctx.user_id))
    linked = [name for row in rows for name in github_usernames(row["url"])]
    if not linked:
        return {"error": "INTEGRATION_REQUIRED"}
    wanted = args.username.lower()
    username = wanted if wanted in linked else linked[0]
    text = await fetch_github_context(username, transport=GITHUB_TRANSPORT)
    return {"username": username, "text": text} if text else {"error": "GITHUB_UNAVAILABLE"}


async def _posting(ctx: ToolContext, args: PostingArgs) -> dict:
    if not args.posting_id:
        return {}
    return await ctx.core.call(
        "GET", f"/api/v1/postings/{args.posting_id}",
        user_id=ctx.user_id, company_id=ctx.company_id,
    )


async def _fit(_ctx: ToolContext, args: FitArgs) -> dict:
    return compute_fit(
        args.requirements, args.keywords, args.description,
        args.document_id or UUID(int=0), args.content, "FREE")


def _artifact_id(ctx: ToolContext, name: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"push:artifact:{ctx.conversation_id}:{name}"))


async def _put_body(ctx: ToolContext, name: str, body: str) -> None:
    await ctx.db.q().execute(
        "INSERT INTO workspace_files (conversation_id, name, body, updated_at) "
        "VALUES ($1,$2,$3,now()) "
        "ON CONFLICT (conversation_id, name) DO UPDATE "
        "SET body=EXCLUDED.body, updated_at=now()",
        ctx.conversation_id, name, body,
    )


async def _put_pdf(ctx: ToolContext, name: str, content: bytes) -> None:
    await ctx.db.q().execute(
        "INSERT INTO workspace_files (conversation_id, name, content, updated_at) "
        "VALUES ($1,$2,$3,now()) "
        "ON CONFLICT (conversation_id, name) DO UPDATE "
        "SET content=EXCLUDED.content, updated_at=now()",
        ctx.conversation_id, name, content,
    )


async def _document_id(ctx: ToolContext, name: str) -> str:
    from app.harness.personal.tools import bound_services
    from app.infrastructure.resume_workspace import _sync_documents_db

    svc = bound_services.get()
    document_svc = getattr(svc, "document_svc", None) if svc else None
    try:
        user_id = UUID(ctx.user_id)
    except ValueError:
        return ""
    if document_svc is None or ctx.db is None:
        return ""
    synced = await _sync_documents_db(
        SimpleNamespace(db=ctx.db, document_svc=document_svc),
        user_id,
        SimpleNamespace(id=ctx.conversation_id, title=""),
        [name],
    )
    if not synced:
        return ""
    return str(synced[0]["document_id"])


async def save_artifact(ctx: ToolContext, name: str, content: str) -> str:
    file_id = _artifact_id(ctx, name)
    if ctx.db is None:
        return file_id
    body = content.strip() + "\n"
    await _put_body(ctx, name, body)
    if not _FINAL_MD.fullmatch(name):
        return file_id
    from app.infrastructure.resume_workspace import md_to_pdf

    buf = io.BytesIO()
    await asyncio.to_thread(md_to_pdf, body, buf)
    await _put_pdf(ctx, name[:-3] + ".pdf", buf.getvalue())
    document_id = await _document_id(ctx, name)
    emit({
        "type": "file",
        "name": name,
        "mime": "text/markdown",
        "fileId": file_id,
        "documentId": document_id,
        "downloadUrl": f"/conversations/{ctx.conversation_id}/artifacts/{name}",
    })
    return file_id


async def _save(ctx: ToolContext, args: ArtifactArgs) -> dict:
    file_id = await save_artifact(ctx, args.name, args.content)
    return {"fileId": file_id, "name": args.name}


RESUME_TOOLS = [
    ToolSpec("parse_attachment", Tier.READ, AttachmentArgs, _parse_attachment, lambda _args: "첨부 파일을 읽어요"),
    ToolSpec("fetch_url", Tier.READ, UrlArgs, _fetch_url, lambda _args: "미리 읽은 페이지만 봐요"),
    ToolSpec("explore_github", Tier.READ, GithubArgs, _explore_github, lambda _args: "GitHub 저장소를 봐요"),
    ToolSpec("get_posting", Tier.READ, PostingArgs, _posting, lambda _args: "공고를 봐요"),
    ToolSpec("compute_fit", Tier.READ, FitArgs, _fit, lambda _args: "공고와 얼마나 맞는지 봐요"),
    ToolSpec("save_artifact", Tier.SAFE_WRITE, ArtifactArgs, _save, lambda _args: "산출물을 저장해요"),
    ToolSpec("render_pdf", Tier.SAFE_WRITE, ArtifactArgs, _save, lambda _args: "PDF로 만들어요"),
    ToolSpec("save_to_documents", Tier.SAFE_WRITE, ArtifactArgs, _save, lambda _args: "서류함에 넣어요"),
]
