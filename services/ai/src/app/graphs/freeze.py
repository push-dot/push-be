from __future__ import annotations

from pydantic import BaseModel

from app.domain import entities as ent
from app.jsonutil import to_jsonable

_MODELS = {
    "Conversation": ent.Conversation,
    "AICompletion": ent.AICompletion,
    "MessageAttachment": ent.MessageAttachment,
    "Operation": ent.Operation,
    "OperationResult": ent.OperationResult,
    "Message": ent.Message,
}


def freeze_state(state: dict) -> dict:
    out = {}
    for key, value in state.items():
        out[key] = _freeze(value)
    return out


def thaw_state(raw: dict) -> dict:
    return {key: _thaw(value) for key, value in (raw or {}).items()}


def _freeze(value):
    if isinstance(value, BaseModel):
        # model_dump() drops Field(exclude=True) fields such as
        # Conversation.user_id, which the next workflow step needs to rebuild
        # the model. Freeze every declared field by name instead.
        data = {name: _freeze(getattr(value, name))
                for name in type(value).model_fields}
        data["__m__"] = type(value).__name__
        return data
    if isinstance(value, list):
        return [_freeze(item) for item in value]
    if isinstance(value, dict):
        return {k: _freeze(v) for k, v in value.items()}
    return to_jsonable(value)


def _thaw(value):
    if isinstance(value, dict) and "__m__" in value:
        data = dict(value)
        name = data.pop("__m__")
        data = {k: _thaw(v) for k, v in data.items()}
        cls = _MODELS.get(name)
        return cls(**data) if cls is not None else data
    if isinstance(value, list):
        return [_thaw(item) for item in value]
    if isinstance(value, dict):
        return {k: _thaw(v) for k, v in value.items()}
    return value
