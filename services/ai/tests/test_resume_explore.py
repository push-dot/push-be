from __future__ import annotations

import asyncio
import json
from uuid import uuid4

from langchain_core.messages import AIMessage
from pydantic import BaseModel

from app.harness.personal.resume import explore
from app.harness.personal.resume.explore import Budget, run_explore
from app.harness.policy import Tier
from app.harness.tools import ToolContext, ToolSpec
from tests.fakes import data_json


class _Model:
    def __init__(self, replies):
        self.replies = list(replies)
        self.seen = []
        self.bound = []

    def bind_tools(self, tools, **kwargs):
        self.bound.append([tool.name for tool in tools])
        return self

    async def ainvoke(self, messages, **kwargs):
        self.seen.append(list(messages))
        reply = self.replies.pop(0) if self.replies else {"content": json.dumps({"message": "끝"})}
        return AIMessage(content=reply.get("content") or "", tool_calls=reply.get("tool_calls") or [])


def _call(name, args, call_id):
    return {"name": name, "args": args, "id": call_id}


class _FileArgs(BaseModel):
    repo: str
    path: str = ""


def _fake_tools(log, delay=0.0):
    async def read(ctx, args):
        log.append(("start", args.path))
        await asyncio.sleep(delay)
        log.append(("end", args.path))
        return {"repo": args.repo, "path": args.path, "text": f"const {args.path} = true", "lines": 1,
                "from": 1, "to": 1}

    return [ToolSpec("read_github", Tier.READ, _FileArgs, read, lambda _args: "GitHub 파일을 읽어요")]


def _ctx():
    return ToolContext(user_id=str(uuid4()), company_id=None, conversation_id=str(uuid4()), job_id="job-1",
                       tool_call_id="", db=None, core=None, inputs={})


def _notes(monkeypatch, start=None):
    store = {"notes": start or {"evidence": [], "assumptions": [], "read": [], "steer": [], "ask": None},
             "saves": 0}

    async def load(ctx):
        return json.loads(json.dumps(store["notes"]))

    async def save(ctx, notes):
        store["notes"] = json.loads(json.dumps(notes))
        store["saves"] += 1

    def add(notes, kind, source, quote, claim, *, text):
        item = {"id": f"E{len(notes['evidence']) + 1}", "kind": kind, "source": source, "quote": quote,
                "claim": claim, "verified": bool(quote) and quote in text}
        notes["evidence"].append(item)
        return item

    monkeypatch.setattr(explore, "load_notes", load)
    monkeypatch.setattr(explore, "save_notes", save)
    monkeypatch.setattr(explore, "add_evidence", add)
    monkeypatch.setattr(explore, "ledger_text", lambda notes, limit=6000: json.dumps(notes["evidence"]))
    events = []
    monkeypatch.setattr(explore, "emit", events.append)
    return store, events


_BUDGET = Budget(rounds=4, tool_calls=8, input_tokens=60_000, repo_agents=2, boost_cycles=0)


async def test_calls_in_one_step_run_together_and_emit_run_then_ok(monkeypatch):
    store, events = _notes(monkeypatch)
    log = []
    model = _Model([
        {"tool_calls": [_call("read_github", {"repo": "acme-labs/shop-api", "path": "a"}, "c1"),
                        _call("read_github", {"repo": "acme-labs/shop-api", "path": "b"}, "c2"),
                        _call("read_github", {"repo": "acme-labs/shop-web", "path": "c"}, "c3")]},
        {"content": json.dumps({"message": "분석했어요", "jobs": {}})},
    ])
    out = await run_explore(model, {"inputs": {}}, _ctx(), budget=_BUDGET, tools=_fake_tools(log, 0.01))
    assert out["message"] == "분석했어요"
    assert [step for step, _ in log[:3]] == ["start", "start", "start"]
    lines = [event for event in events if event.get("type") == "tool"]
    assert [line["state"] for line in lines].count("run") == 3
    assert lines[0]["target"] == "acme-labs/shop-api · a"
    assert any(line.get("resultLine") == "1줄 중 1-1줄" for line in lines)
    assert store["saves"] >= 2


