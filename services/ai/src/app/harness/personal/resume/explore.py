"""Analyze as a budgeted agent loop: the model picks what to read next, every finding it keeps goes to
the 00_notes.json ledger, and the loop ends on its own answer or when the plan's budget runs out."""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from pydantic import BaseModel, Field

from app.framework.models import _content
from app.framework.untrusted import DATA_RULE, as_data, strip_exfil
from app.harness.kstyle.budget import BUDGETS, Budget, budget_for  # noqa: F401
from app.harness.kstyle.stage import entry
from app.harness.kstyle.workspace import load_json
from app.harness.personal.resume.workspace import (
    Notes,
    add_evidence,
    ledger_text,
    load_notes,
    save_notes,
)
from app.harness.policy import Tier
from app.harness.tools import (
    RETRY_WARNING,
    ToolContext,
    ToolSpec,
    call_retrying,
    emit,
    to_structured_tool,
)

EXPLORE_NOTE = (Path(__file__).with_name("explore.md")).read_text(encoding="utf-8")
_KEEP_ROUNDS = 2
_TOKEN_CAP = 200
# The attachment reader's own limit (resume.tools._TEXT_LIMIT): later pages stay quotable.
_ATTACHMENT_CAP = 20_000
_PREFETCH_SECONDS = 20
_WRAP_UP = "예산이 거의 찼어요. 더 탐색하지 말고 지금까지의 메모로 결과 JSON을 써요."
_FINAL = "도구 없이 지금까지의 메모로 결과 JSON 하나만 써요."
_STAGE_KEY = "stage_one"
_READERS = ("posting", "resume", "company")
# GitHub errors that mean "could not read", not "the model asked for something it may not have".
_LEFT_OUT = frozenset({"AGENT_FAILED", "TOOL_FAILED", "GITHUB_RATE_LIMITED"})
_DEDUPE = {"read_github", "open_page", "research_company", "github_agent"}


class NoteArgs(BaseModel):
    kind: Literal["repo", "resume", "company", "posting", "assumption", "ask"]
    claim: str = Field(description="One sentence the draft may use; for ask, the question.")
    source: str = Field(default="", description="owner/repo:path or https URL the quote came from.")
    quote: str = Field(default="", description="Verbatim text from the source; for ask, options joined by |.")


class GithubAgentArgs(BaseModel):
    repo: str = Field(description="owner/repo")
    focus: str = Field(default="", description="What to look for, e.g. the posting's key skills.")


async def _never(_ctx, _args) -> dict:
    return {}


NOTE_SPEC = ToolSpec("note", Tier.READ, NoteArgs, _never, lambda _args: "메모해요")
GITHUB_AGENT_SPEC = ToolSpec("github_agent", Tier.READ, GithubAgentArgs, _never,
                             lambda _args: "GitHub 에이전트가 코드와 커밋을 살펴봐요")


def _line(name: str, state: str, summary: str, target: str, result: str = "",
          extra: list[str] | None = None, warning: str = "") -> dict:
    line = {"type": "tool", "name": name, "state": state, "summary": summary, "tier": "READ"}
    if target:
        line["target"] = target
    if result:
        line["resultLine"] = result
    if extra:
        line["extra"] = extra[:5]
    if warning:
        line["warning"] = warning
    return line


def _target(name: str, args: dict) -> str:
    if name in {"read_github", "github_agent"}:
        repo = str(args.get("repo") or "")
        what = args.get("path") or args.get("dir") or ""
        return f"{repo} · {what}" if what and name != "github_agent" else repo
    if name == "open_page":
        parts = urlsplit(str(args.get("url") or ""))
        return (parts.hostname or "") + (parts.path if parts.path not in {"", "/"} else "")
    if name == "research_company":
        return str(args.get("company") or "")
    if name == "explore_github":
        return str(args.get("username") or "")
    return ""


def _result_line(name: str, result: dict) -> str:
    if "error" in result:
        return str(result["error"])
    if name == "read_github":
        if "files" in result:
            return f"파일 {len(result['files'])}개"
        if result.get("lines"):
            return f"{result['lines']}줄 중 {result.get("from", 1)}-{result.get('to', result['lines'])}줄"
    if name == "open_page":
        return f"{len(str(result.get('text') or ''))}자 읽음"
    if name == "research_company":
        return f"출처 {len(result.get('sources') or [])}개"
    if name == "explore_github":
        return f"저장소 {len(result.get('repos') or [])}개"
    return ""


