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
        if index < cursor:
            state = "done"
        elif index == cursor:
            state = "now"
        else:
            state = "todo"
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


def posting_line(analysis: dict, *, failed: bool = False) -> dict:
    job = _posting(analysis)
    required = (
        job.get("required") if isinstance(job.get("required"), list) else job.get("requirements")
    )
    preferred = job.get("preferred")
    title = job.get("title") or job.get("position") or job.get("role")
    target = " · ".join(str(part).strip() for part in (job.get("company"), title) if part)
    if failed:
        reason = job.get("read_error")
        result = "“자격 요건”을 읽지 못했어요"
        if isinstance(reason, str) and reason.strip():
            result = f"{result} · {reason.strip()}"
        return _line(
            "analyze_posting",
            "공고 읽기",
            "err",
            target=target or "회사 채용 페이지",
            resultLine=result,
        )
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


def think_event(phase: str, seconds: float) -> dict:
    return {"type": "think", "seconds": max(1, round(seconds)), "phase": phase}


_ACTION_TAG = {
    "expand": "강화",
    "modify": "수정",
    "add": "추가",
    "condense": "축소",
    "remove": "축소",
}


def strategy_plan(output: dict) -> dict | None:
    if not isinstance(output, dict):
        return None
    sections = output.get("sections")
    if not isinstance(sections, list):
        return None
    rows: list[dict] = []
    keywords: list[str] = []
    seen: set[str] = set()
    for item in sections:
        if len(rows) >= 6:
            break
        if not isinstance(item, dict):
            continue
        tag = _ACTION_TAG.get(str(item.get("action") or "").strip().lower())
        if tag is None:
            continue
        label = str(item.get("section") or "").strip()
        if not label:
            continue
        reason = item.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            focus = item.get("suggested_focus")
            reason = focus if isinstance(focus, str) else ""
        rows.append({"tag": tag, "label": label, "note": str(reason).strip()[:60]})
        words = item.get("suggested_keywords")
        if isinstance(words, str):
            words = [words]
        if not isinstance(words, list):
            continue
        for word in words:
            text = str(word).strip()
            key = text.casefold()
            if text and key not in seen and len(keywords) < 6:
                seen.add(key)
                keywords.append(text)
    if not rows:
        return None
    plan = {
        "type": "plan",
        "id": "strategy",
        "title": "수정 전략",
        "meta": f"섹션 {len(rows)}개",
        "rows": rows,
    }
    if keywords:
        plan["keywords"] = keywords
    return plan


def strategy_line(plan: dict) -> dict:
    rows = plan.get("rows") if isinstance(plan, dict) else None
    words = plan.get("keywords") if isinstance(plan, dict) else None
    count = len(rows) if isinstance(rows, list) else 0
    keywords = len(words) if isinstance(words, list) else 0
    result = f"섹션 {count}개"
    if keywords:
        result = f"{result} · 추가할 키워드 {keywords}개"
    return _line("strategy", "전략 세우기", target="공고 요건 ↔ 내 경력", resultLine=result)


_PAPER_KIND = {
    "resume": "이력서",
    "portfolio": "포트폴리오",
    "cover_letter": "자기소개서",
}


def _strip_md(text: str) -> str:
    return text.replace("#", "").replace("*", "").replace("_", "").replace("`", "")


def _md_heading(line: str) -> str | None:
    if line.startswith("# "):
        return line[2:].strip()
    if line.startswith("## "):
        return line[3:].strip()
    return None


def _body_line(line: str) -> str:
    text = line.strip()
    if text.startswith("- "):
        text = "• " + text[2:]
    return _strip_md(text).strip()


def paper_event(
    target: str, version: int, markdown: str, fallback_heading: str = ""
) -> dict | None:
    if not isinstance(markdown, str) or not markdown.strip():
        return None
    heading = ""
    lines: list[str] = []
    for raw in markdown.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        found = _md_heading(stripped)
        if found is not None and not heading:
            heading = _strip_md(found).strip()
            continue
        cleaned = _body_line(stripped)
        if cleaned:
            lines.append(cleaned[:120])
    kind = _PAPER_KIND.get(target, target)
    number = int(version)
    return {
        "type": "paper",
        "id": f"draft-{target}-v{number}",
        "label": f"{kind} 초안 v{number}",
        "heading": heading or fallback_heading or "",
        "lines": lines[:6],
    }


_TONE_OPTIONS = (
    {"id": "professional", "label": "전문적으로"},
    {"id": "confident", "label": "자신 있게"},
    {"id": "concise", "label": "짧게"},
    {"id": "technical", "label": "기술 중심으로"},
    {"id": "collaborative", "label": "협업 중심으로"},
    {"id": "preserve", "label": "원래 말투로"},
)


def _github_found_label(analysis: dict) -> str:
    found = analysis.get("github") if isinstance(analysis.get("github"), dict) else {}
    url = str(found.get("url") or "").strip()
    if url:
        return url
    username = str(found.get("username") or "").strip()
    if not username:
        return ""
    if "github.com" in username.lower():
        return username
    return f"github.com/{username}"


