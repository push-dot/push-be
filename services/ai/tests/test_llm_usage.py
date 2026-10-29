from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk

from app.domain import entities as ent
from app.domain.plan_levers import levers_for
from tests.stubs import StubAiUsageStore


class _CountingUsage(StubAiUsageStore):
    def __init__(self):
        super().__init__()
        self.settles = 0
        self.releases = 0

    async def settle(self, *args):
        self.settles += 1
        await super().settle(*args)

    async def release(self, id_):
        self.releases += 1
        await super().release(id_)


class _StreamModel(BaseChatModel):
    fail: bool = False
    input_tokens: int = 11
    output_tokens: int = 7

    @property
    def _llm_type(self) -> str:
        return "scripted-stream"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        raise NotImplementedError

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        yield ChatGenerationChunk(message=AIMessageChunk(content="안"))
        if self.fail:
            raise RuntimeError("mid-stream")
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="녕",
                usage_metadata={
                    "input_tokens": self.input_tokens,
                    "output_tokens": self.output_tokens,
                    "total_tokens": self.input_tokens + self.output_tokens,
                },
            )
        )


def _reserved(user_id):
    return ent.AiUsage(
        id=uuid4(),
        user_id=user_id,
        provider="OPENAI",
        model="deepseek/deepseek-v4.1-flash",
        managed=True,
        input_tokens=4,
        output_tokens=2048,
        cost_micro_credits=9,
        status=ent.USAGE_RESERVED,
        created_at=datetime.now(UTC),
    )


async def _stream(model, callback):
    chunks = []
    async for chunk in model.astream("hi", config={"callbacks": [callback]}):
        chunks.append(chunk)
    return chunks


async def test_streamed_reply_with_usage_metadata_settles_one_row():
    from app.framework.llm import AiUsageCallback

    user_id = uuid4()
    store = _CountingUsage()
    row = _reserved(user_id)
    await store.create(row)
    callback = AiUsageCallback(store, user_id, "job-1", row.id)
    chunks = await _stream(_StreamModel(), callback)
    assert "".join(str(chunk.content) for chunk in chunks) == "안녕"
    assert store.settles == 1 and store.releases == 0
    assert len(store.items) == 1
    settled = store.items[0]
    assert settled.status == ent.USAGE_SETTLED
    assert (settled.input_tokens, settled.output_tokens) == (11, 7)
    assert settled.cost_micro_credits == ent.ai_cost_micro_credits("OPENAI", settled.model, 11, 7)
    run_id = next(iter(callback._runs))
    await callback.on_llm_end(object(), run_id=run_id)
    assert store.settles == 1
    assert (settled.input_tokens, settled.output_tokens) == (11, 7)


async def test_exception_mid_stream_releases_reservation_and_writes_no_settled_row():
    from app.framework.llm import AiUsageCallback

    user_id = uuid4()
    store = _CountingUsage()
    row = _reserved(user_id)
    await store.create(row)
    callback = AiUsageCallback(store, user_id, "job-1", row.id)
    with pytest.raises(RuntimeError, match="mid-stream"):
        await _stream(_StreamModel(fail=True), callback)
    assert store.settles == 0 and store.releases == 1
    assert len(store.items) == 1
    released = store.items[0]
    assert released.status == ent.USAGE_RELEASED
    assert released.cost_micro_credits == 0
    assert not any(item.status == ent.USAGE_SETTLED for item in store.items)
    await callback.on_llm_error(RuntimeError("again"), run_id=next(iter(callback._runs)))
    assert store.releases == 1


class _Recording:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


def test_free_plan_request_carries_deepseek_provider_order_and_ignore():
    from app.config import Config
    from app.framework.llm import chat_model_for

    config = Config(managed_ai_key="k")
    free = levers_for("PERSONAL", "FREE", config)
    model = chat_model_for(free, web_search=True, streaming=True, config=config, cls=_Recording)
    body = model.kwargs["extra_body"]
    assert model.kwargs["model"] == "deepseek/deepseek-v4.1-flash:online"
    assert body["provider"] == {
        "ignore": ["DeepSeek"],
        "order": ["Together", "Fireworks", "Novita"],
    }
    assert body["reasoning"] == {"effort": "low"}
    assert model.kwargs["timeout"] == 60
    assert model.kwargs["max_retries"] == 1
    assert model.kwargs["base_url"] == "https://openrouter.ai/api/v1"
    pro = chat_model_for(levers_for("PERSONAL", "PRO", config), config=config, cls=_Recording)
    assert "provider" not in (pro.kwargs.get("extra_body") or {})
