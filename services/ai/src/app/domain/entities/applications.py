from __future__ import annotations

from datetime import datetime
from typing import ClassVar, Optional
from uuid import UUID

from pydantic import Field

from app.domain.entities.base import Model, OmitModel

EVENT_STAGE_CHANGED = "STAGE_CHANGED"
EVENT_IMPORTED = "IMPORTED"
EVENT_SUBMISSION = "SUBMISSION"


STAGE_ORDER = ["DISCOVERED", "PREPARING", "READY", "APPLIED", "SCREENING", "INTERVIEW", "OFFER", "ACCEPTED"]
STAGE_REJECTED = "REJECTED"
STAGE_WITHDRAWN = "WITHDRAWN"
STAGE_APPLIED = "APPLIED"
TERMINAL_STAGES = {"ACCEPTED", "REJECTED", "WITHDRAWN"}


def _stage_index(s: str) -> int:
    try:
        return STAGE_ORDER.index(s)
    except ValueError:
        return -1


def valid_stage(s: str) -> bool:
    return _stage_index(s) >= 0 or s in ("REJECTED", "WITHDRAWN")


def terminal_stage(s: str) -> bool:
    return s in TERMINAL_STAGES


def can_patch_stage(frm: str, to: str) -> bool:
    if frm == to:
        return True
    if terminal_stage(frm):
        return False
    if to in ("REJECTED", "WITHDRAWN"):
        return True
    if to == "APPLIED":
        return False
    return _stage_index(to) == _stage_index(frm) + 1


def next_stage(s: str) -> str | None:
    i = _stage_index(s)
    if i < 0 or i + 1 >= len(STAGE_ORDER):
        return None
    return STAGE_ORDER[i + 1]


def stage_after_applied(s: str) -> bool:
    return s in ("SCREENING", "INTERVIEW", "OFFER")


class Application(OmitModel):
    _omit_none: ClassVar[frozenset] = frozenset({"fit_score"})
    id: UUID
    user_id: UUID = Field(exclude=True)
    revision: int = 1
    job_id: UUID
    company: str
    title: str
    stage: str = "DISCOVERED"
    notes: str = ""
    applied_at: Optional[datetime] = None
    next_action_at: Optional[datetime] = None
    imported: bool = False
    fit_score: Optional[int] = None
    created_at: datetime
    updated_at: datetime


class ApplicationEvent(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    application_id: UUID
    type: str
    payload: dict = {}
    created_at: datetime


class SubmissionDraft(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    application_id: UUID
    application_revision: int
    mode: str
    adapter: Optional[str] = None
    document_version_ids: list[UUID] = []
    confirmed_submitted: bool = False
    payload_hash: str
    created_at: datetime


class Submission(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    application_id: UUID
    mode: str
    adapter: Optional[str] = None
    status: str
    document_version_ids: list[UUID] = []
    approval_id: Optional[UUID] = None
    receipt_url: Optional[str] = None
    error_code: Optional[str] = None
    created_at: datetime
    updated_at: datetime
