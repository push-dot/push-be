from __future__ import annotations

import asyncio
import json

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from app.domain import entities as ent
from app.harness.kstyle import stats
from app.harness.kstyle.stage import Task, run_stage
from app.harness.kstyle.subagent import LIGHT_MODEL, light_model, mid_model, single_call
from app.harness.model import GateModel, settle_turn
from tests.harness_fakes import USER, Gate, ScriptedLC, managed_ai


class _SlowGate(Gate):
    """Yields inside check and reserve, the way the real gate awaits the DB."""

    def __init__(self):
        super().__init__()
        self.checks = 0

    async def check(self, user_id, ai):
        self.checks += 1
        await asyncio.sleep(0.01)
        await super().check(user_id, ai)

    async def _reserve(self, *args, **kwargs):
        await asyncio.sleep(0.01)
        return await super()._reserve(*args, **kwargs)


def _main(gate, turn) -> GateModel:
    return GateModel(gate, USER, ent.AiOptions(**managed_ai()), "job", turn, cls=ScriptedLC)


async def test_three_parallel_first_calls_make_one_reservation():
    ScriptedLC.replies = []
    gate, turn = _SlowGate(), {}
    main = _main(gate, turn)
    light = light_model(main)
    await asyncio.gather(*(model.ainvoke([HumanMessage("hi")]) for model in (light, light, light)))
    assert len(gate.reserved) == 1 and gate.checks == 1
    assert turn["model"] == "anthropic/claude-sonnet-5-5" and main.ai.model == "anthropic/claude-sonnet-5-5"


async def test_usage_is_recorded_by_tier():
    ScriptedLC.replies = []
    turn: dict = {}
    main = _main(Gate(), turn)
    await main.ainvoke([HumanMessage("hi")])
    await light_model(main).ainvoke([HumanMessage("hi")])
    mid = mid_model(main)
    await mid.ainvoke([HumanMessage("hi")])
    await mid.bind_tools([]).ainvoke([HumanMessage("hi")])
    assert turn["tiers"] == {"main": {"calls": 1, "in": 10, "out": 5}, "light": {"calls": 1, "in": 10, "out": 5},
                             "mid": {"calls": 2, "in": 20, "out": 10}}
    assert (turn["input_tokens"], turn["output_tokens"]) == (40, 20)
    summary = stats.summary(turn)
    assert "lock" not in json.dumps(summary) and summary["tiers"]["mid"]["calls"] == 2


def test_derived_tiers_keep_the_turn_and_change_only_what_they_must():
    turn = {"checked": True}
    main = GateModel(Gate(), "u", ent.AiOptions(provider="OPENAI", model="anthropic/x", effort="HIGH",
                                                web_search=True), "job", turn)
    light, mid = light_model(main), mid_model(main)
    assert (light.tier, light.ai.model) == ("light", LIGHT_MODEL)
    assert (mid.tier, mid.ai.model, mid.ai.effort, mid.ai.web_search) == ("mid", "anthropic/x", "LOW", False)
    assert light.turn is turn and mid.turn is turn and main.tier == "main" and main.ai.effort == "HIGH"
    plain = object()
    assert light_model(plain) is None and mid_model(plain) is plain


def test_stage_marks():
    turn: dict = {}
    stats.mark(turn, "stage_one", 1.23456, ["company"])
    assert stats.summary(turn)["stages"] == [{"stage": "stage_one", "seconds": 1.235, "late": ["company"]}]


class _Rows:
    """ai_usage rows under the SQL status rules: settle RESERVED/SETTLED, release RESERVED."""

    def __init__(self):
        self.rows: dict = {}
        self.releases = 0

    async def settle(self, id_, input_tokens, output_tokens, cost, generation=None):
        row = self.rows[id_]
        if row["status"] in ("RESERVED", "SETTLED"):
            row.update(status="SETTLED", tokens=(input_tokens, output_tokens))

    async def release(self, id_, generation=None):
        self.releases += 1
        if self.rows[id_]["status"] == "RESERVED":
            self.rows[id_]["status"] = "RELEASED"


class _BilledGate(Gate):
    def __init__(self):
        super().__init__()
        self.usage = _Rows()
        self.reserved_models: list[str] = []

    async def _reserve(self, user_id, ai, *args, **kwargs):
        self.reserved_models.append(ai.model)
        usage_id = await super()._reserve(user_id, ai, *args, **kwargs)
        self.usage.rows[usage_id] = {"status": "RESERVED", "tokens": (0, 0)}
        return usage_id

    async def _settle(self, usage_id, model, input_tokens, output_tokens, generation=None):
        await self.usage.settle(usage_id, input_tokens, output_tokens, 0, generation)

    async def _release(self, usage_id, generation=None):
        await self.usage.release(usage_id, generation)


class _Provider(BaseChatModel):
    """A provider behind the real callback path: a system prompt holding "BOOM" fails the call."""

    @property
    def _llm_type(self) -> str:
        return "fake-provider"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if "BOOM" in str(messages[0].content):
            raise RuntimeError("provider down")
        usage = {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150}
        reply = AIMessage(content='{"ok": true}', usage_metadata=usage)
        return ChatResult(generations=[ChatGeneration(message=reply)])


def _provider(**_kwargs):
    return _Provider()


async def test_one_failed_subagent_call_does_not_free_the_turn():
    gate, turn = _BilledGate(), {}
    main = GateModel(gate, USER, ent.AiOptions(**managed_ai()), "job", turn, cls=_provider)
    light = light_model(main)
    staged = await run_stage([Task("bad", lambda: single_call(light, "BOOM", {})),
                              Task("good", lambda: single_call(light, "fine", {}))])
    assert staged["failed"] == ["bad"]
    await main.ainvoke([HumanMessage("hi")])
    await settle_turn(gate, turn, ok=True)
    assert gate.usage.rows[turn["usage_id"]] == {"status": "SETTLED", "tokens": (200, 100)}
    assert gate.usage.releases == 0


async def test_a_light_first_call_reserves_under_the_main_model():
    gate, turn = _BilledGate(), {}
    main = GateModel(gate, USER, ent.AiOptions(**managed_ai()), "job", turn, cls=_provider)
    await light_model(main).ainvoke([HumanMessage("hi")])
    await main.ainvoke([HumanMessage("hi")])
    assert gate.reserved_models == ["anthropic/claude-sonnet-5-5"]
