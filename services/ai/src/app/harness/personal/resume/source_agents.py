"""Stage-one subagents, started together before the main model's first call (k-style "1단계 — 동시에
시작"): one reads the posting, one the user's documents, one researches the company. A fourth checks a
finished draft against what was read. All run on the light model, and each claim keeps its verbatim
quote so code can check it against the source."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

from app.harness.approval import site_host
from app.harness.kstyle.stage import Task, run_stage
from app.harness.kstyle.verify import fact_check
from app.harness.personal.resume.subagent import (
    Corpus,
    Emit,
    SubBudget,
    line,
    run_subagent,
    single_call,
    squash,
)
from app.ingest.web_page import LeftSite, fetch_page, find_urls

_PAGE_LIMIT = 8000
_DOC_LIMIT = 20_000

POSTING_SYSTEM = """너는 채용 공고를 읽는 하위 에이전트다. 공고 본문에서 아래를 뽑아 JSON 하나로 답한다.
{"company": 회사 이름, "title": 직무 이름,
 "required": [{"text": 필수 요건 한 줄, "quote": 그 요건이 적힌 공고 원문 그대로}],
 "preferred": [{"text": 우대 사항 한 줄, "quote": 공고 원문 그대로}],
 "keywords": [핵심 기술·업무 낱말], "summary": 이 직무가 하는 일 두 문장 이내}
공고에 적힌 것만 쓴다. 필수와 우대는 공고가 나눈 대로 나눈다."""

RESUME_SYSTEM = """너는 사용자가 올린 서류(이력서·포트폴리오·자기소개서)를 읽는 하위 에이전트다. JSON 하나로 답한다.
{"name": 이름, "headline": 한 줄 소개,
 "experience": [{"org": 회사, "role": 역할, "period": 기간, "quote": 서류 원문 그대로 한 줄}],
 "projects": [{"name": 프로젝트, "summary": 한 문장, "stack": [기술], "quote": 서류 원문 그대로 한 줄}],
 "links": [서류에 적힌 링크]}
