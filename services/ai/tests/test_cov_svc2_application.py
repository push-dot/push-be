"""Live ApplicationService paths: list (harness tool), get (resume run,
conversation), create (chat graph auto-creates an application for a job)."""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.application import ApplicationService
from tests.stubs import FakeDB, StubApplicationStore, StubJobStore

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


class _FailingStore:
    def __init__(self, err=None):
        self.err = err or RuntimeError("db down")

    async def list(self, *a):
        raise self.err

    async def get(self, *a):
        raise self.err

    async def create(self, *a):
        raise self.err


class _ListStore:
    def __init__(self):
        self.calls = []

    async def list(self, user_id, stage, query, page):
        self.calls.append((user_id, stage, query, page))
        return ["page"]


class _RecordingAppStore(StubApplicationStore):
    def __init__(self):
        super().__init__()
        self.created = []

    async def create(self, a):
        self.created.append(a)


def _svc(apps=None, jobs=None):
    svc = ApplicationService(FakeDB(), None, None)
    if apps is not None:
        svc.applications = apps
    if jobs is not None:
        svc.jobs = jobs
    return svc


def _job(user_id):
    # only the fields create() copies; the job entity itself is not under test
    return SimpleNamespace(id=uuid4(), user_id=user_id, company="Acme",
                           title="Backend")


async def test_list_passes_filters_through():
    store = _ListStore()
    uid = uuid4()
    assert await _svc(store).list(uid, "APPLIED", "acme", "p") == ["page"]
    assert store.calls == [(uid, "APPLIED", "acme", "p")]


async def test_store_failures_surface_as_internal():
    svc = _svc(_FailingStore(), StubJobStore())
    with pytest.raises(DomainError) as e:
        await svc.list(uuid4(), None, "", None)
    assert e.value.code == "INTERNAL" and e.value.status == 500
    with pytest.raises(DomainError) as e:
        await svc.get(uuid4(), uuid4())
    assert e.value.code == "INTERNAL"


async def test_get_is_scoped_to_owner():
    owner = uuid4()
    a = ent.Application(id=uuid4(), user_id=owner, job_id=uuid4(),
                        company="c", title="t", created_at=T0, updated_at=T0)
    svc = _svc(StubApplicationStore(app=a))
    assert (await svc.get(owner, a.id)) is a
    with pytest.raises(DomainError) as e:
        await svc.get(uuid4(), a.id)
    assert e.value.code == "NOT_FOUND" and e.value.status == 404


async def test_create_copies_job_fields_and_starts_discovered():
    uid = uuid4()
    job = _job(uid)
    apps = _RecordingAppStore()
    a = await _svc(apps, StubJobStore(job)).create(uid, job.id, "first look")
    assert apps.created == [a]
    assert (a.user_id, a.job_id, a.company, a.title) == (
        uid, job.id, "Acme", "Backend")
    assert a.stage == "DISCOVERED" and a.revision == 1
    assert a.notes == "first look"


async def test_create_for_someone_elses_job_is_not_found():
    job = _job(uuid4())
    apps = _RecordingAppStore()
    with pytest.raises(DomainError) as e:
        await _svc(apps, StubJobStore(job)).create(uuid4(), job.id, "")
    assert e.value.code == "NOT_FOUND"
    assert apps.created == []


async def test_create_maps_job_lookup_and_insert_failures_to_internal():
    uid = uuid4()
    with pytest.raises(DomainError) as e:
        await _svc(_RecordingAppStore(), _FailingStore()).create(uid, uuid4(), "")
    assert e.value.code == "INTERNAL"
    job = _job(uid)
    with pytest.raises(DomainError) as e:
        await _svc(_FailingStore(), StubJobStore(job)).create(uid, job.id, "")
    assert e.value.code == "INTERNAL"
