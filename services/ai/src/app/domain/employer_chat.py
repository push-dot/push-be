from __future__ import annotations

from contextvars import ContextVar, Token

from app.domain.errors import validation_field
from app.domain.plan_levers import levers_for

INTENTS = frozenset({"posting", "review", "interview", "general"})
PERSONAL_INTENTS = frozenset({"match_posting", "fit", "gaps", "experience", "boost"})
_UNSET = object()
_plan: ContextVar[object] = ContextVar("employer_company_plan", default=_UNSET)


def known_intent(intent: str | None) -> str | None:
    if intent is None or intent == "":
        return None
    if not isinstance(intent, str) or intent not in INTENTS | PERSONAL_INTENTS:
        raise validation_field("intent", "unsupported intent")
    return intent


def turn_from_payload(payload: dict | None) -> dict:
    body = payload if isinstance(payload, dict) else {}
    intent = known_intent(body.get("intent"))
    application_id = body.get("application_id")
    if application_id is None:
        application_id = body.get("applicationId")
    out: dict = {}
    if intent:
        out["intent"] = intent
    if application_id:
        out["application_id"] = application_id
    return out


def apply_employer_turn(ai, plan: str | None, intent: str | None, config: object):
    levers = levers_for("EMPLOYER", plan, config)
    ai.model = levers.model
    ai.effort = levers.effort
    if intent == "posting":
        ai.web_search = True
    return ai


def posting_system_prompt() -> str:
    return (
        "공고 초안은 다음 펜스 안에 JSON으로만 쓴다.\n"
        "```posting-draft\n"
        "{\n"
        '  "title": "",\n'
        '  "description": "",\n'
        '  "requirements": [],\n'
        '  "preferred": [],\n'
        '  "workConditions": {}\n'
        "}\n"
        "```\n"
        "title은 공고 제목, description은 하는 일, requirements는 자격 요건, "
        "preferred는 우대 사항, workConditions는 근무 조건이다."
    )


def bind_employer_plan(plan: str | None) -> Token:
    stored = "" if plan is None or str(plan).strip() == "" else str(plan)
    return _plan.set(stored)


def reset_employer_plan(token: Token) -> None:
    _plan.reset(token)


def current_employer_plan() -> str | None:
    bound = _plan.get()
    if bound is _UNSET:
        return None
    return str(bound)
