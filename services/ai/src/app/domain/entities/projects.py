from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import Field

from app.domain.entities.base import Model

CLI_PROVIDERS = {"CODEX", "CLAUDE_CODE", "GROK_BUILD"}
CLI_EXECUTABLES = {"CODEX": "codex", "CLAUDE_CODE": "claude", "GROK_BUILD": "grok"}
BLUEPRINT_DRAFT = "DRAFT"
BLUEPRINT_SELECTED = "SELECTED"
BLUEPRINT_IN_PROGRESS = "IN_PROGRESS"
BLUEPRINT_VERIFIED = "VERIFIED"
BLUEPRINT_ARCHIVED = "ARCHIVED"
RUN_DRAFT = "DRAFT"
RUN_APPROVAL_REQUIRED = "APPROVAL_REQUIRED"
RUN_RUNNING = "RUNNING"
RUN_VERIFYING = "VERIFYING"
RUN_VERIFIED = "VERIFIED"
RUN_FAILED = "FAILED"
LAUNCH_NOT_CLAIMED = "NOT_CLAIMED"
LAUNCH_CLAIMED = "CLAIMED"
LAUNCH_STARTED = "STARTED"
LAUNCH_UNKNOWN = "UNKNOWN"
LAUNCH_FINISHED = "FINISHED"


def valid_cli_provider(p: str) -> bool:
    return p in CLI_PROVIDERS


def valid_reported_launch_status(s: str) -> bool:
    return s in (LAUNCH_CLAIMED, LAUNCH_STARTED, LAUNCH_UNKNOWN)


def can_transition_launch(frm: str, to: str) -> bool:
    if frm == to:
        return True
    if frm == LAUNCH_NOT_CLAIMED:
        return to == LAUNCH_CLAIMED
    if frm == LAUNCH_CLAIMED:
        return to in (LAUNCH_STARTED, LAUNCH_UNKNOWN)
    if frm == LAUNCH_STARTED:
        return to == LAUNCH_UNKNOWN
    return False


class BlueprintTask(Model):
    id: str
    title: str
    description: str
    acceptance: list[str] = []


class BlueprintMetric(Model):
    name: str
    unit: str
    measurement: str
    target: Optional[float] = None


class EffortEstimate(Model):
    min_hours: int
    max_hours: int


class ProjectBlueprint(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    revision: int = 1
    application_id: UUID
    gap_analysis_id: UUID
    title: str
    skills: list[str] = []
    problem: str = ""
    solution: str = ""
    tasks: list[BlueprintTask] = []
    completion_criteria: list[str] = []
    metrics: list[BlueprintMetric] = []
    estimated_effort: EffortEstimate = Field(default_factory=lambda: EffortEstimate(min_hours=0, max_hours=0))
    state: str = "DRAFT"
    created_at: datetime
    updated_at: datetime


class ProcessInfo(Model):
    pid: int
    started_at: datetime


class CliRun(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    revision: int = 1
    project_id: UUID
    application_id: UUID
    provider: str
    working_directory: str
    executable: str
    arguments: list[str] = []
    prompt: str
    payload_hash: str
    state: str
    launch_status: str = "NOT_CLAIMED"
    approval_id: Optional[UUID] = None
    device_id: Optional[str] = None
    detected_version: Optional[str] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    failure_reason: Optional[str] = None
    exit_code: Optional[int] = None
    commit_sha: Optional[str] = None
    stdout_hash: Optional[str] = None
    stderr_hash: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class TestResults(Model):
    test_command: str = ""
    test_output: str = ""
    exit_code: int = 0


class MetricEntry(Model):
    name: str
    value: float
    unit: str


class ProjectEvidence(Model):
    id: UUID
    user_id: UUID = Field(exclude=True)
    revision: int = 1
    project_id: UUID
    run_id: UUID
    commit_url: str
    commit_sha: Optional[str] = None
    test_results: TestResults = Field(default_factory=TestResults)
    metrics: list[MetricEntry] = []
    summary: str = ""
    status: str = "PENDING"
    verification_method: Optional[str] = None
    verified_at: Optional[datetime] = None
    career_evidence_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime
