from __future__ import annotations
from uuid import UUID

from app.domain.entities import Experiment, ExperimentAssignment, ExperimentEvent
from app.infrastructure.store_common import Store, to_model

_EXPERIMENT_COLS = "key, variants, status, created_at, updated_at"
_ASSIGNMENT_COLS = "experiment_key, user_id, variant, created_at"


class ExperimentStore(Store):
    async def upsert(self, e: Experiment) -> None:
        await self.q().execute(
            f"INSERT INTO experiments ({_EXPERIMENT_COLS}) VALUES ($1,$2,$3,$4,$5) "
            "ON CONFLICT (key) DO NOTHING",
            e.key, e.variants, e.status, e.created_at, e.updated_at)

    async def get(self, key: str) -> Experiment:
        return to_model(Experiment, await self.one(
            f"SELECT {_EXPERIMENT_COLS} FROM experiments WHERE key = $1", key))

    async def get_assignment(self, key: str, user_id: UUID) -> ExperimentAssignment:
        return to_model(ExperimentAssignment, await self.one(
            f"SELECT {_ASSIGNMENT_COLS} FROM experiment_assignments "
            "WHERE experiment_key = $1 AND user_id = $2", key, user_id))

    async def create_assignment(self, a: ExperimentAssignment) -> None:
        await self.q().execute(
            f"INSERT INTO experiment_assignments ({_ASSIGNMENT_COLS}) "
            "VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            a.experiment_key, a.user_id, a.variant, a.created_at)

    async def record_event(self, e: ExperimentEvent) -> None:
        await self.q().execute(
            "INSERT INTO experiment_events "
            "(id, experiment_key, user_id, variant, event, created_at) "
            "VALUES ($1,$2,$3,$4,$5,$6)",
            e.id, e.experiment_key, e.user_id, e.variant, e.event, e.created_at)

    async def event_counts(self, key: str) -> dict:
        rows = await self.q().fetch(
            "SELECT variant, event, COUNT(*) AS n FROM experiment_events "
            "WHERE experiment_key = $1 GROUP BY variant, event", key)
        counts: dict = {}
        for r in rows:
            counts.setdefault(r["variant"], {})[r["event"]] = r["n"]
        return counts
