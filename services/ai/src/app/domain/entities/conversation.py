from __future__ import annotations

from datetime import datetime
from typing import ClassVar, Optional
from uuid import UUID

from pydantic import Field

from app.domain.entities.base import Model, OmitModel


class Conversation(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    revision: int = 1
    application_id: Optional[UUID] = None
    title: str = ""
    pinned: bool = False
    archived: bool = Field(default=False, exclude=True)
    created_at: datetime
    updated_at: datetime
    company_id: Optional[UUID] = Field(default=None, exclude=True)


class MessageAttachment(OmitModel):
    _omit_none: ClassVar[frozenset] = frozenset({"document_id", "title"})
    type: str
    id: UUID
    document_id: Optional[UUID] = None
    title: Optional[str] = None


class Message(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    conversation_id: UUID
    role: str
    text: str
    attachments: list[MessageAttachment] = []
    operation_id: Optional[UUID] = None
    created_at: datetime


ACCESS_MODES = {"SUGGEST", "CONFIRM_ACTIONS", "ALWAYS_ASK", "AUTO", "BYPASS"}


def valid_access_mode(m: str) -> bool:
    return m in ACCESS_MODES
