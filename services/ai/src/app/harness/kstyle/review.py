"""Adversarial reviewers: two or three run together at a judgment point and return objections only, each
tied to an item of the subject. They never rewrite; the main model decides."""
from __future__ import annotations

from dataclasses import dataclass

from app.harness.kstyle.stage import Task, run_stage
from app.harness.kstyle.subagent import Emit, line, single_call

_FORMAT = """brief.subject.items의 항목마다 반대할 점만 찾는다. 고쳐 쓰지 않는다.
JSON 하나로 답한다: {"objections": [{"target": 항목의 id 그대로, "objection": 무엇이 문제인지 한 줄}]}.
반대할 점이 없으면 빈 배열."""


@dataclass(frozen=True)
class Reviewer:
    name: str       # tool-line name, e.g. "review_reader"
    summary: str    # Korean status line
    stance: str     # system prompt: who they are and what they object to


async def run_reviewers(model, reviewers: list[Reviewer], subject: dict, emit: Emit, *,
                        seconds: float = 45) -> dict:
    """{"objections": [{"by", "target", "objection"}], "late": [name], "failed": [name]}. An
    objection whose target is not an id in subject["items"] is dropped. A reviewer whose answer has
    no objection list failed: an unreadable answer is not "no objections"."""
    ids = {str(item.get("id")) for item in subject.get("items") or [] if isinstance(item, dict)}

    def task(reviewer: Reviewer) -> Task:
        async def run() -> dict:
            emit(line(reviewer.name, "run", reviewer.summary, ""))
            out = await single_call(model, reviewer.stance + "\n\n" + _FORMAT, {"subject": subject})
            if not isinstance(out.get("objections"), list):
                raise ValueError(f"{reviewer.name}: unreadable answer")
            kept = [{"by": reviewer.name, "target": str(item.get("target")),
                     "objection": str(item.get("objection") or "").strip()}
                    for item in out.get("objections") or [] if isinstance(item, dict)]
            kept = [item for item in kept if item["target"] in ids and item["objection"]]
            emit(line(reviewer.name, "ok", reviewer.summary, "", f"반대 {len(kept)}개"))
            return {"objections": kept}

        return Task(reviewer.name, run, seconds)

    staged = await run_stage([task(reviewer) for reviewer in reviewers])
    late, failed = staged["late"], staged["failed"]
    dropped = {*late, *failed}
    for reviewer in reviewers:
        if reviewer.name in dropped:
            emit(line(reviewer.name, "err", reviewer.summary, "",
                      "시간 안에 끝나지 않았어요" if reviewer.name in late else "끝내지 못했어요"))
    objections = [item for reviewer in reviewers if reviewer.name not in dropped
                  for item in staged["out"][reviewer.name].get("objections") or []]
    return {"objections": objections, "late": late, "failed": failed}
