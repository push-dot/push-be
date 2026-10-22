from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from app.harness.policy import Tier

if TYPE_CHECKING:
    from app.harness.core_client import CoreClient


@dataclass
class ToolContext:
    user_id: str
    company_id: str | None
    conversation_id: str
    job_id: str
    tool_call_id: str
    db: Any
    core: CoreClient


@dataclass(frozen=True)
class HarnessSpec:
    id: str
    audience: str
    prompt: str
    tools: list[ToolSpec]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    tier: Tier
    args_model: type[BaseModel]
    run: Callable[[ToolContext, BaseModel], Awaitable[dict]]
    summarize: Callable[[BaseModel], str]