def _source_key(name: str, args: dict, result: dict) -> str:
    if name == "read_github" and result.get("text") is not None:
        return f"{result.get('repo') or args.get('repo')}:{result.get('path') or args.get('path')}"
    if name == "open_page":
        return str(result.get("url") or args.get("url") or "")
    if name == "research_company":
        return f"research:{args.get('company')}"
    return ""


def _parse(reply) -> dict:
    if isinstance(reply, dict):
        return reply
    text = _content(reply).strip()
    return _parse_text(text) or {"text": text}


def _elide(messages: list, rounds: list[list[int]]) -> None:
    for indexes in rounds[:-_KEEP_ROUNDS]:
        for index in indexes:
            message = messages[index]
            if not str(message.content).startswith("(읽음"):
                messages[index] = ToolMessage(
                    content="(읽음. 필요한 내용은 메모에 있어요)", tool_call_id=message.tool_call_id)


class _Run:
    def __init__(self, ctx: ToolContext, notes: Notes, budget: Budget, specs: dict[str, ToolSpec],
                 agent: Callable[[str, str], Awaitable[dict]] | None):
        self.ctx = ctx
        self.notes = notes
        self.budget = budget
        self.specs = specs
        self.agent = agent
        self.corpus: dict[str, str] = {}
        self.calls = 0
        self.agents = 0
        self.asked = notes.get("ask") is not None
        self.new_ask = False
        self.late: list[str] = []
        self.failed: list[str] = []

    def _text_for(self, kind: str, source: str) -> str:
        """Only the named source backs a quote; a résumé fact may also come from any attachment."""
        if source in self.corpus:
            return self.corpus[source]
        if kind == "resume":
            return "\n".join(text for key, text in self.corpus.items()
                             if key.startswith("attachment:"))
        return ""

    def _note(self, args: NoteArgs) -> dict:
        if args.kind == "assumption":
            if args.claim not in self.notes["assumptions"]:
                self.notes["assumptions"].append(args.claim)
            return {"ok": True}
        if args.kind == "ask":
            if self.asked:
                return {"error": "ALREADY_ASKED"}
            options = [part.strip() for part in args.quote.split("|") if part.strip()][:3]
            # The ask gate needs two options; a question it cannot show must not use up the ask.
            if len(options) < 2:
                return {"error": "ASK_NEEDS_OPTIONS"}
            self.asked = True
            self.new_ask = True
            self.notes["ask"] = {"question": args.claim, "options": options}
            return {"ok": True}
        item = add_evidence(self.notes, args.kind, args.source, args.quote, args.claim,
                            text=self._text_for(args.kind, args.source))
        return {"id": item["id"], "verified": item["verified"]}

    async def _github(self, args: GithubAgentArgs) -> dict:
        if self.agent is None or self.agents >= self.budget.repo_agents:
            return {"error": "AGENT_LIMIT"}
        self.agents += 1
        found = await self.agent(args.repo, args.focus)
        if "error" in found:
            return found
        kept = []
        for item in found.get("findings") or []:
            source = str(item.get("source") or args.repo)
            claim = str(item.get("claim") or "")
            # A teammate's commit is evidence of the team's work, never of the user's own.
            own = item.get("own", True)
            added = add_evidence(
                self.notes, "repo" if own else "repo_team", source, str(item.get("quote") or ""),
                claim if own else f"팀원 커밋: {claim}", text=str(item.get("text") or ""))
            if added["verified"]:
                kept.append({"id": added["id"], "claim": added["claim"], "source": source})
        return {"repo": args.repo, "code": found.get("code", ""), "stack": found.get("stack", []),
                "history": found.get("history", ""), "authors": found.get("authors", []), "evidence": kept,
                "late": list(found.get("late") or []), "failed": list(found.get("failed") or [])}

    def _left_out(self, name: str, raw: dict, result: dict) -> None:
        """GitHub reads that ran late or failed go to the closing message as github:<repo>."""
        if name not in {"github_agent", "read_github", "explore_github"}:
            return
        what = f"github:{raw.get('repo') or raw.get('username') or ''}"
        if result.get("error") in _LEFT_OUT or result.get("failed"):
            self.failed.append(what)
        elif result.get("late"):
            self.late.append(what)

    async def call(self, call: dict) -> dict:
        name = str(call.get("name") or "")
        raw = call.get("args") or {}
        if name == "note":
            try:
                return self._note(NoteArgs.model_validate(raw))
            except Exception:
                return {"error": "INVALID_ARGS"}
        self.calls += 1
        target = _target(name, raw)
        key = f"{name}:{json.dumps(raw, sort_keys=True, ensure_ascii=False)}"
        if name in _DEDUPE and key in self.notes["read"]:
            return {"note": "이미 읽었어요. 메모를 보세요."}
        if name == "github_agent":
            emit(_line(name, "run", GITHUB_AGENT_SPEC.summarize(None), target))
            try:
                result = await self._github(GithubAgentArgs.model_validate(raw))
            except Exception:
                result = {"error": "TOOL_FAILED"}
            claims = [item["claim"] for item in result.get("evidence") or []]
            emit(_line(name, "err" if "error" in result else "ok", GITHUB_AGENT_SPEC.summarize(None), target,
                       result.get("error") or f"근거 {len(claims)}개 찾음", claims))
            self._left_out(name, raw, result)
            # A repo with a failed part is read again on the next call.
            if "error" not in result and not result.get("failed"):
                self.notes["read"].append(key)
            return result
        spec = self.specs.get(name)
        if spec is None:
            return {"error": "UNKNOWN_TOOL"}
        try:
            args = spec.args_model.model_validate(raw)
        except Exception:
            return {"error": "INVALID_ARGS"}
        summary = spec.summarize(args)
        emit(_line(name, "run", summary, target))
        result, _ok, retried = await call_retrying(spec, args, replace(self.ctx, tool_call_id=call.get("id", "")))
        emit(_line(name, "err" if "error" in result else "ok", summary, target, _result_line(name, result),
                   warning=RETRY_WARNING if retried else ""))
        self._left_out(name, raw, result)
        source = _source_key(name, raw, result)
        if source and "error" not in result:
            self.corpus[source] = str(result.get("text") or "")
        if "error" not in result and name in _DEDUPE:
            self.notes["read"].append(key)
        return result


