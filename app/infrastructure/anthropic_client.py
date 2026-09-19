from __future__ import annotations
import json
from typing import Optional

import httpx

from app.domain import entities as ent

_ANTHROPIC_VERSION = "2023-06-01"
_MAX_TOKENS = 8192


class AnthropicClient:
    def __init__(self, base_url: str = "https://api.anthropic.com"):
        self._client = httpx.AsyncClient(timeout=60)
        self.base_url = base_url

    def _headers(self, api_key: str,
                 extra_headers: Optional[dict] = None) -> dict:
        headers = {"x-api-key": api_key,
                   "anthropic-version": _ANTHROPIC_VERSION}
        headers.update(extra_headers or {})
        return headers

    def _body(self, model: str, system: str, user: str,
              stream: bool) -> dict:
        body = {"model": model, "max_tokens": _MAX_TOKENS,
                "messages": [{"role": "user", "content": user}]}
        if system:
            body["system"] = system
        if stream:
            body["stream"] = True
        return body

    async def chat(self, api_key: str, model: str, system: str,
                   user: str, reasoning: str = "",
                   extra_headers: Optional[dict] = None) -> ent.AICompletion:
        resp = await self._client.post(
            self.base_url + "/v1/messages",
            json=self._body(model, system, user, False),
            headers=self._headers(api_key, extra_headers))
        body = resp.json()
        if resp.status_code != 200:
            msg = (body.get("error") or {}).get("message") or \
                f"anthropic status {resp.status_code}"
            raise ValueError(msg)
        text = "".join(
            b.get("text", "") for b in body.get("content", [])
            if b.get("type") == "text")
        usage = body.get("usage") or {}
        return ent.AICompletion(
            text=text,
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0))

    async def chat_stream(self, api_key: str, model: str, system: str,
                          user: str, usage: dict, reasoning: str = "",
                          extra_headers: Optional[dict] = None):
        async with self._client.stream(
                "POST", self.base_url + "/v1/messages",
                json=self._body(model, system, user, True),
                headers=self._headers(api_key, extra_headers)) as resp:
            if resp.status_code != 200:
                await resp.aread()
                body = resp.json()
                msg = (body.get("error") or {}).get("message") or \
                    f"anthropic status {resp.status_code}"
                raise ValueError(msg)
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                chunk = json.loads(line[5:].strip())
                kind = chunk.get("type")
                if kind == "message_start":
                    u = (chunk.get("message") or {}).get("usage") or {}
                    usage["input_tokens"] = u.get("input_tokens", 0)
                elif kind == "content_block_delta":
                    delta = (chunk.get("delta") or {}).get("text")
                    if delta:
                        yield delta
                elif kind == "message_delta":
                    u = chunk.get("usage") or {}
                    usage["output_tokens"] = u.get("output_tokens", 0)

    async def list_models(self, api_key: str) -> list[str]:
        resp = await self._client.get(
            self.base_url + "/v1/models",
            headers=self._headers(api_key))
        body = resp.json()
        if resp.status_code != 200:
            msg = (body.get("error") or {}).get("message") or \
                f"anthropic status {resp.status_code}"
            raise ValueError(msg)
        return sorted(m["id"] for m in body.get("data", []) if m.get("id"))

    async def aclose(self):
        await self._client.aclose()
