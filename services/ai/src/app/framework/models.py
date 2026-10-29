from __future__ import annotations

from typing import Final

from app.domain import entities as ent
from app.domain.plan_levers import provider_for
from app.framework.flag import use_langchain
from app.framework.prompts import render_messages


def openai_compatible(chat) -> bool:
    from app.infrastructure.openai_client import OpenAIClient
    return isinstance(chat, OpenAIClient)


# SDK defaults are a 600s timeout and 2 retries; provider errors fail the job without a queue retry.
_TIMEOUT_SECONDS: Final = 60
_MAX_RETRIES: Final = 1


def provider_of(chat, model: str) -> dict | None:
    """OpenRouter provider routing, the same rule OpenAIClient applies to its own requests."""
    config = getattr(chat, "config", None)
    return None if config is None else provider_for(model, config)


def chat_model(*, api_key: str, model: str, base_url: str,
               reasoning: str = "", headers: dict | None = None,
               provider: dict | None = None, cls=None, streaming: bool = True):
    """OpenAI-compatible chat model. Tools are not bound to this call."""
    if cls is None:
        from langchain_openai import ChatOpenAI
        cls = ChatOpenAI
    kwargs = {
        "api_key": api_key,
        "model": model,
        "base_url": base_url,
        "streaming": streaming,
        "stream_usage": True,
        "max_tokens": 65536,
        "timeout": _TIMEOUT_SECONDS,
        "max_retries": _MAX_RETRIES,
    }
    extra_body: dict = {}
    if reasoning:
        extra_body["reasoning"] = {"effort": reasoning}
    if provider:
        extra_body["provider"] = provider
    if extra_body:
        kwargs["extra_body"] = extra_body
    if headers:
        kwargs["default_headers"] = headers
    return cls(**kwargs)


def _content(message) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict):
                parts.append(part.get("text", ""))
            else:
                parts.append(str(part))
        return "".join(parts)
    return content or ""


def _apply_usage(message, usage: dict) -> None:
    meta = getattr(message, "usage_metadata", None) or {}
    if meta:
        if meta.get("input_tokens") is not None:
            usage["input_tokens"] = meta["input_tokens"]
        elif meta.get("prompt_tokens") is not None:
            usage["input_tokens"] = meta["prompt_tokens"]
        if meta.get("output_tokens") is not None:
            usage["output_tokens"] = meta["output_tokens"]
        elif meta.get("completion_tokens") is not None:
            usage["output_tokens"] = meta["completion_tokens"]
    finish = (getattr(message, "response_metadata", None) or {}).get(
        "finish_reason")
    if finish:
        usage["finish"] = finish


def _attach(model, callback):
    if callback is None:
        return model
    model.callbacks = [*(getattr(model, "callbacks", None) or []), callback]
    return model


def _built_model(chat, key: str, model: str, reasoning: str,
                 headers: dict | None, *, levers=None, web_search: bool = False,
                 session_id: str = "", app_config=None, callback=None):
    if levers is None:
        lc = chat_model(
            api_key=key, model=model, base_url=getattr(chat, "base_url", ""),
            reasoning=reasoning, headers=headers, provider=provider_of(chat, model))
    else:
        from app.framework.llm import chat_model_for
        lc = chat_model_for(
            levers, web_search=web_search, streaming=True, config=app_config,
            session_id=session_id)
    return _attach(lc, callback)


async def complete_langchain(chat, key: str, model: str, system: str,
                             user: str, reasoning: str = "",
                             headers: dict | None = None, *, levers=None,
                             web_search: bool = False, session_id: str = "",
                             app_config=None, callback=None) -> ent.AICompletion:
    lc = _built_model(
        chat, key, model, reasoning, headers, levers=levers, web_search=web_search,
        session_id=session_id, app_config=app_config, callback=callback)
    messages = render_messages(system, user)
    result = await lc.ainvoke(messages)
    usage: dict = {}
    _apply_usage(result, usage)
    return ent.AICompletion(
        text=_content(result),
        input_tokens=usage.get("input_tokens", 0),
        output_tokens=usage.get("output_tokens", 0))


async def stream_langchain(chat, key: str, model: str, system: str, user: str,
                           usage: dict, reasoning: str = "",
                           headers: dict | None = None,
                           assistant_prefix: str = "", *, levers=None,
                           web_search: bool = False, session_id: str = "",
                           app_config=None, callback=None):
    lc = _built_model(
        chat, key, model, reasoning, headers, levers=levers, web_search=web_search,
        session_id=session_id, app_config=app_config, callback=callback)
    messages = render_messages(system, user, assistant_prefix)
    async for chunk in lc.astream(messages):
        _apply_usage(chunk, usage)
        text = _content(chunk)
        if text:
            yield text


async def complete_or_none(chat, key: str, model: str, system: str, user: str,
                           reasoning: str = "", headers: dict | None = None,
                           **factory):
    if not use_langchain() or not openai_compatible(chat):
        return None
    try:
        return await complete_langchain(
            chat, key, model, system, user, reasoning, headers, **factory)
    except ImportError:
        return None


def stream_or_none(chat, key: str, model: str, system: str, user: str,
                   usage: dict, reasoning: str = "",
                   headers: dict | None = None, assistant_prefix: str = "",
                   **factory):
    if not use_langchain() or not openai_compatible(chat):
        return None
    return stream_langchain(
        chat, key, model, system, user, usage, reasoning, headers,
        assistant_prefix, **factory)