서류에 적힌 것만 쓴다. 지어내거나 고치지 않는다."""

COMPANY_SYSTEM = """너는 지원할 회사를 조사하는 하위 에이전트다.
- 회사 이름은 공고 본문(brief.posting)에서 찾는다.
- search_company로 그 회사의 서비스·기술·소식·문화를 찾는다. 서로 다른 초점은 한 번에 같이 부른다.
- 검색 결과나 공고 본문에 나온 회사 사이트·기술 블로그 주소를 open_page로 한두 개 열어 확인한다.
- 확인한 사실은 finding으로 남긴다. path에는 출처 주소(검색이면 search:초점)를, quote에는 원문을 그대로 옮긴다.
- 다 찾았으면 JSON 하나로 답한다: {"name": 회사 이름, "summary": 세 문장 이내, "sources": [출처 주소]}."""

def _verified_items(items, corpus: Corpus, keep: tuple[str, ...]) -> tuple[list[dict], list[dict]]:
    """Items whose quote is in the source, and the findings they make."""
    kept, findings = [], []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        quote = str(item.get("quote") or "")
        text = corpus.anywhere(quote)
        if not text:
            continue
        kept.append({key: item.get(key) for key in keep if key in item})
        findings.append({"quote": quote, "text": text,
                         "claim": str(item.get("text") or item.get("summary") or item.get("role") or "")})
    return kept, findings


async def posting_agent(model, pages: dict[str, str], emit: Emit) -> dict:
    if not pages:
        return {"findings": []}
    corpus = Corpus({url: str(text) for url, text in pages.items()})
    target = ", ".join(site_host(url) for url in pages)
    emit(line("posting_agent", "run", "공고를 읽어요", target))
    out = await single_call(model, POSTING_SYSTEM, {"pages": {url: str(text)[:_PAGE_LIMIT] for url, text in pages.items()}})
    required, found_required = _verified_items(out.get("required"), corpus, ("text",))
    preferred, found_preferred = _verified_items(out.get("preferred"), corpus, ("text",))
    findings = [{**item, "kind": "posting", "source": next(iter(pages))} for item in found_required + found_preferred]
    jobs = {
        "company": str(out.get("company") or ""),
        "title": str(out.get("title") or ""),
        "required": [str(item["text"]) for item in required if item.get("text")],
        "preferred": [str(item["text"]) for item in preferred if item.get("text")],
        "keywords": [str(item) for item in out.get("keywords") or [] if isinstance(item, str)],
        "summary": str(out.get("summary") or ""),
    }
    emit(line("posting_agent", "ok", "공고를 읽어요", target,
              f"필수 {len(jobs['required'])} · 우대 {len(jobs['preferred'])}"))
    return {"jobs": jobs, "findings": findings}


async def resume_agent(model, documents: list[dict], emit: Emit) -> dict:
    if not documents:
        return {"findings": []}
    corpus = Corpus({f"attachment:{item.get('id')}": str(item.get("text") or "") for item in documents})
    target = ", ".join(str(item.get("title") or "서류") for item in documents)
    emit(line("resume_agent", "run", "서류를 읽어요", target))
    out = await single_call(model, RESUME_SYSTEM, {"documents": [
        {"title": item.get("title"), "text": str(item.get("text") or "")[:_DOC_LIMIT]} for item in documents]})
    experience, found_experience = _verified_items(out.get("experience"), corpus, ("org", "role", "period"))
    projects, found_projects = _verified_items(out.get("projects"), corpus, ("name", "summary", "stack"))
    source = f"attachment:{documents[0].get('id')}"
    findings = [{**item, "kind": "resume", "source": source} for item in found_experience + found_projects]
    parsed = {
        "name": str(out.get("name") or ""),
        "headline": str(out.get("headline") or ""),
        "experience": experience,
        "projects": projects,
        "links": [str(item) for item in out.get("links") or [] if isinstance(item, str)],
    }
    emit(line("resume_agent", "ok", "서류를 읽어요", target, f"경력 {len(experience)} · 프로젝트 {len(projects)}"))
    return {"resume": parsed, "findings": findings}


class SearchArgs(BaseModel):
    company: str
    focus: Literal["product", "tech", "news", "culture", "hiring"] = "product"


class OpenArgs(BaseModel):
    url: str = Field(description="A URL from the posting or from search results.")


async def company_agent(model, search: Callable[[str, str], Awaitable[str]], posting: str, emit: Emit,
                        budget: SubBudget | None = None) -> dict:
    """Searches only for a company the posting names, and opens only URLs the posting or a search showed."""
    if not posting.strip():
        return {"findings": []}
    corpus = Corpus()
    findings: list[dict] = []

    def seen() -> set[str]:
        # Only the posting and search results name pages to open: a page cannot lead to the next one.
        urls = find_urls(posting)
        for key, text in corpus.texts.items():
            if key.startswith("search:"):
                urls += find_urls(text)
        return set(urls)

    async def run_search(args: SearchArgs) -> dict:
        company = squash(args.company).replace(" ", "").lower()
        if len(company) < 2:
            return {"error": "NO_COMPANY"}
        if company not in posting.replace(" ", "").lower():
            return {"error": "NOT_ALLOWED"}
        text = await search(args.company, args.focus)
        if not text:
            return {"error": "RESEARCH_UNAVAILABLE"}
        corpus.texts[f"search:{args.focus}"] = text
        return {"text": text[:_PAGE_LIMIT], "sources": find_urls(text)}

    async def run_open(args: OpenArgs) -> dict:
        url = args.url.strip()
        host = site_host(url)
        if url not in seen() or not host:
            return {"error": "NOT_ALLOWED"}
        try:
            page = await fetch_page(url, allow_hop=lambda hop: site_host(hop) == host)
        except LeftSite as left:
            return {"error": "REDIRECTED", "to": left.to}
        corpus.texts[url] = page.text
        corpus.texts[page.url] = page.text
        return {"url": page.url, "text": page.text[:_PAGE_LIMIT]}

    tools = {
        "search_company": (SearchArgs, run_search, lambda args: f"{args.company} · {args.focus}",
                           lambda result: f"출처 {len(result.get('sources') or [])}개"),
        "open_page": (OpenArgs, run_open,
                      lambda args: (urlsplit(args.url).hostname or "") + urlsplit(args.url).path,
                      lambda result: f"{len(str(result.get('text') or ''))}자 읽음"),
    }
    out = await run_subagent(model, "company_agent", "회사를 조사해요", COMPANY_SYSTEM,
                             {"posting": posting[:_PAGE_LIMIT]}, tools, corpus, budget or SubBudget(), emit,
                             findings)
    sources = [url for url in out.get("sources") or [] if isinstance(url, str) and url in seen()]
    return {
        "company": {"name": str(out.get("name") or ""), "summary": str(out.get("summary") or ""),
                    "sources": list(dict.fromkeys(sources + [item["path"] for item in findings
                                                             if item["path"].startswith("http")]))},
        "findings": [{**item, "kind": "company", "source": item["path"]} for item in findings],
    }


async def fact_check_agent(model, markdown: str, sources: str, emit: Emit) -> list[dict]:
    """Sentences of the draft that claim more than the sources say. It never rewrites anything."""
    return await fact_check(model, markdown, sources, emit, noun="서류")


# Each reader owns one state entry, 01_agent_<name>.json, holding this key of its result.
_PAYLOAD = {"posting": "jobs", "resume": "resume", "company": "company"}


async def stage_one(model, *, pages: dict[str, str], documents: list[dict],
                    search: Callable[[str, str], Awaitable[str]] | None, emit: Emit,
                    save: Callable[[str, dict], Awaitable[None]] | None = None,
                    only: list[str] | None = None) -> dict:
    """The three readers at once, or the ones named in `only`; a late or failed one is left out, not
    waited for. `save(entry, body)` stores each reader's non-empty result that finished in time."""
    posting_text = "\n\n".join(str(text) for text in pages.values())
    tasks = [
        Task("posting", lambda: posting_agent(model, pages, emit)),
        Task("resume", lambda: resume_agent(model, documents, emit)),
        Task("company", lambda: company_agent(model, search, posting_text, emit) if search is not None
             else _empty()),
    ]
    tasks = [task for task in tasks if only is None or task.name in only]

    async def keep(entry: str, out: dict) -> None:
        body = out.get(_PAYLOAD[entry.removeprefix("01_agent_").removesuffix(".json")])
        if body and save is not None:
            await save(entry, body)

    staged = await run_stage(tasks, save=keep)
    out = staged["out"]
    return {
        "posting": out.get("posting", {}).get("jobs") or {},
        "resume": out.get("resume", {}).get("resume") or {},
        "company": out.get("company", {}).get("company") or {},
        "findings": [item for result in out.values() for item in result.get("findings") or []],
        "late": staged["late"],
        "failed": staged["failed"],
    }


async def _empty() -> dict:
    return {"findings": []}
