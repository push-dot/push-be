from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import Field

from app.domain.entities.base import Model

JOB_SOURCE_KINDS = {"URL", "TEXT", "DOM"}
METHOD_RULE_BASED = "RULE_BASED"
METHOD_AI_ASSISTED = "AI_ASSISTED"


def valid_job_source_kind(k: str) -> bool:
    return k in JOB_SOURCE_KINDS


class JobPosting(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    revision: int = 1
    company: str
    title: str
    source_kind: str
    source_url: Optional[str] = None
    source_text: str
    requirements: list[str] = []
    preferred: list[str] = []
    keywords: list[str] = []
    risks: list[str] = []
    deadline: Optional[datetime] = None
    language: str = ""
    archived: bool = False
    created_at: datetime
    updated_at: datetime


class RequirementMatch(Model):
    requirement: str
    evidence_ids: list[str]


class GapAnalysis(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    application_id: UUID
    job_id: UUID
    job_revision: int
    evidence_ids: list[UUID] = []
    matched: list[RequirementMatch] = []
    missing: list[str] = []
    preferred_missing: list[str] = []
    risks: list[str] = []
    fit_score: Optional[int] = None
    method: str
    stale: bool = False
    part_scores: dict = Field(default_factory=dict)
    created_at: datetime
