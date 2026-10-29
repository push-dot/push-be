"""Production ``generate`` for employer nodes: LangChain structured output."""

from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

from app.framework.llm import astructured_reply


def structured_generate(model):
    """Wrap a LangChain chat model (from ``chat_model_for``) as ``generate(schema, system, user)``.

    The schema is offered as a tool, not forced, so reasoning models can answer.
    """

    async def generate(schema, system: str, user: str):
        messages = [SystemMessage(content=system), HumanMessage(content=user)]
        _raw, result = await astructured_reply(model, schema, messages)
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
        return await structured(schema, [SystemMessage(content=system), HumanMessage(content=user)])

    return generate
