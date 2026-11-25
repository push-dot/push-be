"""The GitHub agent, run the k-style way: code collects what needs no judgement first (the file list
and the commit list, at once), then two subagents on the light model read from there at the same
time — one the code, one the commit history — each choosing what to open next and each within its
own time limit. Only findings whose quote is in what they actually read come back."""
from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable

from pydantic import BaseModel, Field

from app.harness.personal.resume.subagent import (
    LIGHT_MODEL,
    Corpus,
    Emit,
    SubBudget,
    Tool,
    light_model,
    run_subagent,
    timed,
)
from app.ingest.web_page import (
    GithubRateLimited,
    fetch_github_commit,
    fetch_github_commits,
    fetch_github_file,
    fetch_github_tree,
)

__all__ = ["LIGHT_MODEL", "SubBudget", "github_agent", "light_model"]

GITHUB_TRANSPORT = None
_SHA = re.compile(r"^[0-9a-fA-F]{7,40}$")
_FILE_CAP = 200_000
_PAGE_CHARS = 6000


CODE_SYSTEM = """너는 GitHub 저장소 하나의 코드를 탐색하는 하위 에이전트다.
목표: 탐색 초점에 맞는 이 저장소의 구조, 기술 스택, 핵심 구현을 찾는다.
- 파일 목록은 brief.files에 이미 있다. 설정 파일(package.json, pyproject.toml 같은)과 핵심 소스 파일을 골라 repo_file로 읽는다. 폴더를 더 봐야 할 때만 repo_tree를 쓴다.
- 서로 상관없는 파일은 한 번에 같이 읽는다. 같은 파일을 두 번 읽지 않는다.
- 확인한 사실은 finding으로 남긴다. quote는 파일 원문을 고치지 않고 그대로 옮긴 한 줄이다.
- 다 찾았으면 JSON 하나로 답한다: {"summary": 세 문장 이내, "stack": [기술 이름]}."""

COMMIT_SYSTEM = """너는 GitHub 저장소 하나의 커밋 내역을 탐색하는 하위 에이전트다.
목표: 탐색 초점과 관련해 누가 어떤 작업을 했는지 찾는다.
- 최근 커밋 목록은 brief.commits에 이미 있다. 사용자 계정 후보가 있으면 그 계정의 커밋을 중심으로 의미 있는 기능 작업을 고른다. 더 오래된 커밋이나 특정 작성자·경로가 필요할 때만 list_commits를 쓴다.
- commit_detail로 바뀐 파일과 변경 내용을 확인한다. 서로 상관없는 커밋은 한 번에 같이 본다.
- 확인한 작업은 finding으로 남긴다. path에는 커밋 sha를, quote에는 커밋 메시지나 변경 내용의 원문 한 줄을 그대로 옮긴다.
- 다 찾았으면 JSON 하나로 답한다: {"summary": 세 문장 이내, "authors": [작성자 계정]}."""


class TreeArgs(BaseModel):
    dir: str = Field(default="", description="Folder to list; empty lists the whole repo.")


class FileArgs(BaseModel):
    path: str
    offset: int = Field(default=0, description="First line to read, 0-based.")


class CommitsArgs(BaseModel):
    author: str = Field(default="", description="GitHub login to filter by; empty lists everyone.")
    path: str = Field(default="", description="Only commits touching this path.")


class CommitArgs(BaseModel):
    sha: str


class _Repo(Corpus):
    """What both subagents read from one repo, kept for paging and for checking quotes."""

    def __init__(self, owner: str, repo: str):
        super().__init__()
        self.owner = owner
        self.repo = repo
        self.tree: list[str] | None = None
        self.commit_list: list[dict] = []
        self.authors: dict[str, str] = {}  # commit key in texts -> author login

    @property
    def name(self) -> str:
        return f"{self.owner}/{self.repo}"

    async def prime(self) -> None:
        """The two lists every run starts from, fetched together before any model call."""
        tree, commits = await asyncio.gather(
            fetch_github_tree(self.owner, self.repo, transport=GITHUB_TRANSPORT),
            fetch_github_commits(self.owner, self.repo, transport=GITHUB_TRANSPORT),
        )
        self.tree = tree
        self.commit_list = commits

    async def list_tree(self, folder: str) -> dict:
        if self.tree is None:
            self.tree = await fetch_github_tree(self.owner, self.repo, transport=GITHUB_TRANSPORT)
        if not self.tree:
            return {"error": "GITHUB_UNAVAILABLE"}
        prefix = folder.strip().strip("/")
        files = [path for path in self.tree if not prefix or path.startswith(prefix + "/")]
        return {"files": files[:300], "total": len(files)}

    async def read(self, path: str, offset: int) -> dict:
        path = path.strip().lstrip("/")
        if not path or ".." in path.split("/"):
            return {"error": "INVALID_PATH"}
        if path not in self.texts:
            text = await fetch_github_file(self.owner, self.repo, path, transport=GITHUB_TRANSPORT,
                                           limit=_FILE_CAP)
            if not text:
                return {"error": "NOT_FOUND"}
            self.texts[path] = text
        lines = self.texts[path].splitlines()
        start = max(0, offset)
        out, size, end = [], 0, start
        for line in lines[start:]:
            if size + len(line) > _PAGE_CHARS and out:
                break
            out.append(line)
            size += len(line) + 1
            end += 1
        return {"path": path, "text": "\n".join(out), "lines": len(lines), "from": start + 1, "to": end}

    async def commits(self, author: str, path: str) -> dict:
        rows = await fetch_github_commits(self.owner, self.repo, author=author.strip(), path=path.strip(),
                                          transport=GITHUB_TRANSPORT)
        return {"commits": rows}

    async def commit(self, sha: str) -> dict:
        if not _SHA.match(sha.strip()):
            return {"error": "INVALID_SHA"}
        detail = await fetch_github_commit(self.owner, self.repo, sha.strip(), transport=GITHUB_TRANSPORT)
        if not detail:
            return {"error": "NOT_FOUND"}
        body = detail["message"] + "\n" + "\n".join(item["patch"] for item in detail["files"])
        for key in (sha.strip(), detail["sha"]):
            self.texts[key] = body
            self.authors[key] = detail["author"]
        return detail


