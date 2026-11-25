"""Pull 자격요건 / 우대사항 lines out of a posting page's flattened text."""

from __future__ import annotations

import re

_TERM_CAP = 15
_TERM_CHARS = 200

# A Korean heading followed by a particle ("자격요건을") is prose.
# In flattened text an English heading is capitalised or ends in ":" ("Our benefits:"),
# never a lowercase word mid-sentence.
_KO = r"(?![을를이가은는에의과와도])"
_EN_LEAD = r"(?:(?:our|your|basic|minimum)\s+)?"


def _english(words: str) -> str:
    return rf"\b{_EN_LEAD}(?:(?-i:(?=[A-Z]))(?:{words})\b|(?:{words})(?=\s*(?::|$)))"


_HEADING = re.compile(
    r"(?P<preferred>(?:우대\s*(?:사항|요건|조건))" + _KO
    + "|" + _english(r"preferred(?:\s+qualifications)?|nice\s+to\s+have") + ")"
    r"|(?P<required>(?:자격\s*요건|지원\s*자격|필수\s*(?:요건|사항|역량|조건))" + _KO
    + "|" + _english(r"requirements|qualifications|must\s+have") + ")"
    r"|(?P<stop>(?:주요\s*업무|담당\s*업무|업무\s*내용|혜택|복지|채용\s*절차|전형\s*절차|기술\s*스택"
    r"|근무\s*(?:조건|환경|형태|지)|회사\s*소개|팀\s*소개)" + _KO
    + "|" + _english(r"responsibilities|benefits|tech\s+stack|hiring\s+process") + ")",
    re.IGNORECASE,
)
# The page text arrives whitespace-flattened (ingest/web_page.py), so bullets are often gone:
# a standalone "분" or a closing "경험" is where one requirement ends and the next begins.
# "경험 3년 이상", "경험 (필수)" and "경험 다수" still belong to the same item.
_SPLIT = re.compile(
    r"\n+|\s*[•▪●◦]\s*|(?<!\S)[-*·](?=\s)\s*|(?<=[.!?])\s+|(?<=\s분)\s+"
    r"|(?<=경험)\s+(?!및|또는|혹은|이나|보유|우대|필수|있|다수|\d|\()"
)
_NONE = "없음"


def _terms(section: str) -> list[str]:
    found = []
    for chunk in _SPLIT.split(section):
        term = chunk.strip(" \t:\uff1a-\u2013.")[:_TERM_CHARS].strip()
        if len(term) >= 2 and term != _NONE:
            found.append(term)
    return found


def posting_terms(text: str) -> dict[str, list[str]]:
    """Each heading's section runs until the next known heading of any kind."""
    lists: dict[str, list[str]] = {"required": [], "preferred": []}
    marks = list(_HEADING.finditer(text or ""))
    for index, mark in enumerate(marks):
        kind = mark.lastgroup
        if kind == "stop":
            continue
        end = marks[index + 1].start() if index + 1 < len(marks) else len(text)
        lists[kind].extend(_terms(text[mark.end():end]))
    return {kind: list(dict.fromkeys(items))[:_TERM_CAP] for kind, items in lists.items()}
