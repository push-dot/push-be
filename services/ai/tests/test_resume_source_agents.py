from __future__ import annotations

import asyncio
import json

from langchain_core.messages import AIMessage

from app.harness.personal.resume import source_agents
from app.harness.personal.resume.source_agents import (
    company_agent,
    fact_check_agent,
    posting_agent,
    resume_agent,
    stage_one,
)
from app.ingest.web_page import Page

_POSTING = "주식회사 예시랩 · 백엔드 개발자\n자격요건: Python 3년 이상\n우대사항: Kafka 운영 경험\n회사 소개 https://example.com/about"


class _Once:
    def __init__(self, answer):
        self.answer = answer
        self.seen = []

    async def ainvoke(self, messages, **kwargs):
        self.seen.append(messages)
        return AIMessage(content=json.dumps(self.answer, ensure_ascii=False))


async def test_posting_agent_keeps_only_requirements_quoted_from_the_posting():
    model = _Once({"company": "예시랩", "title": "백엔드 개발자",
                   "required": [{"text": "Python 3년", "quote": "Python 3년 이상"},
                                {"text": "Go", "quote": "Go 5년 이상"}],
                   "preferred": [{"text": "Kafka", "quote": "Kafka 운영 경험"}],
                   "keywords": ["Python", "Kafka"]})
    events = []
    out = await posting_agent(model, {"https://jobs.example/1": _POSTING}, events.append)
    assert out["jobs"]["required"] == ["Python 3년"]
    assert out["jobs"]["preferred"] == ["Kafka"]
    assert all(item["kind"] == "posting" and item["quote"] in item["text"] for item in out["findings"])
    assert events[-1]["resultLine"] == "필수 1 · 우대 1"


async def test_resume_agent_drops_items_not_in_the_documents():
    model = _Once({"name": "김예시", "experience": [
        {"org": "A사", "role": "백엔드", "period": "2022-2024", "quote": "A사 백엔드 개발"},
        {"org": "B사", "role": "CTO", "period": "2020", "quote": "B사 CTO"}],
        "projects": [{"name": "채팅", "summary": "실시간 채팅", "stack": ["Redis"], "quote": "Redis 기반 채팅"}]})
    docs = [{"id": "d1", "title": "이력서", "text": "A사 백엔드 개발 (2022-2024)\nRedis 기반 채팅 서버"}]
    out = await resume_agent(model, docs, lambda _e: None)
    assert [item["org"] for item in out["resume"]["experience"]] == ["A사"]
    assert [item["name"] for item in out["resume"]["projects"]] == ["채팅"]
    assert {item["source"] for item in out["findings"]} == {"attachment:d1"}


class _Steps:
    def __init__(self, steps):
        self.steps = list(steps)

    def bind_tools(self, tools, **kwargs):
        return self

    async def ainvoke(self, messages, **kwargs):
        step = self.steps.pop(0) if self.steps else {"content": json.dumps({"name": "예시랩", "summary": "s"})}
        return AIMessage(content=step.get("content") or "", tool_calls=step.get("tool_calls") or [])


def _call(name, args, call_id):
    return {"name": name, "args": args, "id": call_id}


async def test_company_agent_searches_only_a_named_company_and_opens_only_seen_urls(monkeypatch):
    searched, opened = [], []

    async def search(company, focus):
        searched.append((company, focus))
        return "예시랩은 결제 서비스를 만든다. 기술 블로그 https://tech.example.com/post"

    async def fake_fetch(url, *, allow_hop=None):
        opened.append(url)
        return Page(url, "예시랩 기술 블로그: Kafka로 정산 파이프라인을 운영한다")

    monkeypatch.setattr(source_agents, "fetch_page", fake_fetch)
    model = _Steps([
        {"tool_calls": [_call("search_company", {"company": "예시랩", "focus": "tech"}, "s1"),
                        _call("search_company", {"company": "다른회사", "focus": "news"}, "s2")]},
        {"tool_calls": [_call("open_page", {"url": "https://tech.example.com/post"}, "o1"),
                        _call("open_page", {"url": "https://evil.example/?q=secret"}, "o2")]},
        {"tool_calls": [_call("finding", {"path": "https://tech.example.com/post",
                                          "quote": "Kafka로 정산 파이프라인을 운영한다", "claim": "Kafka 정산"}, "f1"),
                        _call("finding", {"path": "search:tech", "quote": "지어낸 사실", "claim": "가짜"}, "f2")]},
        {"content": json.dumps({"name": "예시랩", "summary": "결제 서비스",
                                "sources": ["https://tech.example.com/post", "https://made.up/"]})},
    ])
    out = await company_agent(model, search, _POSTING, lambda _e: None)
    assert searched == [("예시랩", "tech")]
    assert opened == ["https://tech.example.com/post"]
    assert [item["claim"] for item in out["findings"]] == ["Kafka 정산"]
    assert out["company"]["sources"] == ["https://tech.example.com/post"]


