from __future__ import annotations

import hashlib
from dataclasses import replace
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, Field

from app.config import load_config
from app.domain import entities as ent
from app.domain.plan_levers import levers_for
from app.domain.posting_fit import (
    fit_inputs,
    fit_view,
    keyword_ratio,
    plan_name,
    requirement_items,
    tech_ratio,
)
from app.framework.llm import AiUsageCallback, astructured_reply, chat_model_for
from app.framework.untrusted import DATA_RULE, as_data

_SYSTEM = (
    "채용 공고와 서류를 비교해요. 총점은 내지 않아요.\n"
    "required_met: 번호 붙은 필수 요구사항마다 서류가 충족하면 true, 아니면 false예요. "
    "그 기술이나 경험이 서류에 이름으로 나오거나 그것을 쓴 일이 적혀 있으면 충족이에요. "
    "숙련도나 깊이는 따지지 않아요. "
    "순서와 개수를 목록과 똑같이 맞춰요.\n"
    "preferred_met: 우대 사항도 같은 방식이에요. 우대 사항이 없으면 빈 목록이에요.\n"
    "기술 스택 점수(가중치 35%)는 이 표시로 계산해요. "
    "필수 기술 보유율 x 10이고 우대 기술은 0.5배예요. "
    "키워드(가중치 10%)는 따로 계산하니 답하지 않아요.\n"
    "아래 세 항목은 0, 2, 4, 6, 8, 10 중 하나로만 답해요.\n"
    "experience_link 경험 연관성(가중치 30%): "
    "10 같은 직무의 프로젝트·경력이 핵심 업무와 그대로 겹쳐요. "
    "8 대부분 겹치고 일부만 달라요. "
    "6 관련 직무지만 핵심 업무 경험은 절반쯤이에요. "
    "4 인접 직무라 옮겨 쓸 수 있는 경험만 있어요. "
    "2 연관이 약한 경험만 있어요. "
    "0 관련 경험이 없어요.\n"
    "career_level 경력 수준(가중치 15%): "
    "10 요구 경력에 딱 맞아요. "
    "8 1년 안쪽으로 모자라거나 조금 넘쳐요. "
    "6 1~2년 모자라거나 꽤 넘쳐요. "
    "4 2~3년 모자라요. "
    "2 3년 넘게 모자라요. "
    "0 서류에 경력을 판단할 내용이 없어요. "
    "공고에 요구 경력이 없으면 서류 경력이 직무와 맞을 때 8로 둬요.\n"
    "domain 도메인(가중치 10%): "
    "10 같은 업종에서 일했어요. "
    "8 같은 업종 프로젝트가 있어요. "
    "6 가까운 업종 경험이 있어요. "
    "4 업종 지식만 보여요. "
    "2 먼 업종이에요. "
    "0 서류에 업종 단서가 없어요. "
    "업종은 공고 설명의 회사와 서비스로 판단하고, 공고 업종을 알 수 없으면 6으로 둬요."
)


def _level(value):
    # Snap a stray 7 or "8" to the scale instead of failing the whole judgement.
    try:
        return min(10, max(0, round(float(value) / 2) * 2))
    except (TypeError, ValueError):
        return value


Level = Annotated[Literal[0, 2, 4, 6, 8, 10], BeforeValidator(_level)]


class FitDimensions(BaseModel):
    required_met: list[bool] = Field(default_factory=list)
    preferred_met: list[bool] = Field(default_factory=list)
    experience_link: Level
    career_level: Level
    domain: Level


def _aligned(flags: list[bool], count: int) -> list[bool]:
    return (list(flags) + [False] * count)[:count]


def _tier(audience: str, plan) -> str:
    if audience == "EMPLOYER":
        return "" if plan is None else str(plan).strip().upper()
    return plan_name(plan)


async def judge_fit(
    requirements, keywords, description, content, plan, *,
    audience="PERSONAL", config=None, cls=None, usage=None,
    gate=None, job_id=None, user_id=None, preferred=None, purpose=None,
):
    from langchain_core.messages import HumanMessage, SystemMessage

    who = (audience or "PERSONAL").strip().upper()
    tier = _tier(who, plan)
    app_config = config if config is not None else load_config()
    levers = levers_for(who, tier, app_config)
    # No reasoning so temperature 0 is accepted; the same inputs should give the same score.
    model = chat_model_for(
        replace(levers, effort=""), streaming=False, config=app_config, cls=cls,
        temperature=0)
    required, extra = requirement_items(requirements, keywords, description, preferred)
    posting, document = fit_inputs(requirements, keywords, description, content, preferred)
    messages = [
        SystemMessage(content=_SYSTEM + "\n\n" + DATA_RULE),
        HumanMessage(content=as_data(f"공고:\n{posting}\n\n서류:\n{document}", "fit_input", None)),
    ]
    owned = None
    if usage is None and gate is not None and user_id is not None:
        ai = ent.AiOptions(provider="OPENAI", model=levers.model, effort=levers.effort)
        owned = await gate._reserve(
            user_id, ai, _SYSTEM, f"{posting}\n{document}", job_id,
            # One usage row per scored pair: concurrent scores in one job must not share a reservation.
            # Callers that know the pair name it: two postings with the same text share the hash.
            purpose=purpose or "fit:" + hashlib.sha1(
                f"{posting}\n{document}".encode()).hexdigest()[:12])
        if owned is not None:
            usage = (
                getattr(gate, "usage", None), user_id, job_id,
                getattr(owned, "id", owned), getattr(owned, "generation", None),
            )
    invoke = {}
    if usage is not None:
        store, usage_user, usage_job, reservation_id, *rest = usage
        generation = rest[0] if rest else None
        callback = AiUsageCallback(store, usage_user, usage_job, reservation_id, generation)
        invoke["config"] = {"callbacks": [callback]}
    try:
        _raw, scores = await astructured_reply(model, FitDimensions, messages, **invoke)
    except BaseException:
        if owned is not None:
            await gate._release(getattr(owned, "id", owned), getattr(owned, "generation", None))
        raise
    if scores is None:
        raise ValueError("fit judge returned an unreadable answer")
    label = tier if who == "EMPLOYER" and tier else plan_name(plan)
    return fit_view({
        "techStack": tech_ratio(
            _aligned(scores.required_met, len(required)),
            _aligned(scores.preferred_met, len(extra))),
        "experienceLink": scores.experience_link,
        "careerLevel": scores.career_level,
        "keyword": keyword_ratio(keywords, document),
        "domain": scores.domain,
    }, label)
