"""Production ``generate`` for employer nodes: LangChain structured output."""

from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

from app.framework.llm import astructured_reply
from app.framework.untrusted import DATA_RULE, as_data


def _messages(system: str, user: str) -> list:
    """A flow's user text is the posting, documents and profiles it works on: data only."""
    return [SystemMessage(content=system + "\n\n" + DATA_RULE),
            HumanMessage(content=as_data(user, "flow_input", None))]


def structured_generate(model):
    """Wrap a LangChain chat model (from ``chat_model_for``) as ``generate(schema, system, user)``.

    The schema is offered as a tool, not forced, so reasoning models can answer.
    """

    async def generate(schema, system: str, user: str):
        _raw, result = await astructured_reply(model, schema, _messages(system, user))
        if result is None:
            raise ValueError(f"model returned no {schema.__name__}")
        return result

    return generate


def gate_generate(model):
    """``generate`` over the turn's GateModel, so structured calls share the turn's metering."""
    structured = getattr(model, "astructured", None)
    if structured is None:
        return structured_generate(model)

    async def generate(schema, system: str, user: str):
        return await structured(schema, _messages(system, user))

    return generate