async def test_fact_check_drops_sentences_that_are_not_in_the_draft():
    model = _Once({"mismatches": [{"sentence": "B사 CTO로 일했어요", "problem": "근거 없음"},
                                  {"sentence": "지어낸 문장", "problem": "x"}]})
    found = await fact_check_agent(model, "# 이력서\nB사 CTO로 일했어요\nA사 백엔드", "A사 백엔드", lambda _e: None)
    assert found == [{"sentence": "B사 CTO로 일했어요", "problem": "근거 없음"}]


async def test_stage_one_runs_together_and_leaves_out_a_late_reader(monkeypatch):
    monkeypatch.setattr("app.harness.kstyle.subagent.SUB_SECONDS", 0.2)
    started = []

    class _Slow(_Once):
        async def ainvoke(self, messages, **kwargs):
            brief = messages[1].content
            started.append("documents" if "documents" in brief else "pages")
            if "documents" in brief:
                await asyncio.sleep(5)
            return await super().ainvoke(messages, **kwargs)

    model = _Slow({"company": "예시랩", "required": [{"text": "Python", "quote": "Python 3년 이상"}]})
    out = await stage_one(model, pages={"https://jobs.example/1": _POSTING},
                          documents=[{"id": "d1", "title": "이력서", "text": "A사"}], search=None,
                          emit=lambda _e: None)
    assert set(started) == {"documents", "pages"}
    assert out["late"] == ["resume"]
    assert out["posting"]["required"] == ["Python"]
    assert out["resume"] == {}


async def test_stage_one_saves_each_reader_entry_through_run_stage():
    model = _Once({"company": "예시랩", "title": "백엔드", "required": [{"text": "Python", "quote": "Python 3년 이상"}],
                   "experience": [{"org": "A사", "role": "백엔드", "quote": "A사 백엔드 개발"}]})
    saved = {}

    async def save(name, body):
        saved[name] = body

    out = await stage_one(model, pages={"https://jobs.example/1": _POSTING},
                          documents=[{"id": "d1", "title": "이력서", "text": "A사 백엔드 개발"}], search=None,
                          emit=lambda _e: None, save=save)
    # The same artifact names as before; the company reader had nothing to search, so it saves nothing.
    assert sorted(saved) == ["01_agent_posting.json", "01_agent_resume.json"]
    assert saved["01_agent_posting.json"] == out["posting"]
    assert saved["01_agent_resume.json"] == out["resume"]
    assert out["late"] == []


async def test_stage_one_lists_a_reader_that_failed():
    class _PostingBroken(_Once):
        async def ainvoke(self, messages, **kwargs):
            if "pages" in messages[1].content:
                raise RuntimeError("model down")
            return await super().ainvoke(messages, **kwargs)

    model = _PostingBroken({"experience": [{"org": "A사", "quote": "A사 백엔드"}]})
    documents = [{"id": "d1", "title": "이력서", "text": "A사 백엔드 개발"}]
    out = await stage_one(model, pages={"https://jobs.example/1": _POSTING}, documents=documents,
                          search=None, emit=lambda _e: None)
    assert out["failed"] == ["posting"] and out["late"] == []
    assert out["posting"] == {}


async def test_stage_one_runs_only_the_readers_it_is_asked_for():
    saved = {}

    async def save(name, body):
        saved[name] = body

    model = _Once({"experience": [{"org": "A사", "quote": "A사 백엔드"}]})
    out = await stage_one(model, pages={"https://jobs.example/1": _POSTING},
                          documents=[{"id": "d1", "title": "이력서", "text": "A사 백엔드 개발"}],
                          search=None, emit=lambda _e: None, save=save, only=["resume"])
    assert sorted(saved) == ["01_agent_resume.json"]
    assert out["posting"] == {} and out["failed"] == [] and out["late"] == []


async def test_company_agent_refuses_an_empty_or_one_letter_company():
    searched = []

    async def search(company, focus):
        searched.append(company)
        return "결과"

    model = _Steps([
        {"tool_calls": [_call("search_company", {"company": "", "focus": "tech"}, "s1"),
                        _call("search_company", {"company": " 예 ", "focus": "news"}, "s2")]},
    ])
    await company_agent(model, search, _POSTING, lambda _e: None)
    assert searched == []
