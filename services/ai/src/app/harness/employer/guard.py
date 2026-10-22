from __future__ import annotations

from types import SimpleNamespace

from app.config import load_config
from app.domain.employer_chat import apply_employer_turn


def guard_employer_intent(plan: str | None, intent: str | None) -> None:
    apply_employer_turn(
        SimpleNamespace(model="", effort="", web_search=False),
        plan,
        intent,
        load_config(),
    )
