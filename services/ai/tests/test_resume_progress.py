from __future__ import annotations

from app.harness.personal.resume.progress import (
    analyze_steps,
    company_line,
    done_summary,
    fit_card,
    github_line,
    posting_line,
    resume_line,
    todo_event,
    verify_text,
)

_PARTS = {
    "techStack": 7.5,
    "experienceLink": 7.0,
    "careerLevel": 8.0,
    "keyword": 4.5,
    "domain": 5.0,
}
_VIEW = {"fitScore": 6.9, "parts": _PARTS, "topGap": "키워드", "plan": "PRO"}


def test_todo_marks_steps_before_the_cursor_done_and_the_cursor_now():
    steps = [("resume", "이력서 읽기"), ("github", "GitHub 살펴보기"), ("fit", "적합도 계산")]
    assert todo_event("analyze", steps, 1, {"github"}) == {
        "type": "todo",
        "id": "analyze",
        "items": [
            {"id": "resume", "text": "이력서 읽기", "state": "done"},
            {"id": "github", "text": "GitHub 살펴보기", "state": "now", "added": True},
            {"id": "fit", "text": "적합도 계산", "state": "todo"},
        ],
    }


def test_analyze_steps_follow_the_inputs_and_mark_late_github_added():
    inputs = {"pages": {"https://moapay.kr/jobs/1": "공고"}}
    assert analyze_steps(inputs) == (
        [("resume", "이력서 읽기"), ("posting", "공고 분석"), ("fit", "적합도 계산")],
        set(),
    )
    steps, added = analyze_steps(inputs, {"github": {"username": "seojun-kim"}})
    assert [key for key, _label in steps] == ["resume", "github", "posting", "fit"]
    assert added == {"github"}


def test_analyze_steps_put_company_research_before_the_posting():
    inputs = {"github": "https://github.com/acme-labs", "posting": {"company": "토스"}}
    steps, added = analyze_steps(inputs, company=True)
    assert [key for key, _label in steps] == ["resume", "github", "company", "posting", "fit"]
    assert ("company", "회사 조사") in steps
    assert added == set()
    assert analyze_steps({"attachments": ["a"]}, company=True) == ([("resume", "이력서 읽기")], set())
    assert "company" not in [key for key, _label in analyze_steps(inputs)[0]]


def test_analyze_steps_mark_company_added_when_the_posting_is_found_late():
    steps, added = analyze_steps({}, {"jobs": [{"title": "백엔드"}]}, company=True)
    assert [key for key, _label in steps] == ["resume", "company", "posting", "fit"]
    assert added == {"company", "posting", "fit"}
    todo = todo_event("analyze", steps, 1, added)
    assert todo["items"][1] == {"id": "company", "text": "회사 조사", "state": "now", "added": True}


_TOOL_KEYS = {"type", "name", "state", "summary", "tier", "target", "resultLine", "extra"}


def test_company_line_lists_unique_sources():
    line = company_line(["https://toss.im/a", "https://toss.im/a", "https://toss.tech/b"])
    assert set(line) <= _TOOL_KEYS
    assert (line["name"], line["state"], line["summary"]) == ("research_company", "ok", "회사 조사")
    assert line["resultLine"] == "출처 2개"
    assert line["extra"] == ["https://toss.im/a", "https://toss.tech/b"]
    assert company_line([])["resultLine"] == "출처를 찾지 못했어요"
    assert "extra" not in company_line([])


def test_verify_text_lists_p0_first_in_polite_copy():
    text = verify_text([
        {"level": "P0", "rule": "unsupported_number", "detail": "40%, 1.5배"},
        {"level": "P0", "rule": "unknown_evidence", "detail": "E3"},
    ])
    assert text.splitlines() == [
        "확인이 필요한 점이 있어요.",
        "• 출처를 찾지 못한 숫자가 있어요: 40%, 1.5배",
        "• 근거 목록에 없는 E3을 인용했어요.",
    ]
    assert verify_text([]) == ""


