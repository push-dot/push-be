from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError

from app.domain import entities as ent
from app.domain.errors import unauthenticated, validation, validation_field
from app.domain.pagination import MAX_LIMIT, Page, PageRequest, decode_cursor
from app.jsonutil import to_jsonable

if TYPE_CHECKING:
    from app.api.schemas import AiOptionsReq
    from app.main import Deps


def deps(request: Request) -> Deps:
    return request.app.state.deps


def current_user(request: Request) -> ent.User:
    u = getattr(request.state, "user", None)
    if u is None:
        raise unauthenticated("missing bearer token")
    return u


async def bind_json[M: BaseModel](request: Request, model: type[M]) -> M:
    body = await request.body()
    if not body:
        raise validation("request body required")
    # One parse in pydantic-core. json.loads raised UnicodeDecodeError (a 500)
    # on a body that was not UTF-8.
    try:
        return model.model_validate_json(body)
    except ValidationError as e:
        raise validation("invalid request body: " + str(e))


def param_id(value: str, name: str) -> UUID:
    try:
        return UUID(value)
    except (ValueError, AttributeError, TypeError):
        raise validation_field(name, "must be a UUID")


def page_request(request: Request) -> PageRequest:
    p = PageRequest()
    if limit := request.query_params.get("limit"):
        try:
            n = int(limit)
        except ValueError:
            raise validation_field("limit", "must be a positive integer")
        if n < 1:
            raise validation_field("limit", "must be a positive integer")
        p.limit = min(n, MAX_LIMIT)
    if cur := request.query_params.get("cursor"):
        try:
            p.cursor = decode_cursor(cur)
        except ValueError:
            raise validation_field("cursor", "invalid cursor")
    return p


def optional_query_uuid(request: Request, name: str) -> UUID | None:
    v = request.query_params.get(name)
    if not v:
        return None
    try:
        return UUID(v)
    except ValueError:
        raise validation_field(name, "must be a UUID")


def data(status: int, v: Any) -> JSONResponse:
    return JSONResponse(content={"data": to_jsonable(v)},
                        status_code=status)


def page_body(p: Page[Any]) -> JSONResponse:
    return JSONResponse(content={
        "data": to_jsonable(p.items),
        "page": {"nextCursor": p.next_cursor, "hasMore": p.has_more}},
        status_code=200)


def ai_options(req: AiOptionsReq | None) -> ent.AiOptions | None:
    if req is None:
        return None
    return ent.AiOptions(provider=req.provider, model=req.model,
                         effort=req.effort,
                         ultra_resume=req.ultra_resume,
                         web_search=req.web_search, models=req.models)
