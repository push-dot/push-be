"""Card payloads as A2UI surfaces: valid v0.9.1 and 1.0 messages of the Push catalog, the same
live and on replay. Every case also writes its wire frame to packages/contracts/a2ui/fixtures/
<case>.json (v0.9.1) and fixtures/v1.0/<case>.json (1.0), which the frontend mocks and renderer
tests import."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from jsonschema_specifications import REGISTRY as METASCHEMAS
from referencing import Registry, Resource

from app.domain.a2ui import CATALOG_ID, V091, V1, VERSIONS, auto_pick_line, frame, to_a2ui
from app.domain.chat_turns import bot_turn_events
from app.domain.services.conversation import _live_event
from app.harness.approval import tool_action_event
from app.harness.personal.resume.progress import (
    boost_fit,
    boost_rounds,
    feedback_plan,
    intake_panel,
    paper_event,
    quality_diff,
    todo_event,
)

A2UI = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "a2ui"
FIXTURES = {V091: A2UI / "fixtures", V1: A2UI / "fixtures" / "v1.0"}
CARD = "00000000-0000-4000-8000-00000000c0de"
JOB = "00000000-0000-4000-8000-00000000a001"
SID = "00000000-0000-4000-8000-0000000051d0"
AT = "2026-11-23T00:00:00.000000Z"


def _schema(name: str) -> dict:
    return json.loads((A2UI / name).read_text())


def _validator(message: str, common: str, catalog: str, alias: str) -> Draft202012Validator:
    server = _schema(message)
    # The message and common-type schemas refer to catalog.json, which is the catalog the surface
    # names (as the upstream test runners alias it): here the Push catalog of that version.
    push = {**_schema(catalog), "$id": alias}
    registry = Registry().with_resources(
        (doc["$id"], Resource.from_contents(doc)) for doc in (server, _schema(common), push)
    )
    return Draft202012Validator(server, registry=registry)


VALIDATORS = {
    V091: _validator(
        "spec/server_to_client.json",
        "spec/common_types.json",
        "push-catalog.json",
        "https://a2ui.org/specification/v0_9/catalog.json",
    ),
    V1: _validator(
        "spec/v1.0/agent_to_renderer.json",
        "spec/v1.0/common_types.json",
        "push-catalog.v1.json",
        "https://a2ui.org/specification/v1_0/catalog.json",
    ),
}

_SITE = tool_action_event(
    CARD,
    "moapay.com을 읽어요",
    "read_page",
    {"url": "https://moapay.com"},
    title="moapay.com을 읽어도 될까요?",
    options=(
        {"id": "approve", "label": "한 번 허용"},
        {
            "id": "approve_always",
            "label": "항상 허용",
            "desc": "이 Bot이 이 사이트를 읽을 때 다시 묻지 않아요",
        },
        {"id": "reject", "label": "거절"},
    ),
)
_TOOL = tool_action_event(
    CARD,
    "지원 단계를 바꿔요",
    "change_applicant_stage",
    {"stage": "INTERVIEW"},
    [{"name": "김푸시", "initial": "김", "from": "서류", "to": "면접"}],
)
_EDIT = {
    "type": "approval",
    "id": CARD,
    "kind": "DOCUMENT_EDIT",
    "title": "수정 적용",
    "summary": "1줄을 고쳤어요. 적용하면 문서에 바로 반영돼요.",
    "documentId": "00000000-0000-4000-8000-00000000d0c1",
    "options": [{"id": "apply", "label": "적용"}, {"id": "skip", "label": "그대로 두기"}],
    "hunks": [
        {"line": None, "sign": "", "text": "경력"},
        {"line": None, "sign": "-", "text": "결제 서버를 운영했어요"},
        {"line": None, "sign": "+", "text": "결제 서버 트래픽을 3배로 늘렸어요"},
        {"line": None, "sign": "", "text": "학력"},
    ],
}
_PLAIN = {
    "type": "choice",
    "id": CARD,
    "kind": "RESUME_GATE",
    "gate": "analyze",
    "title": "이대로 분석을 시작할까요?",
    "recommended": "ready",
    "detail": "공고와 이력서를 비교해요.",
    "options": [{"id": "ready", "label": "시작하기"}, {"id": "cancel", "label": "그만하기"}],
}
_MULTI = {
    "type": "choice",
    "id": CARD,
    "kind": "RESUME_GATE",
    "gate": "output_targets",
    "title": "어떤 산출물을 만들까요?",
    "recommended": "resume",
    "multiple": True,
    "options": [
        {"id": "resume", "label": "이력서", "badge": "추천"},
        {"id": "portfolio", "label": "포트폴리오"},
        {"id": "cover_letter", "label": "자기소개서"},
        {"id": "cancel", "label": "닫기"},
    ],
}
_SECTIONS = {
    "type": "choice",
    "id": CARD,
    "kind": "RESUME_GATE",
    "gate": "output_targets",
    "title": "어떤 산출물을 만들까요?",
    "recommended": "resume",
    "options": [{"id": "resume", "label": "이력서"}, {"id": "cancel", "label": "닫기"}],
    "sections": intake_panel({"fileName": "이력서.pdf", "github": "https://github.com/push"}),
    "submit": {"label": "이 말투로 쓰기"},
}
_TEMPLATES = {
    "type": "choice",
    "id": CARD,
    "kind": "RESUME_GATE",
    "gate": "review",
    "title": "어떤 디자인으로 만들까요?",
    "recommended": "CLASSIC",
    "options": [{"id": "CLASSIC", "label": "클래식"}, {"id": "cancel", "label": "닫기"}],
    "sections": [
        {
            "id": "template",
            "kind": "thumbnails",
            "options": [
                {"id": "CLASSIC", "label": "클래식", "badge": "추천"},
                {"id": "MODERN", "label": "모던"},
                {"id": "COMPACT", "label": "컴팩트"},
                {"id": "ATS", "label": "ATS"},
            ],
            "selected": ["CLASSIC"],
        }
    ],
    "submit": {
        "label": "만들기",
        "optionLabels": {"CLASSIC": "클래식으로 만들기", "MODERN": "모던으로 만들기"},
    },
}
_STRATEGY = {
    "type": "plan",
    "id": "strategy",
    "title": "수정 전략",
    "meta": "섹션 2개",
    "rows": [
        {"tag": "강화", "label": "경력", "note": "결제 트래픽 성과를 숫자로 써요"},
        {"tag": "보완", "label": "기술 스택", "note": "Kafka 경험을 더해요"},
    ],
    "keywords": ["Kafka", "결제"],
}
_FIT = {
    "type": "fit",
    "score": 6.9,
    "parts": {
        "techStack": 7.5,
        "experienceLink": 6.0,
        "careerLevel": 8.0,
        "keyword": 5.0,
        "domain": 5.5,
    },
    "topGap": "키워드",
    "plan": "PRO",
    "band": "보통이고, 고칠 여지가 있어요.",
    "summary": "경력 수준은 잘 맞아요. 키워드와 도메인이 약해요.",
    "keywords": [
        {"label": "Kafka", "ok": False},
        {"label": "결제", "ok": True},
        {"label": "MSA", "ok": False},
    ],
}
_EXTERNAL = {
    "type": "result",
    "source": "external",
    "taskLine": "이력서 수정 · 올린 파일 · 경력",
    "checklist": ["공고 읽기", "이력서 고치기"],
    "fileName": "이력서_모아페이_백엔드.pdf",
    "pageLine": "A4 2쪽 · 120KB",
    "cardMeta": "A4 2쪽 · 120KB",
    "documentId": "00000000-0000-4000-8000-00000000d0c1",
    "savedLine": "내 서류에 자동 저장됨",
    "company": "모아페이",
    "actions": [
        {"id": "apply", "label": "모아페이에 바로 지원하기"},
        {
            "id": "convert",
            "label": "프로필로 전환",
            "method": "POST",
            "path": "/api/v1/documents/00000000-0000-4000-8000-00000000d0c1/profile",
        },
    ],
    "summary": "다 됐어요! 적합도를 6.9 → 8.3으로 올렸어요.",
    "fitFrom": 6.9,
    "fitTo": 8.3,
    "bullets": ["경력 문장에 Kafka를 넣었어요", "성과를 숫자로 보여 줬어요"],
}
_PROFILE = {
    "type": "result",
    "source": "profile",
    "taskLine": "프로필 수정 · Push 프로필 · 경력",
    "checklist": ["프로필 고치기"],
    "documentId": "00000000-0000-4000-8000-00000000d0c2",
    "name": "김푸시",
    "headline": "백엔드 개발자",
    "title": "김푸시 · 백엔드 개발자",
    "subtitle": "Push 프로필 · 방금 수정",
    "actions": [{"id": "view", "label": "프로필 보기"}],
    "summary": "다 됐어요! 프로필을 고쳤어요.",
    "bullets": [],
}
_BOOST_LINE = {
    "type": "tool",
    "name": "boost1",
    "target": "경력 · 모아페이",
    "resultLine": "6.9 → 8.3 · 성과를 숫자로 보여 줬어요",
}

APPROVED = {"status": "APPROVED", "optionId": "approve"}

# case name -> (kind, payload, resolution)
CASES = {
    "approval-tool": ("approval", _TOOL, None),
    "approval-tool-answered": ("approval", _TOOL, APPROVED),
    "approval-site": ("approval", _SITE, None),
    "approval-edit": ("approval", _EDIT, None),
    "approval-edit-answered": ("approval", _EDIT, {"status": "REJECTED", "optionId": "skip"}),
    "choice-single": ("choice", _PLAIN, None),
    "choice-single-answered": ("choice", _PLAIN, {"status": "APPROVED", "optionId": "ready"}),
    "choice-multiple": ("choice", _MULTI, None),
    "choice-multiple-answered": (
        "choice",
        _MULTI,
        {"status": "APPROVED", "optionId": "resume", "optionIds": ["resume", "cover_letter"]},
    ),
    "choice-sections": ("choice", _SECTIONS, None),
    "choice-sections-answered": (
        "choice",
        _SECTIONS,
        {
            "status": "APPROVED",
            "optionId": "submit",
            "optionIds": ["submit", "resume", "m_file", "preserve"],
        },
    ),
    "choice-templates": ("choice", _TEMPLATES, None),
    "plan-strategy": ("plan", {**_STRATEGY, "sid": f"plan:strategy:{JOB}"}, None),
    "plan-feedback": (
        "plan",
        {
            **feedback_plan(
                {
                    "feedback": [
                        {
                            "problem": "성과가 숫자로 없어요",
                            "fix": "트래픽 수치를 넣어요",
                            "tag": "성과",
                        },
                        {
                            "problem": "도메인 경험이 약해요",
                            "fix": "결제 도메인을 강조해요",
                            "tag": "도메인",
                        },
                    ]
                }
            ),
            "sid": f"plan:feedback:{JOB}",
        },
        None,
    ),
    "paper": (
        "paper",
        {
            **paper_event(
                "resume",
                1,
                "# 김푸시\n\n- 결제 서버 트래픽을 3배로 늘렸어요\n- Kafka로 정산을 옮겼어요",
            ),
            "sid": f"paper:draft-resume-v1:{JOB}",
        },
        None,
    ),
    "todo": (
        "todo",
        {
            **todo_event(
                "analyze",
                [("resume", "이력서 읽기"), ("posting", "공고 분석"), ("fit", "적합도 계산")],
                1,
                frozenset({"fit"}),
            ),
            "sid": f"todo:analyze:{JOB}",
        },
        None,
    ),
    "diff": (
        "diff",
        {**quality_diff([{"line": 3, "before": "운영햇어요", "after": "운영했어요"}]), "sid": SID},
        None,
    ),
    "fit": ("fit", {**_FIT, "sid": SID}, None),
    "fit-locked": ("fit", {**_FIT, "plan": "FREE", "sid": SID}, None),
    "fit-boost": (
        "fit",
        {**boost_fit(6.9, 8.3, boost_rounds(None, JOB, _BOOST_LINE)["items"]), "sid": SID},
        None,
    ),
    "result": ("result", {**_EXTERNAL, "sid": SID}, None),
    "result-save-failed": (
        "result",
        {**{k: v for k, v in _EXTERNAL.items() if k != "savedLine"}, "sid": SID},
        None,
    ),
    "result-profile": ("result", {**_PROFILE, "sid": SID}, None),
}


def _project(name: str, version: str = V091) -> dict:
    kind, payload, resolution = CASES[name]
    stored = {k: v for k, v in payload.items() if k != "type"}
    projection = to_a2ui(kind, stored, resolution, version)
    assert projection is not None
    return projection


def _components(projection: dict) -> list[dict]:
    return projection["messages"][1]["updateComponents"]["components"]


def _data(projection: dict) -> dict:
    return projection["messages"][2]["updateDataModel"]["value"]


def _by_type(projection: dict, name: str) -> dict:
    return next(c for c in _components(projection) if c["component"] == name)


@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("name", sorted(CASES))
def test_every_case_is_a_valid_full_snapshot_of_the_push_catalog(name, version):
    kind, _payload, _resolution = CASES[name]
    projection = _project(name, version)
    for message in projection["messages"]:
        VALIDATORS[version].validate(message)
        assert message["version"] == version
    create, update, data = projection["messages"]
    assert create["createSurface"] == {
        "surfaceId": projection["surfaceId"],
        "catalogId": CATALOG_ID,
    }
    assert data["updateDataModel"]["path"] == "/"
    components = update["updateComponents"]["components"]
    ids = [component["id"] for component in components]
    assert len(ids) == len(set(ids)) and ids.count("root") == 1
    for component in components:
        for child in component.get("children", []):
            assert child in ids
        if component["component"] == "Text":
            assert "**" not in component["text"]
    # The exact wire frame of the stream and the transcript, with a fixed stamp.
    wire = {**frame(kind, projection), "seq": 1, "at": AT, "turn": JOB}
    path = FIXTURES[version] / f"{name}.json"
    text = json.dumps(wire, ensure_ascii=False, indent=2) + "\n"
    if not path.exists() or path.read_text() != text:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


@pytest.mark.parametrize("version", VERSIONS)
def test_the_fixture_folder_holds_exactly_the_cases(version):
    assert {path.stem for path in FIXTURES[version].glob("*.json")} == set(CASES)


def test_both_catalogs_are_valid_catalog_documents_with_the_same_components():
    v091, v1 = _schema("push-catalog.json"), _schema("push-catalog.v1.json")
    definition = _schema("spec/v1.0/catalog_definition.json")
    registry = METASCHEMAS.with_resources(
        (doc["$id"], Resource.from_contents(doc))
        for doc in (definition, _schema("spec/v1.0/common_types.json"))
    )
    Draft202012Validator(definition, registry=registry).validate(v1)
    assert v1["catalogId"] == v091["catalogId"] == CATALOG_ID
    assert list(v1["components"]) == list(v091["components"])
    for name in ("PushChoice", "PushTodo", "PushDiff", "PushPlan", "PushFit", "PushDocument"):
        props = set(v091["components"][name]["properties"]) - {"id"}
        assert set(v1["components"][name]["properties"]) == props, name
        assert "$ref" not in json.dumps(v1["components"][name])


def test_1_0_differs_only_in_version_bindings_and_heading_variants():
    old, new = _project("approval-edit-answered"), _project("approval-edit-answered", V1)
    assert [m["version"] for m in new["messages"]] == [V1] * 3
    choice = _by_type(new, "PushChoice")
    assert (choice["open"], choice["picked"]) == ({"@path": "/open"}, {"@path": "/picked"})
    assert new["messages"][2]["updateDataModel"] == old["messages"][2]["updateDataModel"]
    title = next(c for c in _components(new) if c["id"] == "title")
    assert title == {"id": "title", "component": "Text", "text": "수정 적용"}
    caption = next(c for c in _components(_project("approval-tool", V1)) if c["id"] == "row0")
    assert "variant" not in caption
    todo = _by_type(_project("todo", V1), "PushTodo")
    assert todo["items"] == {"@path": "/items"}


def test_surface_ids_follow_the_kind():
    assert _project("approval-tool")["surfaceId"] == CARD
    assert _project("choice-single")["surfaceId"] == CARD
    assert _project("plan-strategy")["surfaceId"] == f"plan:strategy:{JOB}"
    assert _project("fit")["surfaceId"] == SID
    assert to_a2ui("fit", {"score": 1.0}) is None


def test_open_cards_take_an_answer_and_answered_ones_bake_it():
    assert _data(_project("approval-tool")) == {"open": True, "picked": [], "selected": {"q": []}}
    assert _data(_project("approval-tool-answered"))["picked"] == ["approve"]
    assert _data(_project("approval-edit-answered")) == {
        "open": False,
        "picked": ["skip"],
        "selected": {"q": []},
    }
    assert _data(_project("choice-multiple-answered"))["picked"] == ["resume", "cover_letter"]
    expired = to_a2ui("choice", _PLAIN, {"status": "EXPIRED", "optionId": None})
    assert _data(expired) == {"open": False, "picked": [], "selected": {"q": []}}
    pending = to_a2ui("choice", _PLAIN, {"status": "PENDING", "optionId": None})
    assert _data(pending)["open"] is True


def test_the_two_button_panels_put_the_way_out_left():
    edit = _by_type(_project("approval-edit"), "PushChoice")
    assert edit["form"] == "buttons"
    assert [(c["id"], c["label"]) for c in edit["questions"][0]["choices"]] == [
        ("skip", "되돌리기"),
        ("apply", "적용"),
    ]
    assert _by_type(_project("approval-edit"), "PushDiff")["title"] == "1줄을 더하고 1줄을 뺐어요"
    tool = _by_type(_project("approval-tool"), "PushChoice")
    assert [c["id"] for c in tool["questions"][0]["choices"]] == ["reject", "approve"]
    texts = [c["text"] for c in _components(_project("approval-tool")) if c["component"] == "Text"]
    assert texts == ["지원 단계를 바꿔요", "김푸시 · 서류 → 면접"]


def test_the_site_card_asks_by_its_title_and_lists_three_answers():
    projection = _project("approval-site")
    texts = [c["text"] for c in _components(projection) if c["component"] == "Text"]
    assert texts == ["moapay.com을 읽어도 될까요?", "moapay.com을 읽어요"]
    choice = _by_type(projection, "PushChoice")
    assert choice["form"] == "list" and len(choice["questions"][0]["choices"]) == 3


def test_a_plain_choice_answers_on_tap_and_closes_with_닫기():
    choice = _by_type(_project("choice-single"), "PushChoice")
    assert choice["answer"] == "pick" and "submit" not in choice
    (question,) = choice["questions"]
    assert question["detail"] == "공고와 이력서를 비교해요."
    assert question["choices"] == [
        {"id": "ready", "label": "시작하기", "recommended": True},
        {"id": "cancel", "label": "닫기"},
    ]


def test_a_multiple_pick_has_one_button_and_moves_cancel_out_of_the_list():
    choice = _by_type(_project("choice-multiple"), "PushChoice")
    assert choice["submit"] == {"label": "이대로 진행"}
    assert choice["secondary"] == {"id": "cancel", "label": "닫기"}
    assert [c["id"] for c in choice["questions"][0]["choices"]] == [
        "resume",
        "portfolio",
        "cover_letter",
    ]
    assert choice["questions"][0]["multiple"] is True


def test_sections_are_steps_answered_by_submit_with_their_defaults_selected():
    projection = _project("choice-sections")
    choice = _by_type(projection, "PushChoice")
    assert choice["answer"] == "submit"
    assert [q["id"] for q in choice["questions"]] == ["targets", "materials", "tone"]
    assert choice["submit"] == {"label": "이 말투로 쓰기"} and choice["secondary"]["id"] == "cancel"
    materials = choice["questions"][1]
    assert materials["multiple"] is True
    rows = {
        "id": "found",
        "kind": "rows",
        "options": [{"id": "m_github", "label": "push", "action": "change"}],
    }
    (shown,) = _by_type(to_a2ui("choice", {**_SECTIONS, "sections": [rows]}), "PushChoice")[
        "questions"
    ]
    assert shown["answerable"] is False and shown["choices"][0]["change"] is True
    assert _data(projection)["selected"] == {
        "targets": ["resume"],
        "materials": ["m_file", "m_github"],
        "tone": ["preserve"],
    }
    templates = _by_type(_project("choice-templates"), "PushChoice")
    assert templates["submit"]["labels"]["MODERN"] == "모던으로 만들기"
    assert templates["questions"][0]["choices"][0]["recommended"] is True


def test_an_auto_picked_choice_has_no_surface_and_a_line_instead():
    auto = {**_PLAIN, "auto": True}
    assert to_a2ui("choice", auto) is None
    assert auto_pick_line(auto) == "자동으로 골랐어요: 시작하기"
    sections = {**_SECTIONS, "auto": True}
    assert (
        auto_pick_line(sections)
        == "자동으로 골랐어요: 이력서, 이력서.pdf, https://github.com/push, 원래 말투로"
    )
    assert auto_pick_line({**_PLAIN, "auto": True, "gate": "present"}) is None


def test_fit_sentences_use_the_particle_of_the_number():
    fit = _by_type(_project("fit"), "PushFit")
    assert fit["sentence"] == "적합도는 6.9점이에요. 보통이고, 고칠 여지가 있어요."
    assert [item["label"] for item in fit["items"]] == [
        "기술 스택",
        "경험 연관성",
        "경력 수준",
        "키워드",
        "도메인",
    ]
    assert fit["missing"] == ["Kafka", "MSA"]
    boost = _by_type(_project("fit-boost"), "PushFit")
    assert boost["sentence"] == "적합도를 6.9 → 8.3으로 올렸어요. (+1.4)"
    assert boost["rounds"] == ["경력 · 모아페이: 성과를 숫자로 보여 줬어요"]
    to_eight = to_a2ui("fit", {**boost_fit(6.9, 8.2), "sid": SID})
    assert _by_type(to_eight, "PushFit")["sentence"].startswith("적합도를 6.9 → 8.2로 올렸어요.")


def test_a_free_plan_fit_is_locked_and_sends_no_real_bars():
    fit = _by_type(_project("fit-locked"), "PushFit")
    assert fit["locked"] is True and "items" not in fit


def test_boost_rounds_count_only_this_jobs_rounds():
    first = boost_rounds(None, JOB, _BOOST_LINE)
    second = boost_rounds(
        first,
        JOB,
        {**_BOOST_LINE, "target": "키워드", "resultLine": "8.3 → 8.6 · 키워드를 넣었어요"},
    )
    assert [r["label"] for r in second["items"]] == ["경력 · 모아페이", "키워드"]
    assert [r["label"] for r in boost_rounds(second, "next-job", _BOOST_LINE)["items"]] == [
        "경력 · 모아페이"
    ]
    assert (
        boost_rounds(None, JOB, {"type": "tool", "name": "boost1", "resultLine": "6.9 → 7.0"})[
            "items"
        ]
        == []
    )


def test_results_say_what_happened_and_a_failed_save_offers_only_다시_저장하기():
    document = _by_type(_project("result"), "PushDocument")
    assert (document["status"], document["title"], document["share"]) == (
        "done",
        "이력서를 저장했어요",
        True,
    )
    assert [a["id"] for a in document["actions"]] == ["apply", "convert"]
    texts = [c["text"] for c in _components(_project("result")) if c["component"] == "Text"]
    assert texts[0] == "다 됐어요! 적합도를 6.9 → 8.3으로 올렸어요."
    failed = _by_type(_project("result-save-failed"), "PushDocument")
    assert failed["status"] == "failed" and failed["actions"] == [
        {"id": "retry_save", "label": "다시 저장하기"}
    ]
    assert "share" not in failed and "documentId" not in failed
    profile = _by_type(_project("result-profile"), "PushDocument")
    assert (profile["title"], profile["name"], profile["share"]) == (
        "Push 프로필에 저장했어요",
        "김푸시 · 백엔드 개발자",
        False,
    )


def test_todo_states_are_bound_so_a_later_frame_updates_in_place():
    projection = _project("todo")
    assert _by_type(projection, "PushTodo")["items"] == {"path": "/items"}
    assert _data(projection)["items"] == [
        {"text": "이력서 읽기", "state": "done"},
        {"text": "공고 분석", "state": "running"},
        {"text": "적합도 계산 (새로 추가)", "state": "waiting"},
    ]


def test_a_long_diff_keeps_twenty_changed_lines_with_context():
    hunks = [{"line": None, "sign": "", "text": "머리"}]
    hunks += [{"line": None, "sign": "+", "text": f"줄 {i}"} for i in range(30)]
    diff = _by_type(to_a2ui("diff", {"sid": SID, "hunks": hunks, "documentId": "doc"}), "PushDiff")
    assert sum(line["sign"] == "+" for line in diff["lines"]) == 20
    assert diff["lines"][0] == {"sign": "", "text": "머리"}
    assert (diff["title"], diff["documentId"]) == ("30줄을 더했어요", "doc")


def _stored_row(id_: int, kind: str, payload: dict) -> dict:
    return {
        "id": id_,
        "job_id": JOB,
        "type": kind,
        "payload": payload,
        "created_at": datetime(2026, 11, 23, tzinfo=UTC),
    }


def test_the_live_row_keeps_the_legacy_payload_and_carries_its_surface():
    kind, stored = _live_event({**_FIT}, JOB)
    assert kind == "fit"
    assert {key: stored[key] for key in _FIT if key != "type"} == {
        k: v for k, v in _FIT.items() if k != "type"
    }
    assert stored["a2ui"][V091]["surfaceId"] == stored["a2ui"][V1]["surfaceId"] == stored["sid"]
    _kind, plan = _live_event({**_STRATEGY}, JOB)
    assert plan["sid"] == f"plan:strategy:{JOB}" == plan["a2ui"][V1]["surfaceId"]
    _kind, card = _live_event({**_TOOL}, JOB)
    assert "sid" not in card and card["a2ui"][V091]["surfaceId"] == CARD
    _kind, auto = _live_event({**_PLAIN, "auto": True}, JOB)
    assert "a2ui" not in auto


@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize(
    "chunk", [_TOOL, _PLAIN, _STRATEGY, _FIT, _EXTERNAL], ids=lambda c: c["type"]
)
def test_replay_rebuilds_the_live_surface_from_the_stored_payload(chunk, version):
    kind, stored = _live_event({**chunk}, JOB)
    cards = {CARD: {"resolution": {"status": "PENDING", "optionId": None}, "openedAt": None}}
    (event,) = bot_turn_events([_stored_row(9, kind, stored)], cards, True, version)
    live = stored["a2ui"][version]
    assert (event["type"], event["kind"], event["surfaceId"]) == ("a2ui", kind, live["surfaceId"])
    assert event["messages"] == live["messages"]


def test_replay_of_an_answered_card_shows_it_answered():
    _kind, stored = _live_event({**_TOOL}, JOB)
    cards = {CARD: {"resolution": APPROVED, "openedAt": None}}
    (event,) = bot_turn_events([_stored_row(9, "approval", stored)], cards, active=False)
    assert event["messages"][2]["updateDataModel"]["value"]["picked"] == ["approve"]


def test_a_row_stored_before_surfaces_gets_a_stable_surface_id_on_replay():
    rows = [
        _stored_row(4, "fit", {k: v for k, v in _FIT.items() if k != "type"}),
        _stored_row(5, "todo", {"id": "analyze", "items": []}),
    ]
    first = [event["surfaceId"] for event in bot_turn_events(rows, {}, active=True)]
    assert first == ["fit:4", f"todo:analyze:{JOB}"]
    assert [event["surfaceId"] for event in bot_turn_events(rows, {}, active=True)] == first
