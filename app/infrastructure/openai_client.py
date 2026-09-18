from __future__ import annotations
import json

import httpx

from app.domain import entities as ent


class OpenAIClient:
    def __init__(self, base_url: str = "https://api.openai.com/v1"):
        self._client = httpx.AsyncClient(timeout=60)
        self.base_url = base_url

    async def chat(self, api_key: str, model: str, system: str,
                   user: str) -> dict:
        messages = ([{"role": "system", "content": system}] if system else []) + [
            {"role": "user", "content": user}]
        resp = await self._client.post(
            self.base_url + "/chat/completions",
            json={"model": model, "messages": messages},
            headers={"Authorization": "Bearer " + api_key})
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
                          user: str, usage: dict):
        messages = ([{"role": "system", "content": system}] if system else []) + [
            {"role": "user", "content": user}]
        async with self._client.stream(
                "POST", self.base_url + "/chat/completions",
                json={"model": model, "messages": messages, "stream": True,
                      "stream_options": {"include_usage": True}},
                headers={"Authorization": "Bearer " + api_key}) as resp:
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
                    delta = (c.get("delta") or {}).get("content")
                    if delta:
                        yield delta

    async def aclose(self):
        await self._client.aclose()
