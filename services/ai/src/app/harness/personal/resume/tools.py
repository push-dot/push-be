from __future__ import annotations

import asyncio
import io
import json
import re
from types import SimpleNamespace
from typing import Literal
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, Field

from app.framework.fit_judge import judge_fit
from app.harness.approval import site_host
from app.harness.kstyle.workspace import put_body
from app.harness.personal.resume.subject import github_links
from app.harness.policy import Tier
from app.harness.tools import OptionalId, ToolContext, ToolSpec
from app.infrastructure.posting_fit_cache import read_plan
from app.ingest.pdf_text import read_pdf_text
from app.ingest.web_page import (
    GithubRateLimited,
    LeftSite,
    fetch_github_context,
    fetch_github_file,
    fetch_github_tree,
    fetch_page,
    find_urls,
    github_targets,
)

_FINAL_MD = re.compile(r"05_final_\w+\.md")


GITHUB_TRANSPORT = None
_TEXT_LIMIT = 20000
_GITHUB_FILE_CAP = 200_000
_GITHUB_PAGE = 6000
_PAGE_LIMIT = 12000
_GITHUB_HOSTS = {"github.com", "raw.githubusercontent.com"}
_REPO = re.compile(r"^([A-Za-z0-9-]+)/((?!\.{1,2}$)[A-Za-z0-9._-]+)$")


class AttachmentArgs(BaseModel):
    attachment_id: UUID


class UrlArgs(BaseModel):
    url: str


class GithubArgs(BaseModel):
    username: str = ""


class CompanyArgs(BaseModel):
    company: str = Field(description="Company name exactly as the posting states it.")
    focus: Literal["", "product", "tech", "news", "culture", "hiring"] = ""


class PageArgs(BaseModel):
    url: str


class RepoFileArgs(BaseModel):
    repo: str = Field(description="owner/repo")
    path: str = Field(default="", description="File path in the repo. Leave empty to list its files.")
    offset: int = Field(default=0, ge=0, description="First line to read (0-based) when paging a long file.")
    dir: str = Field(default="", description="With an empty path, list only files under this folder.")


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
    text = await read_pdf_text(bytes(attachment["content"]))
    return {"title": attachment["file_name"], "text": text[:_TEXT_LIMIT]}


async def _fetch_url(ctx: ToolContext, args: UrlArgs) -> dict:
    text = (ctx.inputs.get("pages") or {}).get(args.url)
    if text is None:
        return {"error": "NOT_FETCHED"}
    return {"url": args.url, "text": text[:_TEXT_LIMIT]}


async def _github_targets(ctx: ToolContext) -> list[tuple[str, str | None]]:
    rows = await ctx.db.q().fetch(
        "SELECT url FROM user_links WHERE user_id = $1 AND kind = 'github' AND ai_read "
        "AND deleted_at IS NULL",
        UUID(ctx.user_id))
    # Only the user's own GitHub links pick an owner: a model-given name could come from injected
    # page text, and a page the user pasted (a posting on github.com) is not their account.
    supplied = [row["url"] for row in rows] + github_links(ctx.inputs.get("github"))
    return [target for url in supplied for target in github_targets(url)]


async def _explore_github(ctx: ToolContext, args: GithubArgs) -> dict:
    targets = await _github_targets(ctx)
    owners = list(dict.fromkeys(owner for owner, _ in targets))
    if not owners:
        return {"error": "INTEGRATION_REQUIRED"}
    wanted = args.username.lower()
    username = wanted if wanted in owners else owners[0]
    repos = list(dict.fromkeys(repo for owner, repo in targets if owner == username and repo))
    try:
        text = await fetch_github_context(username, transport=GITHUB_TRANSPORT, repos=repos)
    except GithubRateLimited:
        return {"error": "GITHUB_RATE_LIMITED"}
    if not text:
        return {"error": "GITHUB_UNAVAILABLE"}
    return {"username": username, "text": text, "repos": _repo_rows(text)}


