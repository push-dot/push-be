from __future__ import annotations

from app.domain.services.conversation import _live_event
from push_agent.domain.fair_hiring import DECISION_DISCLAIMER
from push_agent.harness.flows import kit_text, review_plan
from push_agent.harness.schemas import InterviewKit, InterviewQuestion

REPORT = {
    "flags": [
        {"title": "Kafka 운영 범위", "level": "CHECK",
         "reason": "혼자 운영했는지 서류만으로 모호해요", "quote": "Kafka 클러스터를 운영"},
        {"title": "결제 API", "level": "SUPPORTED", "reason": "성과 수치가 있어요", "quote": None},
    ],
    "matches": [
        {"requirement": "Java 3년 이상", "status": "MET", "evidence": "Java 4년"},
        {"requirement": "MSA 경험", "status": "MISSING", "evidence": None},
    ],
}


def test_the_review_reaches_the_client_as_a_plan_card_with_its_disclaimer():
    event = review_plan(REPORT, None)
    kind, payload = _live_event(event, "job-1")
    assert kind == "plan" and payload["a2ui"]
    assert payload["meta"] == DECISION_DISCLAIMER
    rows = [(r["tag"], r["label"]) for r in payload["rows"]]
    assert rows == [("확인", "Kafka 운영 범위"), ("근거 있음", "결제 API"),
                    ("통과", "Java 3년 이상"), ("보완", "MSA 경험")]
    assert "Kafka 클러스터를 운영" in payload["rows"][0]["note"]


def test_an_external_pdf_review_names_the_file():
    assert review_plan(REPORT, "홍길동.pdf")["title"] == "서류 검토 · 홍길동.pdf"


def test_the_kit_is_numbered_text_the_web_reads_as_questions():
    kit = InterviewKit(questions=[
        InterviewQuestion(text="Kafka 장애를 어떻게 다뤘나요?", verify="혼자 운영했는지",
                          good_signals=["재현 절차"], caution_signals=["팀 성과만 말함"]),
        InterviewQuestion(text="결제 API 지연을 줄인 방법은?", verify="본인 기여"),
    ])
    assert kit_text(kit) == (
        "1. Kafka 장애를 어떻게 다뤘나요?\n확인할 점 · 혼자 운영했는지\n"
        "좋은 신호 · 재현 절차\n주의 신호 · 팀 성과만 말함\n\n"
        "2. 결제 API 지연을 줄인 방법은?\n확인할 점 · 본인 기여"
    )


def test_a_long_document_says_it_was_cut_and_a_short_one_says_nothing():
    from push_agent.harness.flows import _cut_note
    from push_agent.harness.nodes import DOC_LIMIT

    assert _cut_note("가" * DOC_LIMIT) == []
    [note] = _cut_note("가" * (DOC_LIMIT + 1))
    assert "20,000자" in note


def test_an_empty_review_still_reaches_the_client_with_its_disclaimer():
    kind, payload = _live_event(review_plan({"flags": [], "matches": []}, None), "job-1")
    assert kind == "plan" and payload["a2ui"]
    assert payload["meta"] == DECISION_DISCLAIMER
    assert [r["label"] for r in payload["rows"]] == ["서류에서 따로 확인할 곳을 찾지 못했어요"]
