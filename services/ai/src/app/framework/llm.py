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
