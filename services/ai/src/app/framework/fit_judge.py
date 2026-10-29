from __future__ import annotations

from pydantic import BaseModel

from app.config import Config
from app.domain import entities as ent
from app.domain.plan_levers import levers_for
from app.domain.posting_fit import fit_inputs, fit_view, plan_name
from app.framework.llm import AiUsageCallback, astructured_reply, chat_model_for

_SYSTEM = (
    "채용 공고와 서류를 비교해 다섯 항목을 각각 0점에서 10점으로 매겨요. "
    "기술 스택은 필수 기술 보유율 x 10이고 우대 기술은 0.5배, 가중치 35%예요. "
    "경험 연관성은 프로젝트와 경력이 직무와 얼마나 가까운지, 가중치 30%예요. "
    "경력 수준은 요구 경력 대비 적정하면 높고, 가중치 15%예요. "
    "키워드는 공고 핵심어가 서류에 있는 비율, 가중치 10%예요. "
    "도메인은 같은 업종 경험이 있는지, 가중치 10%예요. "
    "총점은 내지 않아요."
)


class FitDimensions(BaseModel):
    tech_stack: float
    experience_link: float
    career_level: float
    keyword: float
    domain: float


def _tier(audience: str, plan) -> str:
    if audience == "EMPLOYER":
        return "" if plan is None else str(plan).strip().upper()
    return plan_name(plan)


async def judge_fit(
    requirements, keywords, description, content, plan, *,
    audience="PERSONAL", config=None, cls=None, usage=None,
    gate=None, job_id=None, user_id=None,
):
    from langchain_core.messages import HumanMessage, SystemMessage

    who = (audience or "PERSONAL").strip().upper()
    tier = _tier(who, plan)
    app_config = config or Config()
    levers = levers_for(who, tier, app_config)
    model = chat_model_for(levers, streaming=False, config=app_config, cls=cls)
    posting, document = fit_inputs(requirements, keywords, description, content)
    messages = [
        SystemMessage(content=_SYSTEM),
        HumanMessage(content=f"공고:\n{posting}\n\n서류:\n{document}"),
    ]
    owned = None
    if usage is None and gate is not None and user_id is not None:
        ai = ent.AiOptions(provider="OPENAI", model=levers.model, effort=levers.effort)
        owned = await gate._reserve(
            user_id, ai, _SYSTEM, f"{posting}\n{document}", job_id, purpose="fit")
        usage = (getattr(gate, "usage", None), user_id, job_id, owned)
    invoke = {}
    if usage is not None:
        store, usage_user, usage_job, reservation_id = usage
        callback = AiUsageCallback(store, usage_user, usage_job, reservation_id)
        invoke["config"] = {"callbacks": [callback]}
    try:
        _raw, scores = await astructured_reply(model, FitDimensions, messages, **invoke)
    except BaseException:
        if owned is not None:
            await gate._release(owned)
        raise
    if scores is None:
        raise ValueError("fit judge returned an unreadable answer")
    label = tier if who == "EMPLOYER" and tier else plan_name(plan)
    return fit_view({
        "techStack": scores.tech_stack,
        "experienceLink": scores.experience_link,
        "careerLevel": scores.career_level,
        "keyword": scores.keyword,
        "domain": scores.domain,
    }, label)
