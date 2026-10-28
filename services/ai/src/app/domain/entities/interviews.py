from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import Field

from app.domain.entities.base import Model

EVENT_INTERVIEW = "INTERVIEW"


class CompanySource(Model):
    source_url: str
    source_text: str
    accessed_at: datetime


class InterviewSession(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    revision: int = 1
    application_id: UUID
    title: str
    scheduled_at: datetime
    duration_minutes: Optional[int] = None
    event_id: Optional[UUID] = None
    evidence_ids: list[UUID] = []
    company_sources: list[CompanySource] = []
    notes: str = ""
    reflection: str = ""
    created_at: datetime
    updated_at: datetime


CAL_EVENT_TYPES = {"INTERVIEW", "DEADLINE", "FOLLOW_UP", "CUSTOM"}
EVENT_SOURCE_LOCAL = "LOCAL"
EVENT_SOURCE_GOOGLE = "GOOGLE"


def valid_event_type(t: str) -> bool:
    return t in CAL_EVENT_TYPES


class CalendarEvent(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    revision: int = 1
    application_id: Optional[UUID] = None
    type: str
    title: str
    starts_at: datetime
    ends_at: datetime
    time_zone: str = "UTC"
    source: str = "LOCAL"
    external_id: Optional[str] = None
    notes: str = ""
    created_at: datetime
    updated_at: datetime
