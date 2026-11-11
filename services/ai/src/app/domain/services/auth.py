from __future__ import annotations

import hmac
from uuid import UUID

from app.db import DB, NotFoundError
from app.domain import entities as ent
from app.domain.errors import token_expired, unauthenticated
from app.infrastructure.crypto import token_hash
from app.infrastructure.store_auth import SessionStore, UserStore


class AuthService:
    def __init__(self, db: DB, app_env: str, dev_token: str, dev_user_id: UUID):
        self.db = db
        self.users = UserStore(db)
        self.sessions = SessionStore(db)
        self.app_env = app_env
        self.dev_token = dev_token
        self.dev_user_id = dev_user_id

    async def resolve_access_token(self, token: str) -> ent.User:
        if (self.app_env == "development" and self.dev_token
                and hmac.compare_digest(token.encode(), self.dev_token.encode())):
            try:
                return await self.users.get(self.dev_user_id)
            except NotFoundError:
                raise unauthenticated("dev user not seeded")
        try:
            user, expires_at = await self.sessions.get_user_by_access_token(
                token_hash(token))
        except NotFoundError:
            raise unauthenticated("invalid access token")
        from app.clock import utcnow
        if utcnow() > expires_at:
            raise token_expired()
        return user
