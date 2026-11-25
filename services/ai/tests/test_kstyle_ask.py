from __future__ import annotations

from app.harness.kstyle.ask import ask_once, ask_options, ask_title, needs_ask
from app.harness.kstyle.ledger import empty_notes


def test_only_user_sourced_cut_or_lighten_items_and_at_most_three():
    items = [
        {"source": "harness", "verdict": "cut", "what": "부록", "why": "길어요"},
        {"source": "user", "verdict": "keep", "what": "프로젝트 A", "why": ""},
        *({"source": "user", "verdict": verdict, "what": f"항목 {index}", "why": "공고와 멀어요"}
          for index, verdict in enumerate(["cut", "lighten", "cut", "lighten"], 1)),
    ]
    picked = needs_ask(items)
    assert [item["what"] for item in picked] == ["항목 1", "항목 2", "항목 3"]
    assert ask_title(picked).splitlines() == [
        "이렇게 정했어요. 괜찮으면 '그대로', 다시 넣을 게 있으면 알려 주세요.",
        "1. 항목 1 — 공고와 멀어요", "2. 항목 2 — 공고와 멀어요", "3. 항목 3 — 공고와 멀어요"]
    assert [option["id"] for option in ask_options()] == ["keep_plan", "restore"]


def test_asks_once():
    notes = empty_notes()
    assert ask_once(notes)
    notes["ask"] = {"question": "q", "options": []}
    assert not ask_once(notes)
