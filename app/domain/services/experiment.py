from __future__ import annotations
import hashlib
from datetime import datetime, timezone
from uuid import UUID, uuid4

from app.db import DB, NotFoundError
from app.domain import entities as ent
from app.domain.errors import internal, not_found, validation_field
from app.infrastructure.store_experiments import ExperimentStore


def _now() -> datetime:
    return datetime.now(timezone.utc)


def bucket_variant(user_id: UUID, key: str, variants: list[str]) -> str:
    h = int(hashlib.sha256(f"{user_id}:{key}".encode()).hexdigest(), 16)
    return variants[h % len(variants)]


class ExperimentService:
    def __init__(self, db: DB):
        self.db = db
        self.experiments = ExperimentStore(db)

    async def seed(self, specs: list[dict]) -> None:
        now = _now()
        for spec in specs:
            key = spec.get("key") or ""
            variants = spec.get("variants") or []
            if not key:
                raise validation_field("key", "required")
            if not variants:
                raise validation_field("variants", "must be non-empty")
            try:
                await self.experiments.upsert(ent.Experiment(
                    key=key, variants=variants,
                    status=spec.get("status") or ent.EXPERIMENT_ACTIVE,
                    created_at=now, updated_at=now))
            except Exception:
                raise internal()

    async def assignment(self, user_id: UUID, key: str) -> ent.ExperimentAssignment:
        exp = await self._get(key)
        if exp.status == ent.EXPERIMENT_ENDED:
            return ent.ExperimentAssignment(
                experiment_key=key, user_id=user_id,
                variant=exp.variants[0], created_at=_now())
        try:
            return await self.experiments.get_assignment(key, user_id)
        except NotFoundError:
            pass
        except Exception:
            raise internal()
        a = ent.ExperimentAssignment(
            experiment_key=key, user_id=user_id,
            variant=bucket_variant(user_id, key, exp.variants),
            created_at=_now())
        try:
            await self.experiments.create_assignment(a)
            return await self.experiments.get_assignment(key, user_id)
        except NotFoundError:
            raise internal()
        except Exception:
            raise internal()

    async def record_event(self, user_id: UUID, key: str, event: str) -> None:
        if not 1 <= len(event) <= 100:
            raise validation_field("event", "must be 1-100 characters")
        a = await self.assignment(user_id, key)
        try:
            await self.experiments.record_event(ent.ExperimentEvent(
                id=uuid4(), experiment_key=key, user_id=user_id,
                variant=a.variant, event=event, created_at=_now()))
        except Exception:
            raise internal()

    async def stats(self, key: str) -> dict:
        exp = await self._get(key)
        try:
            counts = await self.experiments.event_counts(key)
        except Exception:
            raise internal()
        variants = {v: counts.get(v, {}) for v in exp.variants}
        return {"key": key, "status": exp.status, "variants": variants}

    async def _get(self, key: str) -> ent.Experiment:
        try:
            exp = await self.experiments.get(key)
        except NotFoundError:
            raise not_found()
        except Exception:
            raise internal()
        if not exp.variants:
            raise validation_field("variants", "must be non-empty")
        return exp
