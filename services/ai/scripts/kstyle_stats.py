"""stats.json for one loop run, from the per-turn `stats.summary(turn)` records kstyle_loop.py writes.

python scripts/kstyle_stats.py <run-dir>/transcript.jsonl [--out stats.json]

Each transcript line is one turn: {"turn", "seconds", "summary", "stop", "reply"}. `summary` is the dict
`HarnessRuntime.astream` logs as "turn stats"; `stop` is the gate the turn stopped at ({"id", "gate", "kind"})
or null; `reply` is the text the user saw.

Cost is an estimate from RATES below, by tier, not the flat credit rate the service bills.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# USD per 1M tokens (input, output) by tier. Assumes the PRO row: main and mid are the PRO model
# (anthropic/claude-sonnet-5-5); light is LIGHT_MODEL (deepseek/deepseek-v4.1-flash). The sonnet figures
# match k-style loop/stats.py; the light figure is a list-price guess, not checked against a bill.
RATES = {"main": (2.0, 10.0), "mid": (2.0, 10.0), "light": (0.3, 1.2)}
LEFT_HEAD = "확인이 필요한 점"   # kstyle/final.py's heading for findings left after the retry


def left_lines(reply: str) -> list[str]:
    """The bullet lines under the final message's left-to-check heading."""
    out, inside = [], False
    for raw in (reply or "").splitlines():
        text = raw.strip()
        if text == LEFT_HEAD:
            inside = True
        elif inside and text.startswith("• "):
            out.append(text[2:])
        elif inside and text:
            inside = False
    return out


def build(turns: list[dict]) -> dict:
    calls: dict[str, dict] = {}
    stages: dict[str, float] = {}
    late: list[str] = []
    gates: list[str] = []
    for row in turns:
        summary = row.get("summary") or {}
        for tier, used in (summary.get("tiers") or {}).items():
            total = calls.setdefault(tier, {"calls": 0, "input_tokens": 0, "output_tokens": 0})
            total["calls"] += used.get("calls", 0)
            total["input_tokens"] += used.get("in", 0)
            total["output_tokens"] += used.get("out", 0)
        for stage in summary.get("stages") or []:
            stages[stage["stage"]] = round(stages.get(stage["stage"], 0.0) + stage.get("seconds", 0.0), 3)
            late += [name for name in stage.get("late") or [] if name not in late]
        if row.get("stop"):
            gates.append(row["stop"].get("gate") or row["stop"].get("kind") or "?")
    by_tier, unpriced = {}, []
    for tier, used in calls.items():
        rate = RATES.get(tier)
        if rate is None:
            unpriced.append(tier)
            continue
        by_tier[tier] = round((used["input_tokens"] * rate[0] + used["output_tokens"] * rate[1]) / 1e6, 6)
    last = turns[-1].get("reply", "") if turns else ""
    return {
        "turns": len(turns),
        "stops": {"count": len(gates), "gates": gates},
        "model_calls": calls,
        "cost_estimate": {"usd": round(sum(by_tier.values()), 6), "by_tier": by_tier,
                          "rates_per_mtok": RATES, "unpriced_tiers": unpriced},
        "wall_seconds": {"total": round(sum(row.get("seconds", 0.0) for row in turns), 3), "stages": stages},
        "late": late,
        "left": left_lines(last),
    }


def read(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


if __name__ == "__main__":
    args = sys.argv[1:]
    out = None
    if "--out" in args:
        i = args.index("--out")
        out = args[i + 1]
        del args[i:i + 2]
    stats = build(read(Path(args[0])))
    text = json.dumps(stats, ensure_ascii=False, indent=1)
    if out:
        Path(out).write_text(text, encoding="utf-8")
    print(text)
