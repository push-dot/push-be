from __future__ import annotations

from uuid import uuid4

from langgraph.checkpoint.memory import MemorySaver

from app.harness.graph import astream_harness, build_harness_graph
from app.harness.personal.reference import reference_lines
from app.harness.registry import REGISTRY
from app.harness.tools import HarnessSpec
from tests.fakes import ScriptedChat

_TEMPLATE = "{대상}의 {문제}를 {기술}로 해결해 {지표}를 {수치}% 개선했다"
_NEAR = "{기간}에 {조치}했습니다"
_RAW = "시크릿 원문 문장"


def _row(tenure, band, template, category="dev"):
    return {
        "job_category": category,
        "tenure_years": tenure,
        "score_band": band,
        "features": {
            "has_metric": True,
            "tech_depth": "concrete",
            "links_experience": True,
        },
        "sentence_templates": [template],
    }


def _pool():
    rows = (
        [_row(5, 80, _TEMPLATE) for _ in range(30)]
        + [_row(6, 80, _NEAR) for _ in range(30)]
        + [_row(5, 90, _NEAR) for _ in range(30)]
        + [_row(8, 80, "OUT_OF_TENURE") for _ in range(30)]
        + [_row(5, 50, "OUT_OF_SCORE") for _ in range(30)]
    )
    rows[0]["sentence_templates"] = [_RAW, _TEMPLATE]
    return rows


class _RefDB:
    def __init__(self, ctx, samples, fit):
        self.ctx = ctx
        self.samples = samples
        self.fit = fit
        self.application_id = uuid4()
        self.sample_sql = ""

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        if "profiles" in sql:
            return self.ctx
        return None

    async def fetchval(self, sql, *args):
        if "conversations" in sql:
            return self.application_id
        if "gap_analyses" in sql:
            return self.fit
        return None

    async def fetch(self, sql, *args):
        if "reference_samples" in sql:
            self.sample_sql = sql
            return self.samples
        return []


def _ctx(consent, plan="FREE", category="dev", tenure=5):
    return {
        "plan": plan,
        "job_category": category,
        "tenure_years": tenure,
        "reference_data": consent,
    }


def test_personal_prompt_forbids_invented_experience():
    prompt = REGISTRY["personal"].prompt
    assert "지어내지 않아요" in prompt
    assert "서류, 링크, 첨부" in prompt
    assert "1차 검토 시간은 4~8초" in prompt
    assert "근거 있는 사실만" in prompt
    assert "항상 묻기" in prompt
    assert "바로 실행" in prompt
    assert "start_document" in prompt
    assert "마이 › 설정에서 할 수 있어요" in prompt
    lowered = prompt.lower()
    assert "deepseek" not in lowered
    assert "claude" not in lowered
    assert "1차 검토 시간은 4~8초" not in REGISTRY["employer"].prompt


async def test_reference_lines_stay_inside_the_free_window():
    user_id = uuid4()
    db = _RefDB(_ctx(True, "FREE"), _pool(), 82)
    lines = await reference_lines(db, user_id, uuid4())
    text = "\n".join(lines)
    assert "dev 5년 80점대 30건" in text
    assert _TEMPLATE in text
    assert "dev 6년" not in text
    assert "90점대" not in text
    assert "8년" not in text
    assert "50점대" not in text
    assert "OUT_OF_TENURE" not in text
    assert "OUT_OF_SCORE" not in text
    assert _NEAR not in text
    assert _RAW not in text
    assert "sentence_templates" in db.sample_sql


async def test_reference_lines_use_the_pro_window():
    user_id = uuid4()
    db = _RefDB(_ctx(True, "PRO"), _pool(), 82)
    text = "\n".join(await reference_lines(db, user_id, uuid4()))
    assert "dev 5년 80점대 30건" in text
    assert "dev 6년 80점대 30건" in text
    assert "dev 5년 90점대 30건" in text
    assert _NEAR in text
    assert "8년" not in text
    assert "50점대" not in text


async def test_reference_lines_need_consent():
    user_id = uuid4()
    samples = _pool()
    for consent in (False, None):
        lines = await reference_lines(_RefDB(_ctx(consent), samples, 82), user_id, uuid4())
        assert lines == []


async def test_reference_lines_skip_a_bucket_under_30():
    user_id = uuid4()
    thin = [_row(5, 80, _TEMPLATE) for _ in range(29)]
    db = _RefDB(_ctx(True), thin, 82)
    assert await reference_lines(db, user_id, uuid4()) == []


async def test_reference_lines_need_a_score_for_a_bounded_plan():
    user_id = uuid4()
    db = _RefDB(_ctx(True), _pool(), None)
    assert await reference_lines(db, user_id, uuid4()) == []


async def test_personal_agent_adds_reference_lines_to_the_system_message():
    user_id = uuid4()
    db = _RefDB(_ctx(True, "FREE"), _pool(), 82)
    chat = ScriptedChat([{"content": "확인했어요"}])
    graph = build_harness_graph(
        HarnessSpec(id="personal", prompt="help", tools=[]),
        MemorySaver(),
        model=chat,
        db=db,
        core=object(),
    )
    async for _event in astream_harness(graph, {
        "messages": [{"role": "user", "content": "이력서 볼게"}],
        "user_id": str(user_id),
        "conversation_id": str(uuid4()),
        "job_id": str(uuid4()),
        "access_mode": "AUTO",
    }, {"configurable": {"thread_id": "conv-1"}}):
        pass
    content = chat.seen[0][0].content
    assert content.startswith("help")
    assert "dev 5년 80점대 30건" in content
    assert _TEMPLATE in content
    assert _RAW not in content
