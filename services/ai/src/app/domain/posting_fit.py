from __future__ import annotations

import json

from app.domain.content import node_text

_DIMS = (
    ("techStack", "기술 스택", 35),
    ("experienceLink", "경험 연관성", 30),
    ("careerLevel", "경력 수준", 15),
    ("keyword", "키워드", 10),
    ("domain", "도메인", 10),
)


def plan_name(plan) -> str:
    if plan is None:
        return "FREE"
    text = str(plan).strip()
    return text or "FREE"


def _point(value) -> float:
    return min(10.0, max(0.0, round(float(value), 1)))


def fit_view(parts: dict, plan) -> dict:
    scored = tuple(
        (_point(parts.get(key, 0)), index, label, weight)
        for index, (key, label, weight) in enumerate(_DIMS))
    total = sum(value * weight for value, _index, _label, weight in scored)
    score = min(10.0, max(0.0, round(total / 100, 1)))
    gap = min(scored, key=lambda item: (item[0], item[1]))
    return {
        "fitScore": score,
        "parts": {key: scored[index][0] for index, (key, _label, _weight) in enumerate(_DIMS)},
        "topGap": gap[2],
        "plan": plan_name(plan),
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
    }


def fit_inputs(requirements, keywords, description, content) -> tuple[str, str]:
    lines = ["요구사항:", *_requirements(requirements, description), "키워드:", *_strings(keywords)]
    return "\n".join(lines), _source_text(content)


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


def _requirements(requirements, description) -> list[str]:
    lines = _strings(requirements)
    if lines:
        return lines
    return _strings(description)