# fetch_github_context's list line: "- name | lang | ★stars | pushed 2026-01-02 | description"
_REPO_LINE = re.compile(r"^- (\S+) \| (.+?) \| ★\d+ \| pushed (\S*)(?: \| (.*))?$")


def _repo_rows(text: str) -> list[dict]:
    rows = [_REPO_LINE.match(line) for line in text.splitlines()]
    return [{"name": row[1], "language": "" if row[2] == "-" else row[2], "pushed": row[3],
             "description": row[4] or ""} for row in rows if row]


async def _repo_target(ctx: ToolContext, name: str) -> tuple[str, str] | dict:
    match = _REPO.match(name.strip())
    if match is None:
        return {"error": "INVALID_REPO"}
    owner, repo = match.group(1).lower(), match.group(2)
    if owner not in {target_owner for target_owner, _ in await _github_targets(ctx)}:
        return {"error": "NOT_ALLOWED"}
    return owner, repo


async def _read_github(ctx: ToolContext, args: RepoFileArgs) -> dict:
    target = await _repo_target(ctx, args.repo)
    if isinstance(target, dict):
        return target
    owner, repo = target
    name = f"{owner}/{repo}"
    path, folder = args.path.strip().lstrip("/"), args.dir.strip().strip("/")
    if ".." in path.split("/") or ".." in folder.split("/"):
        return {"error": "INVALID_PATH"}
    try:
        if not path:
            files = await fetch_github_tree(owner, repo, transport=GITHUB_TRANSPORT)
            files = [item for item in files if not folder or item.startswith(folder + "/")]
            return {"repo": name, "files": files} if files else {"error": "GITHUB_UNAVAILABLE"}
        text = await fetch_github_file(
            owner, repo, path, transport=GITHUB_TRANSPORT, limit=_GITHUB_FILE_CAP)
    except GithubRateLimited:
        return {"error": "GITHUB_RATE_LIMITED"}
    if not text:
        return {"error": "NOT_FOUND"}
    lines = text.splitlines()
    start = max(0, args.offset)
    out, size = [], 0
    for line in lines[start:]:
        if size + len(line) > _GITHUB_PAGE and out:
            break
        out.append(line)
        size += len(line) + 1
    return {"repo": name, "path": path, "text": "\n".join(out), "lines": len(lines),
            "from": start + 1, "to": start + len(out)}


_SECOND_LEVEL = {"co", "or", "go", "ac", "ne", "re", "com", "net", "org"}


def _domain(host: str) -> str:
    """shortcut: a two-letter country code under co/or/go/… keeps three labels (example.co.kr);
    a public-suffix list would be exact."""
    labels = host.split(".")
    keep = 3 if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in _SECOND_LEVEL else 2
    return ".".join(labels[-keep:])


def _seen_urls(ctx: ToolContext) -> set[str]:
    # Only URLs the user gave, the posting printed, a company search cited or an opened page
    # linked: a path the model builds itself could carry the user's data out in its query.
    pages = ctx.inputs.get("pages") or {}
    urls = [*pages, *(ctx.inputs.get("links") or []), *github_links(ctx.inputs.get("github")),
            *(ctx.inputs.get("found_links") or []), *(ctx.inputs.get("opened_links") or [])]
    for text in pages.values():
        urls += find_urls(str(text))
    return {str(url) for url in urls}


def _may_open(url: str, host: str, seen: set[str]) -> bool:
    """An exact URL a source printed, or the bare root of a host one did (or its www. twin, which
    site_host folds): a model-built host label, userinfo or port could carry the user's data out."""
    if url in seen:
        return True
    parts = urlsplit(url)
    try:
        port = parts.port
    except ValueError:
        return False
    bare = parts.scheme in ("http", "https") and parts.path in ("", "/") and not parts.query \
        and not parts.fragment and port is None \
        and parts.username is None and parts.password is None
    return bare and host in {site_host(item) for item in seen}