def test_analyze_steps_without_a_posting_only_read_the_resume():
    assert analyze_steps({"attachments": ["a"]}) == ([("resume", "이력서 읽기")], set())


def test_resume_line_names_the_file_and_counts_sections():
    line = resume_line(
        {"fileName": "김서준_백엔드_이력서_2026.pdf"},
        {
            "resume": {
                "experience": [1, 2],
                "projects": [1, 2, 3, 4, 5],
                "personal_info": {"links": ["a", "b", "c"]},
            }
        },
    )
    assert line == {
        "type": "tool",
        "name": "read_resume",
        "state": "ok",
        "summary": "이력서 읽기",
        "tier": "READ",
        "target": "김서준_백엔드_이력서_2026.pdf",
        "resultLine": "경력 2건, 프로젝트 5건, 링크 3개",
    }


def test_github_line_folds_matched_repos_into_extra():
    line = github_line(
        {
            "github": {
                "username": "seojun-kim",
                "repos_scanned": 12,
                "repos_matched": 3,
                "matched_repos": [
                    {"name": "payment-retry-lab"},
                    {"name": "settle-pipeline"},
                    {"name": "kotlin-ledger"},
                ],
            }
        }
    )
    assert line["target"] == "seojun-kim"
    assert line["resultLine"] == "저장소 12개 중 공고 관련 3개"
    assert line["extra"] == ["payment-retry-lab", "settle-pipeline", "kotlin-ledger"]


def test_posting_line_counts_required_and_preferred():
    line = posting_line(
        {
            "jobs": {
                "company": "모아페이",
                "title": "백엔드 엔지니어",
                "required": ["Kotlin", "Spring Boot"],
                "preferred": ["Kafka"],
            }
        }
    )
    assert line["summary"] == "공고 읽기"
    assert line["target"] == "모아페이 · 백엔드 엔지니어"
    assert line["resultLine"] == "필수 2개 · 우대 1개"
    assert line["extra"] == ["Kotlin", "Spring Boot", "Kafka"]


def test_fit_card_has_band_summary_and_keyword_chips():
    card = fit_card(
        _VIEW, ["Kotlin", "Kafka"], "Kotlin, Spring", ["승인 API 성과를 숫자로 보여 주기"]
    )
    assert card == {
        "type": "fit",
        "score": 6.9,
        "parts": _PARTS,
        "topGap": "키워드",
        "plan": "PRO",
        "band": "보통이고, 고칠 여지가 있어요.",
        "summary": "경력 수준은 잘 맞아요. 키워드와 도메인이 약해요.",
        "keywords": [{"label": "Kotlin", "ok": True}, {"label": "Kafka", "ok": False}],
    }


def test_fit_card_projects_a_score_only_for_ultra():
    card = fit_card({**_VIEW, "plan": "ULTRA"}, [], "", ["a", "b", "c", "d"])
    assert card["projected"] == {"score": 8.0, "label": "8점대", "bullets": ["a", "b", "c"]}


def test_done_summary_reports_the_fit_change():
    assert done_summary("external", 6.9, 8.1, ["a"]) == {
        "summary": "다 됐어요! 적합도를 6.9 → 8.1로 올렸어요.",
        "fitFrom": 6.9,
        "fitTo": 8.1,
        "bullets": ["a"],
    }
    assert (
        done_summary("external", 6.9, 7.0, [])["summary"]
        == "다 됐어요! 적합도를 6.9 → 7.0으로 올렸어요."
    )


def test_done_summary_without_a_fit_says_what_was_fixed():
    assert done_summary("external", None, None, []) == {
        "summary": "다 됐어요! 이력서를 고쳤어요.",
        "bullets": [],
    }
    assert done_summary("profile", None, None, [])["summary"] == "다 됐어요! 프로필을 고쳤어요."


from types import SimpleNamespace  # noqa: E402

import pytest  # noqa: E402

from app.harness.personal.tools import bound_services  # noqa: E402
from tests.test_harness_resume import _Approvals, _base, _config, _graph, _PhaseModel  # noqa: E402
from tests.test_resume_boost import _pull  # noqa: E402

