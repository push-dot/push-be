from __future__ import annotations

from datetime import datetime
from typing import ClassVar, Optional
from uuid import UUID

from pydantic import Field

from app.domain.entities.base import Model, OmitModel

EVENT_DOCUMENT_FINAL = "DOCUMENT_FINALIZED"


DOC_KINDS = {"RESUME", "PORTFOLIO", "COVER_LETTER", "CAREER_STATEMENT"}
DOC_TEMPLATE_ALIASES = {"CLASSIC": "SIMPLE", "COMPACT": "ATS"}
DOC_TEMPLATES = {"SIMPLE", "MODERN", "CREATIVE", "ATS"} | set(DOC_TEMPLATE_ALIASES)
DOC_TEMPLATE_MESSAGE = "must be SIMPLE, MODERN, CREATIVE, ATS, CLASSIC or COMPACT"
DOC_DRAFT = "DRAFT"
DOC_FINALIZED = "FINALIZED"
DOC_ARCHIVED = "ARCHIVED"
CLAIM_SUPPORTED = "SUPPORTED"
CLAIM_NEEDS_REVIEW = "NEEDS_REVIEW"
CLAIM_UNSUPPORTED = "UNSUPPORTED"
REVISION_ACTIONS = {"REWRITE", "SHORTEN", "EMPHASIZE_METRICS", "CHANGE_TONE", "TAILOR_TO_JOB"}


def valid_document_kind(k: str) -> bool:
    return k in DOC_KINDS


def valid_document_template(t: str) -> bool:
    return t in DOC_TEMPLATES


def stored_document_template(t: str) -> str:
    return DOC_TEMPLATE_ALIASES.get(t, t)


def valid_revision_action(a: str) -> bool:
    return a in REVISION_ACTIONS


class Document(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    revision: int = 1
    application_id: Optional[UUID] = None
    title: str
    kind: str
    template: str
    language: str = ""
    status: str = "DRAFT"
    latest_version_id: Optional[UUID] = None
    finalized_version_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime


class EvidenceRef(Model):
    evidence_id: UUID
    start: int
    end: int


class Block(Model):
    id: str
    text: str
    evidence_refs: list[EvidenceRef] = []
    claim_status: str = ""


class QualityIssue(OmitModel):
    _omit_none: ClassVar[frozenset] = frozenset({"block_id"})
    code: str
    severity: str
    block_id: Optional[str] = None
    message: str


class Quality(Model):
    job_fit: Optional[int] = None
    evidence_fidelity: Optional[int] = None
    readability: Optional[int] = None
    ats: Optional[int] = None
    method: str = "RULE_BASED"
    issues: list[QualityIssue] = []


class DocumentVersion(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    document_id: UUID
    application_id: Optional[UUID] = None
    number: int
    content: dict
    blocks: list[Block] = []
    change_note: str = ""
    quality: Quality = Field(default_factory=Quality)
    created_at: datetime


class Selection(Model):
    from_: int = Field(alias="from")
    to: int
    text: str


class RevisionProposal(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    document_id: UUID
    source_version_id: UUID
    source_revision: int
    selection: Selection
    replacement: str
    evidence_refs: list[EvidenceRef] = []
    claim_status: str = ""
    applied_at: Optional[datetime] = None
    created_at: datetime


class ExportValidation(Model):
    korean_text: bool
    links: bool
    ats_text: bool


class ExportResult(OmitModel):
    _omit_none: ClassVar[frozenset] = frozenset({"page_count", "error_code"})
    sha256: str
    byte_length: int
    page_count: Optional[int] = None
    validation: ExportValidation
    error_code: Optional[str] = None


class DocumentExport(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    document_id: UUID
    version_id: UUID
    format: str
    template: str
    language: str = ""
    content: dict
    blocks: list[Block] = []
    content_hash: str
    status: str = "READY_TO_RENDER"
    renderer_version: str
    result: Optional[ExportResult] = None
    created_at: datetime
    updated_at: datetime