def _over(run: _Run, rounds: int, started: float, used: int) -> float:
    b = run.budget
    return max(rounds / b.rounds, run.calls / b.tool_calls, used / b.input_tokens,
               (time.monotonic() - started) / b.wall_seconds)


async def prefetch(state: dict, *, read: Callable | None = None) -> dict:
    """Attachments are read before the first model call, all at once: the model never spends a
    round on them. A slow or failed one is left out instead of holding the loop, and named in
    `failed`."""
    ids = [str(item) for item in (state.get("inputs") or {}).get("attachments") or []]
    if read is None or not ids:
        return {"attachments": [], "failed": []}

    async def one(attachment_id: str) -> dict:
        try:
            async with asyncio.timeout(_PREFETCH_SECONDS):
                return await read(attachment_id)
        except Exception:
            return {"error": "TOOL_FAILED"}

    found = await asyncio.gather(*(one(item) for item in ids))
    return {
        "attachments": [
            {"id": item_id, "source": f"attachment:{item_id}", "title": item.get("title", ""),
             "text": str(item.get("text") or "")[:_ATTACHMENT_CAP]}
            for item_id, item in zip(ids, found, strict=True) if "error" not in item
        ],
        "failed": [item_id for item_id, item in zip(ids, found, strict=True) if "error" in item],
    }


