"""Employer harness quality eval (super-recruit). Run on the VPS before a release:

    uv run python eval/employer/run_employer_eval.py --plan PRO

Uses the real model for the plan (OpenRouter key from the environment) and prints
the metrics the design doc gates on (docs/plans/2026-10-30-employer-harness-design.md §8):
- banned terms left in posting drafts: 0
- forbidden interview questions left: 0
- verdict phrases in review flags: 0
- planted exaggerations flagged CHECK: >= 80%
- solid documents wrongly flagged CHECK: <= 20%
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from app.config import load_config
from app.domain.fair_hiring import banned_in_interview, banned_in_posting, verdicts_in
from app.domain.plan_levers import PlanLevers, levers_for
from app.framework.llm import chat_model_for
from app.harness.employer import nodes
from app.harness.employer.llm import structured_generate
from app.harness.employer.schemas import Flag, PostingDraft

CASES = json.loads((Path(__file__).parent / "cases.json").read_text(encoding="utf-8"))


async def run(plan: str) -> dict:
    cfg = load_config()
    levers = levers_for("EMPLOYER", plan, cfg)
    model = chat_model_for(
        PlanLevers(levers.model, levers.effort, "", "", "", 0), streaming=False, config=cfg
    )
    generate = structured_generate(model)
    left = 0
    for case in CASES["postings"]:
        review = await nodes.review_posting(generate, PostingDraft.model_validate(case["draft"]))
        left += len(banned_in_posting(review.draft.text()))
    caught = planted = solid_wrong = solid = verdicts = 0
    for doc in CASES["documents"]:
        flags = await nodes.verify_claims(
            generate, doc["text"], "백엔드 엔지니어 4-6년", "[]", {"used": False}
        )
        verdicts += sum(1 for f in flags if verdicts_in(f.title + f.reason))
        checks = [f for f in flags if f.level == "CHECK"]
        if doc["kind"] == "CHECK":
            planted += 1
            caught += 1 if checks else 0
        else:
            solid += 1
            solid_wrong += 1 if checks else 0
    kit = await nodes.design_interview(
        generate,
        [Flag(title="역할", level="CHECK", reason="본인 기여가 흐려요")],
        "백엔드 엔지니어",
        CASES["documents"][0]["text"],
    )
    bad_questions = sum(1 for q in kit.questions if banned_in_interview(q.text))
    return {
        "plan": plan,
        "posting_banned_left": left,
        "interview_forbidden_left": bad_questions,
        "verdicts": verdicts,
        "planted_recall": round(caught / planted, 2) if planted else None,
        "solid_false_check": round(solid_wrong / solid, 2) if solid else None,
    }


def passed(m: dict) -> bool:
    return (
        m["posting_banned_left"] == 0
        and m["interview_forbidden_left"] == 0
        and m["verdicts"] == 0
        and (m["planted_recall"] or 0) >= 0.8
        and (m["solid_false_check"] or 0) <= 0.2
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", default="PRO", choices=["BASIC", "PRO", "ULTRA"])
    metrics = asyncio.run(run(parser.parse_args().plan))
    print(json.dumps({**metrics, "passed": passed(metrics)}, ensure_ascii=False, indent=2))
    raise SystemExit(0 if passed(metrics) else 1)


if __name__ == "__main__":
    main()
