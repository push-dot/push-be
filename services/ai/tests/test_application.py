from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.domain import entities as ent
from app.domain.errors import DomainError
from app.domain.services.application import ApplicationService
from tests.stubs import FakeDB


def _now():
    return datetime.now(timezone.utc)


def _app(stage="DISCOVERED", revision=1, user_id=None):
    return ent.Application(
        id=uuid4(), user_id=user_id or uuid4(), revision=revision,
        job_id=uuid4(), company="Acme", title="Dev", stage=stage,
        created_at=_now(), updated_at=_now())


def _svc(store):
    svc = ApplicationService(FakeDB(), None, {})
    svc.applications = store
    return svc


def _code(err):
    assert isinstance(err, DomainError)
    return err.code


def test_application_json_omits_fit_score_until_an_analysis_exists():
    from app.jsonutil import to_jsonable
    assert "fitScore" not in to_jsonable(_app())
    scored = _app().model_copy(update={"fit_score": 72})
    assert to_jsonable(scored)["fitScore"] == 72


async def test_application_store_selects_latest_fit_score():
    from app.db import NotFoundError
    from app.infrastructure.store_applications import ApplicationStore

    class Query:
        def __init__(self):
            self.sql = ""

        async def fetchrow(self, sql, *args):
            self.sql = sql
            return None

    class DB:
        def __init__(self, query):
            self.query = query

        def q(self):
            return self.query

    query = Query()
    with pytest.raises(NotFoundError):
        await ApplicationStore(DB(query)).get(uuid4(), uuid4())
    assert "gap_analyses" in query.sql
    assert "fit_score" in query.sql
