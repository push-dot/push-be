from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field

from app.domain.entities.base import Model

ACCESS_TOKEN_TTL_SECONDS = 900
REFRESH_TOKEN_TTL = timedelta(days=30)
OAUTH_STATE_TTL = timedelta(minutes=10)
EXCHANGE_CODE_TTL = timedelta(seconds=60)

AUTH_CALLBACK_URI = "push://auth/callback"
AUTH_CALLBACK_WEB_URI = "http://localhost:5173/auth/callback"

OAUTH_PURPOSE_LOGIN = "LOGIN"


class User(Model):
    id: UUID
    provider: str = Field(exclude=True, default="")
    provider_subject: str = Field(exclude=True, default="")
    display_name: str
    locale: str = "ko"
    plan: str = Field(exclude=True, default="FREE")
    subscription_status: str = Field(exclude=True, default="NONE")
    stripe_customer_id: Optional[str] = Field(exclude=True, default=None)
    period_ends_at: Optional[datetime] = Field(exclude=True, default=None)
    created_at: datetime


class OAuthState(BaseModel):
    state: str
    provider: str
    purpose: str = "LOGIN"
    user_id: Optional[UUID] = None
    code_challenge: str
    redirect_uri: str
    final_uri: str = ""
    expires_at: datetime
    created_at: datetime


class ExchangeCode(BaseModel):
    code: str
    user_id: UUID
    code_challenge: str
    expires_at: datetime
    used_at: Optional[datetime] = None
    created_at: datetime


class AccessToken(BaseModel):
    id: UUID
    user_id: UUID
    token_hash: str
    refresh_token_id: UUID
    expires_at: datetime
    created_at: datetime


class RefreshToken(BaseModel):
    id: UUID
    user_id: UUID
    token_hash: str
    expires_at: datetime
    revoked_at: Optional[datetime] = None
    created_at: datetime


class Session(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int
    user: User


def valid_oauth_provider(p: str) -> bool:
    return p in ("google", "github")


class IdempotencyRecord(BaseModel):
    id: UUID
    user_id: UUID
    key: UUID
    method: str
    path: str
    request_hash: str
    response_status: Optional[int] = None
    response_body: Optional[bytes] = None
    response_headers: Optional[list] = None
    created_at: datetime
