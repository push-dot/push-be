from __future__ import annotations

import asyncio
import contextlib
import json

import httpx
from langchain_core.messages import AIMessage

from app.harness.personal.resume import github_agent as agent_module
from app.harness.personal.resume.github_agent import CODE_SYSTEM, SubBudget, github_agent

_TREE = {"tree": [
    {"path": "package.json", "type": "blob"},
    {"path": "src/app.ts", "type": "blob"},
    {"path": "node_modules/x.js", "type": "blob"},
    {"path": "src", "type": "tree"},
]}
_FILES = {"package.json": '{\n  "name": "shop-app",\n  "dependencies": {"react": "19"}\n}',
          "src/app.ts": "export const stream = openStream()\nexport const retry = 3"}
_COMMITS = [
    {"sha": "abc1234def", "author": {"login": "me"},
     "commit": {"message": "feat: add SSE stream retry\n\nbody", "author": {"date": "2026-11-01T00:00:00Z"}}},
    {"sha": "fff0000aaa", "author": {"login": "other-dev"},
     "commit": {"message": "chore: bump", "author": {"date": "2026-10-01T00:00:00Z"}}},
]
_DETAIL = {"sha": "abc1234def", "author": {"login": "me"},
           "commit": {"message": "feat: add SSE stream retry", "author": {"date": "2026-11-01T00:00:00Z"}},
           "files": [{"filename": "src/app.ts", "additions": 3, "deletions": 1,
                      "patch": "+export const retry = 3"}]}
_OTHER_DETAIL = {"sha": "fff0000aaa", "author": {"login": "Other-Dev"},
                 "commit": {"message": "feat: add payment webhook",
                            "author": {"date": "2026-10-01T00:00:00Z"}},
                 "files": []}


def _github(seen):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        path = request.url.path
        if request.url.host == "raw.githubusercontent.com":
            name = path.split("/HEAD/", 1)[1]
            return httpx.Response(200, text=_FILES[name]) if name in _FILES else httpx.Response(404)
        if path.endswith("/git/trees/HEAD"):
            return httpx.Response(200, json=_TREE)
        if path.endswith("/commits"):
            return httpx.Response(200, json=_COMMITS)
        if "/commits/fff" in path:
            return httpx.Response(200, json=_OTHER_DETAIL)
        if "/commits/" in path:
            return httpx.Response(200, json=_DETAIL)
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def _call(name, args, call_id):
    return {"name": name, "args": args, "id": call_id}


class _Model:
    """Plays both subagents: the system prompt says which one is asking."""

    def __init__(self, code_steps, commit_steps):
        self.steps = {"code": list(code_steps), "commit": list(commit_steps)}
        self.started = []

    def bind_tools(self, tools, **kwargs):
        return self

    async def ainvoke(self, messages, **kwargs):
        who = "code" if messages[0].content.startswith(CODE_SYSTEM[:20]) else "commit"
        self.started.append(who)
        await asyncio.sleep(0)
        step = self.steps[who].pop(0) if self.steps[who] else {"content": json.dumps({"summary": f"{who} 끝"})}
        return AIMessage(content=step.get("content") or "", tool_calls=step.get("tool_calls") or [])


async def test_code_and_commit_subagents_run_together_and_return_verified_findings(monkeypatch):
    seen = []
    monkeypatch.setattr(agent_module, "GITHUB_TRANSPORT", _github(seen))
    model = _Model(
        code_steps=[
            {"tool_calls": [_call("repo_tree", {}, "t1")]},
            {"tool_calls": [_call("repo_file", {"path": "package.json"}, "f1"),
                            _call("repo_file", {"path": "src/app.ts"}, "f2")]},
            {"tool_calls": [_call("finding", {"path": "src/app.ts", "quote": "export const retry = 3",
                                              "claim": "재시도 로직 구현"}, "n1"),
                            _call("finding", {"path": "src/app.ts", "quote": "지어낸 코드", "claim": "가짜"}, "n2")]},
            {"content": json.dumps({"summary": "React 앱", "stack": ["React"]})},
        ],
        commit_steps=[
            {"tool_calls": [_call("list_commits", {"author": "me"}, "c1")]},
            {"tool_calls": [_call("commit_detail", {"sha": "abc1234def"}, "c2")]},
            {"tool_calls": [_call("finding", {"path": "abc1234def", "quote": "feat: add SSE stream retry",
                                              "claim": "SSE 재시도 기능 개발"}, "n3")]},
            {"content": json.dumps({"summary": "스트림 작업", "authors": ["me"]})},
        ],
    )
    events = []
    out = await github_agent(model, "acme-labs", "shop-web", focus="React, SSE", logins=["me"],
                             emit=events.append)
    assert model.started[:2] in (["code", "commit"], ["commit", "code"])
    assert out["code"] == "React 앱" and out["stack"] == ["React"]
    assert out["history"] == "스트림 작업" and out["authors"] == ["me"]
    assert [(item["source"], item["claim"]) for item in out["findings"]] == [
        ("acme-labs/shop-web:src/app.ts", "재시도 로직 구현"),
        ("acme-labs/shop-web@abc1234def", "SSE 재시도 기능 개발"),
    ]
    owners = [(item["own"], item.get("author")) for item in out["findings"]]
    assert owners == [(True, None), (True, "me")]
    assert all(item["quote"] in item["text"] for item in out["findings"])
    names = {event["name"] for event in events}
    assert names == {"github_code", "github_commits"}
    assert any(event.get("target") == "acme-labs/shop-web · src/app.ts" for event in events)
    assert any(event.get("resultLine") == "커밋 2개" for event in events)
    assert not any("node_modules" in url for url in seen)
    assert any("author=me" in url for url in seen)


