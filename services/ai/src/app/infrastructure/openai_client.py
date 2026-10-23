from __future__ import annotations
import json
from typing import Optional

import httpx

from app.domain import entities as ent
from app.domain.plan_levers import provider_for


def completion_body(model: str, messages: list, reasoning: str = "",
                    provider: dict | None = None) -> dict:
    body = {"model": model, "messages": messages}
    if reasoning:
        body["reasoning"] = {"effort": reasoning}
    if provider:
        body["provider"] = provider
    return body


def stream_body(model: str, messages: list, reasoning: str,
                provider: dict | None = None) -> dict:
    body = completion_body(model, messages, reasoning, provider)
    body["stream"] = True
    body["stream_options"] = {"include_usage": True}
    body["max_tokens"] = 65536
    return body


class OpenAIClient:
    def __init__(self, base_url: str = "https://api.openai.com/v1", config=None):
        self._client = httpx.AsyncClient(timeout=60)
        self.base_url = base_url
        self.config = config

    def _provider(self, model: str):
        if self.config is None:
            return None
        return provider_for(model, self.config)

    async def chat(self, api_key: str, model: str, system: str,
                   user: str, reasoning: str = "",
                   extra_headers: Optional[dict] = None) -> dict:
        messages = ([{"role": "system", "content": system}] if system else []) + [
            {"role": "user", "content": user}]
        body = completion_body(model, messages, reasoning, self._provider(model))
        headers = {"Authorization": "Bearer " + api_key}
        headers.update(extra_headers or {})
        resp = await self._client.post(
            self.base_url + "/chat/completions",
            json=body,
            headers=headers)
        body = resp.json()
        if resp.status_code != 200:
            msg = (body.get("error") or {}).get("message") or \
                f"openai status {resp.status_code}"
            raise ValueError(msg)
        if not body.get("choices"):
            raise ValueError("openai returned no choices")
        return ent.AICompletion(
            text=body["choices"][0]["message"]["content"],
            input_tokens=(body.get("usage") or {}).get("prompt_tokens", 0),
            output_tokens=(body.get("usage") or {}).get("completion_tokens", 0))

    async def chat_stream(self, api_key: str, model: str, system: str,
                          user: str, usage: dict, reasoning: str = "",
                          extra_headers: Optional[dict] = None,
                          assistant_prefix: str = ""):
        messages = ([{"role": "system", "content": system}] if system else []) + [
            {"role": "user", "content": user}]
        if assistant_prefix:
            messages += [{"role": "assistant", "content": assistant_prefix},
                         {"role": "user", "content": "끊긴 지점부터 이어서 작성해."}]
        headers = {"Authorization": "Bearer " + api_key}
        headers.update(extra_headers or {})
        async with self._client.stream(
                "POST", self.base_url + "/chat/completions",
                json=stream_body(model, messages, reasoning, self._provider(model)),
                headers=headers) as resp:
            if resp.status_code != 200:
                await resp.aread()
                body = resp.json()
                msg = (body.get("error") or {}).get("message") or \
                    f"openai status {resp.status_code}"
                raise ValueError(msg)
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                chunk = json.loads(payload)
                if chunk.get("usage"):
                    usage["input_tokens"] = chunk["usage"].get("prompt_tokens", 0)
                    usage["output_tokens"] = chunk["usage"].get(
                        "completion_tokens", 0)
                for c in chunk.get("choices") or []:
                    if c.get("finish_reason"):
                        usage["finish"] = c["finish_reason"]
                    delta = (c.get("delta") or {}).get("content")
                    if delta:
                        yield delta

    async def embed(self, api_key: str, model: str,
                    texts: list[str]) -> list[list[float]]:
        resp = await self._client.post(
            self.base_url + "/embeddings",
            json={"model": model, "input": texts},
            headers={"Authorization": "Bearer " + api_key})
        body = resp.json()
        if resp.status_code != 200:
            msg = (body.get("error") or {}).get("message") or \
                f"embeddings status {resp.status_code}"
            raise ValueError(msg)
        data = sorted(body.get("data") or [], key=lambda d: d["index"])
        return [d["embedding"] for d in data]

    async def aclose(self):
        await self._client.aclose()