_ANALYSIS = {
    "message": "자료를 읽었어요.",
    "improvements": ["승인 API 성과를 숫자로 보여 주기"],
    "resume": {"experience": [1, 2], "projects": [1]},
    "github": {
        "username": "seojun-kim",
        "repos_scanned": 12,
        "repos_matched": 1,
        "matched_repos": [{"name": "payment-retry-lab"}],
    },
    "jobs": {
        "company": "모아페이",
        "title": "백엔드 엔지니어",
        "required": ["Kotlin", "Kafka"],
        "preferred": [],
    },
}


@pytest.fixture
def judged(monkeypatch):
    seen = []

    async def fake(*args, **kwargs):
        seen.append(args)
        return dict(_VIEW)

    monkeypatch.setattr("app.framework.fit_judge.judge_fit", fake)
    token = bound_services.set(SimpleNamespace(ai=SimpleNamespace(_reserve=object())))
    yield seen
    bound_services.reset(token)


def _kinds(events):
    out = []
    for event in events:
        if event.get("type") == "tool":
            out.append("tool:" + event["name"])
        elif event.get("type") == "todo":
            out.append("todo:" + ",".join(item["state"] for item in event["items"]))
        elif event.get("type") in ("fit", "choice"):
            out.append(event["type"])
    return out


async def test_analyze_reports_each_step_then_the_fit_card(judged):
    graph = _graph(_Approvals(), model=_PhaseModel({"analyze": _ANALYSIS}))
    state = _base(
        phase="analyze",
        work_mode="resume_based",
        inputs={
            "fileName": "이력서.pdf",
            "markdown": "Kotlin 개발",
            "pages": {"https://moapay.kr/jobs/1": "공고"},
        },
    )
    snap, events = await _pull(graph, state, _config())
    assert _kinds(events) == [
        "todo:now,todo,todo",
        "tool:read_resume",
        "todo:done,now,todo,todo",
        "tool:explore_github",
        "todo:done,done,now,todo",
        "tool:analyze_posting",
        "todo:done,done,done,now",
        "tool:fit_score",
        "fit",
        "todo:done,done,done,done",
        "choice",
    ]
    todo = next(event for event in events if event.get("type") == "todo")
    assert [item["id"] for item in todo["items"]] == ["resume", "posting", "fit"]
    late = [event for event in events if event.get("type") == "todo"][1]
    assert late["items"][1] == {
        "id": "github",
        "text": "GitHub 살펴보기",
        "state": "now",
        "added": True,
    }
    fit = next(event for event in events if event.get("type") == "fit")
    assert fit["keywords"] == [{"label": "Kotlin", "ok": True}, {"label": "Kafka", "ok": False}]
    assert snap.values["fit_from"] == 6.9


async def test_analyze_without_an_ai_gate_skips_the_fit_card():
    graph = _graph(_Approvals(), model=_PhaseModel({"analyze": _ANALYSIS}))
    state = _base(
        phase="analyze",
        work_mode="resume_based",
        inputs={"pages": {"https://moapay.kr/jobs/1": "공고"}},
    )
    _snap, events = await _pull(graph, state, _config())
    kinds = _kinds(events)
    assert "fit" not in kinds
    assert kinds[-2:] == ["todo:done,done,done,done", "choice"]


async def test_a_failed_fit_marks_the_line_and_still_finishes_the_list(monkeypatch):
    async def broken(*_args, **_kwargs):
        raise ValueError("unreadable")

    monkeypatch.setattr("app.framework.fit_judge.judge_fit", broken)
    token = bound_services.set(SimpleNamespace(ai=SimpleNamespace(_reserve=object())))
    try:
        graph = _graph(_Approvals(), model=_PhaseModel({"analyze": _ANALYSIS}))
        state = _base(
            phase="analyze",
            work_mode="resume_based",
            inputs={"pages": {"https://moapay.kr/jobs/1": "공고"}},
        )
        snap, events = await _pull(graph, state, _config())
    finally:
        bound_services.reset(token)
    failed = next(event for event in events if event.get("name") == "fit_score")
    assert failed["state"] == "err"
    assert {"type": "notice", "text": "적합도를 계산하지 못했어요"} in events
    assert "resultLine" not in failed
    assert _kinds(events)[-2:] == ["todo:done,done,done,done", "choice"]
    assert snap.values.get("fit_from") is None


