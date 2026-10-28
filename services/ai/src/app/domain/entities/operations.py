from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional
from uuid import UUID

from pydantic import Field

from app.domain.entities.base import Model

DEFAULT_APPROVAL_TTL = timedelta(hours=24)

EVENT_APPROVAL = "APPROVAL"


APPROVAL_KINDS = {"EVIDENCE_USE", "DOCUMENT_FINALIZE", "APPLICATION_SUBMIT", "CLI_EXECUTE"}
APPROVAL_EVIDENCE_USE = "EVIDENCE_USE"
APPROVAL_DOCUMENT_FINALIZE = "DOCUMENT_FINALIZE"
APPROVAL_APPLICATION_SUBMIT = "APPLICATION_SUBMIT"
APPROVAL_CLI_EXECUTE = "CLI_EXECUTE"
APPROVAL_PENDING = "PENDING"
APPROVAL_APPROVED = "APPROVED"
APPROVAL_DENIED = "DENIED"
APPROVAL_EXPIRED = "EXPIRED"
APPROVAL_CONSUMED = "CONSUMED"


def valid_approval_kind(k: str) -> bool:
    return k in APPROVAL_KINDS


def one_shot_approval(k: str) -> bool:
    return k != APPROVAL_EVIDENCE_USE


class Approval(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    revision: int = 1
    kind: str
    application_id: Optional[UUID] = None
    target_id: UUID
    target_revision: Optional[int] = None
    payload_hash: str
    status: str = "PENDING"
    expires_at: Optional[datetime] = None
    decided_at: Optional[datetime] = None
    consumed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    def expired(self, now: datetime) -> bool:
        return self.expires_at is not None and now > self.expires_at


OP_EVIDENCE_IMPORT = "EVIDENCE_IMPORT"
OP_JOB_ANALYSIS = "JOB_ANALYSIS"
OP_DOCUMENT_GENERATE = "DOCUMENT_GENERATE"
OP_DOCUMENT_REVISE = "DOCUMENT_REVISE"
OP_PROJECT_BLUEPRINTS = "PROJECT_BLUEPRINTS"
OP_PROJECT_VERIFY = "PROJECT_VERIFY"
OP_INTERVIEW_PREPARE = "INTERVIEW_PREPARE"
OP_RESUME_WORKFLOW = "RESUME_WORKFLOW"
OP_AI_GENERATE = "AI_GENERATE"
OP_CHAT_MESSAGE = "CHAT_MESSAGE"
OP_GOOGLE_SYNC = "GOOGLE_SYNC"
OP_APPLICATION_SUBMIT = "APPLICATION_SUBMIT"
OP_QUEUED = "QUEUED"
OP_RUNNING = "RUNNING"
OP_NEEDS_INPUT = "NEEDS_INPUT"
OP_SUCCEEDED = "SUCCEEDED"
OP_FAILED = "FAILED"
OP_CANCELLED = "CANCELLED"
TERMINAL_OP_STATUSES = {OP_SUCCEEDED, OP_FAILED, OP_CANCELLED}


def terminal_operation_status(s: str) -> bool:
    return s in TERMINAL_OP_STATUSES


class InputField(Model):
    name: str
    label: str
    type: str


class InputRequest(Model):
    code: str
    message: str
    fields: list[InputField]


class OperationError(Model):
    code: str
    message: str
    retryable: bool


class OperationResult(Model):
    kind: str
    value: Any


class Operation(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    type: str
    application_id: Optional[UUID] = None
    status: str
    progress: Optional[int] = None
    result: Optional[OperationResult] = None
    error: Optional[OperationError] = None
    input_request: Optional[InputRequest] = None
    pending_payload: Any = Field(default=None, exclude=True)
    created_at: datetime
    updated_at: datetime
