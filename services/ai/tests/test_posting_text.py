from __future__ import annotations

from app.domain.posting_text import posting_terms

# Shaped like a jobboard page after ingest/web_page.py flattened its whitespace.
_BOARD = (
    "잡보드 채용 주요업무 자격요건 우대사항 주요업무 냉장 물류센터 입출고 운영 및 재고 관리 "
    "자격요건 엑셀 피벗과 함수를 능숙하게 다루실 수 있으신 분 "
    "창고 관리 시스템 운영 경험이 있으신 분 재고 실사 진행 경험 "
    "교대 근무가 가능하신 분 "
    "우대사항 콜드체인 품질 관리 경험이 있으신 분 "
    "SQL로 재고 데이터를 조회해 보신 분 혜택 및 복지 통근 버스 운영"
)


def test_flattened_korean_page_splits_on_sentence_ends():
    terms = posting_terms(_BOARD)
    assert terms["required"] == [
        "엑셀 피벗과 함수를 능숙하게 다루실 수 있으신 분",
        "창고 관리 시스템 운영 경험이 있으신 분",
        "재고 실사 진행 경험",
        "교대 근무가 가능하신 분",
    ]
    assert terms["preferred"] == [
        "콜드체인 품질 관리 경험이 있으신 분",
        "SQL로 재고 데이터를 조회해 보신 분",
    ]


def test_years_and_counts_stay_with_their_experience_item():
    text = (
        "자격요건 React 개발 경험 3년 이상인 분 백엔드 개발 경험 5년 이상 "
        "우대사항 스타트업 경험 다수 근무조건 서울"
    )
    assert posting_terms(text) == {
        "required": ["React 개발 경험 3년 이상인 분", "백엔드 개발 경험 5년 이상"],
        "preferred": ["스타트업 경험 다수"],
    }
    marked = posting_terms("자격요건 배포 자동화 경험 (필수)")["required"]
    assert marked == ["배포 자동화 경험 (필수)"]


def test_a_heading_word_inside_prose_opens_no_section():
    assert posting_terms("자격요건을 충족하는 분을 찾습니다 필수 역량 Java 우대사항 없음") == {
        "required": ["Java"],
        "preferred": [],
    }
    english = "We list requirements below. Requirements: Python. Our benefits: none"
    assert posting_terms(english) == {
        "required": ["Python"],
        "preferred": [],
    }


def test_english_headings_and_bullets():
    text = (
        "Requirements - 3+ years Python - Django • AWS "
        "Preferred Qualifications Kafka. Go. Benefits free lunch"
    )
    assert posting_terms(text) == {
        "required": ["3+ years Python", "Django", "AWS"],
        "preferred": ["Kafka", "Go"],
    }


def test_section_without_delimiter_is_one_term_and_capped():
    assert posting_terms("자격 요건: Kotlin, Spring") == {
        "required": ["Kotlin, Spring"],
        "preferred": [],
    }
    long = posting_terms("자격요건 " + "가" * 500)
    assert len(long["required"][0]) == 200
    many = posting_terms("필수 요건 " + " ".join(f"- 항목{n}" for n in range(30)))
    assert len(many["required"]) == 15


def test_no_heading_reads_nothing():
    assert posting_terms("공고 본문") == {"required": [], "preferred": []}
    assert posting_terms("") == {"required": [], "preferred": []}
