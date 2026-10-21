from __future__ import annotations

from dataclasses import dataclass

_DEFAULT_FREE = "deepseek/deepseek-v4.1-flash"
_DEFAULT_PRO = "anthropic/claude-sonnet-5-5"
_DEFAULT_ULTRA = "anthropic/claude-opus-5-5"
_DEFAULT_EMPLOYER_ULTRA = "anthropic/claude-fable-5-1"
_DEFAULT_PROVIDERS = "Together,Fireworks,Novita"

_ROWS = {
    ("PERSONAL", "FREE"): ("model_free", _DEFAULT_FREE, "LOW", "basic", "same", "same", 1_800_000),
    ("PERSONAL", "PRO"): ("model_pro", _DEFAULT_PRO, "MEDIUM", "extended", "plus1", "up1", 30_000_000),
    ("PERSONAL", "ULTRA"): ("model_ultra", _DEFAULT_ULTRA, "HIGH", "full", "plus2", "top", 100_000_000),
    ("EMPLOYER", ""): ("model_pro", _DEFAULT_PRO, "MEDIUM", "extended", "plus1", "up1", 0),
    ("EMPLOYER", "BASIC"): ("model_pro", _DEFAULT_PRO, "MEDIUM", "extended", "plus1", "up1", 18_000_000),
    ("EMPLOYER", "PRO"): ("model_ultra", _DEFAULT_ULTRA, "HIGH", "full", "plus2", "top", 90_000_000),
    ("EMPLOYER", "ULTRA"): (
        "model_employer_ultra", _DEFAULT_EMPLOYER_ULTRA, "MAX", "full", "all", "all", 180_000_000,
    ),
}


@dataclass(frozen=True)
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


def deepseek_provider(config: object) -> dict:
    raw = _cfg(config, "openrouter_deepseek_providers", _DEFAULT_PROVIDERS)
    order = [part.strip() for part in raw.split(",") if part.strip()]
    return {"ignore": ["DeepSeek"], "order": order}


def provider_for(model: str, config: object) -> dict | None:
    free = _cfg(config, "model_free", _DEFAULT_FREE)
    base = model[:-len(":online")] if model.endswith(":online") else model
    if base != free:
        return None
    return deepseek_provider(config)