def test_analyze_prompt_asks_for_three_improvements():
    from app.harness.personal.resume.graph import _IMPROVEMENTS_NOTE, phase_instructions

    assert _IMPROVEMENTS_NOTE in phase_instructions("analyze", {})
    assert _IMPROVEMENTS_NOTE not in phase_instructions("craft", {})


def test_boost_line_and_card_show_the_change_from_the_first_score():
    from app.harness.personal.resume.progress import boost_fit, boost_line

    assert boost_line(2, 7.8, 8.3) == {
        "type": "tool",
        "name": "boost2",
        "state": "ok",
        "summary": "점수 올리기 2회",
        "tier": "READ",
        "resultLine": "7.8 → 8.3",
    }
    before, after = {"keyword": 5.0, "domain": 7.0}, {"keyword": 7.5, "domain": 7.1}
    raised = boost_line(1, 6.9, 7.8, before, after)
    assert raised["name"] == "boost1"
    assert raised["target"] == "키워드"
    assert raised["resultLine"] == "6.9 → 7.8 · 키워드를 경력 문장에 넣었어요"
    assert boost_fit(6.9, 8.3) == {
        "type": "fit",
        "score": 8.3,
        "from": 6.9,
        "delta": "+1.4",
        "note": "적합도 6.9 → 8.3 (+1.4)",
        "band": "높고, 잘 맞아요.",
    }


async def test_each_boost_cycle_reports_its_score_and_stopping_keeps_fit_to(monkeypatch):
    from langgraph.types import Command

    from tests.test_resume_boost import _script, _to_first_cycle

    _seen, token = _script(monkeypatch, [1.0, 2.0, 3.0], SimpleNamespace(_reserve=object()))
    graph = _graph(_Approvals(), model=_PhaseModel())
    config = _config()
    try:
        _snap, events = await _to_first_cycle(graph, config)
        snap, _ = await _pull(graph, Command(resume={"option_id": "stop"}), config)
    finally:
        bound_services.reset(token)
    line = next(event for event in events if event.get("name") == "boost1")
    card = next(event for event in events if event.get("type") == "fit")
    assert (line["summary"], line["resultLine"]) == ("점수 올리기 1회", "1.0 → 2.0")
    assert (card["score"], card["from"], card["delta"]) == (2.0, 1.0, "+1.0")
    assert (snap.values["fit_from"], snap.values["fit_to"]) == (1.0, 2.0)


async def test_result_reports_the_fit_change_and_what_changed():
    from uuid import uuid4

    from tests.test_resume_result_source import _DB, _FILE, _one, _present

    events, _kept = await _present(
        _DB(),
        None,
        phase="present",
        user_id=str(uuid4()),
        fit_from=6.9,
        fit_to=8.1,
        drafts={"markdown": "# 이력서", "changes": ["승인 API 성과를 숫자로 강조"]},
        inputs={"attachments": [{"fileName": _FILE, "mimeType": "application/pdf"}]},
    )
    result = _one(events, "result")
    assert result["summary"] == "다 됐어요! 적합도를 6.9 → 8.1로 올렸어요."
    assert (result["fitFrom"], result["fitTo"]) == (6.9, 8.1)
    assert result["bullets"] == ["승인 API 성과를 숫자로 강조"]


async def test_profile_result_without_a_fit_says_the_profile_was_fixed():
    from uuid import uuid4

    from tests.test_resume_result_source import _DB, _one, _present

    events, _kept = await _present(
        _DB(),
        None,
        phase="present",
        user_id=str(uuid4()),
        analysis={"improvements": ["Kafka를 기술 스택 맨 앞으로 옮기기"]},
        drafts={"markdown": "# 프로필"},
        inputs={"documentId": "11111111-1111-4111-8111-111111111111", "name": "김서준"},
    )
    result = _one(events, "result")
    assert result["summary"] == "다 됐어요! 프로필을 고쳤어요."
    assert "fitFrom" not in result
    assert result["bullets"] == ["Kafka를 기술 스택 맨 앞으로 옮기기"]


