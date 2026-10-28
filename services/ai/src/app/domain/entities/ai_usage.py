from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field

from app.domain.entities.base import Model

AI_PROVIDERS = {"OPENAI", "OPENROUTER", "CLAUDE", "GEMINI", "GROK"}
EFFORTS = {"LOW", "MEDIUM", "HIGH", "MAX"}


def valid_ai_provider(p: str) -> bool:
    return p in AI_PROVIDERS


def valid_effort(e: str) -> bool:
    return e in EFFORTS


class AiOptions(Model):
    provider: str
    model: str
    effort: str
    ultra_resume: bool = False
    web_search: bool = False
    models: dict = {}


class AIModelInfo(BaseModel):
    provider: str
    model: str
    label: str


OPENAI_MODELS = [
    AIModelInfo(provider="OPENAI", model="deepseek/deepseek-v4.1-flash",
                label="DeepSeek V4.1 Flash"),
    AIModelInfo(provider="OPENAI", model="opencode-go/deepseek-v4.1-flash",
                label="DeepSeek V4.1 Flash Go"),
    AIModelInfo(provider="OPENAI", model="openai/gpt-5.6-luna",
                label="GPT-5.6 Luna"),
    AIModelInfo(provider="OPENAI", model="openai/gpt-5.6-terra",
                label="GPT-5.6 Terra"),
    AIModelInfo(provider="OPENAI", model="openai/gpt-5.6-sol",
                label="GPT-5.6 Sol"),
]

_DEFAULT_MICRO_PER_1M = (2_000_000, 8_000_000)


def ai_cost_micro_credits(provider: str, model: str, in_tokens: int, out_tokens: int) -> int:
    if provider != "OPENAI":
        return 0
    rates = _DEFAULT_MICRO_PER_1M
    return (in_tokens * rates[0] + out_tokens * rates[1]) // 1_000_000


USAGE_RESERVED = "RESERVED"
USAGE_SETTLED = "SETTLED"
USAGE_RELEASED = "RELEASED"
USAGE_EXPIRED = "EXPIRED"


class AiUsage(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    operation_id: Optional[UUID] = None
    provider: str
    model: str
    managed: bool
    input_tokens: int
    output_tokens: int
    cost_micro_credits: int
    status: str
    created_at: datetime


class AICompletion(BaseModel):
    text: str
    input_tokens: int
    output_tokens: int
    usage_id: Optional[UUID] = None
