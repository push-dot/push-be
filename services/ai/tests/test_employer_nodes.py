from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.domain.employer_baseline import baseline_lines, baseline_stats
from app.harness.employer import nodes
from app.harness.employer.schemas import (
    CompanyProfile,
    Fact,
    Flag,
    InterviewKit,
    InterviewQuestion,
    PostingDraft,
    PostingReview,
    ReviewReport,
    RoleSpec,
)


class Script:
    """Fake generate: returns queued outputs in order and records prompts."""

    def __init__(self, *outputs):
        self.outputs = list(outputs)
        self.calls: list[tuple[type, str, str]] = []

    async def __call__(self, schema, system, user):
        self.calls.append((schema, system, user))
        out = self.outputs.pop(0)
        assert isinstance(out, schema)
        return out


def _draft(**kw) -> PostingDraft:
    base = {
        "title": "결제 승인 백엔드 엔지니어 (Kotlin)",
        "description": ["하루 2,000만 건 결제 승인 API를 설계해요"],
        "requirements": ["Kotlin 또는 Java 서버 개발 4년 이상"],
        "preferred": ["Kafka 운영 경험"],
        "work_style": "주 3일 출근",
    }
    return PostingDraft(**{**base, **kw})


def test_profile_cache_lasts_thirty_days():
    now = datetime(2026, 10, 30, tzinfo=UTC)
    assert nodes.profile_is_fresh(now - timedelta(days=29), now)
    assert not nodes.profile_is_fresh(now - timedelta(days=31), now)
    assert not nodes.profile_is_fresh(None, now)


async def test_research_drops_facts_without_a_source():
    gen = Script(
        CompanyProfile(
            name="모아페이",
            facts=[
                Fact(text="월 거래액 1조", sourceUrl="https://news.example/1"),
                Fact(text="출처 없는 소문"),
            ],
        )
    )
    profile = await nodes.research_company(gen, "모아페이", "검색 결과 본문")
    assert [f.text for f in profile.facts] == ["월 거래액 1조"]
    assert "공정 채용 기준" not in gen.calls[0][1]


async def test_draft_uses_reference_structure_and_previous():
    gen = Script(_draft())
    await nodes.draft_posting(
        gen,
        CompanyProfile(name="모아페이"),
        RoleSpec(need="결제 승인"),
        reference="필수 4개 · 우대 3개 · 1-3년",
        previous=_draft(),
        request="연차를 4-6년으로",
    )
    user = gen.calls[0][2]
    assert "문장은 쓰지 않는다" in user and "담당자 요청" in user
    assert "공정 채용 기준" in gen.calls[0][1]


def test_copied_sentences_detects_near_copies():
    ref = "대용량 트래픽을 처리하는 결제 시스템을 함께 만들어 갈 분을 찾습니다."
    draft = (
        "대용량 트래픽을 처리하는 결제 시스템을 함께 만들어 갈 분을 찾아요.\n"
        "정산 배치를 스트림으로 바꿔요."
    )
    assert nodes.copied_sentences(draft, ref) == [
        "대용량 트래픽을 처리하는 결제 시스템을 함께 만들어 갈 분을 찾아요."
    ]
    assert nodes.copied_sentences(draft, None) == []


async def test_review_rewrites_banned_terms_and_asks_salary():
    dirty = _draft(requirements=["만 35세 이하", "Kotlin 서버 개발 4년 이상"])
    clean = _draft()
    gen = Script(PostingReview(changed=True, notes=["나이 조건을 뺐어요"], draft=clean))
    review = await nodes.review_posting(gen, dirty)
    assert review.changed and review.ask_salary
    assert "세 이하" in gen.calls[0][2]
    assert "세 이하" not in review.draft.text()


async def test_review_strips_banned_lines_the_model_kept():
    dirty = _draft(requirements=["남성 우대", "Kotlin 서버 개발 4년 이상"])
    gen = Script(PostingReview(draft=dirty), PostingReview(draft=dirty))
    review = await nodes.review_posting(gen, dirty)
    assert review.draft.requirements == ["Kotlin 서버 개발 4년 이상"]
    assert any("뺐어요" in n for n in review.notes)


DOC = (
    "결제 승인 API를 다시 설계해 p99 지연을 420ms에서 180ms로 줄였어요. "
    "Kafka 기반 정산 파이프라인 고도화"
)


