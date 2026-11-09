from __future__ import annotations

from dataclasses import dataclass

from app.domain.entities import PLAN_CREDITS_MICRO, PLAN_FREE, PLAN_PRO, PLAN_ULTRA

_DEFAULT_FREE = "deepseek/deepseek-v4.1-flash"
_DEFAULT_PRO = "anthropic/claude-sonnet-5-5"
_DEFAULT_ULTRA = "anthropic/claude-opus-5-5"
_DEFAULT_EMPLOYER_ULTRA = "anthropic/claude-fable-5-1"

_ROWS = {
    ("PERSONAL", "FREE"): ("model_free", _DEFAULT_FREE, "LOW", "basic", "same", "same", PLAN_CREDITS_MICRO[PLAN_FREE]),
    ("PERSONAL", "PRO"): ("model_pro", _DEFAULT_PRO, "MEDIUM", "extended", "plus1", "up1", PLAN_CREDITS_MICRO[PLAN_PRO]),
    ("PERSONAL", "ULTRA"): ("model_ultra", _DEFAULT_ULTRA, "HIGH", "full", "plus2", "top", PLAN_CREDITS_MICRO[PLAN_ULTRA]),
    ("EMPLOYER", ""): ("model_pro", _DEFAULT_PRO, "MEDIUM", "extended", "plus1", "up1", 0),
    ("EMPLOYER", "BASIC"): ("model_pro", _DEFAULT_PRO, "MEDIUM", "extended", "plus1", "up1", 18_000_000),
    ("EMPLOYER", "PRO"): ("model_ultra", _DEFAULT_ULTRA, "HIGH", "full", "plus2", "top", 90_000_000),
    ("EMPLOYER", "ULTRA"): (
        "model_employer_ultra", _DEFAULT_EMPLOYER_ULTRA, "MAX", "full", "all", "all", 180_000_000,
    ),
}


@dataclass(frozen=True, slots=True)
class PlanLevers:
    model: str
    effort: str
    reference: str
    tenure: str
    score_band: str
    monthly_micro: int


def _cfg(config: object, name: str, default: str) -> str:
    value = getattr(config, name, None)
    if value is None or value == "":
        return default
    return str(value)


def levers_for(audience: str, plan: str | None, config: object) -> PlanLevers:
    who = (audience or "").strip().upper()
    tier = (plan or "").strip().upper()
    if who == "PERSONAL" and tier == "":
        tier = "FREE"
    row = _ROWS.get((who, tier))
    if row is None:
        raise ValueError("unsupported audience or plan")
    field, default, effort, reference, tenure, score_band, monthly_micro = row
    return PlanLevers(
        _cfg(config, field, default), effort, reference, tenure, score_band, monthly_micro,
    )


# OpenRouter provider pins, the 개인정보처리방침 국외 이전 list: US providers that do not train
# on requests. Checked 2026-11-09 against openrouter.ai/api/v1/models/<model>/endpoints and
# /api/v1/providers (headquarters US); see decisions.tsv. A prefix ending in "/" covers its family.
_US_PROVIDERS = (
    ("deepseek/deepseek-v4.1-flash", ("together", "fireworks", "novita")),
    ("anthropic/", ("anthropic",)),
    ("openai/text-embedding-3-small", ("openai",)),
)


def provider_for(model: str) -> dict:
    """OpenRouter provider preferences; a model without a pinned list is refused before any call."""
    base = model.removesuffix(":online")
    for name, only in _US_PROVIDERS:
        if base == name or (name.endswith("/") and base.startswith(name)):
            return {"only": list(only), "allow_fallbacks": False, "data_collection": "deny"}
    from app.domain.errors import not_configured
    raise not_configured("model " + base + " has no approved provider")


def openrouter_route(model: str) -> dict:
    """Request fields every OpenRouter chat call carries. Web search always runs on Exa."""
    route: dict = {"provider": provider_for(model)}
    if model.endswith(":online"):
        route["plugins"] = [{"id": "web", "engine": "exa"}]
    return route
