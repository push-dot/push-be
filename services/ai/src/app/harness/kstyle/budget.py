"""What a plan may spend on one run: explore rounds and calls, subagents, reviewers, and extras."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Budget:
    rounds: int
    tool_calls: int
    input_tokens: int
    repo_agents: int
    boost_cycles: int
    wall_seconds: int = 300
    reviewers: int = 0
    extras: bool = False


BUDGETS = {
    "FREE": Budget(4, 8, 60_000, 2, 0),
    "PRO": Budget(8, 24, 200_000, 4, 2, reviewers=2, extras=True),
    "ULTRA": Budget(12, 40, 400_000, 6, 3, reviewers=3, extras=True),
    "EMPLOYER:BASIC": Budget(4, 8, 60_000, 0, 0),
    "EMPLOYER:PRO": Budget(8, 24, 200_000, 0, 0, reviewers=2, extras=True),
    "EMPLOYER:ULTRA": Budget(12, 40, 400_000, 0, 0, reviewers=2, extras=True),
}


def budget_for(plan: str | None) -> Budget:
    key = str(plan or "").upper()
    fallback = "EMPLOYER:BASIC" if key.startswith("EMPLOYER:") else "FREE"
    return BUDGETS.get(key, BUDGETS[fallback])
