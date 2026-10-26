"""Request bodies for the routes this service still serves.

CRUD bodies moved to push-be-core with their routes.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from pydantic.alias_generators import to_camel


def _coerce_uuid(v: Any) -> UUID:
    return v if isinstance(v, UUID) else UUID(str(v))


# Strict models reject a str for UUID in Python mode (queue payloads).
UUIDT = Annotated[UUID, BeforeValidator(_coerce_uuid)]


class Req(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel,
                              populate_by_name=False, strict=True)


class AiOptionsReq(Req):
    provider: str
    model: str
    effort: str
    ultra_resume: bool = False
    web_search: bool = False
    models: dict[str, Any] = {}


class ImportEvidenceReq(Req):
    source_id: UUIDT | None = None
    text: str
    source_url: str | None = None
    content_hash: str
    format: str
    kind: str
    title: str


class ExpectedRevisionReq(Req):
    expected_revision: int


class ResumeRunReq(Req):
    ai: AiOptionsReq | None = None


class AnalyzeReq(Req):
    application_id: UUIDT
    expected_revision: int
    evidence_ids: list[UUIDT] = []
    ai: AiOptionsReq | None = None


class GenerateDocReq(Req):
    expected_revision: int
    evidence_ids: list[UUIDT] = []
    analysis_id: UUIDT | None = None
    ai: AiOptionsReq | None = None
    language: str | None = None


class SelectionReq(Req):
    model_config = ConfigDict(extra="forbid", populate_by_name=False,
                              strict=True)
    from_: int = Field(alias="from")
    to: int
    text: str


class ReviseReq(Req):
    expected_revision: int
    version_id: UUIDT
    selection: SelectionReq
    action: str
    instruction: str = ""
    ai: AiOptionsReq | None = None


class BlueprintsReq(Req):
    application_id: UUIDT
    gap_analysis_id: UUIDT
    ai: AiOptionsReq | None = None


class PrepareReq(Req):
    expected_revision: int
    ai: AiOptionsReq | None = None


class CreateApprovalReq(Req):
    kind: str
    application_id: UUIDT | None = None
    target_id: UUIDT
    target_revision: int | None = None


class DecisionReq(Req):
    expected_revision: int
    decision: str


class OpInputReq(Req):
    fields: dict[str, str] = {}
    source_id: UUIDT | None = None


class AiGenerateReq(Req):
    ai: AiOptionsReq | None = None
    prompt: str
    application_id: UUIDT
    evidence_ids: list[UUIDT] = []
