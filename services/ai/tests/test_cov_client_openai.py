"""OpenAIClient against httpx.MockTransport: managed chat, streaming chat and
embeddings (the paths AIGate uses with the managed key)."""
from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from app.domain import entities as ent
from app.infrastructure.openai_client import (
    OpenAIClient, completion_body, stream_body,
)

KEY = "sk-test-not-a-real-key"
BASE = "https://llm.example.test/v1"
FREE = "deepseek/deepseek-v4.1-flash"
EMBED = "openai/text-embedding-3-small"
PIN = {"allow_fallbacks": False, "data_collection": "deny"}


def _client(handler, config=None):
    c = OpenAIClient(base_url=BASE, config=config)
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return c


def _capture(response):
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        return response(req) if callable(response) else response
    return handler, seen


def _sse(*lines: str) -> httpx.Response:
    return httpx.Response(200, content=("\n".join(lines) + "\n").encode(),
                          headers={"content-type": "text/event-stream"})


# ---------- request bodies ----------

def test_completion_body_pins_providers_and_adds_reasoning_only_when_set():
    msgs = [{"role": "user", "content": "hi"}]
    provider = {"only": ["together", "fireworks", "novita"], **PIN}
    assert completion_body(FREE, msgs) == {"model": FREE, "messages": msgs, "provider": provider}
    assert completion_body(FREE, msgs, "high") == {
        "model": FREE, "messages": msgs, "reasoning": {"effort": "high"}, "provider": provider}


def test_stream_body_requests_usage_and_large_budget():
    b = stream_body(FREE, [], "")
    assert b["stream"] is True
    assert b["stream_options"] == {"include_usage": True}
    assert b["max_tokens"] == 65536
    assert "reasoning" not in b


# ---------- chat ----------

async def test_chat_sends_auth_messages_and_parses_usage():
    handler, seen = _capture(httpx.Response(200, json={
        "choices": [{"message": {"content": "hello"}}],
        "usage": {"prompt_tokens": 11, "completion_tokens": 7}}))
    c = _client(handler)
    out = await c.chat(KEY, "anthropic/claude-sonnet-5-5", "be brief", "hi", "low",
                       {"X-Title": "push"})
    assert isinstance(out, ent.AICompletion)
    assert (out.text, out.input_tokens, out.output_tokens) == ("hello", 11, 7)
    req = seen[0]
    assert req.method == "POST" and str(req.url) == BASE + "/chat/completions"
    assert req.headers["authorization"] == "Bearer " + KEY
    assert req.headers["x-title"] == "push"
    body = json.loads(req.content)
    assert body == {"model": "anthropic/claude-sonnet-5-5", "reasoning": {"effort": "low"},
                    "provider": {"only": ["anthropic"], **PIN},
                    "messages": [{"role": "system", "content": "be brief"},
                                 {"role": "user", "content": "hi"}]}
    await c.aclose()


async def test_chat_omits_empty_system_and_defaults_usage_to_zero():
    handler, seen = _capture(httpx.Response(200, json={
        "choices": [{"message": {"content": "x"}}]}))
    out = await _client(handler).chat(KEY, FREE, "", "hi")
    assert json.loads(seen[0].content)["messages"] == [
        {"role": "user", "content": "hi"}]
    assert (out.input_tokens, out.output_tokens) == (0, 0)


async def test_chat_pins_us_providers_and_exa_search_on_every_request():
    handler, seen = _capture(httpx.Response(200, json={
        "choices": [{"message": {"content": "x"}}]}))
    c = _client(handler)
    await c.chat(KEY, FREE + ":online", "", "hi")
    await c.chat(KEY, "anthropic/claude-opus-5-5", "", "hi")
    first, second = (json.loads(r.content) for r in seen)
    assert first["provider"] == {"only": ["together", "fireworks", "novita"], **PIN}
    assert first["plugins"] == [{"id": "web", "engine": "exa"}]
    assert second["provider"] == {"only": ["anthropic"], **PIN}
    assert "plugins" not in second


async def test_chat_refuses_a_model_without_pinned_providers_before_sending():
    handler, seen = _capture(httpx.Response(200, json={}))
    with pytest.raises(Exception, match="no approved provider"):
        await _client(handler).chat(KEY, "example/unpinned-model", "", "hi")
    assert seen == []


@pytest.mark.parametrize("status,body,msg", [
    (401, {"error": {"message": "bad key"}}, "bad key"),
    (429, {"error": {}}, "openai status 429"),
    (500, {}, "openai status 500"),
])
async def test_chat_maps_error_status_to_value_error(status, body, msg):
    handler, _ = _capture(httpx.Response(status, json=body))
    with pytest.raises(ValueError, match=msg):
        await _client(handler).chat(KEY, FREE, "", "hi")


