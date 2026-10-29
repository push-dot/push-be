from __future__ import annotations

from typing import Literal
from urllib.parse import urlencode
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.domain.posting_fit import compute_fit
from app.harness.core_client import idempotency_key
from app.harness.policy import Tier
from app.harness.tools import OptionalId, ToolContext, ToolSpec

Stage = Literal["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "REJECTED"]


class EmptyArgs(BaseModel):
    pass


class PostingId(BaseModel):
    posting_id: UUID


class ApplicantsArgs(BaseModel):
    posting_id: UUID
    stage: Stage | None = None


class ApplicantArgs(BaseModel):
    posting_id: UUID
    application_id: UUID


class StageArgs(BaseModel):
    posting_id: UUID
    application_id: UUID
    stage: Stage


class ProfileSearch(BaseModel):
    q: str = ""


class ProfileId(BaseModel):
    profile_id: UUID


class OfferArgs(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    profile_id: UUID
    message: str
    posting_id: UUID | None = None


class DraftArgs(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    title: str = ""
    description: str = ""
    job_category: Literal["dev", "data", "design", "plan", "marketing", "sales", "hr", "ops"]
    career_min: int = 0
    career_max: int | None = None
    location: str
    employment_type: Literal["full_time", "contract", "intern", "freelance", "dispatch"]
    skills: list[str] = []
    requirements: list[str] = []
    preferred: list[str] = []


class PostingPatch(BaseModel):
    posting_id: UUID
    title: str = ""
    description: str = ""


class PostBody(BaseModel):
    category: Literal["work", "dev", "daily", "career", "talk", "coffeechat", "marketing"]
    title: str
    body: str


class FitArgs(BaseModel):
    posting_id: OptionalId = None
    document_id: OptionalId = None
    requirements: list[str] = []
    keywords: list[str] = []
    description: str = ""
    content: str = ""


def _http(name, tier, model, summary, method, path_of, *, write=False, body_of=None, wrap=None):
    async def run(ctx: ToolContext, args):
        data = await ctx.core.call(
            method,
            path_of(args),
            user_id=ctx.user_id,
            company_id=ctx.company_id,
            json=body_of(args) if body_of else None,
            idempotency_key=idempotency_key(ctx.job_id, ctx.tool_call_id) if write else None,
        )
        if wrap == "draft":
            return {"draft": data}
        return data

    return ToolSpec(name, tier, model, run, lambda _args: summary)


def _patch_posting(name, tier, model, summary, body_of, *, draft_only=False):
    async def run(ctx: ToolContext, args):
        path = f"/api/v1/postings/{args.posting_id}"
        current = await ctx.core.call("GET", path, user_id=ctx.user_id, company_id=ctx.company_id)
        if draft_only and current.get("status") != "DRAFT":
            return {"error": "NOT_DRAFT"}
        return await ctx.core.call(
            "PATCH",
            path,
            user_id=ctx.user_id,
            company_id=ctx.company_id,
            json={**body_of(args), "expectedRevision": current.get("revision")},
            idempotency_key=idempotency_key(ctx.job_id, ctx.tool_call_id),
        )

    return ToolSpec(name, tier, model, run, lambda _args: summary)


def _kept(args, drop: set[str]) -> dict:
    body = args.model_dump(mode="json", exclude=drop, by_alias=True)
    return {key: value for key, value in body.items() if value not in ("", None, [])}


async def _fit(_ctx: ToolContext, args: FitArgs) -> dict:
    return compute_fit(
        args.requirements, args.keywords, args.description,
        args.document_id or UUID(int=0), args.content, "FREE")


EMPLOYER_TOOLS = [
    _http("list_company_postings", Tier.READ, EmptyArgs, "우리 회사 공고를 봐요", "GET",
          lambda _args: "/api/v1/companies/me/postings"),
    _http("get_posting", Tier.READ, PostingId, "공고 내용을 봐요", "GET",
          lambda args: f"/api/v1/postings/{args.posting_id}"),
    _http("list_applicants", Tier.READ, ApplicantsArgs, "지원자 목록을 봐요", "GET",
          lambda args: f"/api/v1/postings/{args.posting_id}/applicants"
          + ("?" + urlencode({"stage": args.stage}) if args.stage else "")),
    _http("get_applicant", Tier.READ, ApplicantArgs, "지원자 서류를 봐요", "GET",
          lambda args: f"/api/v1/postings/{args.posting_id}/applicants/{args.application_id}"),
    _http("get_applicant_counts", Tier.READ, PostingId, "단계별 지원자 수를 봐요", "GET",
          lambda args: f"/api/v1/postings/{args.posting_id}/applicant-counts"),
    _http("search_profiles", Tier.READ, ProfileSearch, "인재를 찾아요", "GET",
          lambda args: "/api/v1/profiles" + ("?" + urlencode({"q": args.q}) if args.q else "")),
    _http("get_profile", Tier.READ, ProfileId, "인재 프로필을 봐요", "GET",
          lambda args: f"/api/v1/profiles/{args.profile_id}"),
    _http("get_company", Tier.READ, EmptyArgs, "우리 회사 정보를 봐요", "GET",
          lambda _args: "/api/v1/companies/me"),
    ToolSpec("get_fit_score", Tier.READ, FitArgs, _fit, lambda _args: "공고와 얼마나 맞는지 봐요"),
    _http("draft_posting", Tier.SAFE_WRITE, DraftArgs, "공고 초안을 저장해요", "POST",
          lambda _args: "/api/v1/postings", write=True, wrap="draft",
          body_of=lambda args: {**_kept(args, set()), "status": "DRAFT"}),
    _patch_posting("update_posting_draft", Tier.SAFE_WRITE, PostingPatch, "공고 초안을 수정해요",
                   lambda args: _kept(args, {"posting_id"}), draft_only=True),
    _patch_posting("publish_posting", Tier.RISKY_WRITE, PostingId, "공고를 게시해요",
                   lambda _args: {"status": "OPEN"}),
    _patch_posting("update_published_posting", Tier.RISKY_WRITE, PostingPatch, "게시한 공고를 수정해요",
                   lambda args: _kept(args, {"posting_id"})),
    _http("close_posting", Tier.RISKY_WRITE, PostingId, "공고를 마감해요", "POST",
          lambda args: f"/api/v1/postings/{args.posting_id}/close", write=True),
    _http("change_applicant_stage", Tier.RISKY_WRITE, StageArgs, "지원자 단계를 바꿔요", "PATCH",
          lambda args: f"/api/v1/postings/{args.posting_id}/applicants/{args.application_id}",
          write=True, body_of=lambda args: {"stage": args.stage}),
    _http("send_offer", Tier.RISKY_WRITE, OfferArgs, "인재에게 제안을 보내요", "POST",
          lambda args: f"/api/v1/profiles/{args.profile_id}/offer", write=True,
          body_of=lambda args: _kept(args, {"profile_id"})),
    _http("create_company_post", Tier.RISKY_WRITE, PostBody, "회사 글을 올려요", "POST",
          lambda _args: "/api/v1/posts", write=True,
          body_of=lambda args: args.model_dump()),
]


class StartPostingArgs(BaseModel):
    reference_posting_id: UUID | None = None


class ApplicationArgs(BaseModel):
    application_id: UUID


def _enter(name: str, **flow):
    from app.harness.graph import enter_flow

    return enter_flow(f"{name}_flow", flow={"name": name, "step": "start", **flow})


async def _start_posting(_ctx: ToolContext, args: StartPostingArgs):
    ref = str(args.reference_posting_id) if args.reference_posting_id else None
    return _enter("posting", reference_posting_id=ref)


async def _review_applicant(_ctx: ToolContext, args: ApplicationArgs):
    return _enter("review", application_id=str(args.application_id))


async def _prepare_interview(_ctx: ToolContext, args: ApplicationArgs):
    return _enter("interview", application_id=str(args.application_id))


EMPLOYER_TOOLS += [
    ToolSpec("start_posting", Tier.SAFE_WRITE, StartPostingArgs, _start_posting,
             lambda _args: "회사를 조사하고 공고 초안을 함께 만들어요"),
    ToolSpec("review_applicant", Tier.READ, ApplicationArgs, _review_applicant,
             lambda _args: "지원자 서류에서 면접 때 확인할 부분을 찾아요"),
    ToolSpec("prepare_interview", Tier.READ, ApplicationArgs, _prepare_interview,
             lambda _args: "서류 검토 결과로 검증 면접 질문을 만들어요"),
]