def test_think_event_rounds_to_nearest_at_least_one():
    from app.harness.personal.resume.progress import think_event

    assert think_event("craft", 0.2)["seconds"] == 1
    assert think_event("craft", 6.4)["seconds"] == 6
    event = think_event("strategy", 2)
    assert event == {"type": "think", "seconds": 2, "phase": "strategy"}
    assert "seq" not in event


def test_strategy_plan_maps_actions_to_tags():
    from app.harness.personal.resume.progress import strategy_plan

    plan = strategy_plan(
        {
            "sections": [
                {"section": "경력", "action": "expand", "reason": "성과를 키운다"},
                {"section": "기술", "action": "modify", "reason": "스택을 맞춘다"},
                {"section": "프로젝트", "action": "add", "reason": "결제 프로젝트를 넣는다"},
                {"section": "수상", "action": "condense", "reason": "한 줄로 줄인다"},
                {"section": "학력", "action": "keep", "reason": "그대로 둔다"},
            ]
        }
    )
    assert plan is not None
    assert [row["tag"] for row in plan["rows"]] == ["강화", "수정", "추가", "축소"]
    assert plan["meta"] == "섹션 4개"
    assert plan["id"] == "strategy"
    assert plan["title"] == "수정 전략"


def test_strategy_plan_none_when_only_keep():
    from app.harness.personal.resume.progress import strategy_plan

    assert (
        strategy_plan({"sections": [{"section": "학력", "action": "keep", "reason": "유지"}]})
        is None
    )


def test_strategy_plan_caps_keywords_at_six_and_dedupes():
    from app.harness.personal.resume.progress import strategy_plan

    plan = strategy_plan(
        {
            "sections": [
                {
                    "section": "기술",
                    "action": "expand",
                    "reason": "키워드",
                    "suggested_keywords": [
                        "Kotlin",
                        "kotlin",
                        "Kafka",
                        "Spring",
                        "SQL",
                        "Redis",
                        "AWS",
                    ],
                }
            ]
        }
    )
    assert plan["keywords"] == ["Kotlin", "Kafka", "Spring", "SQL", "Redis", "AWS"]


def test_strategy_line_omits_keyword_count_when_zero():
    from app.harness.personal.resume.progress import strategy_line

    quiet = strategy_line({"rows": [{"tag": "수정", "label": "경력", "note": "한 줄"}]})
    assert quiet["resultLine"] == "섹션 1개"
    assert "키워드" not in quiet["resultLine"]
    loud = strategy_line({"rows": [{}, {}], "keywords": ["Kotlin"]})
    assert loud["resultLine"] == "섹션 2개 · 추가할 키워드 1개"
    assert loud["summary"] == "전략 세우기"
    assert loud["target"] == "공고 요건 ↔ 내 경력"


def test_paper_event_strips_markdown_and_caps_lines():
    from app.harness.personal.resume.progress import paper_event

    markdown = "\n".join(["**굵게**", "- x", "삼", "사", "오", "육", "칠", "팔", "구", "십"])
    event = paper_event("resume", 1, markdown)
    assert event["id"] == "draft-resume-v1"
    assert event["label"] == "이력서 초안 v1"
    assert len(event["lines"]) == 6
    assert event["lines"][0] == "굵게"
    assert event["lines"][1] == "• x"
    assert all("#" not in line and "*" not in line for line in event["lines"])
    headed = paper_event("cover_letter", 1, "# 김서준\n본문", "김서준 · 백엔드")
    assert headed["heading"] == "김서준"
    assert headed["lines"] == ["본문"]
    assert headed["label"] == "자기소개서 초안 v1"
    fallback = paper_event("portfolio", 2, "본문만", "김서준 · 백엔드")
    assert fallback["heading"] == "김서준 · 백엔드"
    assert fallback["id"] == "draft-portfolio-v2"


