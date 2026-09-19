from __future__ import annotations

from fastapi import APIRouter, Request

from app.presentation import schemas as s
from app.presentation.deps import bind_json, current_user, data, deps

router = APIRouter()




@router.get("/experiments/{key}/assignment")
async def get_assignment(key: str, request: Request):
    d = deps(request)
    a = await d.experiments.assignment(current_user(request).id, key)
    return data(200, a)


@router.post("/experiments/{key}/events", status_code=201)
async def record_experiment_event(key: str, request: Request):
    d = deps(request)
    req = await bind_json(request, s.ExperimentEventReq)
    await d.experiments.record_event(current_user(request).id, key, req.event)
    return data(201, {"recorded": True})


@router.get("/experiments/{key}/stats")
async def experiment_stats(key: str, request: Request):
    d = deps(request)
    stats = await d.experiments.stats(key)
    return data(200, stats)
