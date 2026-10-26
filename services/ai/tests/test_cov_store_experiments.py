"""Only ``upsert`` is reachable (bootstrap seed). The read/assign/event
methods back an experiments router that is not mounted in Python."""
from app.domain.entities import Experiment
from app.infrastructure.store_experiments import ExperimentStore
from tests.cov_fakes import entity, fake_db


async def test_upsert_never_overwrites_existing_experiment():
    e = entity(Experiment, key="k", variants=["a", "b"])
    db, conn = fake_db()
    await ExperimentStore(db).upsert(e)
    _, sql, args = conn.last
    assert "ON CONFLICT (key) DO NOTHING" in sql
    assert args == (e.key, e.variants, e.status, e.exclusion_group, e.created_at, e.updated_at)
