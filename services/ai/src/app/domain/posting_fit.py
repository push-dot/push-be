from __future__ import annotations

import json
import re

from app.domain.content import node_text
from app.domain.posting_text import posting_terms

_DIMS = (
    ("techStack", "기술 스택", 35),
    ("experienceLink", "경험 연관성", 30),
    ("careerLevel", "경력 수준", 15),
    ("keyword", "키워드", 10),
    ("domain", "도메인", 10),
)
FIT_DIMENSIONS = _DIMS


def plan_name(plan) -> str:
    if plan is None:
        return "FREE"
    text = str(plan).strip()
    return text or "FREE"


def _point(value) -> float:
    return min(10.0, max(0.0, round(float(value), 1)))


def _neutral_tech(parts: dict) -> float:
    # Nothing to check: the weighted mean of the other four, which renormalises their weights.
    rest = [
        (_point(parts.get(key, 0)), weight)
        for key, _label, weight in _DIMS if key != "techStack"]
    return sum(value * weight for value, weight in rest) / sum(weight for _value, weight in rest)


def _scored(parts: dict):
    if parts.get("techStack") is None:
        parts = {**parts, "techStack": _neutral_tech(parts)}
    scored = tuple(
        (_point(parts.get(key, 0)), index, label, weight)
        for index, (key, label, weight) in enumerate(_DIMS))
    total = sum(value * weight for value, _index, _label, weight in scored)
    score = min(10.0, max(0.0, round(total / 100, 1)))
    gap = min(scored, key=lambda item: (item[0], item[1]))
    return scored, score, gap


def _reachable(score, gap) -> float:
    lifted = float(score) + (10.0 - gap[0]) * gap[3] / 100
    return min(10.0, max(0.0, round(lifted, 1)))


def fit_view(parts: dict, plan) -> dict:
    scored, score, gap = _scored(parts)
    return {
        "fitScore": score,
        "parts": {key: scored[index][0] for index, (key, _label, _weight) in enumerate(_DIMS)},
        "topGap": gap[2],
        "plan": plan_name(plan),
        "reachable": _reachable(score, gap),
    }


def cached_view(row) -> dict:
    parts = row["parts"]
    if isinstance(parts, str):
        parts = json.loads(parts)
    viewed = fit_view(parts, row["plan"])
    return {
        "fitScore": float(row["fit_score"]),
        "parts": viewed["parts"],
        "topGap": row["top_gap"],
        "plan": viewed["plan"],
        "reachable": _reachable(row["fit_score"], _scored(parts)[2]),
    }


def requirement_items(
    requirements, keywords, description, preferred=None,
) -> tuple[list[str], list[str]]:
    """Required and preferred items in prompt order.

    Without a requirement list the posting's skills stand in,
    then the 자격요건 section of its description.
    """
    required = (
        _strings(requirements) or _strings(keywords)
        or posting_terms(description if isinstance(description, str) else "")["required"])
    return required, _strings(preferred)


_DESCRIPTION_CAP = 1500


def fit_inputs(requirements, keywords, description, content, preferred=None) -> tuple[str, str]:
    required, extra = requirement_items(requirements, keywords, description, preferred)
    lines = ["필수 요구사항:", *_numbered(required)]
    if extra:
        lines += ["우대 사항:", *_numbered(extra)]
    lines += ["키워드:", *_strings(keywords)]
    context = description.strip() if isinstance(description, str) else ""
    if context:
        # Without the company and its 업종 the domain level is a guess that flips between runs.
        lines += ["공고 설명:", context[:_DESCRIPTION_CAP]]
    return "\n".join(lines), _source_text(content)


def _numbered(items: list[str]) -> list[str]:
    return [f"{index}. {item}" for index, item in enumerate(items, 1)]


def tech_ratio(required_met: list[bool], preferred_met: list[bool]) -> float | None:
    """Met share x 10, a preferred item weighing half a required one; None with nothing to check."""
    total = len(required_met) + 0.5 * len(preferred_met)
    if not total:
        return None
    met = sum(map(bool, required_met)) + 0.5 * sum(map(bool, preferred_met))
    return round(10 * met / total, 1)


def keyword_ratio(keywords, document: str) -> float:
    """Share of distinct posting keywords found in the document (casefolded), x 10."""
    terms = list(dict.fromkeys(text.casefold() for text in _strings(keywords)))
    if not terms:
        return 0.0
    folded = (document or "").casefold()
    return round(10 * sum(_mentions(term, folded) for term in terms) / len(terms), 1)


def _mentions(term: str, folded: str) -> bool:
    if not term.isascii():
        # A Korean keyword is followed by a particle ("파이썬으로"), so a substring is the match.
        return term in folded
    return re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", folded) is not None


def _source_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        return node_text(content)
    return ""


def _strings(value) -> list[str]:
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if not isinstance(value, list):
        return []
    lines = []
    for item in value:
        if item is None:
            continue
        text = str(item).strip()
        if text:
            lines.append(text)
    return lines