def test_paper_event_none_for_empty_draft():
    from app.harness.personal.resume.progress import paper_event

    assert paper_event("resume", 1, "") is None
    assert paper_event("resume", 1, "   \n") is None


def test_feedback_plan_from_analysis():
    from app.harness.personal.resume.progress import feedback_plan

    plan = feedback_plan(
        {
            "feedback": [
                {"tag": "키워드", "problem": "키워드가 없어요", "fix": "결제 승인을 넣어요"},
                {"tag": "도메인", "problem": "도메인이 약해요", "fix": "핀테크를 적어요"},
                {"tag": "성과", "problem": "숫자가 없어요", "fix": "승인율을 적어요"},
            ]
        }
    )
    assert plan["id"] == "feedback"
    assert plan["title"] == "고칠 점"
    assert plan["meta"] == "3개"
    assert plan["rows"][0] == {
        "tag": "키워드",
        "label": "키워드가 없어요",
        "note": "결제 승인을 넣어요",
    }


def test_feedback_plan_none_without_structured_feedback():
    from app.harness.personal.resume.progress import feedback_plan

    assert feedback_plan({"message": "키워드가 부족해요", "improvements": ["한 줄"]}) is None
    assert feedback_plan({"feedback": "문장으로만 왔어요"}) is None


def test_intake_panel_rows_from_inputs():
    from app.harness.personal.resume.progress import intake_panel

    inputs = {
        "fileName": "김서준_백엔드_이력서_2026.pdf",
        "documentId": "doc-1",
        "posting": {"company": "모아페이", "title": "백엔드 엔지니어 (Kotlin·Spring)"},
        "postingId": "post-1",
    }
    sections = intake_panel(inputs, {"github": {"username": "seojun-kim"}})
    materials = next(section for section in sections if section["id"] == "materials")
    assert [row["sub"] for row in materials["options"]] == [
        "마이 › 서류",  # noqa: RUF001
        "홈 › 북마크 공고",  # noqa: RUF001
        "이력서에서 찾았어요",
    ]
    assert materials["options"][0]["label"] == "김서준_백엔드_이력서_2026.pdf"
    assert materials["options"][1]["badge"] == "모"
    assert materials["options"][2]["label"] == "github.com/seojun-kim"
    without = intake_panel(inputs, {})
    assert len(next(section for section in without if section["id"] == "materials")["options"]) == 2
    assert all(section["id"] != "materials" for section in intake_panel({}))


def test_posting_line_err_with_reason():
    line = posting_line(
        {
            "jobs": {
                "company": "모아페이",
                "title": "백엔드",
                "read_error": "로그인이 필요한 영역이에요",
            }
        },
        failed=True,
    )
    assert line["state"] == "err"
    assert line["name"] == "analyze_posting"
    assert line["target"] == "모아페이 · 백엔드"
    assert line["resultLine"] == "“자격 요건”은 로그인이 필요한 영역이라 읽지 못했어요."


def test_posting_line_err_without_reason():
    line = posting_line({"jobs": {}}, failed=True)
    assert line["target"] == "회사 채용 페이지"
    assert line["resultLine"] == "“자격 요건”을 읽지 못했어요."
    assert "·" not in line["resultLine"]


def test_read_failed_text_takes_a_noun_phrase_for_the_reason():
    from app.harness.personal.resume.progress import read_failed_text

    assert read_failed_text("로그인이 필요한 영역") == "“자격 요건”은 로그인이 필요한 영역이라 읽지 못했어요."
    assert read_failed_text("접근이 막힌 페이지이에요.") == "“자격 요건”은 접근이 막힌 페이지라 읽지 못했어요."
    assert read_failed_text("차단") == "“자격 요건”은 차단이라 읽지 못했어요."
    assert read_failed_text("404") == "“자격 요건”은 404라 읽지 못했어요."
    assert read_failed_text(None) == read_failed_text("  ") == "“자격 요건”을 읽지 못했어요."


