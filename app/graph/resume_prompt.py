from __future__ import annotations
from functools import lru_cache
from pathlib import Path

_RES = Path(__file__).resolve().parent.parent / "resources" / "super-resume"

_ADAPT = """[환경 규칙]
이 워크플로우는 Push 채팅 백엔드 안에서 실행된다. 아래 지시문은 파일시스템 도구가 있는
에이전트용으로 작성됐으므로, 환경 차이는 다음 규칙으로 적응한다.

- `_workspace/` 같은 파일시스템이 없다. 단계 산출물은 대화 안에서 구조화된 텍스트로
  유지하고, 이후 단계는 이전 대화 내용을 입력으로 사용한다.
- `request_user_input`이 없다. GATE와 선택 질문은 지시된 문구 그대로 일반 텍스트로
  표시하고 사용자의 다음 메시지를 기다린다. 응답 없이 다음 Phase로 진행하지 않는다.
- `webfetch`가 없다. 사용자 메시지의 URL은 시스템이 미리 읽어 [웹 페이지]로 넣어준다.
  페이지가 제공되지 않은 URL은 읽을 수 없다고 솔직히 말한다.
- 이력서·근거 파일은 [첨부 자료]로 주어진다. PDF 원문은 이미 텍스트로 추출돼 있다.
- 최종 산출물은 마크다운으로 메시지에 출력한다. PDF/HTML 변환은 하지 않는다.
- 지시문 속 파일 경로·Bash·task·skill 언급은 무시하고, 절차·판단 기준·GATE만 따른다.
- 없는 경험을 지어내지 않는다. 모든 주장은 [첨부 자료]와 대화의 실제 근거에서만 가져온다.

[이식된 워크플로우 지시문]
"""

_RESUME_HINTS = (
    "이력서", "자기소개서", "자소서", "포트폴리오",
    "공고에 맞", "공고 맞춰", "resume", "cover letter",
)

_GATE_HINTS = ("선택지:", "질문:", "Phase ", "산출물")


def wants_resume_flow(text: str, history_text: str) -> bool:
    t = text.lower()
    return (
        any(k in t for k in _RESUME_HINTS)
        or any(k in history_text for k in _GATE_HINTS)
    )


@lru_cache(maxsize=1)
def resume_system_prompt() -> str:
    parts = [_ADAPT, (_RES / "orchestrator.md").read_text()]
    for p in sorted((_RES / "skills").glob("*.md")):
        parts.append(p.read_text())
    for p in sorted((_RES / "references").glob("*.md")):
        parts.append(p.read_text())
    return "\n\n---\n\n".join(parts)
