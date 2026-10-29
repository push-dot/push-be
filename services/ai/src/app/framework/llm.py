from __future__ import annotations

import logging

_GO_PREFIX = "opencode-go/"
_CALLBACK = None


def chat_model_for(
    levers,
    *,
    web_search: bool = False,
    streaming: bool = True,
    config,
    session_id: str = "",
    cls=None,
):
    from app.domain.plan_levers import provider_for
    from app.framework.models import chat_model

    model = levers.model
    headers = None
    if model.startswith(_GO_PREFIX):
        model = model[len(_GO_PREFIX) :]
        base_url = config.opencode_go_base_url
        api_key = config.opencode_go_key
        if session_id:
            headers = {"x-opencode-session": session_id}
    else:
        base_url = config.ai_base_url
        api_key = config.managed_ai_key
    if web_search and not model.endswith(":online"):
        model += ":online"
    return chat_model(
        api_key=api_key,
        model=model,
        base_url=base_url,
        reasoning=(levers.effort or "").lower(),
        headers=headers,
        provider=provider_for(model, config),
        streaming=streaming,
        cls=cls,
    )


async def astructured_reply(model, schema, messages, **invoke):
    """Ask for ``schema`` as one tool call; returns ``(raw reply, parsed or None)``.

    Paid plans run Claude with a reasoning effort, and Anthropic rejects a forced
    tool_choice while extended thinking is on. So the schema is offered with
    ``tool_choice="auto"`` and the system prompt asks for exactly one call.
    """
    bound = model.bind_tools([schema], tool_choice="auto")
    reply = await bound.ainvoke(_with_tool_rule(messages, schema), **invoke)
    return reply, parse_structured(reply, schema)


def _with_tool_rule(messages, schema) -> list:
    from langchain_core.messages import SystemMessage

    rule = (
        f"답은 반드시 `{schema.__name__}` 도구를 한 번 호출해서 낸다. "
        "도구 밖에 답을 쓰지 않는다."
    )
    out = list(messages)
    if out and isinstance(out[0], SystemMessage) and isinstance(out[0].content, str):
        out[0] = SystemMessage(content=f"{out[0].content}\n\n{rule}")
    else:
        out.insert(0, SystemMessage(content=rule))
    return out


def parse_structured(reply, schema):
    """The schema tool call's args, else a JSON object in the text, else None."""
    import json

    from pydantic import ValidationError

    calls = getattr(reply, "tool_calls", None) or []
    named = [call for call in calls if call.get("name") == schema.__name__]
    for call in named or calls[:1]:
        try:
            return schema.model_validate(call.get("args") or {})
        except ValidationError:
            return None
    content = getattr(reply, "content", "")
    if isinstance(content, list):
        content = "".join(
            part.get("text", "") if isinstance(part, dict) else str(part) for part in content)
    text = str(content or "")
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return schema.model_validate(json.loads(text[start:end + 1]))
    except (ValueError, ValidationError):
        return None


def _usage_tokens(response) -> tuple[int, int]:
    found = None
    for batch in getattr(response, "generations", None) or []:
        for gen in batch or []:
            meta = getattr(getattr(gen, "message", None), "usage_metadata", None) or {}
            if meta.get("input_tokens") is None and meta.get("output_tokens") is None:
                continue
            found = (int(meta.get("input_tokens") or 0), int(meta.get("output_tokens") or 0))
    if found is not None:
        return found
    output = getattr(response, "llm_output", None) or {}
    usage = output.get("token_usage") or output.get("usage") or {}
    return (
        int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0),
        int(usage.get("output_tokens") or usage.get("completion_tokens") or 0),
    )


def _callback_type():
    global _CALLBACK
    if _CALLBACK is not None:
        return _CALLBACK
    from langchain_core.callbacks import AsyncCallbackHandler

    from app.domain.entities.ai_usage import ai_cost_micro_credits

    class _AiUsageCallback(AsyncCallbackHandler):
        def __init__(self, store, user_id, job_id, reservation_id):
            super().__init__()
            self.store = store
            self.user_id = user_id
            self.job_id = job_id
            self.reservation_id = reservation_id
            self._runs: dict = {}

        async def _finish(self, run_id, status: str) -> bool:
            if run_id in self._runs:
                return False
            self._runs[run_id] = status
            return self.reservation_id is not None and self.store is not None

        async def on_llm_end(self, response, *, run_id, **kwargs):
            if not await self._finish(run_id, "settled"):
                return
            incoming, outgoing = _usage_tokens(response)
            try:
                await self.store.settle(
                    self.reservation_id,
                    incoming,
                    outgoing,
                    ai_cost_micro_credits("OPENAI", "", incoming, outgoing),
                )
            except Exception:
                logging.getLogger(__name__).exception(
                    "usage settle failed id=%s", self.reservation_id
                )

        async def on_llm_error(self, error, *, run_id, **kwargs):
            if not await self._finish(run_id, "released"):
                return
            try:
                await self.store.release(self.reservation_id)
            except Exception:
                logging.getLogger(__name__).exception(
                    "usage release failed id=%s", self.reservation_id
                )

    _CALLBACK = _AiUsageCallback
    return _CALLBACK


class AiUsageCallback:
    def __new__(cls, store, user_id, job_id, reservation_id):
        return _callback_type()(store, user_id, job_id, reservation_id)
