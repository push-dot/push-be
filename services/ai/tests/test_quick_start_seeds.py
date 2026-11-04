from __future__ import annotations

import pytest

from app.domain.access_mode import AccessMode
from app.domain.employer_chat import known_intent
from app.domain.errors import DomainError
from app.domain.quick_starts import TOOL_INTENTS, quick_start_seed
from app.harness.graph import quick_start_resume, write_needs_approval

_FIND = (
    "개발 · 백엔드 · 경력 4–6년 · 서울 · Kotlin · Spring Boot "
    "조건으로 공고를 찾아 주세요. 적합도 7점 이상인 공고만 보여 주세요"
)


def test_worker_accepts_every_quick_start_intent():
    intents = (
        "match_posting", "fit", "gaps", "experience", "boost", *TOOL_INTENTS,
    )
    for intent in intents:
        assert known_intent(intent) == intent
    with pytest.raises(DomainError):
        known_intent("nope")


def test_tool_quick_starts_do_not_enter_the_resume_flow():
    for intent in TOOL_INTENTS:
        assert quick_start_resume(intent, {}) is None


def test_each_sheet_seeds_inputs_and_keeps_writes_behind_approval():
    samples = {
        "find_postings": _FIND,
        "deadline_postings": "마감 임박 공고 2개(파도AI, 도토리증권)의 준비할 일을 정리해 주세요",
        "applications": "모아페이, 도토리증권 지원 현황을 정리하고 다음에 할 일을 알려 주세요",
        "calendar": "이번 주 정리하기: 이번 주 일정 3건을 정리해 주세요",
        "hub_profile": "이력서.pdf를 바탕으로 허브 프로필의 헤드라인, 소개을 다듬어 주세요",
        "offer_reply": "오지현 님의 제안 “커피챗 어떠세요?”에 보낼 답장 초안을 써 주세요",
        "coffee_chat": "이하은 님에게 보낼 커피챗 제안 글을 써 주세요",
        "career_post": "“결제 승인 API” 커리어 글 초안을 써 주세요",
    }
    assert set(samples) == set(TOOL_INTENTS)
    for intent, text in samples.items():
        seed = quick_start_seed(intent, text, {})
        assert seed["intent"] == intent
        assert seed["read_tools"]
        assert seed["inputs"]
        assert "승인" in seed["instruction"] or not seed["write_tools"]
        for name in seed["write_tools"]:
            assert write_needs_approval(AccessMode.BYPASS, "RISKY_WRITE", seed) is True
            assert isinstance(name, str) and name


def test_find_postings_seed_reads_chips_and_the_score_switch():
    seed = quick_start_seed("find_postings", _FIND, {})
    assert seed["inputs"]["chips"] == [
        "개발 · 백엔드", "경력 4–6년", "서울", "Kotlin", "Spring Boot",
    ]
    assert seed["inputs"]["minFit"] is True
    assert seed["inputs"]["category"] == "dev"
    assert seed["inputs"]["role"] == "백엔드"
    assert seed["inputs"]["careerMin"] == 4
    assert seed["inputs"]["careerMax"] == 6
    assert seed["inputs"]["locations"] == ["서울"]
    assert seed["inputs"]["skills"] == ["Kotlin", "Spring Boot"]
    assert "find_matching_postings" in seed["read_tools"]


def test_sheet_fields_land_in_the_other_seeds():
    deadline = quick_start_seed(
        "deadline_postings",
        "마감 임박 공고 2개(파도AI, 도토리증권)의 준비할 일을 정리해 주세요",
        {},
    )
    assert deadline["inputs"]["names"] == ["파도AI", "도토리증권"]
    assert "list_bookmarks" in deadline["read_tools"]

    applications = quick_start_seed(
        "applications",
        "모아페이, 도토리증권 지원 현황을 정리하고 다음에 할 일을 알려 주세요",
        {},
    )
    assert applications["inputs"]["names"] == ["모아페이", "도토리증권"]
    assert "list_applications" in applications["read_tools"]

    calendar = quick_start_seed(
        "calendar", "마감일 넣기: 이번 주 일정 1건을 정리해 주세요", {})
    assert calendar["inputs"]["task"] == "마감일 넣기"
    assert "list_calendar_events" in calendar["read_tools"]
    assert "create_calendar_event" in calendar["write_tools"]

    hub = quick_start_seed(
        "hub_profile",
        "이력서.pdf를 바탕으로 허브 프로필의 헤드라인, 기술 스택을 다듬어 주세요",
        {},
    )
    assert hub["inputs"]["sections"] == ["헤드라인", "기술 스택"]
    assert "update_my_profile" in hub["write_tools"]
    assert "get_my_profile" in hub["read_tools"]

    reply = quick_start_seed(
        "offer_reply",
        "오지현 님의 제안 “커피챗 어떠세요?”에 보낼 답장 초안을 써 주세요",
        {},
    )
    assert reply["inputs"]["name"] == "오지현"
    assert reply["inputs"]["body"] == "커피챗 어떠세요?"
    assert "send_offer_message" in reply["write_tools"]

    coffee = quick_start_seed(
        "coffee_chat", "이하은 님에게 보낼 커피챗 제안 글을 써 주세요", {})
    assert coffee["inputs"]["name"] == "이하은"
    assert "get_my_profile" in coffee["read_tools"]
    assert "search_profiles" in coffee["read_tools"]
    assert coffee["write_tools"] == ("send_offer",)
    assert "create_post" not in coffee["write_tools"]
    assert "공개 글은 올리지 않아요." in coffee["instruction"]

    post = quick_start_seed(
        "career_post", "“결제 승인 API” 커리어 글 초안을 써 주세요", {})
    assert post["inputs"]["topic"] == "결제 승인 API"
    assert "create_post" in post["write_tools"]


def test_read_tools_do_not_wait_just_because_a_quick_start_is_active():
    seed = quick_start_seed("hub_profile", "허브 프로필을 다듬어 주세요", {})
    assert write_needs_approval(AccessMode.BYPASS, "READ", seed) is False
    assert write_needs_approval(AccessMode.BYPASS, "SAFE_WRITE", None) is False