async def _open_page(ctx: ToolContext, args: PageArgs) -> dict:
    url = args.url.strip()
    host = site_host(url)
    if host in _GITHUB_HOSTS:
        return {"error": "USE_READ_GITHUB"}
    if not host or not _may_open(url, host, _seen_urls(ctx)):
        return {"error": "NOT_ALLOWED"}
    try:
        page = await fetch_page(
            url, allow_hop=lambda hop: _domain(site_host(hop)) == _domain(host))
    except LeftSite as left:
        return {"error": "REDIRECTED", "to": left.to}
    text = page.text[:_PAGE_LIMIT]
    opened = ctx.inputs.setdefault("opened_links", [])
    opened += [link for link in find_urls(text) if link not in opened]
    return {"url": page.url, "text": text}


def _squash(text: str) -> str:
    return re.sub(r"\s+", "", text).lower()


def _company_named(ctx: ToolContext, company: str) -> bool:
    # The model may only research a company the posting or the user named, not one a page made up.
    texts = [str(text) for text in (ctx.inputs.get("pages") or {}).values()]
    if ctx.inputs.get("posting"):
        texts.append(json.dumps(ctx.inputs["posting"], ensure_ascii=False, default=str))
    texts.append(str(ctx.inputs.get("message_text") or ""))
    return _squash(company) in _squash("\n".join(texts))


async def _research_company(ctx: ToolContext, args: CompanyArgs) -> dict:
    from app.harness.personal.tools import bound_services

    company = args.company.strip()
    if not company:
        return {"error": "NO_COMPANY"}
    if not _company_named(ctx, company):
        return {"error": "NOT_ALLOWED"}
    svc = bound_services.get()
    gate = getattr(svc, "ai", None) if svc is not None else None
    if gate is None or not hasattr(gate, "company_research"):
        return {"error": "RESEARCH_UNAVAILABLE"}
    posting = "\n\n".join(str(text) for text in (ctx.inputs.get("pages") or {}).values())
    if args.focus:
        posting += f"\n\n조사 초점: {args.focus}"
    try:
        user_id = UUID(ctx.user_id)
    except ValueError:
        user_id = None
    text = await gate.company_research(
        company, context=posting, user_id=user_id, job_id=ctx.usage_job_id or None)
    if not text:
        return {"error": "RESEARCH_UNAVAILABLE"}
    sources = find_urls(text)
    found = ctx.inputs.setdefault("found_links", [])
    found += [url for url in sources if url not in found]
    return {"company": company, "text": text[:_TEXT_LIMIT], "sources": sources}


async def _posting(ctx: ToolContext, args: PostingArgs) -> dict:
    if not args.posting_id:
        return {}
    return await ctx.core.call(
        "GET", f"/api/v1/postings/{args.posting_id}",
        user_id=ctx.user_id, company_id=ctx.company_id,
    )


async def _fit_document(ctx: ToolContext, args: FitArgs) -> str:
    if args.content.strip() or ctx.db is None:
        return args.content
    from app.harness.personal.resume.profile_document import load_document_markdown

    document_id = args.document_id or ctx.inputs.get("documentId")
    if document_id:
        text = await load_document_markdown(
            ctx.db, {"user_id": ctx.user_id, "inputs": {"documentId": str(document_id)}})
        if text:
            return text
    ids = []
    for item in ctx.inputs.get("attachments") or []:
        try:
            ids.append(UUID(str(item)))
        except ValueError:
            continue
    if not ids:
        return ""
    rows = await ctx.db.q().fetch(
        "SELECT source_text FROM career_evidence WHERE id = ANY($1::uuid[]) AND user_id = $2",
        ids, UUID(ctx.user_id))
    return "\n\n".join(row["source_text"] for row in rows if row["source_text"])[:_TEXT_LIMIT]


