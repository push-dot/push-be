from __future__ import annotations

import asyncio
from typing import Final

from langchain_core.messages import AIMessage

from app.domain import entities as ent
from app.domain.errors import DomainError, provider_error
from app.framework.models import _apply_usage, chat_model, provider_of
from app.graphs.chat import stub_reply

# Whole-call ceiling; long reasoning drafts can stream for minutes but never forever.
_CALL_TIMEOUT_SECONDS: Final = 180


def tool_schema(tool) -> dict:
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.name.replace("_", " "),
            "parameters": tool.args_model.model_json_schema(),
        },
    }


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

    async def ainvoke(self, messages, **kwargs):
        if not self.turn.get("checked"):
            await self.gate.check(self.user_id, self.ai)
            self.turn["checked"] = True
            self.turn["model"] = self.ai.model
        chat, key, model, headers = await self.gate._route(self.user_id, self.ai)
        if "usage_id" not in self.turn:
            text = "".join(str(getattr(message, "content", "")) for message in messages)
            self.turn["usage_id"] = await self.gate._reserve(
                self.user_id, self.ai, "", text, self.job_id)
        reasoning = self.ai.effort.lower()
        lc = chat_model(api_key=key, model=model, base_url=getattr(chat, "base_url", ""),
                        reasoning=reasoning, headers=headers,
                        provider=provider_of(chat, model), cls=self.cls)
        runnable = lc.bind_tools([tool_schema(tool) for tool in self.tools]) if self.tools else lc
        try:
            async with asyncio.timeout(_CALL_TIMEOUT_SECONDS):
                reply = await runnable.ainvoke(messages)
        except DomainError:
            raise
        except Exception:
            raise provider_error("AI provider request failed")
        usage: dict = {}
        _apply_usage(reply, usage)
        self.turn["input_tokens"] = self.turn.get("input_tokens", 0) + usage.get("input_tokens", 0)
        self.turn["output_tokens"] = self.turn.get("output_tokens", 0) + usage.get("output_tokens", 0)
        return reply


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
