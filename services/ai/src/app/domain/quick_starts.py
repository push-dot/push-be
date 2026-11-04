from __future__ import annotations

import re

TOOL_INTENTS = (
    "find_postings",
    "deadline_postings",
    "applications",
    "calendar",
    "hub_profile",
    "offer_reply",
    "coffee_chat",
    "career_post",
)

_CATEGORIES = {
    "개발": "dev",
    "데이터": "data",
    "디자인": "design",
    "기획": "plan",
    "마케팅": "marketing",
    "영업": "sales",
    "인사": "hr",
    "운영": "ops",
}


def _chips_from_text(text: str) -> list[str]:
    head = text.split("조건으로 공고를 찾아 주세요", 1)[0].strip()
    parts = [part.strip() for part in head.split(" · ") if part.strip()]
    chips = []
    index = 0
    while index < len(parts):
        part = parts[index]
        nxt = parts[index + 1] if index + 1 < len(parts) else ""
        if part in _CATEGORIES and nxt and not nxt.startswith("경력"):
            chips.append(f"{part} · {nxt}")
            index += 2
            continue
        chips.append(part)
        index += 1
    return chips


def _career(chip: str):
    matched = re.search(r"(\d+)\s*[–\-−]\s*(\d+)", chip)
    if matched:
        return int(matched.group(1)), int(matched.group(2))
    plus = re.search(r"(\d+)\s*년\s*이상", chip)
    if plus:
        return int(plus.group(1)), None
    if "신입" in chip:
        return 0, 0
    return None


def _hangul(text: str) -> bool:
    return bool(text) and all("가" <= char <= "힣" or char == " " for char in text)


def conditions_from_chips(chips: list[str]) -> dict:
    category = None
    role = None
    career = None
    locations = []
    skills = []
    for chip in chips:
        band = _career(chip)
        if band is not None:
            career = band
            continue
        if "·" in chip:
            left, right = [part.strip() for part in chip.split("·", 1)]
            if left in _CATEGORIES:
                category = _CATEGORIES[left]
                role = right
                continue
        if _hangul(chip):
            locations.append(chip)
            continue
        skills.append(chip)
    return {
        "chips": list(chips),
        "category": category,
        "role": role,
        "careerMin": None if career is None else career[0],
        "careerMax": None if career is None else career[1],
        "locations": locations,
        "skills": skills,
    }


def _document_id(context: dict):
    value = context.get("documentId") if isinstance(context, dict) else None
    if value in (None, ""):
        return None
    return str(value)


def _find_inputs(text: str, context: dict) -> dict:
    parsed = conditions_from_chips(_chips_from_text(text))
    parsed["minFit"] = "적합도 7점" in text
    parsed["documentId"] = _document_id(context)
    return parsed


def _split_names(body: str) -> list[str]:
    return [part.strip() for part in body.split(",") if part.strip()]


def _deadline_inputs(text: str, _context: dict) -> dict:
    matched = re.search(r"마감 임박 공고 \d+개\((.+)\)", text)
    return {"names": _split_names(matched.group(1)) if matched else []}


def _application_inputs(text: str, _context: dict) -> dict:
    matched = re.search(r"(.+) 지원 현황을 정리", text)
    return {"names": _split_names(matched.group(1)) if matched else []}


def _calendar_inputs(text: str, _context: dict) -> dict:
    task = text.split(":", 1)[0].strip() if ":" in text else ""
    return {"task": task}


def _hub_inputs(text: str, context: dict) -> dict:
    matched = re.search(r"허브 프로필의 (.+)을 다듬어", text)
    sections = []
    if matched:
        sections = [part.strip() for part in matched.group(1).split(",") if part.strip()]
    return {"sections": sections, "documentId": _document_id(context)}


def _offer_inputs(text: str, _context: dict) -> dict:
    matched = re.search(r"(.+) 님의 제안 [“\"](.+)[”\"]", text)
    if matched is None:
        return {"name": "", "body": ""}
    return {"name": matched.group(1).strip(), "body": matched.group(2).strip()}


def _coffee_inputs(text: str, _context: dict) -> dict:
    matched = re.search(r"(.+) 님에게 보낼 커피챗", text)
    return {"name": matched.group(1).strip() if matched else ""}


def _post_inputs(text: str, _context: dict) -> dict:
    matched = re.search(r"[“\"](.+)[”\"]", text)
    return {"topic": matched.group(1).strip() if matched else ""}