async def test_verify_drops_verdicts_and_foreign_quotes_and_caps():
    flags = [
        Flag(
            title="역할 범위",
            level="CHECK",
            reason="무엇을 직접 바꿨는지 설명이 짧아요.",
            quote="p99 지연을 420ms에서 180ms로",
        ),
        Flag(title="총평", level="CHECK", reason="이 지원자는 불합격이 맞아요."),
        Flag(
            title="인용", level="SUPPORTED", reason="기간과 규모가 맞아요.", quote="남의 서류 문장"
        ),
    ] + [Flag(title=f"추가 {i}", level="UNKNOWN", reason="정보가 없어요.") for i in range(6)]
    gen = Script(ReviewReport(summary="", flags=flags))
    out = await nodes.verify_claims(gen, DOC, "공고", "[]", {"used": False})
    titles = [f.title for f in out]
    assert "총평" not in titles
    assert len(out) == nodes.MAX_FLAGS
    assert out[0].quote == "p99 지연을 420ms에서 180ms로"
    assert next(f for f in out if f.title == "인용").quote is None


async def test_verify_without_baseline_drops_peer_comparisons():
    flags = [Flag(title="깊이", level="CHECK", reason="같은 연차 서류보다 설명이 얕아요.")]
    out = await nodes.verify_claims(
        Script(ReviewReport(summary="", flags=flags)), DOC, "공고", "[]", {"used": False}
    )
    assert out == []
    out = await nodes.verify_claims(
        Script(ReviewReport(summary="", flags=flags)),
        DOC,
        "공고",
        "[]",
        {
            "used": True,
            "category": "백엔드",
            "sample_count": 40,
            "metric_ratio": 0.8,
            "concrete_ratio": 0.7,
            "link_ratio": 0.6,
        },
    )
    assert [f.title for f in out] == ["깊이"]


def test_report_summary_counts_checks():
    flags = [
        Flag(title="a", level="CHECK", reason="r"),
        Flag(title="b", level="SUPPORTED", reason="r"),
    ]
    assert nodes.report_summary(flags) == "다만 아래 1곳은 면접에서 직접 확인해 보는 게 좋아요."
    assert "찾지 못했어요" in nodes.report_summary([])


async def test_interview_rewrites_then_drops_banned_questions():
    bad = InterviewQuestion(text="결혼하셨나요?", verify="x")
    good = InterviewQuestion(
        text="p99를 180ms로 줄일 때 직접 바꾼 코드를 설명해 주세요.", verify="본인 기여"
    )
    gen = Script(InterviewKit(questions=[bad, good]), InterviewKit(questions=[bad, good]))
    kit = await nodes.design_interview(
        gen, [Flag(title="역할", level="CHECK", reason="r")], "공고", DOC
    )
    assert [q.text for q in kit.questions] == [good.text]
    assert "금지 질문" in gen.calls[1][2]


def _sample(i, has_metric=True):
    return {
        "job_category": "백엔드",
        "tenure_years": 5,
        "score_band": 80,
        "features": {
            "has_metric": has_metric,
            "tech_depth": "concrete",
            "links_experience": i % 2 == 0,
        },
        "sentence_templates": ["{대상}의 {문제}를 해결했다"],
    }


def test_baseline_needs_thirty_samples_and_never_leaks_templates():
    few = [_sample(i) for i in range(29)]
    assert baseline_stats(few, "백엔드", 5, 82, "plus1", "up1")["used"] is False
    many = [_sample(i, has_metric=i < 24) for i in range(30)]
    stats = baseline_stats(many, "백엔드", 5, 82, "plus1", "up1")
    assert stats["used"] and stats["sample_count"] == 30 and stats["metric_ratio"] == 0.8
    lines = "\n".join(baseline_lines(stats))
    assert "{대상}" not in lines and "80%" in lines


@pytest.mark.parametrize("window", ["same", "plus1", "plus2", "all"])
def test_baseline_respects_tenure_window(window):
    samples = [_sample(i) | {"tenure_years": 8} for i in range(30)]
    stats = baseline_stats(samples, "백엔드", 5, 82, window, "all")
    assert stats["used"] is (window == "all")


class _FakeStructured:
    def __init__(self, payload):
        self.payload = payload
        self.seen = None

    def bind_tools(self, tools, tool_choice=None):
        assert tool_choice == "auto"
        outer = self

        class _Run:
            async def ainvoke(self, messages):
                from langchain_core.messages import AIMessage

                outer.seen = messages
                return AIMessage(content="", tool_calls=[
                    {"name": tools[0].__name__, "id": "call-1", "args": outer.payload}])

        return _Run()


async def test_structured_generate_validates_dict_output():
    from app.harness.employer.llm import structured_generate

    model = _FakeStructured(
        {"name": "모아페이", "facts": [{"text": "a", "sourceUrl": "https://x"}]}
    )
    profile = await structured_generate(model)(CompanyProfile, "sys", "user")
    assert isinstance(profile, CompanyProfile) and profile.facts[0].source_url == "https://x"
    assert model.seen[0].content.startswith("sys\n\n") and model.seen[1].content == "user"