async def test_bad_paths_and_shas_never_reach_github(monkeypatch):
    seen = []
    monkeypatch.setattr(agent_module, "GITHUB_TRANSPORT", _github(seen))
    model = _Model(
        code_steps=[{"tool_calls": [_call("repo_file", {"path": "../secret"}, "f1")]}],
        commit_steps=[{"tool_calls": [_call("commit_detail", {"sha": "../../x"}, "c1")]}],
    )
    out = await github_agent(model, "o", "r", focus="", logins=[], emit=lambda _e: None)
    # Only the two lists fetched up front; the bad path and sha never become requests.
    assert len(seen) == 2
    assert not any("secret" in url or "/commits/" in url or "raw.githubusercontent" in url for url in seen)
    assert out["findings"] == []


async def test_each_subagent_stops_at_its_budget(monkeypatch):
    seen = []
    monkeypatch.setattr(agent_module, "GITHUB_TRANSPORT", _github(seen))
    loop = [{"tool_calls": [_call("repo_tree", {"dir": str(index)}, f"t{index}")]} for index in range(10)]
    model = _Model(code_steps=loop, commit_steps=[])
    await github_agent(model, "o", "r", focus="", logins=[], emit=lambda _e: None,
                       budget=SubBudget(rounds=2, tool_calls=8))
    assert model.started.count("code") == 3
    assert sum("/git/trees/" in url for url in seen) == 1


async def test_a_long_file_is_paged_by_lines(monkeypatch):
    long = "\n".join("x" * 100 for _ in range(200))

    async def fetch(owner, repo, path, transport=None, *, limit=0):
        return long

    monkeypatch.setattr(agent_module, "fetch_github_file", fetch)
    repo = agent_module._Repo("o", "r")
    first = await repo.read("big.txt", 0)
    second = await repo.read("big.txt", first["to"])
    assert first["from"] == 1 and first["to"] < 200 and first["lines"] == 200
    assert second["from"] == first["to"] + 1


async def test_lists_are_fetched_before_the_subagents_and_given_to_them(monkeypatch):
    seen = []
    monkeypatch.setattr(agent_module, "GITHUB_TRANSPORT", _github(seen))
    briefs = []

    class _Recorder(_Model):
        async def ainvoke(self, messages, **kwargs):
            from tests.fakes import data_json
            briefs.append(data_json(messages[1].content))
            return AIMessage(content=json.dumps({"summary": "끝"}))

    await github_agent(_Recorder([], []), "o", "r", focus="", logins=["me"], emit=lambda _e: None)
    code = next(brief for brief in briefs if "files" in brief)
    history = next(brief for brief in briefs if "commits" in brief)
    assert code["files"] == ["package.json", "src/app.ts"]
    assert [row["sha"] for row in history["commits"]] == ["abc1234def", "fff0000aaa"]
    assert sum("/git/trees/" in url for url in seen) == 1
    assert sum(url.split("?")[0].endswith("/commits") for url in seen) == 1


async def test_a_late_subagent_is_not_waited_for_and_keeps_what_it_verified(monkeypatch):
    seen = []
    monkeypatch.setattr(agent_module, "GITHUB_TRANSPORT", _github(seen))
    monkeypatch.setattr("app.harness.kstyle.subagent.SUB_SECONDS", 0.2)

    class _Slow(_Model):
        async def ainvoke(self, messages, **kwargs):
            who = "code" if messages[0].content.startswith(CODE_SYSTEM[:20]) else "commit"
            if who == "commit":
                await asyncio.sleep(5)
            return await super().ainvoke(messages, **kwargs)

    model = _Slow(code_steps=[
        {"tool_calls": [_call("repo_file", {"path": "src/app.ts"}, "f1")]},
        {"tool_calls": [_call("finding", {"path": "src/app.ts", "quote": "export const retry = 3",
                                          "claim": "재시도"}, "n1")]},
    ], commit_steps=[])
    out = await github_agent(model, "o", "r", focus="", logins=[], emit=lambda _e: None)
    assert out["late"] == ["history"]
    assert [item["claim"] for item in out["findings"]] == ["재시도"]


async def test_a_repo_github_cannot_list_ends_without_model_calls(monkeypatch):
    monkeypatch.setattr(agent_module, "GITHUB_TRANSPORT", httpx.MockTransport(lambda _r: httpx.Response(404)))
    model = _Model([], [])
    assert await github_agent(model, "o", "r", focus="", logins=[], emit=lambda _e: None) == {
        "error": "GITHUB_UNAVAILABLE"}
    assert model.started == []


