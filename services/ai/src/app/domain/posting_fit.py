from __future__ import annotations

import json
from uuid import UUID

from app.domain.content import node_text
from app.domain.services.job import part_scores

_GAPS = (
    ("techStack", "기술 스택"),
    ("experienceLink", "경험 연관성"),
    ("keyword", "키워드"),
)


def plan_name(plan) -> str:
    if plan is None:
        return "FREE"
    text = str(plan).strip()
    return text or "FREE"


def fit_view(parts: dict, plan) -> dict:
    scored = tuple(
        (int(parts[key]), index, label) for index, (key, label) in enumerate(_GAPS))
    total = scored[0][0] + scored[1][0] + scored[2][0]
    score = min(10.0, max(0.0, round(total / 30, 1)))
    return {
        "fitScore": score,
        "parts": {key: scored[index][0] for index, (key, _) in enumerate(_GAPS)},
        "topGap": min(scored)[2],
        "plan": plan_name(plan),
    }


def cached_view(row) -> dict:
    parts = row["parts"]
    if isinstance(parts, str):
        parts = json.loads(parts)
    return {
        "fitScore": float(row["fit_score"]),
        "parts": {key: int(parts[key]) for key, _label in _GAPS},
        "topGap": row["top_gap"],
        "plan": plan_name(row["plan"]),
    }


def compute_fit(requirements, keywords, description, document_id, content, plan) -> dict:
    evidence = _Evidence(document_id, _source_text(content))
    parts = part_scores(
        _requirements(requirements, description), _strings(keywords), [evidence])
    return fit_view(parts, plan)


class _Evidence:
    def __init__(self, id_: UUID, source_text: str):
        self.id = id_
        self.skills: list[str] = []
        self.source_text = source_text


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
