"""What a running job is doing, said with `status`, and the steps that failed, said with `notice`.

The runtime binds one `Run` per job. Every site that starts a phase calls a function here, so no
other code builds a status payload. Core writes the `queued` status at enqueue; the phases below are
the AI service's.
"""

from __future__ import annotations

import contextvars
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from app.harness.tools import emit

CardFor = Literal["answer", "confirm"]

THINKING = "생각 중"
WAITING: dict[CardFor, str] = {
    "answer": "답을 기다리고 있어요",
    "confirm": "확인을 기다리고 있어요",
}

# The status line of a document flow, word for word and in the order of board ChatBotStatusSteps
# (design version 395). The coordinator's ruling of 2026-11-13: the server says exactly these.
STEPS = (
    "서류를 읽는 중",
    "공고 요건을 읽는 중",
    "필수·우대 스택을 뽑는 중",
    "기술 스택을 비교하는 중",
    "경력 수준을 비교하는 중",
    "적합도를 계산하는 중",
    "고칠 곳을 고르는 중",
    "경력 섹션을 쓰는 중",
    "자기소개서를 쓰는 중",
    "서류 양식을 고르는 중",
    "PDF로 만드는 중",
    "결과를 검토하는 중",
    "내 서류에 저장하는 중",
)
(
    READ_DOCUMENT,
    READ_POSTING,
    PICK_STACKS,
    COMPARE_STACKS,
    COMPARE_LEVEL,
    SCORE_FIT,
    PICK_FIXES,
    WRITE_CAREER,
    WRITE_COVER_LETTER,
    PICK_TEMPLATE,
    MAKE_PDF,
    REVIEW_RESULT,
    SAVE_DOCUMENT,
) = STEPS


def _writing(state: dict) -> str:
    return (
        WRITE_COVER_LETTER
        if set(state.get("output_targets") or ()) == {"cover_letter"}
        else WRITE_CAREER
    )


# The line each node of the document flow starts, keyed by its name in the graph. None marks a gate
# or a router: it asks with its own `waiting` status. Two lines start inside a node, where its slow
# part begins: SCORE_FIT before the fit judge of classify_scenario, SAVE_DOCUMENT before p6_present
# saves.
NODE_STATUS: dict[str, str | Callable[[dict], str] | None] = {
    "p0_mode": READ_DOCUMENT,
    "p0i_intake": READ_DOCUMENT,
    "p1_analyze": READ_POSTING,
    "parse_resume": PICK_STACKS,
    "explore_github": PICK_STACKS,
    "analyze_job": PICK_STACKS,
    "classify_scenario": COMPARE_STACKS,
    "p2b_feedback": PICK_FIXES,
    "p2_strategy": PICK_FIXES,
    "p3_craft": _writing,
    "p3c_boost": WRITE_CAREER,
    "p4a_review": PICK_FIXES,
    "p4b_design": PICK_TEMPLATE,
    "p5_publish": MAKE_PDF,
    "p6_present": REVIEW_RESULT,
    "p2x_approach": PICK_FIXES,
    "p2x_validate": COMPARE_LEVEL,
    "p2x_blueprints": WRITE_CAREER,
    "p2x_validate_bp": REVIEW_RESULT,
    "g0": None,
    "g_output_targets": None,
    "g_tone": None,
    "g_intake": None,
    "g1": None,
    "g_feedback": None,
    "g2": None,
    "g3": None,
    "p3c_cycle": None,
    "g_quality": None,
    "g4a": None,
    "g_read_failed": None,
    "g6": None,
    "g_approach": None,
    "g_level": None,
    "g_prevention": None,
    "g_validate_cap": None,
    "g2x": None,
}


def wire_time(at: datetime) -> str:
    """The instant as core writes `since` (ai-jobs.ts QUEUED_STATUS), so a run has one string."""
    return at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


@dataclass
class Run:
    """One job of a turn: its id, its start, and the last status it sent."""

    job_id: str
    since: str
    last: tuple[str, str] | None = None

    def status(self, phase: str, text: str) -> dict | None:
        """The phase's event, or None when it repeats the last one: a tool loop thinks once."""
        if (phase, text) == self.last:
            return None
        self.last = (phase, text)
        return {"type": "status", "text": text, "phase": phase, "since": self.since}


current_run: contextvars.ContextVar[Run | None] = contextvars.ContextVar(
    "harness_run", default=None
)


def running_job() -> str:
    """The job running now. A resumed flow's state keeps the job that started it, for card ids."""
    run = current_run.get()
    return run.job_id if run is not None else ""


def _send(phase: str, text: str) -> None:
    run = current_run.get()
    event = run.status(phase, text) if run is not None else None
    if event is not None:
        emit(event)


def thinking() -> None:
    _send("thinking", THINKING)


def working(text: str) -> None:
    _send("working", text)


def waiting(card_id: object, card_for: CardFor, label: str | None = None) -> None:
    """Sent once per card, just before its `approval` or `choice`. `since` is its asking time.
    A write's card says what it waits on by its label (personal/tools.py CARD_LABEL)."""
    run = current_run.get()
    if run is None:
        return
    text = f"{label} · 확인을 기다리는 중" if label else WAITING[card_for]
    run.last = ("waiting", text)
    emit(
        {
            "type": "status",
            "text": text,
            "phase": "waiting",
            "since": wire_time(datetime.now(UTC)),
            "for": card_for,
            "cardId": str(card_id),
        }
    )


def notice(text: str) -> None:
    """A step failed and the run goes on. A rejected card is not a notice."""
    emit({"type": "notice", "text": text})


def with_status(name: str, node):
    """The node, sending its NODE_STATUS line when it starts. A node without a key fails here."""
    line = NODE_STATUS[name]
    if line is None:
        return node

    async def started(state):
        working(line(state) if callable(line) else line)
        return await node(state)

    return started
