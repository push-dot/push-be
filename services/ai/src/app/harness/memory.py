from __future__ import annotations

import json
import logging

from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage, ToolMessage
from langgraph.types import Command

_SUMMARY_MODEL = "deepseek/deepseek-v4.1-flash"
_FACTS = "사용자의 결정, 문서 버전과 id, 공고, 적용한 것, 거절한 것"

COMPACT_ABOVE = 24_000
KEEP_RECENT = 12_000
SUMMARY_MAX = 1_500


class Compaction:
    def __init__(self, remove_ids: list[str], summary: str):
        self.remove_ids = remove_ids
        self.summary = summary


def estimate_tokens(text: str) -> int:
    return len(text) // 2


def message_text(message) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict):
                parts.append(str(part.get("text") or ""))
            else:
                parts.append(str(part))
        text = "".join(parts)
    else:
        text = "" if content is None else str(content)
    calls = getattr(message, "tool_calls", None) or []
    if calls:
        text += json.dumps(calls, ensure_ascii=False, default=str)
    return text


def _tokens(message) -> int:
    return estimate_tokens(message_text(message))


def _held(messages: list, summary: str) -> int:
    return sum(map(_tokens, messages)) + estimate_tokens(summary or "")


def _call_ids(message) -> list[str]:
    found = []
    for call in getattr(message, "tool_calls", None) or []:
        cid = call.get("id") if isinstance(call, dict) else getattr(call, "id", None)
        if cid:
            found.append(str(cid))
    return found


def _unmatched(messages: list) -> set[str]:
    pending: set[str] = set()
    for message in messages:
        if isinstance(message, AIMessage):
            pending.update(_call_ids(message))
        elif isinstance(message, ToolMessage) and str(message.tool_call_id) in pending:
            pending.discard(str(message.tool_call_id))
    return pending


def plan_compaction(messages: list, summary: str) -> list | None:
    if _held(messages, summary) <= COMPACT_ABOVE:
        return None
    for index, message in enumerate(messages):
        if index == 0 or not isinstance(message, HumanMessage):
            continue
        prefix, tail = messages[:index], messages[index:]
        if sum(map(_tokens, tail)) > KEEP_RECENT:
            continue
        if _unmatched(prefix):
            continue
        return prefix
    return None


def _cap(text: str) -> str:
    limit = SUMMARY_MAX * 2
    if len(text) <= limit:
        return text
    return text[:limit]


def _prompt(summary: str, prefix: list) -> str:
    folded = "\n".join(message_text(message) for message in prefix)
    return (
        "기존 요약과 접을 대화를 한 요약으로 다시 써. "
        f"빠뜨리지 말 것: {_FACTS}. "
        "없는 사실은 만들지 마.\n"
        f"기존 요약:\n{summary}\n"
        f"접을 대화:\n{folded}"
    )


def _config_of(llm):
    gate = llm.gate
    if hasattr(gate, "_factory_config"):
        return gate._factory_config(getattr(gate, "chat", None))
    if hasattr(gate, "_levers_config"):
        return gate._levers_config()
    from app.config import Config

    return Config()


async def _invoke(llm, messages):
    if not hasattr(llm, "gate") or not hasattr(llm, "_add_usage"):
        return await llm.ainvoke(messages)
    from app.domain.plan_levers import PlanLevers
    from app.framework.llm import chat_model_for

    config = _config_of(llm)
    model = getattr(config, "model_free", None) or _SUMMARY_MODEL
    lc = chat_model_for(
        PlanLevers(model, "LOW", "", "", "", 0),
        web_search=False,
        streaming=False,
        config=config,
        cls=getattr(llm, "cls", None),
    )
    reply = await lc.ainvoke(messages)
    llm._add_usage(reply)
    return reply


async def compact(messages: list, summary: str, llm) -> Compaction | None:
    prefix = plan_compaction(messages, summary)
    if not prefix or llm is None:
        return None
    ids = []
    for message in prefix:
        mid = getattr(message, "id", None)
        if not mid:
            return None
        ids.append(mid)
    try:
        reply = await _invoke(llm, [HumanMessage(content=_prompt(summary or "", prefix))])
    except Exception:
        logging.getLogger(__name__).warning("thread summary failed")
        return None
    text = _cap(message_text(reply)).strip()
    if not text:
        return None
    return Compaction(ids, text)


async def memory_update(messages: list, summary: str, llm) -> dict | None:
    done = await compact(messages, summary, llm)
    if done is None:
        return None
    return {
        "messages": [RemoveMessage(id=mid) for mid in done.remove_ids],
        "summary": done.summary,
    }


def merge_memory(memory: dict | None, result):
    if not memory:
        return result
    removals = list(memory.get("messages") or [])
    if isinstance(result, Command):
        update = dict(result.update or {})
        update["messages"] = [*removals, *(update.get("messages") or [])]
        update["summary"] = memory["summary"]
        return Command(update=update, goto=result.goto, graph=result.graph, resume=result.resume)
    merged = dict(result or {})
    merged["messages"] = [*removals, *(merged.get("messages") or [])]
    merged["summary"] = memory["summary"]
    return merged