def _parse_text(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


async def run_explore(model, state: dict, ctx: ToolContext, *, budget: Budget,
                      used_tokens: Callable[[], int] | None = None, system: str = "",
                      context: dict | None = None, tools: list[ToolSpec] | None = None,
                      agent: Callable[[str, str], Awaitable[dict]] | None = None,
                      read_attachment: Callable[[str], Awaitable[dict]] | None = None,
                      stage: Callable[[list[dict], list[str]], Awaitable[dict]] | None = None,
                      ) -> dict:
    notes = await load_notes(ctx)
    for text in (state.get("inputs") or {}).get("steer") or []:
        if text not in notes["steer"]:
            notes["steer"].append(text)
    specs = {spec.name: spec for spec in tools or []}
    run = _Run(ctx, notes, budget, specs, agent)
    early = await prefetch(state, read=read_attachment)
    for item in early["attachments"]:
        run.corpus[item["source"]] = item["text"]
    for item_id in early["failed"]:
        emit(_line("parse_attachment", "err", "첨부 파일을 읽어요", "", "TOOL_FAILED"))
        run.failed.append(f"attachment:{item_id}")
    staged: dict = {}
    # Each stage-one reader runs once per flow; a rerun after a question or a steer starts from the
    # notes and the readers' saved results, and runs again only the readers that failed.
    missing = [name for name in _READERS if f"{_STAGE_KEY}:{name}" not in notes["read"]]
    if stage is not None and missing:
        staged = await stage(early["attachments"], missing)
        for item in staged.get("findings") or []:
            add_evidence(notes, str(item.get("kind") or "posting"), str(item.get("source") or ""),
                         str(item.get("quote") or ""), str(item.get("claim") or ""), text=str(item.get("text") or ""))
        failed = [str(name) for name in staged.get("failed") or []]
        done = [f"{_STAGE_KEY}:{name}" for name in missing if name not in failed]
        notes["read"] += [key for key in done if key not in notes["read"]]
        run.late += [str(name) for name in staged.get("late") or []]
        run.failed += failed
        await save_notes(ctx, notes)
    if stage is not None:
        for name in _READERS:
            if name not in missing and (body := await load_json(ctx, entry(name))):
                staged[name] = body
    payload = dict(context or {})
    payload.update({
        "attachments": early["attachments"],
        "stage_one": {key: staged.get(key) for key in (*_READERS, "late")} if staged else None,
        "notes": {"ledger": ledger_text(notes), "assumptions": notes["assumptions"],
                  "read": notes["read"], "steer": notes["steer"]},
        "budget": {"rounds": budget.rounds, "tool_calls": budget.tool_calls, "repo_agents": budget.repo_agents},
    })
    messages: list = [
        SystemMessage(content=system + "\n\n" + EXPLORE_NOTE
                      + "\n\n결과는 JSON 객체 하나로만 답하고, 사용자에게 보여줄 한두 문장은 message 키에 넣는다."
                      + "\n\n" + DATA_RULE),
        HumanMessage(content=as_data(json.dumps(payload, ensure_ascii=False), "resume_state", None)),
    ]
    bound = [to_structured_tool(spec) for spec in specs.values()] + [to_structured_tool(NOTE_SPEC)]
    if agent is not None and budget.repo_agents:
        bound.append(to_structured_tool(GITHUB_AGENT_SPEC))
    started = time.monotonic()
    rounds, tool_rounds, warned = 0, [], False
    seen = json.dumps(payload, ensure_ascii=False)
    while True:
        load = _over(run, rounds, started, used_tokens() if used_tokens else 0)
        if not hasattr(model, "bind_tools"):
            reply = await model.ainvoke(messages)
            break
        if load >= 1:
            reply = await model.ainvoke([*messages, HumanMessage(content=_FINAL)])
            break
        if load >= 0.8 and not warned:
            messages.append(HumanMessage(content=_WRAP_UP))
            warned = True
        reply = await model.bind_tools(bound).ainvoke(messages)
        calls = list(getattr(reply, "tool_calls", None) or [])
        if not calls:
            break
        said = _content(reply).strip()
        if said:
            emit({"token": strip_exfil(said[:_TOKEN_CAP], seen)})
        messages.append(reply)
        room = max(0, budget.tool_calls - run.calls)
        allowed = [call for call in calls if call.get("name") == "note"]
        allowed += [call for call in calls if call.get("name") != "note"][:room]
        results = await asyncio.gather(*(run.call(call) for call in allowed))
        done = {call["id"]: result for call, result in zip(allowed, results, strict=True)}
        indexes = []
        for call in calls:
            result = done.get(call["id"], {"error": "도구 호출 한도"})
            indexes.append(len(messages))
            body = json.dumps(result, ensure_ascii=False)
            seen += body
            messages.append(ToolMessage(content=as_data(body, str(call.get("name"))), tool_call_id=call["id"]))
        tool_rounds.append(indexes)
        _elide(messages, tool_rounds)
        rounds += 1
        await save_notes(ctx, notes)
    output = _parse(reply)
    if staged.get("posting") and not isinstance(output.get("jobs"), (dict, list)):
        output["jobs"] = staged["posting"]
    if (staged.get("company") or {}).get("name") and not isinstance(output.get("company"), dict):
        output["company"] = staged["company"]
    # The final message lists what ran late or failed; analysis carries them there.
    if run.late:
        output["stage_late"] = list(dict.fromkeys(run.late))
    if run.failed:
        output["stage_failed"] = list(dict.fromkeys(run.failed))
    # Only a question raised in this run goes to the user; an answered one never comes back.
    output.pop("ask", None)
    if run.new_ask:
        output["ask"] = notes["ask"]
    verified = [item["id"] for item in notes["evidence"] if item["verified"]]
    if verified:
        output["evidence_ids"] = verified
    await save_notes(ctx, notes)
    return output
