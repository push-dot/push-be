from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field

from app.domain.entities.base import Model

EVIDENCE_KINDS = {"RESUME", "GITHUB", "CAREER", "EDUCATION", "SKILL", "PROJECT"}
VERIFICATION_USER_PROVIDED = "USER_PROVIDED"
VERIFICATION_PENDING = "PENDING"
VERIFICATION_VERIFIED = "VERIFIED"
VERIFICATION_REJECTED = "REJECTED"


def valid_evidence_kind(k: str) -> bool:
    return k in EVIDENCE_KINDS


class SourceLocation(Model):
    start: int
    end: int
    unit: str


class Provenance(Model):
    source_id: Optional[UUID] = None
    project_evidence_id: Optional[UUID] = None
    content_hash: str = ""
    source_location: Optional[SourceLocation] = None


class CareerEvidence(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    revision: int = 1
    kind: str
    title: str
    source_text: str
    source_url: Optional[str] = None
    skills: list[str] = []
    verification_status: str = "USER_PROVIDED"
    provenance: Provenance = Field(default_factory=Provenance)
    supersedes_id: Optional[UUID] = None
    archived: bool = False
    created_at: datetime
    updated_at: datetime


class Source(BaseModel):
    id: UUID
    user_id: UUID
    file_name: str
    mime_type: str
    size: int
    sha256: str
    path: str
    status: str = "STORED"
    created_at: datetime
