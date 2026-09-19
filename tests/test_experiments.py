from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.db import NotFoundError
from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.experiment import ExperimentService
from tests.stubs import FakeDB


def _now():
    return datetime.now(timezone.utc)


class StubExperimentStore:
    def __init__(self, experiments=None):
        self.experiments = experiments or {}
        self.assignments = {}
        self.events = []

    async def upsert(self, e):
        self.experiments.setdefault(e.key, e)

    async def get(self, key):
        e = self.experiments.get(key)
        if e is None:
            raise NotFoundError()
        return e

    async def get_assignment(self, key, user_id):
        a = self.assignments.get((key, user_id))
        if a is None:
            raise NotFoundError()
        return a

    async def create_assignment(self, a):
        self.assignments.setdefault((a.experiment_key, a.user_id), a)

    async def record_event(self, e):
        self.events.append(e)

    async def event_counts(self, key):
        counts = {}
        for e in self.events:
            if e.experiment_key != key:
                continue
            counts.setdefault(e.variant, {})
            counts[e.variant][e.event] = \
                counts[e.variant].get(e.event, 0) + 1
        return counts


def _experiment(key="onboarding", variants=None, status="active"):
    return ent.Experiment(key=key, variants=variants or ["A", "B"],
                          status=status, created_at=_now(),
                          updated_at=_now())


def _svc(store=None):
    svc = ExperimentService(FakeDB())
    svc.experiments = store or StubExperimentStore()
    return svc


async def test_assignment_is_deterministic():
    store = StubExperimentStore({"onboarding": _experiment()})
    svc = _svc(store)
    user_id = uuid4()
    first = await svc.assignment(user_id, "onboarding")
    second = await svc.assignment(user_id, "onboarding")
    assert first.variant == second.variant
    assert first.variant in ("A", "B")


async def test_assignment_persisted_once():
    store = StubExperimentStore({"onboarding": _experiment()})
    svc = _svc(store)
    user_id = uuid4()
    await svc.assignment(user_id, "onboarding")
    assert len(store.assignments) == 1


async def test_assignment_unknown_key_not_found():
    svc = _svc()
    with pytest.raises(DomainError) as e:
        await svc.assignment(uuid4(), "missing")
    assert e.value.code == "NOT_FOUND"


async def test_ended_experiment_returns_default_variant():
    store = StubExperimentStore(
        {"onboarding": _experiment(status="ended")})
    svc = _svc(store)
    out = await svc.assignment(uuid4(), "onboarding")
    assert out.variant == "A"
    assert store.assignments == {}


async def test_record_event_stores_user_variant():
    store = StubExperimentStore({"onboarding": _experiment()})
    svc = _svc(store)
    user_id = uuid4()
    assigned = await svc.assignment(user_id, "onboarding")
    await svc.record_event(user_id, "onboarding", "conversion")
    assert store.events[0].variant == assigned.variant
    assert store.events[0].event == "conversion"


async def test_record_event_rejects_empty_event():
    store = StubExperimentStore({"onboarding": _experiment()})
    svc = _svc(store)
    with pytest.raises(DomainError) as e:
        await svc.record_event(uuid4(), "onboarding", "")
    assert e.value.code == "VALIDATION_ERROR"


async def test_stats_counts_events_per_variant():
    store = StubExperimentStore({"onboarding": _experiment()})
    svc = _svc(store)
    user_a = uuid4()
    await svc.assignment(user_a, "onboarding")
    await svc.record_event(user_a, "onboarding", "exposure")
    await svc.record_event(user_a, "onboarding", "exposure")
    await svc.record_event(user_a, "onboarding", "conversion")
    stats = await svc.stats("onboarding")
    variant = store.assignments[("onboarding", user_a)].variant
    assert stats["variants"][variant]["exposure"] == 2
    assert stats["variants"][variant]["conversion"] == 1


async def test_stats_includes_zero_counts_for_all_variants():
    store = StubExperimentStore({"onboarding": _experiment()})
    svc = _svc(store)
    stats = await svc.stats("onboarding")
    assert stats["variants"]["A"] == {}
    assert stats["variants"]["B"] == {}


async def test_seed_upserts_experiments():
    store = StubExperimentStore()
    svc = _svc(store)
    await svc.seed([{"key": "onboarding", "variants": ["A", "B"]}])
    assert store.experiments["onboarding"].status == "active"


async def test_seed_does_not_reset_ended_experiment():
    store = StubExperimentStore(
        {"onboarding": _experiment(status="ended")})
    svc = _svc(store)
    await svc.seed([{"key": "onboarding", "variants": ["A", "B"]}])
    assert store.experiments["onboarding"].status == "ended"


async def test_seed_rejects_invalid_spec():
    svc = _svc()
    with pytest.raises(DomainError) as e:
        await svc.seed([{"key": "", "variants": ["A"]}])
    assert e.value.code == "VALIDATION_ERROR"
    with pytest.raises(DomainError) as e:
        await svc.seed([{"key": "x", "variants": []}])
    assert e.value.code == "VALIDATION_ERROR"