async def test_notes_are_verified_against_what_was_read(monkeypatch):
    store, _events = _notes(monkeypatch)
    model = _Model([
        {"tool_calls": [_call("read_github", {"repo": "acme-labs/shop-api", "path": "a"}, "c1")]},
        {"tool_calls": [
            _call("note", {"kind": "repo", "source": "acme-labs/shop-api:a",
                           "quote": "const a = true", "claim": "a를 씀"}, "n1"),
            _call("note", {"kind": "repo", "source": "acme-labs/shop-api:a", "quote": "지어낸 문장",
                           "claim": "가짜"}, "n2"),
            _call("note", {"kind": "assumption", "claim": "지원 직무는 백엔드"}, "n3"),
        ]},
        {"content": json.dumps({"message": "끝"})},
    ])
    out = await run_explore(model, {"inputs": {}}, _ctx(), budget=_BUDGET, tools=_fake_tools([]))
    evidence = store["notes"]["evidence"]
    assert [item["verified"] for item in evidence] == [True, False]
    assert store["notes"]["assumptions"] == ["지원 직무는 백엔드"]
    assert out["evidence_ids"] == ["E1"]


async def test_old_tool_results_are_elided_after_two_rounds(monkeypatch):
    _notes(monkeypatch)
    model = _Model([
        {"tool_calls": [_call("read_github", {"repo": "o/r", "path": f"f{index}"}, f"c{index}")]}
        for index in range(3)
    ] + [{"content": "{}"}])
    await run_explore(model, {"inputs": {}}, _ctx(), budget=_BUDGET, tools=_fake_tools([]))
    last = model.seen[-1]
    tool_bodies = [message.content for message in last if message.type == "tool"]
    assert tool_bodies[0].startswith("(읽음")
    assert "f2" in tool_bodies[-1]


async def test_budget_warns_at_eighty_percent_then_forces_a_final_answer(monkeypatch):
    _notes(monkeypatch)
    budget = Budget(rounds=5, tool_calls=40, input_tokens=60_000, repo_agents=0, boost_cycles=0)
    model = _Model([
        {"tool_calls": [_call("read_github", {"repo": "o/r", "path": f"f{index}"}, f"c{index}")]}
        for index in range(5)
    ] + [{"content": json.dumps({"message": "끝"})}])
    out = await run_explore(model, {"inputs": {}}, _ctx(), budget=budget, tools=_fake_tools([]))
    assert out["message"] == "끝"
    texts = [getattr(message, "content", "") for message in model.seen[-1]]
    assert explore._WRAP_UP in texts
    assert texts[-1] == explore._FINAL
    assert len(model.seen) == 6


async def test_tool_call_budget_caps_calls_in_a_step(monkeypatch):
    _notes(monkeypatch)
    budget = Budget(rounds=4, tool_calls=2, input_tokens=60_000, repo_agents=0, boost_cycles=0)
    log = []
    model = _Model([
        {"tool_calls": [_call("read_github", {"repo": "o/r", "path": f"f{index}"}, f"c{index}")
                        for index in range(4)]},
    ])
    await run_explore(model, {"inputs": {}}, _ctx(), budget=budget, tools=_fake_tools(log))
    assert len([step for step in log if step[0] == "start"]) == 2
    refused = [data_json(message.content) for message in model.seen[-1] if message.type == "tool"]
    assert refused[-1] == {"error": "도구 호출 한도"}


