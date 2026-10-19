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

    async def group_keys(self, group):
        return sorted(k for k, e in self.experiments.items()
                      if e.exclusion_group == group)

    async def result_counts(self, key):
        seen = {}
        for e in self.events:
            if e.experiment_key != key:
                continue
            d = seen.setdefault(e.variant, {"exposure": set(),
                                            "conversion": set()})
            if e.event in d:
                d[e.event].add(e.user_id)
        return {v: {"exposed": len(s["exposure"]),
                    "converted": len(s["conversion"])}
                for v, s in seen.items()}


def _experiment(key="onboarding", variants=None, status="active",
                exclusion_group=""):
    return ent.Experiment(key=key, variants=variants or ["A", "B"],
                          status=status, exclusion_group=exclusion_group,
                          created_at=_now(), updated_at=_now())


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


async def test_assignment_deterministic_repeated():
    store = StubExperimentStore({"onboarding": _experiment()})
    svc = _svc(store)
    user_id = uuid4()
    variants = {(await svc.assignment(user_id, "onboarding")).variant
                for _ in range(20)}
    assert len(variants) == 1


async def test_exclusion_group_enrolls_single_experiment():
    store = StubExperimentStore({
        "exp-one": _experiment(key="exp-one", exclusion_group="greet"),
        "exp-two": _experiment(key="exp-two", exclusion_group="greet"),
    })
    svc = _svc(store)
    violations = 0
    enrolled = {"exp-one": 0, "exp-two": 0}
    for _ in range(200):
        user_id = uuid4()
        one = await svc.assignment(user_id, "exp-one")
        two = await svc.assignment(user_id, "exp-two")
        if one.enrolled and two.enrolled:
            violations += 1
        enrolled["exp-one"] += int(one.enrolled)
        enrolled["exp-two"] += int(two.enrolled)
    assert violations == 0
    assert enrolled["exp-one"] > 0
    assert enrolled["exp-two"] > 0
    assert enrolled["exp-one"] + enrolled["exp-two"] == 200


async def test_exclusion_group_does_not_block_other_groups():
    store = StubExperimentStore({
        "exp-one": _experiment(key="exp-one", exclusion_group="greet"),
        "exp-two": _experiment(key="exp-two", exclusion_group="greet"),
        "other": _experiment(key="other"),
    })
    svc = _svc(store)
    user_id = uuid4()
    other = await svc.assignment(user_id, "other")
    assert other.enrolled


async def test_excluded_assignment_returns_default_variant():
    store = StubExperimentStore({
        "exp-one": _experiment(key="exp-one", exclusion_group="greet"),
        "exp-two": _experiment(key="exp-two", exclusion_group="greet"),
    })
    svc = _svc(store)
    for _ in range(200):
        user_id = uuid4()
        for key in ("exp-one", "exp-two"):
            a = await svc.assignment(user_id, key)
            if not a.enrolled:
                assert a.variant == "A"
                assert (key, user_id) not in store.assignments


async def test_record_event_skipped_when_not_enrolled():
    store = StubExperimentStore({
        "exp-one": _experiment(key="exp-one", exclusion_group="greet"),
        "exp-two": _experiment(key="exp-two", exclusion_group="greet"),
    })
    svc = _svc(store)
    users = [uuid4() for _ in range(50)]
    for user_id in users:
        await svc.record_event(user_id, "exp-one", "exposure")
        await svc.record_event(user_id, "exp-two", "exposure")
    assert len(store.events) == 50
    assert len({e.user_id for e in store.events}) == 50
    per_user = {}
    for e in store.events:
        per_user.setdefault(e.user_id, set()).add(e.experiment_key)
    assert all(len(v) == 1 for v in per_user.values())


async def test_results_aggregation_matches_event_rows():
    store = StubExperimentStore({"onboarding": _experiment()})
    svc = _svc(store)
    users = [uuid4() for _ in range(30)]
    for i, u in enumerate(users):
        await svc.record_event(u, "onboarding", "exposure")
        if i % 3 == 0:
            await svc.record_event(u, "onboarding", "conversion")
        if i % 5 == 0:
            await svc.record_event(u, "onboarding", "exposure")
    results = await svc.results("onboarding")
    total_exposed = sum(v["exposed"] for v in results["variants"])
    total_converted = sum(v["converted"] for v in results["variants"])
    exposure_users = {e.user_id for e in store.events
                      if e.event == "exposure"}
    conversion_users = {e.user_id for e in store.events
                        if e.event == "conversion"}
    assert total_exposed == len(exposure_users)
    assert total_converted == len(conversion_users)
    assert conversion_users <= exposure_users
    for v in results["variants"]:
        expected = len({e.user_id for e in store.events
                        if e.variant == v["variant"]
                        and e.event == "conversion"})
        exposed = v["exposed"]
        assert v["converted"] == expected
        assert v["rate"] == (expected / exposed if exposed else 0.0)


async def test_results_zero_when_no_events():
    store = StubExperimentStore({"onboarding": _experiment()})
    svc = _svc(store)
    results = await svc.results("onboarding")
    assert results["key"] == "onboarding"
    assert results["variants"] == [
        {"variant": "A", "exposed": 0, "converted": 0, "rate": 0.0},
        {"variant": "B", "exposed": 0, "converted": 0, "rate": 0.0},
    ]


async def test_seed_stores_exclusion_group():
    store = StubExperimentStore()
    svc = _svc(store)
    await svc.seed([{"key": "exp-one", "variants": ["A", "B"],
                     "exclusion_group": "greet"}])
    assert store.experiments["exp-one"].exclusion_group == "greet"


async def test_seed_rejects_invalid_spec():
    svc = _svc()
    with pytest.raises(DomainError) as e:
        await svc.seed([{"key": "", "variants": ["A"]}])
    assert e.value.code == "VALIDATION_ERROR"
    with pytest.raises(DomainError) as e:
        await svc.seed([{"key": "x", "variants": []}])
    assert e.value.code == "VALIDATION_ERROR"
