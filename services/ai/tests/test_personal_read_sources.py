"""read_sources: pages and documents opened at once, one light reader per source, quotes checked by code."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

import app.harness.personal.tools as tools
from app.harness.policy import Exposure
from app.harness.tools import ToolContext
from tests.kstyle_fakes import RoleModel

USER = "99999999-9999-4999-8999-999999999999"
CONV = "77777777-7777-4777-8777-777777777777"
PAGE_A = "https://example.com/a"
PAGE_B = "https://example.org/b"
TEXT = {PAGE_A: "회사 A는 물류 플랫폼을 만든다.\n본사는 판교에 있다.",
        PAGE_B: "회사 B는 결제 서비스를 운영한다."}


class _DB:
    def __init__(self):
        self.files = {}
        self.sql = []

    def q(self):
        return self

    async def execute(self, sql, *args):
        self.sql.append(sql)
        if "workspace_files" in sql:
            self.files[args[1]] = args[2]

    async def fetchrow(self, sql, *args):
        return None


def _ctx(db, exposure=Exposure.NONE):
    return ToolContext(user_id=USER, company_id=None, conversation_id=CONV, job_id="job-1",
                       tool_call_id="call-1", db=db, core=None, exposure=exposure)


@pytest.fixture
def web(monkeypatch):
    supplied = {PAGE_A, PAGE_B}
    granted: set[str] = set()

    async def user_supplied(db, conv, user, url):
        return url in supplied

    async def site_granted(db, conv, url):
        return url in granted

    async def fetch_page(url, allow_hop=None):
        return SimpleNamespace(url=url, text=TEXT[url])

    monkeypatch.setattr(tools, "user_supplied", user_supplied)
    monkeypatch.setattr(tools, "site_granted", site_granted)
    monkeypatch.setattr(tools, "fetch_page", fetch_page)
    return SimpleNamespace(supplied=supplied, granted=granted)


def _light(monkeypatch, script):
    model = RoleModel(script, "light")
    monkeypatch.setattr(tools, "light_model", lambda _chat: model)
    return model


async def _run(db, args, exposure=Exposure.NONE):
    return await tools._read_sources(_ctx(db, exposure), tools.SourcesArgs.model_validate(args))


async def test_a_url_the_user_did_not_give_goes_back_to_read_page(web, monkeypatch):
    model = _light(monkeypatch, {})
    web.supplied.clear()
    out = await _run(_DB(), {"question": "어떤 회사예요?", "urls": [PAGE_A]})
    assert out["unread"] == [{"url": PAGE_A, "error": "NEEDS_READ_PAGE"}]
    assert out["findings"] == [] and model.calls == []


async def test_a_granted_host_waits_for_read_page_after_untrusted_text(web, monkeypatch):
    _light(monkeypatch, {"자료 하나만": {"findings": []}})
    web.supplied.clear()
    web.granted.add(PAGE_A)
    out = await _run(_DB(), {"question": "q", "urls": [PAGE_A]}, Exposure.RUN)
    assert out["unread"] == [{"url": PAGE_A, "error": "NEEDS_READ_PAGE"}]
    out = await _run(_DB(), {"question": "q", "urls": [PAGE_A]})
    assert out["unread"] == []


async def test_a_granted_host_is_read_after_untrusted_text_earlier_in_the_thread(web, monkeypatch):
    found = {"findings": [{"quote": "본사는 판교에 있다.", "claim": "판교"}]}
    _light(monkeypatch, {"자료 하나만": found})
    web.supplied.clear()
    web.granted.update({PAGE_A, PAGE_A + "?id=1"})
    db = _DB()
    out = await _run(db, {"question": "q", "urls": [PAGE_A, PAGE_A + "?id=1"]}, Exposure.THREAD)
    assert [f["source"] for f in out["findings"]] == [PAGE_A]
    # A query string could carry the user's data out, so that address still asks through read_page.
    assert out["unread"] == [{"url": PAGE_A + "?id=1", "error": "NEEDS_READ_PAGE"}]
    assert not any("approval" in sql for sql in db.sql)


async def test_only_findings_whose_quote_is_in_their_source_are_kept(web, monkeypatch):
    def reply(messages):
        brief = messages[-1].content
        if PAGE_A in brief:
            return {"findings": [
                {"quote": "본사는  판교에 있다.", "claim": "본사는 판교다."},
                {"quote": "직원은 500명이다.", "claim": "직원 수"},
                {"quote": "회사 B는 결제 서비스를 운영한다.", "claim": "다른 자료의 문장"},
            ]}
        return {"findings": [{"quote": "회사 B는 결제 서비스를 운영한다.", "claim": "결제 서비스"}]}

    model = _light(monkeypatch, {"자료 하나만": reply})
    db = _DB()
    out = await _run(db, {"question": "두 회사 비교", "urls": [PAGE_A, PAGE_B]})
    assert [(f["source"], f["claim"]) for f in out["findings"]] == [
        (PAGE_A, "본사는 판교다."), (PAGE_B, "결제 서비스")]
    assert [f["id"] for f in out["findings"]] == ["E1", "E2"]
    assert out["late"] == [] and out["unread"] == []
    assert model.calls == [("자료 하나만", "light")] * 2
    assert "text" not in json.dumps(out["findings"])
    # Ids are per call and nothing is stored, so two calls in one batch cannot overwrite each other.
    again = await _run(db, {"question": "두 회사 비교", "urls": [PAGE_A, PAGE_B]})
    assert [f["id"] for f in again["findings"]] == ["E1", "E2"]
    assert db.files == {}


async def test_a_reader_reply_without_a_findings_list_drops_only_that_source(web, monkeypatch):
    def reply(messages):
        if PAGE_A in messages[-1].content:
            return {"findings": 5}
        return {"findings": [{"quote": "회사 B는 결제 서비스를 운영한다.", "claim": "결제 서비스"}]}

    model = _light(monkeypatch, {"자료 하나만": reply})
    out = await _run(_DB(), {"question": "q", "urls": [PAGE_A, PAGE_B]})
    assert [f["source"] for f in out["findings"]] == [PAGE_B]
    assert len(model.calls) == 2


async def test_a_page_with_no_text_is_listed_as_unread(web, monkeypatch):
    model = _light(monkeypatch, {})
    monkeypatch.setitem(TEXT, PAGE_A, "  \n ")
    out = await _run(_DB(), {"question": "q", "urls": [PAGE_A]})
    assert out == {"findings": [], "late": [], "unread": [{"source": PAGE_A, "error": "EMPTY"}]}
    assert model.calls == []


async def test_documents_are_read_with_pages(web, monkeypatch):
    doc = uuid4()

    class Docs:
        async def get(self, user_id, doc_id):
            return SimpleNamespace(latest_version_id=uuid4())

        async def get_version(self, user_id, doc_id, version_id):
            return SimpleNamespace(blocks=[SimpleNamespace(text="경력 요약\n물류 시스템 개발")])

    _light(monkeypatch, {"자료 하나만": {"findings": [{"quote": "물류 시스템 개발", "claim": "물류 개발"}]}})
    token = tools.bound_services.set(SimpleNamespace(document_svc=Docs()))
    try:
        out = await _run(_DB(), {"question": "q", "document_ids": [str(doc)]})
    finally:
        tools.bound_services.reset(token)
    assert out["findings"][0]["source"] == f"document:{doc}"


async def test_without_a_light_model_the_raw_texts_come_back(web):
    out = await _run(_DB(), {"question": "q", "urls": [PAGE_A, PAGE_B]})
    assert out == {"sources": [{"source": PAGE_A, "text": TEXT[PAGE_A]},
                               {"source": PAGE_B, "text": TEXT[PAGE_B]}], "unread": []}


async def test_a_late_source_is_listed_and_not_waited_for(web, monkeypatch):
    async def reply(messages):
        if PAGE_B in messages[-1].content:
            await asyncio.sleep(5)
        return {"findings": [{"quote": "본사는 판교에 있다.", "claim": "판교"}]}

    _light(monkeypatch, {"자료 하나만": reply})
    monkeypatch.setattr(tools, "_READ_SECONDS", 0.05)
    out = await _run(_DB(), {"question": "q", "urls": [PAGE_A, PAGE_B]})
    assert out["late"] == [PAGE_B]
    assert [f["source"] for f in out["findings"]] == [PAGE_A]


def test_read_sources_takes_at_most_four_of_each():
    from pydantic import ValidationError

    tools.SourcesArgs.model_validate(
        {"question": "q", "urls": [PAGE_A] * 4, "document_ids": [str(uuid4())] * 4})
    with pytest.raises(ValidationError):
        tools.SourcesArgs.model_validate({"question": "q", "urls": [PAGE_A] * 5})
