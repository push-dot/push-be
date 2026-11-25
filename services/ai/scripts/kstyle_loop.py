"""Drive HarnessRuntime in-process for one loop case, answering every stop with a scripted persona.

python scripts/kstyle_loop.py <surface> <case-dir> <out-dir> [--real]

<case-dir> holds case.json, or is a surface folder of case folders (each runs into <out-dir>/<case>), so
two cases from different domains run together and neither is fitted. Per case it writes:
- transcript.jsonl: one line per turn (events, the turn's stats.summary, the stop, the persona's answer)
- stats.json: scripts/kstyle_stats.py over the transcript

The model is the case's "script" (tests/loop/scripted.py), free and deterministic. --real builds the
provider model instead (managed key from the environment; paid) while the rest of the world stays in
memory. The persona mirrors k-style loop/sim_user.md: it answers only what was asked, from the offered
options, and never adds instructions.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "src"), str(ROOT)]

from scripts.kstyle_stats import build  # noqa: E402

KEEP = "그대로"
MANAGED = {"provider": "OPENAI", "model": "managed", "effort": "LOW"}
_CARDS = ("choice", "approval")


def persona(card: dict | None) -> dict:
    """The recommended option, else the first, else "그대로". Returns the next turn's payload fields."""
    ids = [option["id"] for option in (card or {}).get("options") or [] if option.get("id")]
    pick = card.get("recommended") if card and card.get("recommended") in ids else (ids[0] if ids else None)
    if pick is None:
        return {"text": KEEP}
    return {"text": "", "resume": {"approvalId": card["id"], "optionId": pick}}


class _TurnStats(logging.Handler):
    """Catches the "turn stats" line HarnessRuntime.astream logs once per turn."""

    def __init__(self):
        super().__init__(logging.INFO)
        self.rows: list[dict] = []

    def emit(self, record):
        if record.msg == "turn stats %s":
            self.rows.append(json.loads(record.args[0]))


@contextmanager
def _capture():
    logger = logging.getLogger("app.harness.runtime")
    handler, level = _TurnStats(), logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        yield handler.rows
    finally:
        logger.removeHandler(handler)
        logger.setLevel(level)


def _reply(svc, before: list, events: list[dict]) -> str:
    """What the user keeps: the assistant message this turn stored, else the streamed tokens."""
    stored = [m.text for m in getattr(svc, "messages", None) or [] if m not in before and m.role == "ASSISTANT"]
    return "\n".join(stored) or "".join(str(event["token"]) for event in events if "token" in event)


async def drive(runtime, case: dict, *, user_id, conversation_id, stored=None) -> tuple[list[dict], str]:
    """Runs the case's one opening message, then persona answers, until a turn ends without a stop.
    Returns (turn rows, status): status is "done" or "max_turns". A stop is the graph's interrupt; its card
    is the streamed one with the same id, else `stored(approval_id)`, the approvals row the client reads."""
    thread = {"configurable": {"thread_id": str(conversation_id)}}
    base = {"user_id": user_id, "conversation_id": conversation_id,
            "access_mode": case.get("access_mode", "AUTO"), "ai": case.get("ai", MANAGED)}
    message = {key: case[key] for key in ("text", "intent", "context") if key in case}
    rows: list[dict] = []
    for n in range(1, int(case.get("max_turns", 8)) + 1):
        payload = {"context": {}, **base, **message,
                   "job_id": str(uuid5(NAMESPACE_URL, f"kstyle-loop:{case.get('name', '')}:{n}"))}
        events: list[dict] = []
        waiting: dict = {}
        kept = list(getattr(runtime.svc, "messages", None) or [])
        started = time.monotonic()
        with _capture() as summaries:
            async for mode, chunk in runtime.astream(payload, thread):
                if mode == "custom" and isinstance(chunk, dict):
                    events.append(chunk)
                elif mode == "values" and isinstance(chunk, dict) and chunk.get("__interrupt__"):
                    waiting = getattr(chunk["__interrupt__"][0], "value", None) or {}
        seconds = round(time.monotonic() - started, 3)
        stopped = any(event.get("type") == "done" for event in events)
        card, stop, answer = None, None, None
        if stopped:
            cards = [event for event in events if event.get("type") in _CARDS]
            wanted = waiting.get("approval_id")
            card = next((event for event in reversed(cards) if wanted in (None, event.get("id"))), None)
            if card is None and wanted and stored is not None:
                card = stored(wanted)
            stop = {"id": wanted or (card or {}).get("id"), "gate": waiting.get("gate") or (card or {}).get("gate"),
                    "kind": waiting.get("kind") or (card or {}).get("kind")}
            answer = persona(card)
        rows.append({
            "turn": n, "seconds": seconds, "sent": {k: v for k, v in message.items() if k != "context"},
            "summary": summaries[-1] if summaries else {}, "stop": stop, "answer": answer,
            "reply": _reply(runtime.svc, kept, events),
            "events": [event for event in events if "token" not in event],
        })
        if not stopped:
            return rows, "done"
        message = answer
    return rows, "max_turns"


def play(case: dict, *, real: bool = False) -> tuple[list[dict], str, list]:
    """One case in the scripted world: (turn rows, status, the scripted model's (role, tier) call log)."""
    from app.harness.runtime import HarnessRuntime
    from tests.harness_fakes import CONV, USER
    from tests.loop.scripted import model_cls, offline, service, stored_card

    svc = service(case)
    cls = model_cls(case.get("script") or {})
    runtime = HarnessRuntime(svc, model_cls=None if real else cls)
    runtime._core = None   # the loop's world has no core service: a core tool fails as TOOL_FAILED, offline
    run = drive(runtime, case, user_id=USER, conversation_id=CONV, stored=lambda id_: stored_card(svc.db, id_))
    if real:
        rows, status = asyncio.run(run)
    else:
        with offline(case.get("pages") or {}):
            rows, status = asyncio.run(run)
    return rows, status, cls.log


def run_case(case_dir: Path, out_dir: Path, *, real: bool = False) -> dict:
    case = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    case.setdefault("name", case_dir.name)
    rows, status, _log = play(case, real=real)
    out_dir.mkdir(parents=True, exist_ok=True)
    lines = (json.dumps(row, ensure_ascii=False, default=str) for row in rows)
    (out_dir / "transcript.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    stats = build(rows)
    (out_dir / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"case": case["name"], "status": status, **{k: stats[k] for k in ("turns", "stops", "cost_estimate")}}


def cases(surface: str, case_dir: Path) -> list[Path]:
    found = [case_dir] if (case_dir / "case.json").exists() else sorted(p.parent for p in case_dir.glob("*/case.json"))
    for path in found:
        named = json.loads((path / "case.json").read_text(encoding="utf-8")).get("surface")
        if named != surface:
            raise SystemExit(f"{path}: surface is {named!r}, not {surface!r}")
    return found


def main(argv: list[str]) -> None:
    real = "--real" in argv
    surface, case_dir, out_dir = (arg for arg in argv if arg != "--real")
    case_dir, out_dir = Path(case_dir), Path(out_dir)
    found = cases(surface, case_dir)
    for path in found:
        target = out_dir if path == case_dir else out_dir / path.name
        print(json.dumps(run_case(path, target, real=real), ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
