"""Deterministic guards for employer AI output (fair hiring, no verdicts).

The word lists mirror resources/super-recruit/references/fair-hiring.md section 5;
a test keeps the two in sync.
"""

from __future__ import annotations

POSTING_BANNED: tuple[str, ...] = (
    "세 이하",
    "세 이상",
    "세 미만",
    "년생",
    "20대",
    "30대",
    "40대",
    "젊은",
    "나이",
    "남성",
    "여성",
    "남자",
    "여자",
    "남녀",
    "미혼",
    "기혼",
    "결혼",
    "임신",
    "출산 계획",
    "자녀",
    "가족 관계",
    "용모",
    "외모",
    "키 ",
    "체중",
    "신장",
    "출신 지역",
    "고향",
    "명문대",
    "SKY",
    "인서울",
)

INTERVIEW_BANNED: tuple[str, ...] = (
    "결혼하셨",
    "아이 계획",
    "몇 살",
    "나이가",
    "부모님",
    "종교",
    "고향이",
)

# Words that turn an opinion into a hiring decision. The employer agent only points
# at what to check; the recruiter decides.
VERDICT_TERMS: tuple[str, ...] = (
    "합격",
    "불합격",
    "탈락",
    "추천해요",
    "추천합니다",
    "비추천",
    "부적합",
    "채용하세요",
    "뽑으세요",
    "떨어뜨",
    "거짓말",
    "허위",
)

# The fixed line review cards end with; it names 합격·불합격 to say the AI does not decide.
DECISION_DISCLAIMER = "합격·불합격은 담당자가 정해요. AI는 확인할 부분만 짚어요."


def _hits(text: str, words: tuple[str, ...]) -> list[str]:
    body = text or ""
    return [w for w in words if w in body]


def banned_in_posting(text: str) -> list[str]:
    return _hits(text, POSTING_BANNED)


def banned_in_interview(text: str) -> list[str]:
    return _hits(text, POSTING_BANNED + INTERVIEW_BANNED)


def verdicts_in(text: str) -> list[str]:
    return _hits((text or "").replace(DECISION_DISCLAIMER, ""), VERDICT_TERMS)
