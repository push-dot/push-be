from __future__ import annotations

import io
import re
from types import SimpleNamespace
from uuid import NAMESPACE_URL, UUID, uuid5

from langgraph.config import get_stream_writer
from pydantic import BaseModel

from app.domain.posting_fit import compute_fit
from app.harness.policy import Tier
from app.harness.tools import ToolContext, ToolSpec

_FINAL_MD = re.compile(r"05_final_\w+\.md")


class EmptyArgs(BaseModel):
    pass


class UrlArgs(BaseModel):
    url: str = ""


class GithubArgs(BaseModel):
    username: str = ""


class PostingArgs(BaseModel):
    posting_id: UUID | None = None


class FitArgs(BaseModel):
    requirements: list[str] = []
    keywords: list[str] = []
    description: str = ""
    document_id: str = ""
    content: str = ""


class ArtifactArgs(BaseModel):
    name: str
    content: str = ""


async def _empty(_ctx: ToolContext, _args) -> dict:
    return {}


async def _posting(ctx: ToolContext, args: PostingArgs) -> dict:
    if not args.posting_id:
        return {}
    return await ctx.core.call(
        "GET", f"/api/v1/postings/{args.posting_id}",
        user_id=ctx.user_id, company_id=ctx.company_id,
    )


async def _fit(_ctx: ToolContext, args: FitArgs) -> dict:
    document_id = UUID(args.document_id) if args.document_id else UUID(int=0)
    return compute_fit(
        args.requirements, args.keywords, args.description,
        document_id, args.content, "FREE")


def _emit(event: dict) -> None:
    try:
        get_stream_writer()(event)
    except Exception:
        return


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
    md_to_pdf(body, buf)
    await _put_pdf(ctx, name[:-3] + ".pdf", buf.getvalue())
    document_id = await _document_id(ctx, name)
    _emit({
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
    ToolSpec("parse_attachment", Tier.READ, EmptyArgs, _empty, lambda _args: "첨부 파일을 읽어요"),
    ToolSpec("fetch_url", Tier.READ, UrlArgs, _empty, lambda _args: "미리 읽은 페이지만 봐요"),
    ToolSpec("explore_github", Tier.READ, GithubArgs, _empty, lambda _args: "GitHub 저장소를 봐요"),
    ToolSpec("get_posting", Tier.READ, PostingArgs, _posting, lambda _args: "공고를 봐요"),
    ToolSpec("compute_fit", Tier.READ, FitArgs, _fit, lambda _args: "공고와 얼마나 맞는지 봐요"),
    ToolSpec("save_artifact", Tier.SAFE_WRITE, ArtifactArgs, _save, lambda _args: "산출물을 저장해요"),
    ToolSpec("render_pdf", Tier.SAFE_WRITE, ArtifactArgs, _save, lambda _args: "PDF로 만들어요"),
    ToolSpec("save_to_documents", Tier.SAFE_WRITE, ArtifactArgs, _save, lambda _args: "서류함에 넣어요"),
]
