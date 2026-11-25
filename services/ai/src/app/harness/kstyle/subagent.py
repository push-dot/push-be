"""What every subagent shares, the k-style way: a light (or mid) model, its own small tool loop or a single
call, a time limit it is not waited past, and findings kept only when their quote is in what was read."""
from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from pydantic import BaseModel, Field

from app.claimctx import ends_the_run
from app.framework.models import _content
from app.framework.untrusted import DATA_RULE, as_data
from app.harness.kstyle.ledger import quoted_in, squash  # noqa: F401  (squash: re-exported for callers)
from app.harness.policy import Tier
from app.harness.tools import ToolSpec, to_structured_tool

# The light tier the codebase already runs (plan_levers' FREE default): reading and extraction, not judgement.
LIGHT_MODEL = os.environ.get("LIGHT_MODEL", "").strip() or "deepseek/deepseek-v4.1-flash"
SUB_SECONDS = 120
_KEEP = 2
_FINAL = "도구 없이 지금까지 찾은 것으로 결과 JSON 하나만 써요."

Emit = Callable[[dict], None]
# (args model, run, target line, result line)
Tool = tuple[type[BaseModel], Callable[[BaseModel], Awaitable[dict]], Callable[[BaseModel], str], Callable[[dict], str]]


@dataclass(frozen=True)
class SubBudget:
    rounds: int = 4
    tool_calls: int = 8


class FindingArgs(BaseModel):
    path: str = Field(description="Where the quote is: a file path, commit sha or page URL.")
    quote: str = Field(description="One line copied verbatim from what was read.")
    claim: str = Field(description="One sentence the result may use.")


class Corpus:
    """Everything a subagent read, keyed by where it came from, so a quote can be checked."""

    def __init__(self, texts: dict[str, str] | None = None):
        self.texts: dict[str, str] = dict(texts or {})

    def verified(self, path: str, quote: str) -> str:
        """The text the quote was found in, or "" when it is not in what was read."""
        for key in (path.strip().lstrip("/"), path.strip()):
            text = self.texts.get(key)
            if text and quoted_in(quote, text):
                return text
        return ""

    def anywhere(self, quote: str) -> str:
        return next((text for text in self.texts.values() if quoted_in(quote, text)), "")


def line(name: str, state: str, summary: str, target: str, result: str = "") -> dict:
    out = {"type": "tool", "name": name, "state": state, "summary": summary, "tier": "READ"}
    if target:
        out["target"] = target
    if result:
        out["resultLine"] = result
    return out


