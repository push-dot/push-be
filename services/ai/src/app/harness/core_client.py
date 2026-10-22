from __future__ import annotations

from uuid import NAMESPACE_URL, uuid5

import httpx


class CoreError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def idempotency_key(job_id: str, tool_call_id: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"{job_id}:{tool_call_id}"))


class CoreClient:
    def __init__(self, origin: str, secret: str, transport: httpx.BaseTransport | None = None):
        self.origin = origin.rstrip("/")
        self.secret = secret
        self._transport = transport

    async def call(
        self,
        method: str,
        path: str,
        *,
        user_id: str,
        company_id: str | None = None,
        json: dict | None = None,
        idempotency_key: str | None = None,
    ) -> dict:
        headers = {
            "x-push-internal-secret": self.secret,
            "x-push-act-as": user_id,
        }
        if company_id:
            headers["x-push-company"] = company_id
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        async with httpx.AsyncClient(transport=self._transport, timeout=15.0) as client:
            response = await client.request(method, self.origin + path, headers=headers, json=json)
        if response.status_code == 204:
            return {}
        body: object = {}
        if response.content:
            try:
                body = response.json()
            except ValueError:
                body = {}
        if 400 <= response.status_code < 500:
            err = body.get("error") if isinstance(body, dict) else None
            err = err if isinstance(err, dict) else {}
            raise CoreError(
                response.status_code,
                str(err.get("code") or ""),
                str(err.get("message") or ""),
            )
        response.raise_for_status()
        if isinstance(body, dict) and "data" in body:
            data = body["data"]
            return data if isinstance(data, dict) else {"data": data}
        return body if isinstance(body, dict) else {}
