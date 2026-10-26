from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Annotated, Any
from uuid import UUID

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