def test_light_model_keeps_the_turn_and_changes_only_the_model():
    from types import SimpleNamespace

    from app.domain.entities import AiOptions
    from app.harness.model import GateModel

    turn = {"checked": True}
    main = GateModel(SimpleNamespace(), "u", AiOptions(provider="OPENAI", model="anthropic/x", effort="HIGH",
                                                       web_search=True), "job", turn)
    light = agent_module.light_model(main)
    assert light.ai.model == agent_module.LIGHT_MODEL and light.ai.effort == "LOW" and not light.ai.web_search
    assert light.turn is turn and main.ai.model == "anthropic/x"
    assert agent_module.light_model(object()) is None


async def test_light_model_runs_the_turns_plan_check_on_the_main_model_first():
    from types import SimpleNamespace

    from app.domain.entities import AiOptions
    from app.harness.model import GateModel

    checked = []

    async def check(user_id, ai):
        checked.append(ai.model)
        ai.model = "anthropic/plan-model"
        raise RuntimeError("stop after the check")

    main = GateModel(SimpleNamespace(check=check), "u",
                     AiOptions(provider="OPENAI", model="managed", effort="HIGH"), "job", {})
    light = agent_module.light_model(main)
    with contextlib.suppress(RuntimeError):
        await light.ainvoke([])
    assert checked == ["managed"]
    assert main.ai.model == "anthropic/plan-model"


async def test_a_teammates_commit_is_not_the_users_own_work(monkeypatch):
    monkeypatch.setattr(agent_module, "GITHUB_TRANSPORT", _github([]))
    model = _Model(code_steps=[], commit_steps=[
        {"tool_calls": [_call("commit_detail", {"sha": "fff0000aaa"}, "c1")]},
        {"tool_calls": [_call("finding", {"path": "fff0000aaa", "claim": "결제 웹훅 개발",
                                          "quote": "feat: add payment webhook"}, "n1")]},
    ])
    out = await github_agent(model, "acme-labs", "shop-web", focus="", logins=["me"],
                             emit=lambda _e: None)
    assert [(item["claim"], item["author"], item["own"]) for item in out["findings"]] == [
        ("결제 웹훅 개발", "Other-Dev", False)]


async def test_with_no_known_login_a_commit_is_not_filed_as_a_teammates(monkeypatch):
    monkeypatch.setattr(agent_module, "GITHUB_TRANSPORT", _github([]))
    model = _Model(code_steps=[], commit_steps=[
        {"tool_calls": [_call("commit_detail", {"sha": "fff0000aaa"}, "c1")]},
        {"tool_calls": [_call("finding", {"path": "fff0000aaa", "claim": "결제 웹훅 개발",
                                          "quote": "feat: add payment webhook"}, "n1")]},
    ])
    out = await github_agent(model, "acme-labs", "shop-web", focus="", logins=[],
                             emit=lambda _e: None)
    assert [item["own"] for item in out["findings"]] == [True]


class _Broken(_Model):
    async def ainvoke(self, messages, **kwargs):
        raise RuntimeError("model down")


async def test_both_subagents_failing_is_an_error_not_an_empty_result(monkeypatch):
    monkeypatch.setattr(agent_module, "GITHUB_TRANSPORT", _github([]))
    out = await github_agent(_Broken([], []), "o", "r", focus="", logins=[], emit=lambda _e: None)
    assert out == {"error": "AGENT_FAILED"}


async def test_one_failed_subagent_is_listed_as_failed(monkeypatch):
    monkeypatch.setattr(agent_module, "GITHUB_TRANSPORT", _github([]))

    class _CommitBroken(_Model):
        async def ainvoke(self, messages, **kwargs):
            if not messages[0].content.startswith(CODE_SYSTEM[:20]):
                raise RuntimeError("model down")
            return await super().ainvoke(messages, **kwargs)

    out = await github_agent(_CommitBroken([], []), "o", "r", focus="", logins=[],
                             emit=lambda _e: None)
    assert out["failed"] == ["history"] and out["late"] == []


async def test_a_rate_limit_is_not_reported_as_a_missing_repo(monkeypatch):
    limited = httpx.MockTransport(lambda _r: httpx.Response(429, headers={"retry-after": "60"}))
    monkeypatch.setattr(agent_module, "GITHUB_TRANSPORT", limited)
    model = _Model([], [])
    assert await github_agent(model, "o", "r", focus="", logins=[], emit=lambda _e: None) == {
        "error": "GITHUB_RATE_LIMITED"}
    assert model.started == []
    assert await agent_module._commit_tools(agent_module._Repo("o", "r"))["list_commits"][1](
        agent_module.CommitsArgs()) == {"error": "GITHUB_RATE_LIMITED"}


async def test_an_author_with_no_commits_is_an_empty_list_not_an_error(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[])

    monkeypatch.setattr(agent_module, "GITHUB_TRANSPORT", httpx.MockTransport(handler))
    assert await agent_module._Repo("o", "r").commits("someone", "") == {"commits": []}
