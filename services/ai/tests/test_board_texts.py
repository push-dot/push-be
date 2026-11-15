from app.harness.approval import _ASKS
from app.harness.personal.resume.graph import _GATES
from app.harness.personal.resume.progress import (
    boost_line,
    craft_text,
    fit_band,
    quality_text,
)
from app.harness.personal.tools import _document_event


def test_page_permission_title_is_short_and_the_sentence_is_the_summary():
    posting = {"owner": "모아페이", "host": "careers.moapay.co.kr"}
    title, summary = (form.format(**posting) for form in _ASKS["posting"])
    assert title == "채용 페이지 열기"
    assert summary == "모아페이 채용 페이지(careers.moapay.co.kr)를 열어도 될까요?"
    for kind in ("company", "other"):
        short, sentence = (form.format(**posting) for form in _ASKS[kind])
        assert len(short) <= 10 and sentence.endswith("열어도 될까요?")


def test_edit_approval_title_is_short_and_the_sentence_is_the_summary():
    event = _document_event("job", "call", "doc", [
        {"sign": "-", "text": "a\nb"}, {"sign": "+", "text": "a\nb\nc"}])
    assert event["title"] == "수정 적용"
    assert event["summary"] == "3줄을 고쳤어요. 적용하면 문서에 바로 반영돼요."


def test_fit_band_is_the_tail_of_the_sentence():
    assert fit_band(8.4) == "높고, 잘 맞아요."
    assert fit_band(6.9) == "보통이고, 고칠 여지가 있어요."
    assert fit_band(4.0) == "낮고, 고칠 곳이 많아요."


def test_boost_round_names_the_target_and_what_changed():
    before = {"keyword": 5.0, "domain": 7.0}
    after = {"keyword": 7.5, "domain": 7.1}
    line = boost_line(1, 6.9, 7.5, before, after, added=["정산 배치", "장애 대응"])
    assert line["target"] == "키워드"
    assert line["resultLine"] == "6.9 → 7.5 · 정산 배치, 장애 대응을 경력 문장에 넣었어요"
    career = boost_line(
        2, 7.5, 8.0, {"experienceLink": 6.0}, {"experienceLink": 8.0}, company="모아페이")
    assert career["target"] == "경력 · 모아페이"
    assert career["resultLine"] == "7.5 → 8.0 · 성과를 숫자로 보여 줬어요"
    domain = boost_line(3, 8.0, 8.3, {"domain": 5.0}, {"domain": 7.0})
    assert domain["target"] == "도메인"
    assert domain["resultLine"] == "8.0 → 8.3 · 공고 도메인에 맞춰 고쳤어요"
    assert boost_line(4, 8.3, 8.4)["resultLine"] == "8.3 → 8.4"


def test_flow_texts_are_a_sentence_then_marked_lines():
    assert quality_text(["오타: 트랜젝션 → 트랜잭션", "날짜: 2022.04 → 2022.03"]) == (
        "품질 검사를 마치고 추천 수정까지 반영했어요.\n"
        "• 오타: 트랜젝션 → 트랜잭션\n• 날짜: 2022.04 → 2022.03\n")
    assert craft_text(1, ["Kafka를 기술 스택 맨 앞으로 옮겼어요"]) == (
        "첫 번째 초안(v1)을 만들었어요.\n• Kafka를 기술 스택 맨 앞으로 옮겼어요")
    assert craft_text(2, []) is None


def test_design_gate_title_follows_the_board():
    assert _GATES["review"]["title"] == "검증을 마쳤어요. 디자인을 골라 주세요."
