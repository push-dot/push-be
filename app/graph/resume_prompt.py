from __future__ import annotations
from functools import lru_cache
from pathlib import Path

_RES = Path(__file__).resolve().parent.parent / "resources" / "super-resume"

_ADAPT = """[환경 규칙]
이 워크플로우는 Push 채팅 백엔드 안에서 실행된다. 아래 지시문은 파일시스템 도구가 있는
에이전트용으로 작성됐으므로, 환경 차이는 다음 규칙으로 적응한다.

- 단계 산출물(`01_parsed_resume.json` 등)은 아래 형식의 코드 블록으로 출력하면
  시스템이 `~/.push-resume/<대화>/`에 파일로 저장한다. 저장되는 것은 블록 본문뿐이다.

  ```json
  # file: 01_parsed_resume.json
  { ... }
  ```

  파일명은 `NN_이름.확장자` 형식을 유지한다. 이후 단계는 이전 대화와 저장된
  산출물 내용을 입력으로 사용한다.
- `request_user_input`이 없다. GATE와 선택 질문은 지시된 문구 그대로 일반 텍스트로
  표시하고 사용자의 다음 메시지를 기다린다. 응답 없이 다음 Phase로 진행하지 않는다.
- 게이트 질문을 다음 단계의 결과와 합치거나 생략하지 않는다. 품질 검증 진행 여부,
  템플릿 선택처럼 확인이 필요한 지점에서는 질문만 출력하고 멈춘다. 한 응답에
  두 개 이상의 Phase 결과를 넣지 않는다.
- `webfetch`가 없다. 사용자 메시지의 URL은 시스템이 미리 읽어 [웹 페이지]로 넣어준다.
  페이지가 제공되지 않은 URL은 읽을 수 없다고 솔직히 말한다.
- 이력서·근거 파일은 [첨부 자료]로 주어진다. PDF 원문은 이미 텍스트로 추출돼 있다.
- 최종 산출물은 마크다운 파일 블록으로 출력한다. `05_final_*.md` 블록이 저장될 때
  시스템이 같은 이름의 PDF를 자동 생성하므로 별도 변환 지시는 하지 않는다.
- 지시문 속 파일 경로·Bash·task·skill 언급은 무시하고, 절차·판단 기준·GATE만 따른다.
- 없는 경험을 지어내지 않는다. 모든 주장은 [첨부 자료]와 대화의 실제 근거에서만 가져온다.

[이식된 워크플로우 지시문]
"""

_RESUME_HINTS = (
    "이력서", "자기소개서", "자소서", "포트폴리오",
    "공고에 맞", "공고 맞춰", "resume", "cover letter",
)

_GATE_HINTS = ("선택지:", "질문:", "Phase ", "산출물")


def wants_resume_flow(text: str, history_text: str,
                      evidence_kinds: tuple = ()) -> bool:
    t = text.lower()
    return (
        any(k in t for k in _RESUME_HINTS)
        or any(k in history_text for k in _GATE_HINTS)
        or "RESUME" in evidence_kinds
    )


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

_PHASE_MARKERS = (
    (6, ("05_",)),
    (5, ("04_",)),
    (4, ("03_",)),
    (3, ("02_",)),
    (2, ("01_parsed_resume", "01_job_analyses", "01_github_findings")),
    (1, ("01_scenario", "01_tone", "01_original", "01_extracted")),
)

_PHASE_LABELS = {
    0: "Phase 0/0-I: 작업 모드 선택과 입력 수집",
    1: "Phase 1: 이력서 파싱, GitHub 탐색, 공고 분석",
    2: "Phase 2: 적합도 분석과 콘텐츠 전략",
    3: "Phase 3: 콘텐츠 초안 작성",
    4: "Phase 4: 품질 검증과 디자인 선택",
    5: "Phase 5: PDF 출력",
    6: "Phase 6: 최종 결과 제공",
}


def resume_phase(history_text: str) -> int:
    for phase, markers in _PHASE_MARKERS:
        if any(m in history_text for m in markers):
            return phase
    return 0


@lru_cache(maxsize=8)
def _phase_prompt(phase: int) -> str:
    parts = [_ADAPT, (_RES / "orchestrator.md").read_text()]
    for name in _PHASE_SKILLS[phase]:
        parts.append((_RES / "skills" / (name + ".md")).read_text())
    for p in sorted((_RES / "references").glob("*.md")):
        parts.append(p.read_text())
    parts.append(
        "[현재 단계] 지금 실행할 단계는 " + _PHASE_LABELS[phase] + "이다. "
        "이전 단계는 이미 끝났다. 이 단계의 산출물과 GATE만 처리하고, "
        "다음 Phase는 사용자 응답 후에 진행한다.")
    return "\n\n---\n\n".join(parts)


def resume_system_prompt(history_text: str = "") -> str:
    return _phase_prompt(resume_phase(history_text))
