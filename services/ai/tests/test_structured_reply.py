from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from pydantic import BaseModel

from app.framework.llm import astructured_reply, parse_structured


class Verdict(BaseModel):
    score: int
    note: str


class _Model:
    def __init__(self, reply):
        self.reply = reply
        self.bound = None
        self.seen = None

    def bind_tools(self, tools, **kwargs):
        self.bound = (tools, kwargs)
        return self

    async def ainvoke(self, messages, **kwargs):
        self.seen = messages
        return self.reply


async def test_schema_is_offered_not_forced():
    # Anthropic rejects a forced tool_choice while extended thinking is on.
    model = _Model(AIMessage(content="", tool_calls=[
        {"name": "Verdict", "id": "c1", "args": {"score": 7, "note": "ok"}}]))
    raw, parsed = await astructured_reply(
        model, Verdict, [SystemMessage(content="평가한다"), HumanMessage(content="서류")])
    assert model.bound == ([Verdict], {"tool_choice": "auto"})
    assert model.seen[0].content.startswith("평가한다\n\n")
    assert "`Verdict` 도구를 한 번 호출" in model.seen[0].content
    assert model.seen[1].content == "서류"
    assert raw is model.reply
    assert parsed == Verdict(score=7, note="ok")


async def test_rule_is_added_when_there_is_no_system_message():
    model = _Model(AIMessage(content='{"score": 1, "note": "x"}'))
    await astructured_reply(model, Verdict, [HumanMessage(content="서류")])
    assert isinstance(model.seen[0], SystemMessage)
    assert model.seen[1].content == "서류"


def test_text_json_is_the_fallback():
    reply = AIMessage(content='결과예요.\n{"score": 3, "note": "부족"}\n끝')
    assert parse_structured(reply, Verdict) == Verdict(score=3, note="부족")


def test_text_blocks_are_read():
    reply = AIMessage(content=[{"type": "text", "text": '{"score": 4, "note": "a"}'}])
    assert parse_structured(reply, Verdict) == Verdict(score=4, note="a")


def test_unreadable_answers_are_none():
    assert parse_structured(AIMessage(content="모르겠어요"), Verdict) is None
    assert parse_structured(AIMessage(content='{"score": "많이"}'), Verdict) is None
    bad = AIMessage(content="", tool_calls=[{"name": "Verdict", "id": "c", "args": {"x": 1}}])
    assert parse_structured(bad, Verdict) is None
