from __future__ import annotations

from app.domain.posting_fit import FIT_DIMENSIONS, fit_view

_RESUME = ("resume", "이력서 읽기")
_GITHUB = ("github", "GitHub 살펴보기")
_POSTING = ("posting", "공고 분석")
_FIT = ("fit", "적합도 계산")
_EXTRA_CAP = 10
_STRONG = 7.0
_WEAK = 6.0
_PROJECTED_FLOOR = 8.0
_DIGIT_FINAL = {"0": 21, "1": 8, "3": 16, "6": 1, "7": 8, "8": 8}
_RIEUL = 8


def todo_event(list_id: str, steps: list[tuple[str, str]], cursor: int, added=frozenset()) -> dict:
    items = []
    for index, (key, text) in enumerate(steps):
        state = "done" if index < cursor else "now" if index == cursor else "todo"
        item = {"id": key, "text": text, "state": state}
        if key in added:
            item["added"] = True
        items.append(item)
    return {"type": "todo", "id": list_id, "items": items}


def _github_page(url: str) -> bool:
    return "github.com" in url.lower()


def analyze_steps(inputs: dict, analysis: dict | None = None) -> tuple[list, set]:
    pages = inputs.get("pages") if isinstance(inputs.get("pages"), dict) else {}
    github_in = bool(inputs.get("github")) or any(_github_page(str(url)) for url in pages)
    posting_in = any(inputs.get(key) for key in ("posting", "postingId", "requirements")) or any(
        not _github_page(str(url)) for url in pages
    )
    found = analysis if isinstance(analysis, dict) else {}
    github = github_in or bool(found.get("github"))
    posting = posting_in or bool(found.get("jobs"))
    steps = [_RESUME]
    if github:
        steps.append(_GITHUB)
    if posting:
        steps.extend((_POSTING, _FIT))
    added = set()
    if github and not github_in:
        added.add(_GITHUB[0])
    if posting and not posting_in:
        added.update((_POSTING[0], _FIT[0]))
    return steps, added


def _line(name: str, summary: str, state: str = "ok", **fields) -> dict:
    event = {"type": "tool", "name": name, "state": state, "summary": summary, "tier": "READ"}
    event.update({key: value for key, value in fields.items() if value})
    return event


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _count(value) -> int | None:
    return len(value) if isinstance(value, list) else None


def _names(items) -> list[str]:
    names = []
    for item in items if isinstance(items, list) else []:
        name = item.get("name") if isinstance(item, dict) else item
        if isinstance(name, str) and name.strip():
            names.append(name.strip())
    return names[:_EXTRA_CAP]