async def test_chat_without_choices_is_an_error():
    handler, _ = _capture(httpx.Response(200, json={"choices": []}))
    with pytest.raises(ValueError, match="no choices"):
        await _client(handler).chat(KEY, FREE, "", "hi")


async def test_chat_non_json_gateway_page_raises_value_error():
    handler, _ = _capture(httpx.Response(502, content=b"<html>bad gateway"))
    with pytest.raises(ValueError):
        await _client(handler).chat(KEY, FREE, "", "hi")


async def test_chat_timeout_propagates_to_caller():
    def handler(req):
        raise httpx.ReadTimeout("slow", request=req)
    with pytest.raises(httpx.TimeoutException):
        await _client(handler).chat(KEY, FREE, "", "hi")


# ---------- chat_stream ----------

async def test_chat_stream_yields_deltas_and_records_usage_and_finish():
    handler, seen = _capture(_sse(
        ": OPENROUTER PROCESSING",
        "",
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
        "data: [DONE]",
        'data: {"choices":[{"delta":{"content":"after done"}}]}',
    ))
    usage: dict = {}
    c = _client(handler)
    toks = [t async for t in c.chat_stream(KEY, FREE, "sys", "hi", usage, "high")]
    assert toks == ["Hel", "lo"]
    assert usage == {"input_tokens": 5, "output_tokens": 2, "finish": "stop"}
    body = json.loads(seen[0].content)
    assert body["stream"] is True and body["reasoning"] == {"effort": "high"}
    assert body["messages"][0] == {"role": "system", "content": "sys"}
    assert seen[0].headers["authorization"] == "Bearer " + KEY


async def test_chat_stream_continuation_appends_prefix_and_resume_turn():
    handler, seen = _capture(_sse("data: [DONE]"))
    usage: dict = {}
    toks = [t async for t in _client(handler).chat_stream(
        KEY, FREE, "", "write", usage, assistant_prefix="half")]
    assert toks == [] and usage == {}
    msgs = json.loads(seen[0].content)["messages"]
    assert msgs[0] == {"role": "user", "content": "write"}
    assert msgs[1] == {"role": "assistant", "content": "half"}
    assert msgs[2]["role"] == "user"
    assert len(msgs) == 3


async def test_chat_stream_records_length_cutoff():
    handler, _ = _capture(_sse(
        'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"length"}]}'))
    usage: dict = {}
    toks = [t async for t in _client(handler).chat_stream(KEY, FREE, "", "u", usage)]
    assert toks == ["x"] and usage["finish"] == "length"


@pytest.mark.parametrize("status,body,msg", [
    (400, {"error": {"message": "context too long"}}, "context too long"),
    (503, {}, "openai status 503"),
])
async def test_chat_stream_error_status_raises_before_yielding(status, body, msg):
    handler, _ = _capture(httpx.Response(status, json=body))
    gen = _client(handler).chat_stream(KEY, FREE, "", "u", {})
    with pytest.raises(ValueError, match=msg):
        await gen.__anext__()


# ---------- embed ----------

async def test_embed_posts_inputs_and_restores_input_order():
    handler, seen = _capture(httpx.Response(200, json={"data": [
        {"index": 1, "embedding": [0.2]}, {"index": 0, "embedding": [0.1]}]}))
    out = await _client(handler).embed(KEY, "openai/text-embedding-3-small",
                                       ["a", "b"])
    assert out == [[0.1], [0.2]]
    req = seen[0]
    assert str(req.url) == BASE + "/embeddings"
    assert req.headers["authorization"] == "Bearer " + KEY
    assert json.loads(req.content) == {
        "model": "openai/text-embedding-3-small", "input": ["a", "b"],
        "provider": {"only": ["openai"], **PIN}}


async def test_embed_empty_data_returns_empty_list():
    handler, _ = _capture(httpx.Response(200, json={"data": None}))
    assert await _client(handler).embed(KEY, EMBED, ["a"]) == []


@pytest.mark.parametrize("status,body,msg", [
    (401, {"error": {"message": "no auth"}}, "no auth"),
    (500, {}, "embeddings status 500"),
])
async def test_embed_error_status(status, body, msg):
    handler, _ = _capture(httpx.Response(status, json=body))
    with pytest.raises(ValueError, match=msg):
        await _client(handler).embed(KEY, EMBED, ["a"])