async def _limited(run: Awaitable[dict]) -> dict:
    try:
        return await run
    except GithubRateLimited:
        return {"error": "GITHUB_RATE_LIMITED"}


_SUMMARY = {"github_code": "저장소 코드를 살펴봐요", "github_commits": "커밋 내역을 살펴봐요"}


def _code_tools(repo: _Repo) -> dict[str, Tool]:
    return {
        "repo_tree": (TreeArgs, lambda args: _limited(repo.list_tree(args.dir)),
                      lambda args: f"{repo.name} · {args.dir or '파일 목록'}",
                      lambda result: f"파일 {result.get('total', 0)}개"),
        "repo_file": (FileArgs, lambda args: _limited(repo.read(args.path, args.offset)),
                      lambda args: f"{repo.name} · {args.path}",
                      lambda result: f"{result.get('lines', 0)}줄 중 {result.get('from', 1)}-{result.get('to', 0)}줄"),
    }


def _commit_tools(repo: _Repo) -> dict[str, Tool]:
    return {
        "list_commits": (CommitsArgs, lambda args: _limited(repo.commits(args.author, args.path)),
                         lambda args: f"{repo.name} · 커밋 목록" + (f" ({args.author})" if args.author else ""),
                         lambda result: f"커밋 {len(result.get('commits') or [])}개"),
        "commit_detail": (CommitArgs, lambda args: _limited(repo.commit(args.sha)),
                          lambda args: f"{repo.name} · 커밋 {args.sha[:7]}",
                          lambda result: f"파일 {len(result.get('files') or [])}개 변경"),
    }


async def github_agent(model, owner: str, repo: str, *, focus: str, logins: list[str],
                       emit: Emit, budget: SubBudget | None = None) -> dict:
    """Code and commit history explored at once; findings are verified against what was read.
    A commit finding says whether its author is in `logins`: a teammate's work is not the user's.
    With no login known, nobody can be told apart from the user: every commit counts as theirs."""
    shared = _Repo(owner, repo)
    budget = budget or SubBudget()
    try:
        await shared.prime()
    except GithubRateLimited:
        return {"error": "GITHUB_RATE_LIMITED"}
    if not shared.tree and not shared.commit_list:
        return {"error": "GITHUB_UNAVAILABLE"}
    base = {"repo": shared.name, "focus": focus, "user_logins": logins}
    code_brief = {**base, "files": (shared.tree or [])[:300]}
    commit_brief = {**base, "commits": shared.commit_list}
    code_found: list[dict] = []
    commit_found: list[dict] = []
    code, history = await asyncio.gather(
        timed(run_subagent(model, "github_code", _SUMMARY["github_code"], CODE_SYSTEM, code_brief,
                           _code_tools(shared), shared, budget, emit, code_found), code_found),
        timed(run_subagent(model, "github_commits", _SUMMARY["github_commits"], COMMIT_SYSTEM, commit_brief,
                           _commit_tools(shared), shared, budget, emit, commit_found), commit_found),
    )
    parts = (("code", code), ("history", history))
    failed = [part for part, out in parts if out.get("failed")]
    if len(failed) == len(parts):
        return {"error": "AGENT_FAILED"}
    own = {login.lower() for login in logins}
    findings = []
    for item in [*code["findings"], *history["findings"]]:
        author = shared.authors.get(item["path"])
        if author is None:  # a file of the repo the user linked
            findings.append({**item, "source": f"{shared.name}:{item['path']}", "own": True})
        else:
            findings.append({**item, "source": f"{shared.name}@{item['path']}", "author": author,
                             "own": not own or author.lower() in own})
    return {
        "repo": shared.name,
        "code": str(code.get("summary") or ""),
        "stack": [str(item) for item in code.get("stack") or [] if isinstance(item, str)],
        "history": str(history.get("summary") or ""),
        "authors": [str(item) for item in history.get("authors") or [] if isinstance(item, str)],
        "findings": findings,
        "late": [part for part, out in parts if out.get("late")],
        "failed": failed,
    }

