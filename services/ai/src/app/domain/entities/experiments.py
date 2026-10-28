from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field

from app.domain.entities.base import Model

EXPERIMENT_ACTIVE = "active"
EXPERIMENT_ENDED = "ended"


class Experiment(Model):
    key: str
    variants: list[str]
    status: str = EXPERIMENT_ACTIVE
    exclusion_group: str = ""
    created_at: datetime
    updated_at: datetime


class ExperimentAssignment(Model):
    experiment_key: str
    user_id: UUID = Field(exclude=True)
    variant: str
    enrolled: bool = True
    created_at: datetime


class ExperimentEvent(BaseModel):
    id: UUID
    experiment_key: str
    user_id: UUID
    variant: str
    event: str
    created_at: datetime