def test_quality_line_counts():
    from app.harness.personal.resume.progress import quality_line

    assert quality_line([1, 2], [1, 2, 3])["resultLine"] == "바로 고친 것 2개 · 추천 3개"
    assert quality_line([], [1])["resultLine"] == "추천 1개"
    assert quality_line([1], [])["resultLine"] == "바로 고친 것 1개"
    assert quality_line([], [])["resultLine"] == "고칠 곳이 없어요"


def test_quality_diff_pairs_before_after():
    from app.harness.personal.resume.progress import quality_diff

    diff = quality_diff([{"line": 4, "before": "old", "after": "new"}])
    assert diff == {
        "type": "diff",
        "documentId": "",
        "revisionId": "",
        "hunks": [
            {"line": 4, "sign": "-", "text": "old"},
            {"line": 4, "sign": "+", "text": "new"},
        ],
    }


def test_present_message_has_fixed_parts_and_drops_empty_ones():
    from app.harness.personal.resume.graph import present_message

    view = {"drafts": {"markdown": "# 이력서", "verify_left": [
        {"level": "P1", "rule": "x", "detail": "기타"},
        {"level": "P0", "rule": "unknown_evidence", "detail": "E9"}]},
        "analysis": {"stage_late": ["posting"]}, "output_targets": ["resume", "portfolio"]}
    notes = {"assumptions": ["a1", "a2", "a3"]}
    text = present_message(view, notes, extras=True, saved="이력서_수정본.pdf")
    assert text.split("\n\n") == [
        "만든 것\n• 이력서 · 이력서_수정본.pdf\n• 포트폴리오",
        "대신 정한 것\n• a1\n• a2\n• a3",
        "확인이 필요한 점\n• 근거 목록에 없는 E9를 인용했어요.\n• 기타\n• 공고 읽기: 시간 안에 끝나지 않아 빼고 진행했어요",
        "다음\n• 같은 근거로 자기소개서도 만들 수 있어요. 원하면 말해 주세요.",
    ]
    # No extras on the plan: no next step offers one.
    assert "다음" not in present_message(view, notes, extras=False)
    # Nothing drafted, nothing assumed, nothing left: the caller keeps its own line.
    assert present_message({}, {"assumptions": []}, extras=True) == ""


def test_present_message_names_no_save_when_saving_failed():
    from app.harness.personal.resume.graph import present_message

    text = present_message({"drafts": {"markdown": "# 이력서"}}, {}, extras=True)
    assert "만든 것\n• 이력서\n" in text
    assert "저장" not in text.split("확인이 필요한 점")[0]
    assert "• 저장하지 못했어요. 다시 시도해 주세요." in text


def test_present_message_lists_failed_and_late_github_and_attachment_reads():
    from app.harness.personal.resume.graph import present_message

    view = {"drafts": {"markdown": "# 이력서"}, "analysis": {
        "stage_late": ["github:acme-labs/shop-web"],
        "stage_failed": ["posting", "github:acme-labs/shop-api", "attachment:a1", "attachment:a2"]}}
    text = present_message(view, {}, extras=False, saved="Push 프로필에 저장")
    late = "• GitHub 읽기 (acme-labs/shop-web): 시간 안에 끝나지 않아 빼고 진행했어요"
    assert late in text
    assert "• 공고 읽기: 끝내지 못해 빼고 진행했어요" in text
    assert "• GitHub 읽기 (acme-labs/shop-api): 끝내지 못해 빼고 진행했어요" in text
    assert text.count("첨부 파일 읽기: 끝내지 못해 빼고 진행했어요") == 1


def test_a_budget_stopped_boost_promises_no_follow_up():
    from app.harness.personal.resume.graph import present_message

    view = {"drafts": {"markdown": "# 이력서"}, "boost_stopped": "budget",
            "output_targets": ["resume"]}
    text = present_message(view, {}, extras=True, saved="Push 프로필에 저장")
    assert "더 올려" not in text
    assert text.endswith("같은 근거로 포트폴리오, 자기소개서도 만들 수 있어요. 원하면 말해 주세요.")
