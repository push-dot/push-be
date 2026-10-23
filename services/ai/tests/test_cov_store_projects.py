from uuid import UUID, uuid4

import pytest

from app.db import ConflictError, NotFoundError
from app.domain.entities import BLUEPRINT_ARCHIVED, CliRun, ProjectBlueprint, ProjectEvidence
from app.domain.pagination import Cursor
from app.infrastructure.store_projects import (
    _BP_COLS, _PEV_COLS, _RUN_COLS, ProjectStore,
)
from tests.cov_fakes import NOW, USER, assert_scoped, entity, fake_db, page, row

PROJECT = uuid4()


async def test_blueprints():
    b = entity(ProjectBlueprint, user_id=USER, skills=["go"])
    r = row(_BP_COLS, ProjectBlueprint, user_id=USER, skills=None, tasks=None,
            completion_criteria=None, metrics=None,
            estimated_effort={"minHours": 1, "maxHours": 2})
    rows = [row(_BP_COLS, ProjectBlueprint, user_id=USER) for _ in range(2)]
    db, conn = fake_db(None, r, 3, rows, [], "UPDATE 0", {"revision": 4})
    s = ProjectStore(db)
    await s.create_blueprint(b)
    assert conn.last[2][:2] == (b.id, USER) and conn.last[2][6] == ["go"]
    got = await s.get_blueprint(USER, r["id"])
    assert got.skills == [] and got.tasks == [] and got.estimated_effort.max_hours == 2
    assert_scoped(conn.last, USER)
    assert await s.count_blueprints(USER) == 3
    assert conn.last[2] == (USER, BLUEPRINT_ARCHIVED)
    app_id, cid = uuid4(), uuid4()
    p = await s.list_blueprints(USER, app_id, page(1, Cursor(NOW, cid)))
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (USER, app_id, NOW, cid, 2) and p.has_more
    await s.list_blueprints(USER, None, page())
    assert conn.last[2] == (USER, 51)
    with pytest.raises(ConflictError):
        await s.update_blueprint(b, 1)
    assert_scoped(conn.calls[-2], USER)


@pytest.mark.xfail(strict=True, reason=(
    "BUG: _blueprint maps an empty/NULL estimated_effort to {} but EffortEstimate "
    "requires minHours/maxHours, so a row with the column default '{}' raises "
    "ValidationError instead of loading"))
@pytest.mark.parametrize("effort", [None, {}])
async def test_blueprint_with_default_effort_loads(effort):
    r = row(_BP_COLS, ProjectBlueprint, user_id=USER, estimated_effort=effort)
    db, _ = fake_db(r)
    got = await ProjectStore(db).get_blueprint(USER, r["id"])
    assert got.estimated_effort.min_hours == 0 and got.estimated_effort.max_hours == 0


async def test_runs():
    run = entity(CliRun, user_id=USER, arguments=["-y"])
    r = row(_RUN_COLS, CliRun, user_id=USER, arguments=None)
    rows = [row(_RUN_COLS, CliRun, user_id=USER)]
    db, conn = fake_db(None, r, r, r, rows, "UPDATE 0", None)
    s = ProjectStore(db)
    await s.create_run(run)
    assert len(conn.last[2]) == 25 and conn.last[2][8] == ["-y"]
    got = await s.get_run(USER, PROJECT, r["id"])
    assert got.arguments == []
    assert conn.last[2] == (r["id"], USER, PROJECT)
    assert_scoped(conn.last, USER)
    await s.get_run(USER, UUID(int=0), r["id"])
    assert conn.last[2] == (r["id"], USER) and "project_id" not in conn.last[1].split("WHERE")[1]
    await s.get_run_by_id(USER, r["id"])
    assert_scoped(conn.last, USER)
    p = await s.list_runs(USER, PROJECT, page())
    assert conn.last[2] == (USER, PROJECT, 51) and len(p.items) == 1
    with pytest.raises(NotFoundError):
        await s.update_run(run, 1)
    assert_scoped(conn.calls[-2], USER)


async def test_project_evidence():
    e = entity(ProjectEvidence, user_id=USER)
    r = row(_PEV_COLS, ProjectEvidence, user_id=USER, test_results=None, metrics=None)
    rows = [row(_PEV_COLS, ProjectEvidence, user_id=USER) for _ in range(2)]
    db, conn = fake_db(None, r, rows, "UPDATE 1")
    s = ProjectStore(db)
    await s.create_evidence(e)
    assert conn.last[2][:2] == (e.id, USER) and isinstance(conn.last[2][7], dict)
    got = await s.get_evidence(USER, PROJECT, r["id"])
    assert got.metrics == []
    assert_scoped(conn.last, USER)
    assert conn.last[2] == (r["id"], USER, PROJECT)
    p = await s.list_evidence(USER, PROJECT, page(1))
    assert conn.last[2] == (USER, PROJECT, 2) and p.has_more
    await s.update_evidence(e, 3)
    assert_scoped(conn.last, USER)
    assert conn.last[2][-1] == 3
