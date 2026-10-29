from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Annotated, Any
from uuid import UUID

from langchain_core.runnables.config import RunnableConfig, ensure_config, merge_configs
from langchain_core.tools import StructuredTool
from langgraph.config import get_stream_writer
from langgraph.errors import GraphBubbleUp
from pydantic import BaseModel, BeforeValidator

from app.domain.errors import DomainError
from app.harness.core_client import CoreError
from app.harness.policy import Tier

if TYPE_CHECKING:
    from app.harness.core_client import CoreClient

# Models send "" for "no id"; keep that meaning while still rejecting non-UUID text.
OptionalId = Annotated[UUID | None, BeforeValidator(lambda value: value or None)]


@dataclass
class ToolContext:
    user_id: str
    company_id: str | None
    conversation_id: str
    job_id: str
    tool_call_id: str
    db: Any
    core: CoreClient
    access_mode: str = "AUTO"
    inputs: dict = field(default_factory=dict)


@dataclass(frozen=True)
class HarnessSpec:
    id: str
    prompt: str
    tools: list[ToolSpec]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    tier: Tier
    args_model: type[BaseModel]
    run: Callable[[ToolContext, BaseModel], Awaitable[dict]]
    summarize: Callable[[BaseModel], str]
    approval_kind: str = "TOOL_ACTION"


def emit(event: dict) -> None:
    try:
        get_stream_writer()(event)
    except Exception:
        return


async def run_tool(tool: ToolSpec, ctx: ToolContext, args: BaseModel) -> tuple[dict, bool]:
    """Every failure becomes a result, so no tool call is left without a ToolMessage."""
    try:
        return await tool.run(ctx, args), True
    except GraphBubbleUp:
        raise
    except (CoreError, DomainError) as err:
        return {"error": err.code}, False
    except Exception:
        logging.getLogger(__name__).warning("tool %s failed", tool.name, exc_info=True)
        return {"error": "TOOL_FAILED"}, False


class _ToolDone:
    def __init__(self, result: dict, ok: bool):
        self.result = result
        self.ok = ok


def _description(spec: ToolSpec) -> str:
    try:
        text = spec.summarize(None)
    except Exception:
        text = ""
    if isinstance(text, str) and text.strip():
        return text
    return spec.name.replace("_", " ")


def to_structured_tool(spec: ToolSpec) -> StructuredTool:
    async def _run(config: RunnableConfig, **kwargs):
        ctx = config["configurable"]["tool_context"]
        args = spec.args_model.model_validate(kwargs)
        result, ok = await run_tool(spec, ctx, args)
        return _ToolDone(result, ok)

    return StructuredTool.from_function(
        coroutine=_run,
        name=spec.name,
        description=_description(spec),
        args_schema=spec.args_model,
        infer_schema=False,
        metadata={
            "tier": spec.tier,
            "approval_kind": spec.approval_kind,
            "summary": spec.summarize,
        },
    )


async def call_structured(spec: ToolSpec, args: BaseModel, ctx: ToolContext) -> tuple[dict, bool]:
    config = merge_configs(ensure_config(), {"configurable": {"tool_context": ctx}})
    done = await to_structured_tool(spec).ainvoke(args.model_dump(mode="json"), config)
    return done.result, done.ok
