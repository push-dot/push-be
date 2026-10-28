from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field

from app.domain.entities.base import Model

INTEGRATION_CODE_TTL = timedelta(seconds=60)

GOOGLE_CALLBACK_URI = "push://integrations/google/callback"

OAUTH_PURPOSE_GOOGLE = "GOOGLE"

GOOGLE_SCOPE_GMAIL = "https://www.googleapis.com/auth/gmail.readonly"
GOOGLE_SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar.events"


class IntegrationCode(BaseModel):
    code: str
    user_id: UUID
    code_challenge: str
    payload: dict
    expires_at: datetime
    used_at: Optional[datetime] = None
    created_at: datetime


class GoogleIntegration(BaseModel):
    user_id: UUID
    access_ciphertext: bytes = b""
    access_nonce: bytes = b""
    refresh_ciphertext: Optional[bytes] = None
    refresh_nonce: Optional[bytes] = None
    scopes: list[str] = []
    token_expires_at: Optional[datetime] = None
    gmail_history_id: Optional[str] = None
    calendar_sync_token: Optional[str] = None
    last_synced_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    def has_scope(self, scope: str) -> bool:
        return scope in self.scopes


class GoogleMessage(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    external_id: str = Field(exclude=True, default="")
    thread_id: str = ""
    application_id: Optional[UUID] = None
    sender: str = ""
    subject: str = ""
    snippet: str = ""
    received_at: Optional[datetime] = None
    created_at: datetime


class GoogleTokens(BaseModel):
    access_token: str
    refresh_token: str = ""
    expires_in: int = 0
    scope: str = ""


class GoogleMessageMeta(BaseModel):
    id: str
    thread_id: str = ""
    from_: str = ""
    subject: str = ""
    snippet: str = ""
    received_at: Optional[datetime] = None


class GoogleEvent(BaseModel):
    id: str
    status: str = ""
    summary: str = ""
    starts_at: datetime
    ends_at: datetime
    time_zone: str = ""


class GoogleStatus(Model):
    enabled: bool
    connected: bool
    scopes: list[str] = []
    gmail_status: str = ""
    calendar_status: str = ""
    last_synced_at: Optional[datetime] = None
