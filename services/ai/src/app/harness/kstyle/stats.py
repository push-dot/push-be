"""Per-turn counters for the evaluation loop: model calls and tokens by tier, and stage times. Pure; the
turn dict is the one `GateModel` already carries. Nothing here goes to the client."""
from __future__ import annotations

from contextvars import ContextVar

# The turn dict HarnessRuntime.astream binds, so a stage marks itself without a handle.
current: ContextVar[dict | None] = ContextVar("kstyle_turn_stats", default=None)


def record(turn: dict, tier: str, input_tokens: int, output_tokens: int) -> None:
    row = turn.setdefault("tiers", {}).setdefault(tier, {"calls": 0, "in": 0, "out": 0})
    row["calls"] += 1
    row["in"] += int(input_tokens or 0)
    row["out"] += int(output_tokens or 0)


def mark(turn: dict, stage: str, seconds: float, late: list[str]) -> None:
    turn.setdefault("stages", []).append({"stage": stage, "seconds": round(seconds, 3), "late": list(late)})


def summary(turn: dict) -> dict:
    return {
        "model": turn.get("model") or "",
        "input_tokens": turn.get("input_tokens", 0),
        "output_tokens": turn.get("output_tokens", 0),
        "tiers": {tier: dict(row) for tier, row in (turn.get("tiers") or {}).items()},
        "stages": [dict(item) for item in turn.get("stages") or []],
    }
