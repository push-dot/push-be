"""Reference-data baseline for employer review: statistics only, never sentences.

feature-spec 18: only buckets with at least 30 samples count, the window follows the
company plan, and employer AI never repeats another person's wording.
"""

from __future__ import annotations

from app.domain.reference_text import prompt_samples


def baseline_stats(
    samples: list[dict], category, tenure, score, tenure_window: str, score_window: str
) -> dict:
    kept = prompt_samples(samples, category, tenure, score, tenure_window, score_window)
    if not kept:
        return {
            "used": False,
            "category": category or "",
            "sample_count": 0,
            "metric_ratio": 0.0,
            "concrete_ratio": 0.0,
            "link_ratio": 0.0,
        }
    n = len(kept)

    def ratio(pred) -> float:
        return round(sum(1 for s in kept if pred(s.get("features") or {})) / n, 2)

    return {
        "used": True,
        "category": category,
        "sample_count": n,
        "metric_ratio": ratio(lambda f: f.get("has_metric")),
        "concrete_ratio": ratio(lambda f: f.get("tech_depth") == "concrete"),
        "link_ratio": ratio(lambda f: f.get("links_experience")),
    }


def baseline_lines(stats: dict) -> list[str]:
    """Prompt lines for the claim verifier. Numbers only; no sample text is ever included."""
    if not stats.get("used"):
        return []
    return [
        f"[기준선] {stats['category']} 같은 구간 서류 {stats['sample_count']}개 통계",
        f"- 수치 성과가 있는 서류 비율: {stats['metric_ratio']:.0%}",
        f"- 기술 설명이 구체적인 서류 비율: {stats['concrete_ratio']:.0%}",
        f"- 경험과 역량이 연결된 서류 비율: {stats['link_ratio']:.0%}",
        "이 통계로만 비교한다. 다른 사람의 문장은 쓰지 않는다.",
    ]
