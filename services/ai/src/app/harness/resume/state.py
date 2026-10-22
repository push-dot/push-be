from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ResumeState(BaseModel):
    status: Literal["active", "done", "cancelled"] = "active"
    phase: Literal[
        "mode_select", "intake", "analyze", "strategy", "craft", "review", "publish", "present",
    ] = "mode_select"
    work_mode: Literal["resume_based", "experience_blueprint"] | None = None
    scenario: str | None = None
    inputs: dict = Field(default_factory=dict)
    analysis: dict = Field(default_factory=dict)
    strategy: dict = Field(default_factory=dict)
    drafts: dict = Field(default_factory=dict)
    review: dict = Field(default_factory=dict)
    artifacts: dict[str, str] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    access_mode: str = "AUTO"
    conversation_id: str = ""
    user_id: str = ""
    job_id: str = ""
