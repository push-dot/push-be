from __future__ import annotations

import asyncio
from typing import Final

from langchain_core.messages import AIMessage
from langchain_core.tools import StructuredTool

from app.domain import entities as ent
from app.domain.errors import DomainError, provider_error
from app.domain.plan_levers import PlanLevers
from app.framework.llm import AiUsageCallback, chat_model_for
from app.framework.models import _apply_usage
from app.graphs.chat import stub_reply
from app.harness.tools import to_structured_tool

# Whole-call ceiling; long reasoning drafts can stream for minutes but never forever.
_CALL_TIMEOUT_SECONDS: Final = 180


def _for_model(tool):
    return tool if isinstance(tool, StructuredTool) else to_structured_tool(tool)


class StubModel:
    def __init__(self, text: str):
        self.text = text

    def bind_tools(self, tools, **kwargs):
        return self

    async def ainvoke(self, messages, **kwargs):
        return AIMessage(content=stub_reply(self.text))


class GateModel:
    """Tool-calling chat model behind AIGate. One credit reservation per turn."""

    def __init__(self, gate, user_id, ai: ent.AiOptions, job_id, turn: dict,
                 tools=(), cls=None):
        self.gate = gate
        self.user_id = user_id
        self.ai = ai
        self.job_id = job_id
        self.turn = turn
        self.tools = list(tools)
        self.cls = cls

    def bind_tools(self, tools, **kwargs):
        return GateModel(self.gate, self.user_id, self.ai, self.job_id, self.turn,
                         tools, self.cls)

    async def _open(self, messages):
        if not self.turn.get("checked"):
            await self.gate.check(self.user_id, self.ai)
            self.turn["checked"] = True
            self.turn["model"] = self.ai.model
        if "usage_id" not in self.turn:
            text = "".join(str(getattr(message, "content", "")) for message in messages)
            self.turn["usage_id"] = await self.gate._reserve(
                self.user_id, self.ai, "", text, self.job_id)
        if hasattr(self.gate, "_factory_config"):
            config = self.gate._factory_config(getattr(self.gate, "chat", None))
        elif hasattr(self.gate, "_levers_config"):
            config = self.gate._levers_config()
        else:
            from app.config import Config
            config = Config()
        web = bool(self.ai.web_search) and not str(self.ai.model).startswith("opencode-go/")
        lc = chat_model_for(
            PlanLevers(self.ai.model, self.ai.effort, "", "", "", 0),
            web_search=web, streaming=True, config=config,
            session_id=str(self.user_id or ""), cls=self.cls)
        store = getattr(self.gate, "usage", None)
        callback = None
        if store is not None and self.turn.get("usage_id") is not None:
            callback = AiUsageCallback(store, self.user_id, self.job_id, self.turn["usage_id"])
        runnable = lc.bind_tools([_for_model(tool) for tool in self.tools]) if self.tools else lc
        invoke = {"config": {"callbacks": [callback]}} if callback is not None else {}
        return runnable, invoke

    def _add_usage(self, reply) -> None:
        usage: dict = {}
        _apply_usage(reply, usage)
        self.turn["input_tokens"] = self.turn.get("input_tokens", 0) + usage.get("input_tokens", 0)
        added = usage.get("output_tokens", 0)
        self.turn["output_tokens"] = self.turn.get("output_tokens", 0) + added

    async def _call(self, runnable, messages, invoke):
        try:
            async with asyncio.timeout(_CALL_TIMEOUT_SECONDS):
                return await runnable.ainvoke(messages, **invoke)
        except DomainError:
            raise
        except Exception:
            raise provider_error("AI provider request failed")

    async def ainvoke(self, messages, **kwargs):
        runnable, invoke = await self._open(messages)
        reply = await self._call(runnable, messages, invoke)
        self._add_usage(reply)
        return reply

    async def astream(self, messages, **kwargs):
        runnable, invoke = await self._open(messages)
        stream = getattr(runnable, "astream", None)
        if stream is None:
            reply = await self._call(runnable, messages, invoke)
            self._add_usage(reply)
            yield reply
            return
        last = None
        try:
            async with asyncio.timeout(_CALL_TIMEOUT_SECONDS):
                async for chunk in stream(messages, **invoke):
                    if getattr(chunk, "usage_metadata", None):
                        last = chunk
                    yield chunk
        except DomainError:
            raise
        except Exception:
            raise provider_error("AI provider request failed")
        if last is not None:
            self._add_usage(last)


async def settle_turn(gate, turn: dict, ok: bool) -> None:
    usage_id = turn.get("usage_id")
    if usage_id is None:
        return
    # Tokens already spent are billed even when the turn fails; otherwise failures are free runs.
    if ok or turn.get("input_tokens", 0) or turn.get("output_tokens", 0):
        await gate._settle(usage_id, turn.get("model") or "",
                           turn.get("input_tokens", 0), turn.get("output_tokens", 0))
    else:
        await gate._release(usage_id)