async def _fit(ctx: ToolContext, args: FitArgs) -> dict:
    # An empty 서류 scores 0 on every dimension, which reads as a real verdict.
    content = await _fit_document(ctx, args)
    if not content.strip():
        return {"error": "NO_DOCUMENT"}
    query = None if ctx.db is None else ctx.db.q()
    user_id = None
    if query is not None:
        try:
            user_id = UUID(ctx.user_id)
        except ValueError:
            user_id = None
    plan = await read_plan(query, user_id)
    from app.harness.personal.tools import current_ai_gate
    return await judge_fit(
        args.requirements, args.keywords, args.description, content, plan,
        gate=current_ai_gate(), job_id=ctx.usage_job_id or None, user_id=user_id)


def _artifact_id(ctx: ToolContext, name: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"push:artifact:{ctx.conversation_id}:{name}"))


_put_body = put_body


async def _put_pdf(ctx: ToolContext, name: str, content: bytes) -> None:
    await ctx.db.q().execute(
        "INSERT INTO workspace_files (conversation_id, name, content, updated_at) "
        "VALUES ($1,$2,$3,now()) "
        "ON CONFLICT (conversation_id, name) DO UPDATE "
        "SET content=EXCLUDED.content, updated_at=now()",
        ctx.conversation_id, name, content,
    )


async def _document_id(ctx: ToolContext, name: str, template: str | None = None) -> str:
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
        template,
    )
    if not synced:
        return ""
    return str(synced[0]["document_id"])


async def save_artifact(
    ctx: ToolContext, name: str, content: str, template: str | None = None,
) -> str:
    file_id = _artifact_id(ctx, name)
    if ctx.db is None:
        return file_id
    body = content.strip() + "\n"
    await _put_body(ctx, name, body)
    if not _FINAL_MD.fullmatch(name):
        return file_id
    from app.infrastructure.resume_workspace import md_to_pdf

    buf = io.BytesIO()
    if template:
        await asyncio.to_thread(md_to_pdf, body, buf, template)
    else:
        await asyncio.to_thread(md_to_pdf, body, buf)
    await _put_pdf(ctx, name[:-3] + ".pdf", buf.getvalue())
    await _document_id(ctx, name, template)
    return file_id


async def _save(ctx: ToolContext, args: ArtifactArgs) -> dict:
    file_id = await save_artifact(ctx, args.name, args.content)
    return {"fileId": file_id, "name": args.name}


RESUME_TOOLS = [
    ToolSpec("parse_attachment", Tier.READ, AttachmentArgs, _parse_attachment, lambda _args: "첨부 파일을 읽어요"),
    ToolSpec("fetch_url", Tier.READ, UrlArgs, _fetch_url, lambda _args: "미리 읽은 페이지만 봐요"),
    ToolSpec("explore_github", Tier.READ, GithubArgs, _explore_github, lambda _args: "GitHub 저장소를 봐요"),
    ToolSpec("read_github", Tier.READ, RepoFileArgs, _read_github, lambda _args: "GitHub 파일을 읽어요"),
    ToolSpec("open_page", Tier.READ, PageArgs, _open_page, lambda _args: "웹 페이지를 읽어요"),
    ToolSpec("research_company", Tier.READ, CompanyArgs, _research_company, lambda _args: "회사 정보를 찾아요"),
    ToolSpec("get_posting", Tier.READ, PostingArgs, _posting, lambda _args: "공고를 봐요"),
    ToolSpec("compute_fit", Tier.READ, FitArgs, _fit, lambda _args: "공고와 얼마나 맞는지 봐요"),
    ToolSpec("save_artifact", Tier.SAFE_WRITE, ArtifactArgs, _save, lambda _args: "산출물을 저장해요"),
    ToolSpec("render_pdf", Tier.SAFE_WRITE, ArtifactArgs, _save, lambda _args: "PDF로 만들어요"),
    ToolSpec("save_to_documents", Tier.SAFE_WRITE, ArtifactArgs, _save, lambda _args: "서류함에 넣어요"),
]
