from __future__ import annotations

_PREFIXES = ("이름:", "한 줄:", "연차:", "소개:", "기술:", "경력:")


def parse_profile_draft(text: str) -> dict:
    draft = {
        "displayName": "",
        "headline": "",
        "tenureYears": None,
        "intro": "",
        "careers": [],
        "skills": [],
    }
    if not text or not text.strip():
        return draft
    in_careers = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        label, value = _label(line)
        if label == "경력":
            in_careers = True
            career = _career(value)
            if career is not None:
                draft["careers"].append(career)
            continue
        if label == "이름":
            in_careers = False
            draft["displayName"] = value
            continue
        if label == "한 줄":
            in_careers = False
            draft["headline"] = value
            continue
        if label == "소개":
            in_careers = False
            draft["intro"] = value
            continue
        if label == "연차":
            in_careers = False
            draft["tenureYears"] = _tenure(value)
            continue
        if label == "기술":
            in_careers = False
            draft["skills"] = _skills(value)
            continue
        if in_careers:
            career = _career(line)
            if career is not None:
                draft["careers"].append(career)
    return draft


def _label(line: str) -> tuple[str | None, str]:
    for prefix in _PREFIXES:
        if line.startswith(prefix):
            return prefix[:-1], line[len(prefix):].strip()
    return None, ""


def _tenure(value: str) -> int | None:
    text = value.strip()
    if text.endswith("년"):
        text = text[:-1].strip()
    if text.isdigit():
        return int(text)
    return None


def _skills(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _career(line: str) -> dict | None:
    if line.count("|") != 3:
        return None
    company, title, start, end = (part.strip() for part in line.split("|"))
    return {"company": company, "title": title, "start": start, "end": end}
