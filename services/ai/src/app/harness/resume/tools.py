from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel

from app.domain.posting_fit import compute_fit
from app.harness.policy import Tier
from app.harness.tools import ToolContext, ToolSpec


class EmptyArgs(BaseModel):
    pass


class UrlArgs(BaseModel):
    url: str = ""


class GithubArgs(BaseModel):
    username: str = ""


class PostingArgs(BaseModel):
    posting_id: str = ""


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


async def save_artifact(ctx: ToolContext, name: str, content: str) -> str:
    return await _remember(ctx, name, content)


async def _save(ctx: ToolContext, args: ArtifactArgs) -> dict:
    file_id = await save_artifact(ctx, args.name, args.content)
    return {"fileId": file_id, "name": args.name}


async def _remember(ctx: ToolContext, name: str, content: str) -> str:
    from uuid import uuid4
    file_id = str(uuid4())
    if ctx.db is None:
        return file_id
    await ctx.db.q().execute(
        "INSERT INTO workspace_files (id, conversation_id, name, content) VALUES ($1,$2,$3,$4)",
        file_id, ctx.conversation_id, name, content,
    )
    return file_id


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