async def test_restart_keeps_steer_and_skips_targets_already_read(monkeypatch):
    key = 'read_github:{"path": "a", "repo": "o/r"}'
    store, _events = _notes(monkeypatch, {"evidence": [], "assumptions": [], "read": [key],
                                          "steer": [], "ask": None})
    log = []
    model = _Model([
        {"tool_calls": [_call("read_github", {"repo": "o/r", "path": "a"}, "c1")]},
        {"content": "{}"},
    ])
    await run_explore(model, {"inputs": {"steer": ["백엔드 직무로 써 주세요"]}}, _ctx(),
                      budget=_BUDGET, tools=_fake_tools(log))
    assert log == []
    first = data_json(model.seen[0][1].content)
    assert first["notes"]["steer"] == ["백엔드 직무로 써 주세요"]
    assert store["notes"]["steer"] == ["백엔드 직무로 써 주세요"]


async def test_only_one_ask_per_run(monkeypatch):
    store, _events = _notes(monkeypatch)
    model = _Model([
        {"tool_calls": [_call("note", {"kind": "ask", "claim": "어느 직무에 지원하나요?",
                                       "quote": "백엔드|프론트엔드"}, "n1"),
                        _call("note", {"kind": "ask", "claim": "두 번째 질문", "quote": "a|b"}, "n2")]},
        {"content": "{}"},
    ])
    out = await run_explore(model, {"inputs": {}}, _ctx(), budget=_BUDGET, tools=_fake_tools([]))
    assert out["ask"] == {"question": "어느 직무에 지원하나요?", "options": ["백엔드", "프론트엔드"]}
    assert store["notes"]["ask"]["question"] == "어느 직무에 지원하나요?"


async def test_attachments_are_read_before_the_first_call_and_a_slow_one_is_skipped(monkeypatch):
    _notes(monkeypatch)
    monkeypatch.setattr(explore, "_PREFETCH_SECONDS", 0.05)

    async def read(attachment_id):
        if attachment_id == "slow":
            await asyncio.sleep(1)
        return {"title": "이력서", "text": "React 3년"}

    model = _Model([{"content": "{}"}])
    await run_explore(model, {"inputs": {"attachments": ["fast", "slow"]}}, _ctx(), budget=_BUDGET,
                      tools=_fake_tools([]), read_attachment=read)
    first = data_json(model.seen[0][1].content)
    assert first["attachments"] == [
        {"id": "fast", "source": "attachment:fast", "title": "이력서", "text": "React 3년"}]


async def test_github_agents_add_only_verified_findings_and_respect_the_limit(monkeypatch):
    store, events = _notes(monkeypatch)
    asked = []

    async def agent(repo, focus):
        asked.append((repo, focus))
        return {"code": "앱", "stack": ["React"], "history": "기능 개발", "authors": ["me"], "findings": [
            {"source": f"{repo}:a.ts", "quote": "export const real", "claim": "진짜", "text": "export const real = 1"},
            {"source": f"{repo}@abc1234", "quote": "made up", "claim": "가짜", "text": "other"},
        ]}

    model = _Model([
        {"tool_calls": [_call("github_agent", {"repo": "acme-labs/shop-web", "focus": "React"}, "s1"),
                        _call("github_agent", {"repo": "acme-labs/shop-api"}, "s2"),
                        _call("github_agent", {"repo": "acme-labs/fo-web"}, "s3")]},
        {"content": "{}"},
    ])
    await run_explore(model, {"inputs": {}}, _ctx(), budget=_BUDGET, tools=_fake_tools([]), agent=agent)
    verified = [item for item in store["notes"]["evidence"] if item["verified"]]
    assert len(verified) == 2
    assert ("acme-labs/shop-web", "React") in asked
    results = [data_json(message.content) for message in model.seen[-1] if message.type == "tool"]
    assert results[-1] == {"error": "AGENT_LIMIT"}
    assert any(event.get("resultLine") == "근거 1개 찾음" for event in events)


