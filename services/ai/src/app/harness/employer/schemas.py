"""Typed outputs of the employer harness nodes (super-recruit)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Fact(BaseModel):
    text: str
    source_url: str = Field(alias="sourceUrl", default="")

    model_config = {"populate_by_name": True}


class CompanyProfile(BaseModel):
    name: str
    summary: str = ""
    facts: list[Fact] = []
    teams: list[str] = []
    homepage_count: int = 0
    news_count: int = 0
    posting_count: int = 0


class RoleSpec(BaseModel):
    need: str
    career_min: int = 0
    career_max: int | None = None
    must_skills: list[str] = []
    nice_skills: list[str] = []
    work_style: str = ""
    notes: str = ""


class PostingDraft(BaseModel):
    title: str
    job_category: str = ""
    career_min: int = 0
    career_max: int | None = None
    location: str = ""
    employment_type: str = "FULL_TIME"
    work_style: str = ""
    salary_range: str | None = None
    description: list[str] = []
    requirements: list[str] = []
    preferred: list[str] = []
    skills: list[str] = []

    def text(self) -> str:
        parts = [
            self.title,
            *self.description,
            *self.requirements,
            *self.preferred,
            self.work_style,
        ]
        return "\n".join(p for p in parts if p)


class PostingReview(BaseModel):
    changed: bool = False
    notes: list[str] = []
    draft: PostingDraft
    ask_salary: bool = False


class Match(BaseModel):
    requirement: str
    status: Literal["MET", "PARTIAL", "MISSING"]
    evidence: str | None = None


class Flag(BaseModel):
    title: str
    level: Literal["CHECK", "SUPPORTED", "UNKNOWN"]
    reason: str
    quote: str | None = None


class Baseline(BaseModel):
    used: bool = False
    category: str = ""
    sample_count: int = 0
    metric_ratio: float = 0.0
    concrete_ratio: float = 0.0
    link_ratio: float = 0.0


class ReviewReport(BaseModel):
    summary: str
    matches: list[Match] = []
    flags: list[Flag] = []
    baseline: Baseline = Baseline()


class InterviewQuestion(BaseModel):
    text: str
    verify: str
    good_signals: list[str] = []
    caution_signals: list[str] = []
    from_flag: str | None = None


class InterviewKit(BaseModel):
    questions: list[InterviewQuestion]


class OfferDraft(BaseModel):
    message: str
    reasons: list[str] = []
