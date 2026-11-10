"""change_applicant_stage approval cards name the person. Other tools do not."""

from __future__ import annotations

import os
from uuid import uuid4

import pytest

from app.harness.approval import create_tool_approval, tool_action_event
from app.harness.registry import REGISTRY

P = "11111111-1111-4111-8111-111111111111"
A = "22222222-2222-4222-8222-222222222222"
CONV = "33333333-3333-4333-8333-333333333333"


def _tool():
    name = "change_applicant_stage"
    return next(tool for tool in REGISTRY["employer"].tools if tool.name == name)


def test_other_tool_events_have_no_rows():
    event = tool_action_event("a", "이 공고에 지원해요", "apply_to_posting", {"postingId": P})
    assert "rows" not in event
    assert "color" not in event
    assert event["args"] == {"postingId": P}


class _Db:
    def __init__(self, row):
        self.row = row
        self.stage_sql = ""
        self.stage_args = ()
        self.options = ""

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        if "FROM approvals" in sql:
            return None
        self.stage_sql = sql
        self.stage_args = args
        return self.row

    async def execute(self, sql, *args):
        self.options = args[6]
        return "INSERT 1"


async def test_stage_change_approval_names_the_applicant():
    db = _Db({"display_name": "김태윤", "stage": "APPLIED"})
    tool = _tool()
    args = tool.args_model.model_validate({
        "posting_id": P, "application_id": A, "stage": "INTERVIEW",
    })
    event, created = await create_tool_approval(
        db, user_id=uuid4(), conversation_id=CONV, job_id=uuid4(),
        tool=tool, args=args, tool_call_id="call-1",
    )
    assert created is True
    assert event["rows"] == [{
        "name": "김태윤", "initial": "김", "from": "APPLIED", "to": "INTERVIEW",
    }]
    assert "color" not in event["rows"][0]
    assert "colour" not in event["rows"][0]
    assert event["args"]["stage"] == "INTERVIEW"
    assert "conversations" in db.stage_sql
    assert "company_id" in db.stage_sql
    assert db.stage_args[0] == args.application_id
    assert db.stage_args[1] == args.posting_id
    assert db.stage_args[2] == CONV
    assert "rows" not in db.options


async def test_stage_change_without_a_company_row_adds_no_rows():
    db = _Db(None)
    tool = _tool()
    args = tool.args_model.model_validate({
        "posting_id": P, "application_id": A, "stage": "SCREENING",
    })
    event, _created = await create_tool_approval(
        db, user_id=uuid4(), conversation_id=CONV, job_id=uuid4(),
        tool=tool, args=args, tool_call_id="call-2",
    )
    assert "rows" not in event


@pytest.mark.skipif(not os.environ.get("BILLING_PG_URL"), reason="BILLING_PG_URL is not set")
async def test_stage_rows_are_limited_to_the_conversation_company():
    asyncpg = pytest.importorskip("asyncpg")
    from app.db import DB, _init_conn

    pool = await asyncpg.create_pool(
        os.environ["BILLING_PG_URL"], init=_init_conn, min_size=0, max_size=1)
    db = DB(pool)
    try:
        employer = uuid4()
        applicant = uuid4()
        company_a = uuid4()
        company_b = uuid4()
        posting_a = uuid4()
        posting_b = uuid4()
        job_a = uuid4()
        job_b = uuid4()
        app_a = uuid4()
        app_b = uuid4()
        conv_a = uuid4()
        conv_b = uuid4()
        conv_personal = uuid4()
        await db.q().execute(
            "INSERT INTO users (id, provider, provider_subject, display_name) "
            "VALUES ($1, 'test', $2, '담당')",
            employer, str(employer))
        await db.q().execute(
            "INSERT INTO users (id, provider, provider_subject, display_name) "
            "VALUES ($1, 'test', $2, '김태윤')",
            applicant, str(applicant))
        await db.q().execute(
            "INSERT INTO companies (id, name) VALUES ($1, 'a'), ($2, 'b')", company_a, company_b)
        await db.q().execute(
            "INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'ADMIN')",
            company_a, employer)
        for posting, company in ((posting_a, company_a), (posting_b, company_b)):
            await db.q().execute(
                "INSERT INTO job_postings (id, company, title, job_category, career_min, location, "
                "employment_type, description, company_id) "
                "VALUES ($1, 'co', 'role', 'dev', 0, 'Seoul', 'full_time', 'd', $2)",
                posting, company)
        for job, posting in ((job_a, posting_a), (job_b, posting_b)):
            await db.q().execute(
                "INSERT INTO jobs (id, user_id, company, title, source_kind, source_text, "
                "source_posting_id) VALUES ($1, $2, 'co', 'role', 'TEXT', 's', $3)",
                job, applicant, posting)
        for application, job in ((app_a, job_a), (app_b, job_b)):
            await db.q().execute(
                "INSERT INTO applications (id, user_id, job_id, company, title, stage) "
                "VALUES ($1, $2, $3, 'co', 'role', 'APPLIED')",
                application, applicant, job)
        await db.q().execute(
            "INSERT INTO conversations (id, user_id, title, company_id) VALUES ($1, $2, 'a', $3)",
            conv_a, employer, company_a)
        await db.q().execute(
            "INSERT INTO conversations (id, user_id, title, company_id) VALUES ($1, $2, 'b', $3)",
            conv_b, employer, company_b)
        await db.q().execute(
            "INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, 'personal')",
            conv_personal, employer)
        tool = _tool()

        async def rows(conversation, posting, application, call):
            args = tool.args_model.model_validate({
                "posting_id": str(posting),
                "application_id": str(application),
                "stage": "SCREENING",
            })
            event, _created = await create_tool_approval(
                db, user_id=employer, conversation_id=conversation, job_id=uuid4(),
                tool=tool, args=args, tool_call_id=call,
            )
            return event.get("rows")

        assert await rows(conv_a, posting_a, app_a, "own") == [{
            "name": "김태윤", "initial": "김", "from": "APPLIED", "to": "SCREENING",
        }]
        assert await rows(conv_a, posting_b, app_b, "other-posting") is None
        assert await rows(conv_b, posting_a, app_a, "other-company") is None
        assert await rows(conv_personal, posting_a, app_a, "personal") is None
    finally:
        await pool.close()