async def test_interim_text_is_capped_and_cannot_add_links(monkeypatch):
    _notes(monkeypatch)
    _store, events = _notes(monkeypatch)
    model = _Model([
        {"content": "가" * 300 + " ![x](https://evil.example/?q=1)",
         "tool_calls": [_call("read_github", {"repo": "o/r", "path": "a"}, "c1")]},
        {"content": "{}"},
    ])
    await run_explore(model, {"inputs": {}}, _ctx(), budget=_BUDGET, tools=_fake_tools([]))
    tokens = [event["token"] for event in events if "token" in event]
    assert len(tokens[0]) <= explore._TOKEN_CAP
    assert "evil.example" not in tokens[0]


async def test_a_model_without_tools_answers_once():
    class _Plain:
        async def ainvoke(self, messages, **kwargs):
            return AIMessage(content=json.dumps({"message": "바로 끝"}))

    model = _Plain()
    out = await run_explore(model, {"inputs": {}}, ToolContext(
        user_id="u", company_id=None, conversation_id="c", job_id="j", tool_call_id="", db=None, core=None),
        budget=_BUDGET, tools=[])
    assert out["message"] == "바로 끝"


async def test_stage_one_runs_once_feeds_the_ledger_and_fills_missing_jobs(monkeypatch):
    store, _events = _notes(monkeypatch)
    runs = []

    async def stage(documents, only):
        runs.append(documents)
        return {"posting": {"company": "예시랩", "required": ["Python"], "preferred": [], "keywords": []},
                "resume": {"name": "김예시"}, "company": {"name": "예시랩", "sources": ["https://example.com"]},
                "findings": [{"kind": "posting", "source": "https://jobs.example/1", "quote": "Python 3년",
                              "claim": "Python 필수", "text": "Python 3년 이상"}], "late": []}

    model = _Model([{"content": json.dumps({"message": "분석"})}])
    out = await run_explore(model, {"inputs": {}}, _ctx(), budget=_BUDGET, tools=_fake_tools([]), stage=stage)
    assert out["jobs"]["required"] == ["Python"]
    assert out["company"]["name"] == "예시랩"
    assert [item["verified"] for item in store["notes"]["evidence"]] == [True]
    first = data_json(model.seen[0][1].content)
    assert first["stage_one"]["resume"] == {"name": "김예시"}
    again = _Model([{"content": json.dumps({"message": "다시"})}])
    await run_explore(again, {"inputs": {}}, _ctx(), budget=_BUDGET, tools=_fake_tools([]), stage=stage)
    assert len(runs) == 1


def test_explore_prompt_sets_no_repository_quota_and_skips_a_second_company_search():
    from app.harness.personal.resume.graph import _IMPROVEMENTS_NOTE

    assert "저장소 2~3개" not in explore.EXPLORE_NOTE
    assert "공고와 맞는 저장소만, 예산 안에서" in explore.EXPLORE_NOTE
    assert "stage_one.company가 비어 있을 때만 research_company" in explore.EXPLORE_NOTE
    assert "저장소 2~3개" not in _IMPROVEMENTS_NOTE
    assert "research_company" not in _IMPROVEMENTS_NOTE


def _research_tool(text):
    class _CompanyArgs(BaseModel):
        company: str
        focus: str = ""

    async def research(ctx, args):
        return {"text": text, "sources": ["https://news.example.com/1"]}

    return ToolSpec("research_company", Tier.READ, _CompanyArgs, research,
                    lambda _args: "회사를 조사해요")


def _note(kind, source, quote, claim, call_id):
    return _call("note", {"kind": kind, "source": source, "quote": quote, "claim": claim}, call_id)


async def test_a_note_is_checked_only_against_the_source_it_names(monkeypatch):
    store, _events = _notes(monkeypatch)
    said = "물류 정산 시스템을 새로 만들었다"
    model = _Model([
        {"tool_calls": [_call("research_company", {"company": "예시물류"}, "c1")]},
        {"tool_calls": [
            _note("repo", "acme-labs/shop-api:src/pay.ts", said, "정산 시스템 설계", "n1"),
            _note("company", "research:예시물류", said, "회사가 정산 시스템을 만듦", "n2"),
        ]},
        {"content": "{}"},
    ])
    research = _research_tool(f"예시물류는 올해 {said}.")
    await run_explore(model, {"inputs": {}}, _ctx(), budget=_BUDGET, tools=[research])
    assert [item["verified"] for item in store["notes"]["evidence"]] == [False, True]


