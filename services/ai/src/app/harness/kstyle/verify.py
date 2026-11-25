"""Checks an output must pass before it is shown: nothing in it is made up. Code checks numbers and
evidence ids; a light fact-check subagent flags sentences and never rewrites. One retry, then
what is left is listed. What to stress is the user's call and never checked here."""
from __future__ import annotations

import re
from collections.abc import Awaitable, Callable

from app.harness.kstyle.ledger import Notes, verified
from app.harness.kstyle.subagent import Emit, line, single_call, squash

# A number and its unit, if any. A Hangul unit must touch the number ("14 배포" is not 14배);
# % and ms may keep one space.
_NUMBER = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)([배초명건만억]| ?%| ?ms)?")
_GROUPED = re.compile(r"(?<=\d),(?=\d{3}(?!\d))")
# Dates are not metrics: 2024.03, 2024-03-15, 3/15.
_DATE = re.compile(r"(?<!\d)(?:(?:19|20)\d{2}[.\-/]\d{1,2}(?:[.\-/]\d{1,2})?|\d{1,2}/\d{1,2})(?![\d])")
_YEAR = re.compile(r"(?:19|20)\d{2}")

_FACT_SYSTEM = """너는 완성된 {noun}{obj} 검사하는 하위 에이전트다. 고치지 않고, 문제만 찾는다.
{noun}의 각 문장을 brief.sources(사용자 서류 원문과 확인된 근거)와 대조해서, 근거에 없는 사실(경력·역할·기간·기술·성과)을
주장하는 문장만 골라 JSON 하나로 답한다: {{"mismatches": [{{"sentence": {noun} 원문 그대로, "problem": 무엇이 근거와 다른지 한 줄}}]}}.
문제가 없으면 빈 배열."""


def _obj(noun: str) -> str:
    """을 after a final consonant, 를 after a vowel (or non-Hangul)."""
    last = noun[-1:] or "가"
    return "을" if "가" <= last <= "힣" and (ord(last) - 0xAC00) % 28 else "를"


def finding(level: str, rule: str, detail: str) -> dict:
    return {"level": level, "rule": rule, "detail": detail}


def _numbers(text: str) -> list[tuple[str, str]]:
    """(number, unit) pairs, unit "" for a bare number. Group commas dropped, dates blanked."""
    text = _DATE.sub(" ", _GROUPED.sub("", " ".join(str(text or "").split())))
    return [(num, unit.strip()) for num, unit in _NUMBER.findall(text)]


def unsupported_numbers(text: str, *sources: str) -> list[str]:
    """Metric numbers (12%, 3배, 40명 …) in `text` that no source backs. A source number backs a
    metric when its value is the same (1,200 = 1200, 40.0 = 40) and its unit is the same or it has
    none (so "3~5명" backs 3명). A year-like number passes only as 2024초 ("early 2024").
    Not handled: a unit glued to the next word ("Python 3초보") still reads as 3초 when no
    source holds a 3."""
    known: dict[float, set[str]] = {}
    for source in sources:
        for num, unit in _numbers(source):
            known.setdefault(float(num), set()).add(unit)
    metrics = dict.fromkeys((num, unit) for num, unit in _numbers(text) if unit)
    return [f"{num}{unit}" for num, unit in metrics
            if not known.get(float(num), set()) & {"", unit}
            and not (unit == "초" and _YEAR.fullmatch(num))]


def unknown_ids(used: list[str], notes: Notes) -> list[str]:
    ledger = verified(notes)
    return [item for item in dict.fromkeys(str(item) for item in used) if item not in ledger]


async def fact_check(model, draft: str, sources: str, emit: Emit, *, noun: str = "서류") -> list[dict]:
    """Sentences of the draft that claim more than the sources say: [{sentence, problem}]. Raises
    when the check could not run or its answer is unreadable."""
    if not draft.strip():
        return []
    summary = f"{noun}{_obj(noun)} 근거와 대조해요"
    emit(line("fact_check", "run", summary, ""))
    try:
        out = await single_call(model, _FACT_SYSTEM.format(noun=noun, obj=_obj(noun)),
                                {"draft": draft, "sources": sources})
        if not isinstance(out.get("mismatches"), list):
            raise ValueError("fact check answer unreadable")
    except BaseException:
        # A check that could not run is not "nothing found": the caller lists it as not checked.
        emit(line("fact_check", "err", summary, "", "대조하지 못했어요"))
        raise
    flat = squash(draft)
    found = [{"sentence": str(item.get("sentence") or ""), "problem": str(item.get("problem") or "")}
             for item in out.get("mismatches") or [] if isinstance(item, dict)]
    # Only sentences really in the draft count: a mismatch the checker made up is dropped.
    found = [item for item in found if item["sentence"] and squash(item["sentence"]) in flat]
    emit(line("fact_check", "ok", summary, "", f"맞지 않는 문장 {len(found)}개"))
    return found


async def fix_once(output: dict, check: Callable[[dict], Awaitable[list[dict]]],
                   redo: Callable[[list[dict]], Awaitable[dict]],
                   usable: Callable[[dict], bool]) -> tuple[dict, list[dict]]:
    """Check; on any P0, redo once with the findings and keep the redo only when it is usable.
    Returns the output and the findings left."""
    findings = await check(output)
    if any(item.get("level") == "P0" for item in findings):
        retried = await redo(findings)
        if usable(retried):
            output, findings = retried, await check(retried)
    return output, findings