def _file_name(inputs: dict) -> str:
    name = inputs.get("fileName") or inputs.get("file_name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    for item in inputs.get("attachments") or []:
        if isinstance(item, dict):
            label = item.get("fileName") or item.get("file_name") or item.get("name")
            if isinstance(label, str) and label.strip():
                return label.strip()
    return ""


def resume_line(inputs: dict, analysis: dict) -> dict:
    parsed = _dict(analysis.get("resume")) or _dict(analysis.get("parsed_resume")) or analysis
    links = _dict(parsed.get("personal_info")).get("links", parsed.get("links"))
    counts = [
        f"{label} {count}{unit}"
        for label, count, unit in (
            ("경력", _count(parsed.get("experience")), "건"),
            ("프로젝트", _count(parsed.get("projects")), "건"),
            ("링크", _count(links), "개"),
        )
        if count
    ]
    pages = parsed.get("pages") or parsed.get("page_count")
    head = f"{pages}쪽 · " if isinstance(pages, int) and pages > 0 else ""
    result = head + ", ".join(counts) if counts else head.removesuffix(" · ")
    return _line("read_resume", _RESUME[1], target=_file_name(inputs), resultLine=result)


def github_line(analysis: dict) -> dict:
    found = _dict(analysis.get("github"))
    scanned, matched = found.get("repos_scanned"), found.get("repos_matched")
    result = (
        f"저장소 {scanned}개 중 공고 관련 {matched}개"
        if isinstance(scanned, int) and isinstance(matched, int)
        else ""
    )
    return _line(
        "explore_github",
        _GITHUB[1],
        target=str(found.get("username") or ""),
        resultLine=result,
        extra=_names(found.get("matched_repos")),
    )


def _posting(analysis: dict) -> dict:
    jobs = analysis.get("jobs")
    if isinstance(jobs, list):
        jobs = next((item for item in jobs if isinstance(item, dict)), {})
    return _dict(jobs)


def posting_line(analysis: dict) -> dict:
    job = _posting(analysis)
    required = (
        job.get("required") if isinstance(job.get("required"), list) else job.get("requirements")
    )
    preferred = job.get("preferred")
    title = job.get("title") or job.get("position") or job.get("role")
    target = " · ".join(str(part).strip() for part in (job.get("company"), title) if part)
    counts = (_count(required), _count(preferred))
    result = f"필수 {counts[0]}개 · 우대 {counts[1] or 0}개" if counts[0] else ""
    return _line(
        "analyze_posting",
        "공고 읽기",
        target=target,
        resultLine=result,
        extra=_names(
            (required if isinstance(required, list) else [])
            + (preferred if isinstance(preferred, list) else [])
        ),
    )


_FIT_TARGET = "5개 항목 · 가중치 반영"


def fit_line(score: float) -> dict:
    return _line("fit_score", _FIT[1], target=_FIT_TARGET, resultLine=f"{score:.1f}점")


def fit_failed_line() -> dict:
    return _line("fit_score", _FIT[1], "err", target=_FIT_TARGET)


def _final(word: str) -> int | None:
    last = word.rstrip()[-1:]
    if "가" <= last <= "힣":
        return (ord(last) - ord("가")) % 28
    if last.isdigit():
        return _DIGIT_FINAL.get(last, 0)
    return None


def _josa(word: str, after_final: str, after_vowel: str) -> str:
    final = _final(word)
    return word + (after_final if final else after_vowel)


def _to(word: str) -> str:
    final = _final(word)
    return word + ("으로" if final and final != _RIEUL else "로")


def fit_band(score: float) -> str:
    if score >= 8.0:
        return "높음 · 잘 맞아요"
    if score >= _WEAK:
        return "보통 · 개선 여지 있어요"
    return "낮음 · 고칠 곳이 많아요"


def fit_summary(parts: dict) -> str:
    scored = [(float(parts[key]), label) for key, label, _weight in FIT_DIMENSIONS if key in parts]
    if not scored:
        return ""
    sentences = []
    best, best_label = max(scored, key=lambda item: item[0])
    if best >= _STRONG:
        sentences.append(_josa(best_label, "은", "는") + " 잘 맞아요.")
    weak = [label for value, label in sorted(scored, key=lambda item: item[0]) if value < _WEAK][:2]
    if len(weak) == 2:
        sentences.append(_josa(weak[0], "과", "와") + " " + _josa(weak[1], "이", "가") + " 약해요.")
    elif weak:
        sentences.append(_josa(weak[0], "이", "가") + " 약해요.")
    return " ".join(sentences)


def _keywords(terms: list, resume_text: str) -> list[dict]:
    folded = resume_text.casefold()
    seen: list[str] = []
    for term in terms:
        text = str(term).strip()
        if text and text not in seen:
            seen.append(text)
    return [{"label": text, "ok": text.casefold() in folded} for text in seen[:5]]


def _projected(parts: dict, plan: str, score: float, bullets: list) -> dict | None:
    raised = {key: max(float(value), _PROJECTED_FLOOR) for key, value in parts.items()}
    target = fit_view(raised, plan)["fitScore"] if raised else score
    if target <= score:
        return None
    return {
        "score": target,
        "label": f"{int(target)}점대",
        "bullets": [str(item) for item in bullets][:3],
    }


def fit_card(view: dict, terms: list, resume_text: str, bullets: list) -> dict:
    score = float(view["fitScore"])
    parts = _dict(view.get("parts"))
    card = {
        "type": "fit",
        "score": score,
        "parts": parts,
        "topGap": view.get("topGap") or "",
        "plan": view.get("plan") or "FREE",
        "band": fit_band(score),
    }
    summary = fit_summary(parts)
    if summary:
        card["summary"] = summary
    card["keywords"] = _keywords(terms, resume_text)
    if card["plan"] == "ULTRA":
        projected = _projected(parts, card["plan"], score, bullets)
        if projected is not None:
            card["projected"] = projected
    return card


def done_summary(source: str, fit_from, fit_to, bullets: list) -> dict:
    lines = [str(item) for item in bullets][:3]
    if fit_from is not None and fit_to is not None and float(fit_to) > float(fit_from):
        start, end = f"{float(fit_from):.1f}", f"{float(fit_to):.1f}"
        return {
            "summary": f"다 됐어요! 적합도를 {start} → {_to(end)} 올렸어요.",
            "fitFrom": float(fit_from),
            "fitTo": float(fit_to),
            "bullets": lines,
        }
    what = "이력서를" if source == "external" else "프로필을"
    return {"summary": f"다 됐어요! {what} 고쳤어요.", "bullets": lines}


def boost_line(cycle: int, before: float, after: float) -> dict:
    return _line("boost", f"점수 올리기 {cycle}회", resultLine=f"{before:.1f} → {after:.1f}")


def boost_fit(first: float, after: float) -> dict:
    gain = round(after - first, 1)
    signed = f"+{gain:.1f}" if gain >= 0 else f"{gain:.1f}"
    return {
        "type": "fit",
        "score": after,
        "from": first,
        "delta": signed,
        "note": f"적합도 {first:.1f} → {after:.1f} ({signed})",
        "band": fit_band(after),
    }
