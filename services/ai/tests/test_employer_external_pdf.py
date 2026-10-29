from __future__ import annotations

from pathlib import Path

from app.harness.employer.flows import Matches, build_flows
from app.harness.employer.schemas import Flag, Match, ReviewReport

SRC = Path(__file__).resolve().parents[1] / "src" / "app"
MIGRATIONS = Path(__file__).resolve().parents[3] / "db" / "migrations"


class FakeStore:
    def __init__(self):
        self.saved = []

    async def attachment(self, attachment_id, conversation_id, company_id):
        if (attachment_id, conversation_id, company_id) != ("att-1", "conv-1", "co-1"):
            return None
        return {
            "file_name": "외부지원자_이력서.pdf",
            "mime_type": "application/pdf",
            "content": b"%PDF",
        }

    async def company_posting(self, posting_id, company_id):
        if (posting_id, company_id) != ("post-1", "co-1"):
            return None
        return {
            "title": "결제 승인 백엔드",
            "job_category": "백엔드",
            "career_min": 4,
            "career_max": 6,
            "description": "승인 API",
            "requirements": ["Kotlin"],
            "preferred": [],
        }

    async def save_review(
        self, company_id, conversation_id, application_id, report, attachment_name=None
    ):
        self.saved.append((company_id, conversation_id, application_id, attachment_name))
        return "rev-1"


async def _generate(schema, system, user):
    if schema is Matches:
        return Matches(matches=[Match(requirement="Kotlin", status="MET", evidence="Kotlin 4년")])
    if schema is ReviewReport:
        return ReviewReport(
            summary="", flags=[Flag(title="역할", level="CHECK", reason="설명이 짧아요.")]
        )
    raise AssertionError(schema)


def _review(plan: str, store: FakeStore):
    _state, flows = build_flows(
        db=None,
        generate_for=lambda _s: _generate,
        research_text=None,
        plan_of=lambda _s: plan,
        store=store,
        read_pdf=lambda _b: "Kotlin 4년 결제 승인 API 운영",
    )
    return flows["review"]


STATE = {
    "user_id": "u1",
    "conversation_id": "conv-1",
    "company_id": "co-1",
    "job_id": "j1",
    "messages": [],
    "flow": {"name": "review", "step": "start", "attachment_id": "att-1", "posting_id": "post-1"},
}


async def test_ultra_reviews_an_attached_pdf_and_keeps_it_in_the_conversation():
    store = FakeStore()
    out = await _review("ULTRA", store).ainvoke(dict(STATE))
    assert out["flow"]["status"] == "done"
    assert store.saved == [("co-1", "conv-1", None, "외부지원자_이력서.pdf")]


async def test_pdf_review_is_ultra_only():
    for plan in ("", "BASIC", "PRO"):
        store = FakeStore()
        out = await _review(plan, store).ainvoke(dict(STATE))
        assert out["flow"]["status"] == "cancelled" and "Ultra" in out["flow"]["reply"]
        assert store.saved == []


async def test_pdf_from_another_conversation_is_not_readable():
    store = FakeStore()
    out = await _review("ULTRA", store).ainvoke({**STATE, "conversation_id": "conv-2"})
    assert out["flow"]["status"] == "cancelled" and store.saved == []


async def test_posting_from_another_company_is_rejected():
    store = FakeStore()
    out = await _review("ULTRA", store).ainvoke({**STATE, "company_id": "co-2"})
    assert out["flow"]["status"] == "cancelled" and store.saved == []


def test_external_pdfs_never_reach_rag_or_reference_samples():
    for folder in ("rag", "workers", "ingest"):
        for path in (SRC / folder).rglob("*.py"):
            assert "conversation_attachments" not in path.read_text(encoding="utf-8"), path
    job = (SRC / "domain" / "services" / "job.py").read_text(encoding="utf-8")
    assert "conversation_attachments" not in job


def test_attachments_and_reviews_go_away_with_the_conversation():
    m19 = (MIGRATIONS / "0019_fo_web_employer.sql").read_text(encoding="utf-8")
    assert "conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE" in m19
    m31 = (MIGRATIONS / "0031_employer_harness.sql").read_text(encoding="utf-8")
    assert m31.count("REFERENCES conversations(id) ON DELETE CASCADE") == 2
