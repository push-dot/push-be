"""Production ``generate`` for employer nodes: LangChain structured output."""

from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage


def structured_generate(model):
    """Wrap a LangChain chat model (from ``chat_model_for``) as ``generate(schema, system, user)``.

    ``function_calling`` works across the OpenRouter models the employer plans use.
    """

    async def generate(schema, system: str, user: str):
        runnable = model.with_structured_output(schema, method="function_calling")
        result = await runnable.ainvoke([SystemMessage(content=system), HumanMessage(content=user)])
        return result if isinstance(result, schema) else schema.model_validate(result)

    return generate