async def test_a_resume_note_may_quote_any_attachment_and_a_late_page_still_verifies(monkeypatch):
    store, _events = _notes(monkeypatch)
    tail = "사내 배포 도구를 직접 만들어 배포 시간을 줄였다"
    text = "가" * 10_000 + tail + "나" * 2_000

    async def read(attachment_id):
        return {"title": "포트폴리오", "text": text}

    model = _Model([
        {"tool_calls": [_note("resume", "attachment:p1", tail, "배포 도구", "n1"),
                        _note("resume", "포트폴리오.pdf", tail, "배포 도구", "n2")]},
        {"content": "{}"},
    ])
    await run_explore(model, {"inputs": {"attachments": ["p1"]}}, _ctx(), budget=_BUDGET, tools=[],
                      read_attachment=read)
    assert [item["verified"] for item in store["notes"]["evidence"]] == [True, True]


async def test_a_failed_attachment_is_shown_and_reaches_the_closing_message(monkeypatch):
    _store, events = _notes(monkeypatch)

    async def read(attachment_id):
        raise RuntimeError("broken pdf")

    out = await run_explore(_Model([{"content": "{}"}]), {"inputs": {"attachments": ["a1"]}},
                            _ctx(), budget=_BUDGET, tools=[], read_attachment=read)
    assert out["stage_failed"] == ["attachment:a1"]
    lines = [event for event in events if event.get("name") == "parse_attachment"]
    assert [line["state"] for line in lines] == ["err"]


async def test_an_ask_without_two_options_is_refused_and_keeps_the_ask_free(monkeypatch):
    store, _events = _notes(monkeypatch)
    ask = {"kind": "ask", "claim": "어느 직무에 지원하나요?", "quote": ""}
    model = _Model([{"tool_calls": [_call("note", ask, "n1")]}, {"content": "{}"}])
    out = await run_explore(model, {"inputs": {}}, _ctx(), budget=_BUDGET, tools=[])
    refused = [data_json(message.content) for message in model.seen[-1] if message.type == "tool"]
    assert refused == [{"error": "ASK_NEEDS_OPTIONS"}]
    assert store["notes"]["ask"] is None
    assert "ask" not in out


def _stage_files(monkeypatch):
    files = {}

    async def load_json(ctx, name):
        return files.get(name, {})

    monkeypatch.setattr(explore, "load_json", load_json)
    return files


async def _explore_with(stage):
    model = _Model([{"content": "{}"}])
    out = await run_explore(model, {"inputs": {}}, _ctx(), budget=_BUDGET, tools=[], stage=stage)
    return model, out


async def test_a_rerun_reads_the_saved_stage_results_instead_of_running_the_stage(monkeypatch):
    _notes(monkeypatch)
    files = _stage_files(monkeypatch)
    runs = []

    async def stage(documents, only):
        runs.append(documents)
        files["01_agent_company.json"] = {"name": "예시물류", "sources": []}
        files["01_agent_posting.json"] = {"company": "예시물류", "required": ["Kotlin"]}
        return {"posting": files["01_agent_posting.json"], "resume": {},
                "company": files["01_agent_company.json"], "findings": [], "late": [], "failed": []}

    await _explore_with(stage)
    again, out = await _explore_with(stage)
    assert len(runs) == 1
    assert data_json(again.seen[0][1].content)["stage_one"]["company"]["name"] == "예시물류"
    assert out["company"]["name"] == "예시물류" and out["jobs"]["required"] == ["Kotlin"]


