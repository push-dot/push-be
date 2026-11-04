from __future__ import annotations

from app.harness.personal.resume.progress import (
    analyze_steps,
    done_summary,
    fit_card,
    github_line,
    posting_line,
    resume_line,
    todo_event,
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
        "band": "보통 · 개선 여지 있어요",
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
        "name": "boost",
        "state": "ok",
        "summary": "점수 올리기 2회",
        "tier": "READ",
        "resultLine": "7.8 → 8.3",
    }
    assert boost_fit(6.9, 8.3) == {
        "type": "fit",
        "score": 8.3,
        "from": 6.9,
        "delta": "+1.4",
        "note": "적합도 6.9 → 8.3 (+1.4)",
        "band": "높음 · 잘 맞아요",
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
    line = next(event for event in events if event.get("name") == "boost")
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