def _material_rows(inputs: dict, analysis: dict) -> list[dict]:
    rows: list[dict] = []
    file_name = _file_name(inputs)
    if file_name:
        sub = "마이 › 서류" if inputs.get("documentId") else "올린 파일"  # noqa: RUF001
        rows.append({"id": "m_file", "label": file_name, "sub": sub, "action": "change"})
    posting = inputs.get("posting") if isinstance(inputs.get("posting"), dict) else {}
    company = str(posting.get("company") or "").strip()
    title = str(posting.get("title") or "").strip()
    if company or title:
        row = {
            "id": "m_posting",
            "label": title or company,
            "sub": "홈 › 북마크 공고" if inputs.get("postingId") else "붙여넣은 링크",  # noqa: RUF001
            "action": "change",
        }
        if company:
            row["badge"] = company[:1]
        rows.append(row)
    provided = str(inputs.get("github") or "").strip()
    page = ""
    pages = inputs.get("pages") if isinstance(inputs.get("pages"), dict) else {}
    for url in pages:
        if _github_page(str(url)):
            page = str(url)
            break
    found = _github_found_label(analysis)
    if provided:
        rows.append({"id": "m_github", "label": provided, "sub": "내 링크", "action": "change"})
    elif page:
        rows.append({"id": "m_github", "label": page, "sub": "내 링크", "action": "change"})
    elif found:
        rows.append(
            {"id": "m_github", "label": found, "sub": "이력서에서 찾았어요", "action": "change"}
        )
    return rows


def intake_panel(inputs: dict | None, analysis: dict | None = None) -> list[dict]:
    bag = inputs if isinstance(inputs, dict) else {}
    found = analysis if isinstance(analysis, dict) else {}
    sections = [
        {
            "id": "targets",
            "kind": "chips",
            "title": "어떤 산출물을 만들까요?",
            "multiple": True,
            "options": [
                {"id": "resume", "label": "이력서"},
                {"id": "portfolio", "label": "포트폴리오"},
                {"id": "cover_letter", "label": "자기소개서"},
            ],
            "selected": ["resume"],
        }
    ]
    rows = _material_rows(bag, found)
    if rows:
        sections.append(
            {
                "id": "materials",
                "kind": "rows",
                "title": "가져올 자료",
                "options": rows,
            }
        )
    sections.append(
        {
            "id": "tone",
            "kind": "chips",
            "title": "어떤 말투로 쓸까요?",
            "options": [dict(item) for item in _TONE_OPTIONS],
            "selected": ["preserve"],
        }
    )
    return sections


def quality_line(auto_fixes, recommendations) -> dict:
    fixes = auto_fixes if isinstance(auto_fixes, list) else []
    recs = recommendations if isinstance(recommendations, list) else []
    fixed, offered = len(fixes), len(recs)
    if fixed and offered:
        result = f"바로 고친 것 {fixed}개 · 추천 {offered}개"
    elif fixed:
        result = f"바로 고친 것 {fixed}개"
    elif offered:
        result = f"추천 {offered}개"
    else:
        result = "고칠 곳이 없어요"
    return _line(
        "quality_check",
        "품질 검사",
        target="오타 · 문법 · 말투 · ATS",
        resultLine=result,
    )


def quality_diff(auto_fixes) -> dict | None:
    hunks = []
    for fix in auto_fixes if isinstance(auto_fixes, list) else []:
        if not isinstance(fix, dict):
            continue
        line = fix.get("line") if isinstance(fix.get("line"), int) else None
        hunks.append({"line": line, "sign": "-", "text": str(fix.get("before") or "")})
        hunks.append({"line": line, "sign": "+", "text": str(fix.get("after") or "")})
    if not hunks:
        return None
    return {"type": "diff", "documentId": "", "revisionId": "", "hunks": hunks}


def quality_choice(recommendations) -> dict | None:
    options = []
    selected = []
    for rec in recommendations if isinstance(recommendations, list) else []:
        if len(options) >= 6:
            break
        if not isinstance(rec, dict):
            continue
        label = str(rec.get("label") or "").strip()
        if not label:
            continue
        item = {"id": f"rec{len(options) + 1}", "label": label}
        desc = rec.get("desc")
        if isinstance(desc, str) and desc.strip():
            item["desc"] = desc.strip()
        options.append(item)
        if rec.get("priority") == "P1":
            selected.append(item["id"])
    if not options:
        return None
    copied = [dict(item) for item in options]
    return {
        "type": "choice",
        "kind": "RESUME_GATE",
        "gate": "quality",
        "title": "추천 수정도 반영할까요?",
        "multiple": True,
        "recommended": "rec1",
        "options": options,
        "sections": [
            {
                "id": "recs",
                "kind": "toggle",
                "options": copied,
                "selected": selected,
            }
        ],
        "submit": {
            "label": "{n}개 반영하고 디자인으로",
            "zeroLabel": "그대로 디자인으로",
        },
    }


def apply_recommendations_line(labels: list[str]) -> dict | None:
    picked = [str(item) for item in labels if str(item).strip()]
    if not picked:
        return None
    return {
        "type": "tool",
        "name": "apply_recommendations",
        "state": "ok",
        "tier": "SAFE_WRITE",
        "summary": "추천 수정 반영",
        "target": f"{len(picked)}개",
        "resultLine": " · ".join(picked),
    }


def feedback_line(count: int) -> dict:
    return _line(
        "feedback",
        "피드백 정리",
        target="공고 요건 ↔ 내 이력서",
        resultLine=f"고칠 점 {count}개",
    )


def feedback_plan(analysis: dict) -> dict | None:
    raw = analysis.get("feedback") if isinstance(analysis, dict) else None
    if not isinstance(raw, list):
        return None
    rows = []
    for item in raw:
        if len(rows) >= 5:
            break
        if not isinstance(item, dict):
            continue
        label = str(item.get("problem") or "").strip()
        if not label:
            continue
        note = str(item.get("fix") or "").strip()[:60]
        rows.append({"tag": str(item.get("tag") or "").strip(), "label": label, "note": note})
    if not rows:
        return None
    return {
        "type": "plan",
        "id": "feedback",
        "title": "고칠 점",
        "meta": f"{len(rows)}개",
        "rows": rows,
    }


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