async def test_a_failed_stage_reader_is_reported_and_read_again_next_run(monkeypatch):
    _notes(monkeypatch)
    _stage_files(monkeypatch)
    runs = []

    async def stage(documents, only):
        runs.append(documents)
        failed = ["posting"] if len(runs) == 1 else []
        return {"posting": {}, "resume": {}, "company": {}, "findings": [], "late": ["company"],
                "failed": failed}

    _model, out = await _explore_with(stage)
    assert out["stage_failed"] == ["posting"] and out["stage_late"] == ["company"]
    await _explore_with(stage)
    await _explore_with(stage)
    assert len(runs) == 2


async def test_retrying_a_failed_reader_reads_only_it_and_adds_each_quote_once(monkeypatch):
    store, _events = _notes(monkeypatch)
    files = _stage_files(monkeypatch)
    asked = []
    finding = {"kind": "posting", "source": "https://jobs.example/1", "quote": "Kotlin 3년",
               "claim": "Kotlin 필수", "text": "Kotlin 3년 이상"}

    async def stage(documents, only):
        asked.append(list(only))
        if len(asked) == 1:
            files["01_agent_posting.json"] = {"company": "예시물류", "required": ["Kotlin"]}
            return {"posting": files["01_agent_posting.json"], "resume": {}, "company": {},
                    "findings": [finding], "late": [], "failed": ["company"]}
        return {"posting": {}, "resume": {}, "company": {"name": "예시물류", "sources": []},
                "findings": [], "late": [], "failed": []}

    await _explore_with(stage)
    again, out = await _explore_with(stage)
    assert asked == [["posting", "resume", "company"], ["company"]]
    assert [item["quote"] for item in store["notes"]["evidence"]] == ["Kotlin 3년"]
    assert out["jobs"]["required"] == ["Kotlin"] and out["company"]["name"] == "예시물류"
    assert data_json(again.seen[0][1].content)["stage_one"]["posting"]["required"] == ["Kotlin"]


async def test_a_teammates_commit_never_becomes_the_users_own_evidence(monkeypatch):
    store, _events = _notes(monkeypatch)

    async def agent(repo, focus):
        return {"findings": [
            {"source": f"{repo}@abc1234", "quote": "add payment retry", "claim": "결제 재시도 구현",
             "text": "add payment retry", "own": False},
            {"source": f"{repo}:a.ts", "quote": "export const real", "claim": "진짜",
             "text": "export const real"},
        ]}

    model = _Model([{"tool_calls": [_call("github_agent", {"repo": "acme-labs/shop-api"}, "s1")]},
                    {"content": "{}"}])
    await run_explore(model, {"inputs": {}}, _ctx(), budget=_BUDGET, tools=[], agent=agent)
    team, own = store["notes"]["evidence"]
    assert team["kind"] == "repo_team" and team["claim"] == "팀원 커밋: 결제 재시도 구현"
    assert own["kind"] == "repo"


async def test_late_or_failed_github_parts_are_reported_and_a_failed_repo_is_read_again(monkeypatch):
    _notes(monkeypatch)
    calls = []

    async def agent(repo, focus):
        calls.append(repo)
        if repo.endswith("shop-api"):
            return {"error": "AGENT_FAILED"}
        return {"findings": [], "late": ["code"]}

    model = _Model([
        {"tool_calls": [_call("github_agent", {"repo": "acme-labs/shop-api"}, "s1"),
                        _call("github_agent", {"repo": "acme-labs/shop-web"}, "s2")]},
        {"tool_calls": [_call("github_agent", {"repo": "acme-labs/shop-api"}, "s3")]},
        {"content": "{}"},
    ])
    budget = Budget(rounds=4, tool_calls=8, input_tokens=60_000, repo_agents=4, boost_cycles=0)
    out = await run_explore(model, {"inputs": {}}, _ctx(), budget=budget, tools=[], agent=agent)
    assert out["stage_failed"] == ["github:acme-labs/shop-api"]
    assert out["stage_late"] == ["github:acme-labs/shop-web"]
    assert calls.count("acme-labs/shop-api") == 2