_SPECS = {
    "find_postings": {
        "read_tools": ("find_matching_postings",),
        "write_tools": (),
        "instruction": (
            "빠른 시작은 나에게 맞는 공고 찾기예요. "
            "find_matching_postings를 한 번만 호출해요. "
            "시트 조건으로 전체 열린 공고를 비교해요. "
            "적합도 7점 스위치가 켜져 있으면 7점 미만은 빼요. "
            "공고를 하나씩 점수 매기지 않아요. "
            "결과는 회사, 직무, 지역, 적합도 순으로 말해요."
        ),
        "inputs": _find_inputs,
    },
    "deadline_postings": {
        "read_tools": ("list_bookmarks", "list_documents", "list_applications"),
        "write_tools": (),
        "instruction": (
            "빠른 시작은 마감 임박 공고 정리예요. "
            "list_bookmarks로 저장한 공고를 보고, 일주일 안에 마감되는 것만 골라요. "
            "list_documents와 list_applications로 서류 없음, 서류 준비됨, 초안 있음을 나눠요. "
            "고른 공고마다 준비할 일을 말해요. 저장하거나 지원하지 않아요."
        ),
        "inputs": _deadline_inputs,
    },
    "applications": {
        "read_tools": ("list_applications",),
        "write_tools": (),
        "instruction": (
            "빠른 시작은 지원 현황 정리예요. "
            "list_applications로 고른 지원의 단계, 지금 상황, 다음에 할 일을 말해요. "
            "지원하거나 상태를 바꾸지 않아요."
        ),
        "inputs": _application_inputs,
    },
    "calendar": {
        "read_tools": ("list_calendar_events", "list_bookmarks", "list_applications"),
        "write_tools": ("create_calendar_event", "update_calendar_event"),
        "instruction": (
            "빠른 시작은 캘린더 관리예요. "
            "list_calendar_events로 이번 주 지원, 면접, 마감, 커피챗을 봐요. "
            "일정을 만들거나 고칠 때는 create_calendar_event 또는 update_calendar_event를 써요. "
            "그 도구는 승인 뒤에만 실행해요. 일정을 지우지 않아요."
        ),
        "inputs": _calendar_inputs,
    },
    "hub_profile": {
        "read_tools": ("get_my_profile", "get_document", "list_documents"),
        "write_tools": ("update_my_profile",),
        "instruction": (
            "빠른 시작은 허브 프로필 다듬기예요. "
            "get_my_profile과 get_document로 지금 프로필과 바탕 서류를 읽어요. "
            "고른 부분만 고쳐요. 헤드라인은 한 줄, 소개는 3~4문장이에요. "
            "초안을 먼저 보여 줘요. update_my_profile은 승인 뒤에만 실행해요."
        ),
        "inputs": _hub_inputs,
    },
    "offer_reply": {
        "read_tools": ("list_offers", "get_offer", "get_my_profile"),
        "write_tools": ("send_offer_message",),
        "instruction": (
            "빠른 시작은 제안 답장 쓰기예요. "
            "get_offer와 get_my_profile로 제안과 프로필을 읽어요. "
            "답장 초안을 말해요. send_offer_message는 승인 뒤에만 실행해요."
        ),
        "inputs": _offer_inputs,
    },
    "coffee_chat": {
        "read_tools": ("get_my_profile", "search_career_context"),
        "write_tools": ("create_post",),
        "instruction": (
            "빠른 시작은 커피챗 제안 쓰기예요. "
            "get_my_profile과 search_career_context로 내 경력을 읽어요. "
            "상대에게 보낼 제안 초안을 말해요. "
            "글을 올릴 때는 create_post를 쓰고, 승인 뒤에만 실행해요."
        ),
        "inputs": _coffee_inputs,
    },
    "career_post": {
        "read_tools": ("get_my_profile", "list_documents", "list_applications", "search_career_context"),
        "write_tools": ("create_post",),
        "instruction": (
            "빠른 시작은 커리어 글 쓰기예요. "
            "고른 주제로 초안을 말해요. 근거는 서류, 지원 현황, 경력 자료에서만 가져와요. "
            "글을 올릴 때는 create_post를 쓰고, 승인 뒤에만 실행해요."
        ),
        "inputs": _post_inputs,
    },
}


def quick_start_seed(intent, text, context) -> dict | None:
    spec = _SPECS.get(intent)
    if spec is None:
        return None
    body = text or ""
    bag = context if isinstance(context, dict) else {}
    return {
        "intent": intent,
        "read_tools": spec["read_tools"],
        "write_tools": spec["write_tools"],
        "instruction": spec["instruction"],
        "inputs": spec["inputs"](body, bag),
    }