def parse(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    for candidate in (text, text[text.find("{"):text.rfind("}") + 1]):
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        return parsed if isinstance(parsed, dict) else {}
    return {"summary": text[:500]}


def _derived(chat, tier: str, update: dict):
    """The turn's model on another tier. It shares the turn's one reservation, so its tokens are
    billed with the rest of the turn, and the turn's plan check and reservation always run on the main
    model: that check settles which model the turn may use."""
    from app.harness.model import GateModel

    class _Tier(GateModel):
        def bind_tools(self, tools, **kwargs):
            return _Tier(self.gate, self.user_id, self.ai, self.job_id, self.turn, tools, self.cls)

        async def _open(self, messages, *, tools: bool = True, hold: bool = True):
            await self._hold(messages, chat.ai)
            return await super()._open(messages, tools=tools, hold=False)

    _Tier.tier = tier
    derived = _Tier(chat.gate, chat.user_id, chat.ai, chat.job_id, chat.turn, chat.tools, chat.cls)
    derived.ai = chat.ai.model_copy(update=update)
    return derived


def light_model(chat, model: str = ""):
    """The turn's model moved to the light tier, for reading and extraction. Without the managed gate there
    is no light tier: None, and the caller skips the subagent. model overrides LIGHT_MODEL."""
    from app.harness.model import GateModel

    if not isinstance(chat, GateModel):
        return None
    return _derived(chat, "light", {"model": model or LIGHT_MODEL, "effort": "LOW", "web_search": False})


def mid_model(chat):
    """The plan's own model at low effort, for reviewers that judge. Without the managed gate: chat itself."""
    from app.harness.model import GateModel

    if not isinstance(chat, GateModel):
        return chat
    return _derived(chat, "mid", {"effort": "LOW", "web_search": False})


async def _never(_ctx, _args) -> dict:
    return {}


async def single_call(model, system: str, brief: dict) -> dict:
    """A subagent with nothing to choose: one call, one JSON answer."""
    reply = await model.ainvoke([
        SystemMessage(content=system + "\n\n" + DATA_RULE),
        HumanMessage(content=as_data(json.dumps(brief, ensure_ascii=False), "brief", None)),
    ])
    return parse(_content(reply))


async def run_subagent(model, name: str, summary: str, system: str, brief: dict, tools: dict[str, Tool],
                       corpus: Corpus, budget: SubBudget, emit: Emit, findings: list[dict]) -> dict:
    """A small tool loop: the subagent picks what to read, keeps findings with `finding`, and answers
    with one JSON object. Calls in one step run together; old tool results are cut to keep it short."""
    specs = [ToolSpec(tool, Tier.READ, spec[0], _never, lambda _args, tool=tool: tool) for tool, spec in tools.items()]
    specs.append(ToolSpec("finding", Tier.READ, FindingArgs, _never, lambda _args: "finding"))
    bound = [to_structured_tool(spec) for spec in specs]
    messages: list = [SystemMessage(content=system + "\n\n" + DATA_RULE),
                      HumanMessage(content=as_data(json.dumps(brief, ensure_ascii=False), "brief", None))]
    used, rounds, history = 0, 0, []

    async def run(call: dict) -> dict:
        tool = call.get("name")
        if tool == "finding":
            try:
                args = FindingArgs.model_validate(call.get("args") or {})
            except Exception:
                return {"error": "INVALID_ARGS"}
            text = corpus.verified(args.path, args.quote)
            if not text:
                return {"error": "QUOTE_NOT_FOUND"}
            findings.append({"path": args.path.strip(), "quote": args.quote, "claim": args.claim, "text": text})
            return {"ok": True}
        spec = tools.get(str(tool))
        if spec is None:
            return {"error": "UNKNOWN_TOOL"}
        model_cls, fn, target, result_line = spec
        try:
            args = model_cls.model_validate(call.get("args") or {})
        except Exception:
            return {"error": "INVALID_ARGS"}
        where = target(args)
        emit(line(name, "run", summary, where))
        try:
            result = await fn(args)
        except Exception:
            result = {"error": "TOOL_FAILED"}
        emit(line(name, "err" if "error" in result else "ok", summary, where,
                  str(result["error"]) if "error" in result else result_line(result)))
        return result

    while True:
        if rounds >= budget.rounds or used >= budget.tool_calls or not hasattr(model, "bind_tools"):
            reply = await model.ainvoke([*messages, HumanMessage(content=_FINAL)])
            break
        reply = await model.bind_tools(bound).ainvoke(messages)
        calls = list(getattr(reply, "tool_calls", None) or [])
        if not calls:
            break
        messages.append(reply)
        room = max(0, budget.tool_calls - used)
        reads = [call for call in calls if call.get("name") != "finding"][:room]
        allowed = [call for call in calls if call.get("name") == "finding"] + reads
        used += len(reads)
        results = dict(zip([call["id"] for call in allowed],
                           await asyncio.gather(*(run(call) for call in allowed)), strict=True))
        indexes = []
        for call in calls:
            indexes.append(len(messages))
            body = json.dumps(results.get(call["id"], {"error": "도구 호출 한도"}), ensure_ascii=False)
            messages.append(ToolMessage(content=as_data(body, str(call.get("name"))), tool_call_id=call["id"]))
        history.append(indexes)
        for old in history[:-_KEEP]:
            for index in old:
                messages[index] = ToolMessage(content="(읽음)", tool_call_id=messages[index].tool_call_id)
        rounds += 1
    return parse(_content(reply))


async def timed(run: Awaitable[dict], findings: list[dict] | None = None, *,
                seconds: float | None = None) -> dict:
    """A subagent that runs late or fails is not waited for: what it verified so far still counts.
    It is late only when its own limit ran out. Billing, plan and lost-claim errors are not the
    subagent's, so they end the turn. `late`/`failed` come from here, never from its own answer."""
    # SUB_SECONDS is read here, not bound at import, so a patched module value takes effect.
    limit = asyncio.timeout(SUB_SECONDS if seconds is None else seconds)
    try:
        async with limit:
            out = await run
        out = dict(out) if isinstance(out, dict) else {"summary": ""}
        out.pop("late", None)
        out.pop("failed", None)
    except Exception as err:
        if ends_the_run(err):
            raise
        late = isinstance(err, TimeoutError) and limit.expired()
        out = {"summary": "", "late" if late else "failed": True}
    if findings is not None:
        out["findings"] = findings
    out.setdefault("findings", [])
    return out
