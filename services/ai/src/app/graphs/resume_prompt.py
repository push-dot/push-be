from __future__ import annotations

from functools import lru_cache
from pathlib import Path

_RES = Path(__file__).resolve().parent.parent / "resources" / "super-resume"

_PHASE_SKILLS = {
    0: ("input-collector",),
    1: ("resume-parser", "github-explorer", "job-analyzer"),
    2: ("content-strategy", "approach-selector", "blueprint-generator",
        "bottleneck-validator"),
    3: ("content-craft", "score-booster"),
    4: ("quality-review", "resume-designer"),
    5: ("pdf-publisher", "resume-designer"),
    6: ("result-presenter",),
}

_PHASE_LABELS = {
    0: "Phase 0/0-I: 작업 모드 선택과 입력 수집",
    1: "Phase 1: 이력서 파싱, GitHub 탐색, 공고 분석",
    2: "Phase 2: 적합도 분석과 콘텐츠 전략",
    3: "Phase 3: 콘텐츠 초안 작성",
    4: "Phase 4: 품질 검증과 디자인 선택",
    5: "Phase 5: PDF 출력",
    6: "Phase 6: 최종 결과 제공",
}

_HARNESS_PHASE_INDEX = {
    "mode_select": 0,
    "intake": 0,
    "analyze": 1,
    "strategy": 2,
    "craft": 3,
    "review": 4,
    "publish": 5,
    "present": 6,
}

_PHASE_REFS = {
    "analyze": ("core",),
    "strategy": ("core", "competency-signals", "projects"),
    "craft": (
        "core",
        "checklist-formulas",
        "competency-signals",
        "portfolio",
        "projects",
        "writing-voice",
    ),
    "review": ("checklist-formulas", "writing-voice"),
    "blueprints": (
        "experience-blueprints",
        "projects",
        "checklist-formulas",
        "core",
    ),
}


@lru_cache(maxsize=16)
def phase_prompt_for_harness(phase: str) -> str:
    if phase == "blueprints":
        skills = ("blueprint-generator",)
        label = "Phase 2-X: 문제해결 프로젝트 기획"
    elif phase == "validate_bp":
        skills = ("bottleneck-validator",)
        label = "Phase 2-X: 기획서 검증"
    else:
        index = _HARNESS_PHASE_INDEX[phase]
        skills = _PHASE_SKILLS[index]
        label = _PHASE_LABELS[index]
    parts = []
    for name in skills:
        parts.append((_RES / "skills" / (name + ".md")).read_text())
    for name in _PHASE_REFS.get(phase, ()):
        parts.append((_RES / "references" / (name + ".md")).read_text())
    parts.append(
        "[현재 단계] 지금 실행할 단계는 " + label + "이다. "
        "이 단계의 산출물만 만들고, 다음 단계는 사용자 응답 후에 진행한다.")
    return "\n\n---\n\n".join(parts)
