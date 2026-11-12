"""read_page on the real runtime, the real fetch loop and a migrated Postgres.

The interrogation's four page-read probes, as tests: a page the user gave is read without a
card, a quick start or a grant does not ask, a grant for one host never reads another through a
redirect, and a short link the user gave is followed to the page it names. The card's three
answers, its 10 minute life, and a retry that resumes the same interrupt are proven here too. CI
test-db sets BILLING_PG_URL; elsewhere these tests skip.
"""

import json
import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from langchain_core.messages import ToolMessage

from app.harness.registry import REGISTRY
from app.harness.runtime import HarnessRuntime, _pending
from app.infrastructure.store_turns import TurnStore
from app.queue.admin import AdminJobs
from tests.harness_fakes import ScriptedLC, managed_ai, run, service
from tests.test_page_read import fake_web

asyncpg = pytest.importorskip("asyncpg")
URL = os.environ.get("BILLING_PG_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="BILLING_PG_URL is not set")

POSTING = "https://careers.moapay.example/jobs/1"


@pytest.fixture
async def db():
    from app.db import DB, _init_conn

    pool = await asyncpg.create_pool(URL, init=_init_conn, min_size=0, max_size=2)
    try:
        yield DB(pool)
    finally:
        await pool.close()


@pytest.fixture
async def people(db):
    made = SimpleNamespace(users=[], companies=[])
    yield made
    q = db.q()
    await q.execute("DELETE FROM users WHERE id = ANY($1::uuid[])", made.users)
    await q.execute("DELETE FROM job_postings WHERE company_id = ANY($1::uuid[])", made.companies)
    await q.execute("DELETE FROM companies WHERE id = ANY($1::uuid[])", made.companies)


async def posting(db, people, company: str, url: str, site: str | None = None):
    """A posting Push has, at `url`, of a company whose own site is `site`."""
    company_id, posting_id = uuid4(), uuid4()
    people.companies.append(company_id)
    q = db.q()
    await q.execute(
        "INSERT INTO companies (id, name, website) VALUES ($1, $2, $3)", company_id, company, site
    )
    await q.execute(
        "INSERT INTO job_postings (id, company_id, company, title, job_category, career_min, "
        "location, employment_type, description, source_url) "
        "VALUES ($1, $2, $3, '백엔드 엔지니어', 'dev', 0, 'Seoul', 'full_time', '공고', $4)",
        posting_id,
        company_id,
        company,
        url,
    )
    return posting_id


async def chat(db, people, bot: str | None = "company", site: str | None = None) -> SimpleNamespace:
    """A thread of a company bot made from the 모아페이 posting at POSTING, of the Push Bot, or
    (bot None) a conversation of the web."""
    user, thread, bot_id = uuid4(), uuid4(), None
    people.users.append(user)
    q = db.q()
    await q.execute(
        "INSERT INTO users (id, provider, provider_subject, display_name) "
        "VALUES ($1, 'test', $2, 'page read')",
        user,
        str(user),
    )
    if bot is not None:
        bot_id = uuid4()
        company = bot == "company"
        await q.execute(
            "INSERT INTO bots (id, user_id, kind, company_name, display_name, posting_id) "
            "VALUES ($1, $2, $3, $4, $5, $6)",
            bot_id,
            user,
            bot,
            "모아페이" if company else "",
            "모아페이" if company else "Push Bot",
            await posting(db, people, "모아페이", POSTING, site) if company else None,
        )
    await q.execute(
        "INSERT INTO conversations (id, user_id, title, bot_id) VALUES ($1, $2, 't', $3)",
        thread,
        user,
        bot_id,
    )
    runtime = HarnessRuntime(service(db), model_cls=ScriptedLC)
    return SimpleNamespace(user=user, thread=thread, bot=bot_id, runtime=runtime)


async def said(db, c, text: str, attachments: list | None = None) -> None:
    """The USER row core stores when it queues a turn."""
    await db.q().execute(
        "INSERT INTO messages (id, user_id, conversation_id, role, text, attachments) "
        "VALUES ($1, $2, $3, 'USER', $4, $5::jsonb)",
        uuid4(),
        c.user,
        c.thread,
        text,
        attachments or [],
    )


async def turn(c, text: str = "", mode: str = "ALWAYS_ASK", **extra) -> list[dict]:
    payload = {
        "text": text,
        "user_id": str(c.user),
        "conversation_id": str(c.thread),
        "job_id": str(uuid4()),
        "access_mode": mode,
        "ai": managed_ai(),
        "context": {},
        **extra,
    }
    return [
        chunk for kind, chunk in await run(c.runtime, payload, str(c.thread)) if kind == "custom"
    ]


def reads(*urls: str) -> None:
    ScriptedLC.replies = [
        *(
            {
                "tool_calls": [
                    {
                        "name": "read_page",
                        "id": f"call-{uuid4()}",
                        "type": "tool_call",
                        "args": {"url": url},
                    }
                ]
            }
            for url in urls
        ),
        {"content": "읽었어요"},
    ]


async def state(c):
    return await c.runtime._graph(REGISTRY["personal"]).aget_state(
        {"configurable": {"thread_id": str(c.thread)}}
    )


async def results(c) -> list[dict]:
    return [
        json.loads(m.content)
        for m in (await state(c)).values["messages"]
        if isinstance(m, ToolMessage)
    ]


def cards(events: list[dict]) -> list[dict]:
    return [event for event in events if event.get("type") == "approval"]


async def test_a_link_pasted_in_a_plain_message_is_read_without_a_card(db, people, monkeypatch):
    fetched = fake_web(monkeypatch, {POSTING: "모아페이 백엔드 엔지니어 공고"})
    c = await chat(db, people)
    await said(db, c, "예전에 본 https://[careers.moapay.example 주소는 깨졌어요")
    text = f"이 공고 요약해 줘 {POSTING}"
    await said(db, c, text)
    reads(POSTING)

    events = await turn(c, text)

    assert cards(events) == []
    assert fetched == [POSTING]
    assert await results(c) == [{"url": POSTING, "text": "모아페이 백엔드 엔지니어 공고"}]
    assert [(e["state"], e["tier"]) for e in events if e.get("type") == "tool"] == [
        ("run", "READ"),
        ("ok", "READ"),
    ], "the clients know three tiers until push-fe F3"


@pytest.mark.parametrize(
    ("text", "url"),
    [
        (f"{POSTING}을 요약해 줘", POSTING),
        (
            "https://careers.moapay.example/채용/1 요약해 줘",
            "https://careers.moapay.example/%EC%B1%84%EC%9A%A9/1",
        ),
    ],
    ids=["particle-after-the-link", "korean-path-read-encoded"],
)
async def test_a_link_typed_in_a_korean_sentence_is_read_without_a_card(
    db, people, monkeypatch, text, url
):
    fetched = fake_web(monkeypatch, {url: "공고 본문"})
    c = await chat(db, people)
    await said(db, c, text)
    reads(url)

    events = await turn(c, text, mode="AUTO")

    assert cards(events) == []
    assert fetched == [url]


@pytest.mark.parametrize(("read_mine", "asked"), [(True, 0), (False, 1)])
async def test_a_saved_link_counts_as_given_only_while_my_materials_may_be_read(
    db, people, monkeypatch, read_mine, asked
):
    fetched = fake_web(monkeypatch, {POSTING: "공고 본문"})
    c = await chat(db, people, bot="push")
    await db.q().execute(
        "INSERT INTO user_settings (user_id, allow_ai_read_my_files) VALUES ($1, $2)",
        c.user,
        read_mine,
    )
    await db.q().execute(
        "INSERT INTO user_links (id, user_id, kind, url, title) "
        "VALUES ($1, $2, 'job', $3, '허브 프로필 링크')",
        uuid4(),
        c.user,
        POSTING,
    )
    reads(POSTING)

    events = await turn(c, "내 링크에 있는 공고 읽어 줘", mode="AUTO")

    assert len(cards(events)) == asked
    assert fetched == ([] if asked else [POSTING])


async def test_a_link_attached_to_a_message_is_read_without_a_card_and_marks_the_link_checked(
    db, people, monkeypatch
):
    fetched = fake_web(monkeypatch, {POSTING: "공고 본문"})
    c = await chat(db, people, bot="push")
    link = uuid4()
    await db.q().execute(
        "INSERT INTO user_links (id, user_id, kind, url, title) "
        "VALUES ($1, $2, 'job', $3, '모아페이 공고')",
        link,
        c.user,
        POSTING,
    )
    await said(db, c, "이거 읽어 줘", [{"kind": "link", "id": str(link), "title": "모아페이 공고"}])
    reads(POSTING)

    events = await turn(c, "이거 읽어 줘")

    assert cards(events) == []
    assert fetched == [POSTING]
    checked = await db.q().fetchrow(
        "SELECT last_checked_at, last_check_ok FROM user_links WHERE id = $1", link
    )
    assert checked["last_checked_at"] is not None and checked["last_check_ok"] is True


async def test_a_page_the_bot_chose_asks_unless_the_turn_runs_at_once_or_the_host_is_granted(
    db, people, monkeypatch
):
    fetched = fake_web(monkeypatch, {POSTING: "공고 본문"})

    asked = await chat(db, people)
    reads(POSTING)
    assert len(cards(await turn(asked, "모아페이 공고 읽어 줘", mode="AUTO"))) == 1

    quick = await chat(db, people)
    reads(POSTING)
    assert (
        cards(await turn(quick, "지원 현황 정리해 줘", mode="BYPASS", intent="applications")) == []
    )

    granted = await chat(db, people)
    await db.q().execute(
        "INSERT INTO bot_site_grants (bot_id, host, kind) "
        "VALUES ($1, 'careers.moapay.example', 'posting')",
        granted.bot,
    )
    reads(POSTING)
    assert cards(await turn(granted, "모아페이 공고 읽어 줘", mode="AUTO")) == []

    assert fetched == [POSTING, POSTING]


async def test_a_grant_for_one_host_never_reads_another_through_a_redirect(db, people, monkeypatch):
    other = "https://other-site.example/jobs"
    fetched = fake_web(monkeypatch, {POSTING: ("redirect", other), other: "다른 회사"})
    c = await chat(db, people)
    await db.q().execute(
        "INSERT INTO bot_site_grants (bot_id, host, kind) "
        "VALUES ($1, 'careers.moapay.example', 'posting')",
        c.bot,
    )
    reads(POSTING, other)

    events = await turn(c, "모아페이 공고 읽어 줘", mode="AUTO")

    assert fetched == [POSTING]
    assert await results(c) == [{"error": "REDIRECTED", "to": other}]
    (card,) = cards(events)
    assert (card["title"], card["summary"]) == (
        "other-site.example 페이지를 열어도 될까요?",
        "other-site.example · 페이지 1개를 읽어요",
    ), "the new question names the site the redirect led to, not the bot's company"
    assert {"type": "done", "awaiting": "approval"} in events


async def test_a_short_link_the_user_gave_is_followed_and_the_result_names_the_final_page(
    db, people, monkeypatch
):
    short = "https://short.example/x"
    fetched = fake_web(monkeypatch, {short: ("redirect", POSTING), POSTING: "공고 본문"})
    c = await chat(db, people)
    await said(db, c, f"{short} 이 링크 봐 줘")
    reads(short)

    events = await turn(c, f"{short} 이 링크 봐 줘")

    assert cards(events) == []
    assert fetched == [short, POSTING]
    assert await results(c) == [{"url": POSTING, "text": "공고 본문"}]


async def test_the_page_card_lives_ten_minutes_and_always_allow_stops_asking_for_that_host_only(
    db, people, monkeypatch
):
    fetched = fake_web(
        monkeypatch,
        {
            POSTING: "공고 본문",
            "https://careers.moapay.example/about": "회사 소개",
            "https://blog.example/post": "블로그",
        },
    )
    c = await chat(db, people)
    reads(POSTING)

    (card,) = cards(await turn(c, "모아페이 공고 읽어 줘"))

    assert card["title"] == "모아페이 채용 페이지를 열어도 될까요?"
    assert card["summary"] == "careers.moapay.example · 공고 1개를 읽어요"
    assert card["foot"] == "10분 동안 답이 없으면 이 요청은 만료돼요"
    assert [o["id"] for o in card["options"]] == ["approve", "approve_always", "reject"]
    row = await db.q().fetchrow(
        "SELECT created_at, expires_at FROM approvals WHERE id = $1", card["id"]
    )
    assert row["expires_at"] - row["created_at"] == timedelta(minutes=10)
    assert datetime.fromisoformat(card["expiresAt"]) == row["expires_at"]
    assert fetched == []

    await turn(c, resume={"approvalId": card["id"], "optionId": "approve_always"})

    hosts = await db.q().fetch("SELECT host, kind FROM bot_site_grants WHERE bot_id = $1", c.bot)
    assert [(h["host"], h["kind"]) for h in hosts] == [("careers.moapay.example", "posting")]
    assert fetched == [POSTING]

    reads("https://careers.moapay.example/about")
    assert cards(await turn(c, "회사 소개도 읽어 줘")) == []
    reads("https://blog.example/post")
    assert len(cards(await turn(c, "블로그도 읽어 줘"))) == 1


NURI = "https://nuricloud.career.greetinghr.example/o/1"


@pytest.mark.parametrize(
    ("bot", "url", "title", "summary", "kind"),
    [
        (
            "company",
            POSTING,
            "모아페이 채용 페이지를 열어도 될까요?",
            "careers.moapay.example · 공고 1개를 읽어요",
            "posting",
        ),
        (
            "company",
            "https://moapay.notion.example/about",
            "모아페이 회사 소개를 열어도 될까요?",
            "moapay.notion.example · 회사 소개를 읽어요",
            "company",
        ),
        (
            "company",
            "https://blog.example/post",
            "blog.example 페이지를 열어도 될까요?",
            "blog.example · 페이지 1개를 읽어요",
            "other",
        ),
        (
            "push",
            NURI,
            "누리클라우드 채용 페이지를 열어도 될까요?",
            "nuricloud.career.greetinghr.example · 공고 1개를 읽어요",
            "posting",
        ),
    ],
    ids=["own-posting", "company-site", "unknown-page", "push-bot-reads-a-posting-push-has"],
)
async def test_the_card_and_the_grant_say_what_the_page_is(
    db, people, monkeypatch, bot, url, title, summary, kind
):
    fetched = fake_web(monkeypatch, {url: "본문"})
    await posting(db, people, "누리클라우드", NURI)
    c = await chat(db, people, bot=bot, site="https://moapay.notion.example")
    reads(url)

    (card,) = cards(await turn(c, "읽어 줘"))
    await turn(c, resume={"approvalId": card["id"], "optionId": "approve_always"})

    assert (card["title"], card["summary"]) == (title, summary)
    grants = await db.q().fetch("SELECT kind FROM bot_site_grants WHERE bot_id = $1", c.bot)
    assert [g["kind"] for g in grants] == [kind]
    assert fetched == [url]


async def test_a_conversation_without_a_bot_offers_no_always_allow_and_never_says_bot(
    db, people, monkeypatch
):
    fake_web(monkeypatch, {POSTING: "공고 본문"})
    c = await chat(db, people, bot=None)
    reads(POSTING)

    (card,) = cards(await turn(c, "공고 읽어 줘"))

    assert [(o["id"], o["label"]) for o in card["options"]] == [
        ("approve", "한 번 허용"),
        ("reject", "거절"),
    ]
    assert card["title"] == "careers.moapay.example 페이지를 열어도 될까요?"
    assert "봇" not in json.dumps(card, ensure_ascii=False)


async def test_an_expired_card_resumes_nothing_and_a_rearmed_card_resumes_the_same_interrupt(
    db, people, monkeypatch
):
    fetched = fake_web(monkeypatch, {POSTING: "공고 본문"})
    c = await chat(db, people)
    reads(POSTING)
    (card,) = cards(await turn(c, "모아페이 공고 읽어 줘"))
    await db.q().execute(
        "UPDATE approvals SET created_at = now() - interval '11 minutes', "
        "expires_at = now() - interval '1 minute' "
        "WHERE id = $1",
        card["id"],
    )

    await AdminJobs(db.q()).expire_approvals(datetime.now(UTC))

    assert (
        await db.q().fetchval("SELECT status FROM approvals WHERE id = $1", card["id"]) == "EXPIRED"
    )
    parked = await state(c)
    assert _pending(parked)["approval_id"] == card["id"] and parked.next == ("tools",)
    assert await results(c) == [] and fetched == []
    assert (
        await db.q().fetchval("SELECT count(*) FROM ai_jobs WHERE conversation_id = $1", c.thread)
        == 0
    )
    (stored,) = await TurnStore(db).cards(c.thread, [card["id"]])
    assert (stored["status"], stored["retryable"]) == ("EXPIRED", True)

    # As core's POST /bots/{id}/approvals/{cardId}/retry leaves the row: asked again now, same span.
    await db.q().execute(
        "UPDATE approvals SET status = 'PENDING', created_at = now(), "
        "expires_at = now() + (expires_at - created_at) WHERE id = $1",
        card["id"],
    )
    await turn(c, resume={"approvalId": card["id"], "optionId": "approve"})

    assert fetched == [POSTING]
    assert await results(c) == [{"url": POSTING, "text": "공고 본문"}]
    assert not (await state(c)).next


async def test_an_expired_card_closed_with_reject_is_no_longer_retryable(db, people, monkeypatch):
    fake_web(monkeypatch, {POSTING: "공고 본문"})
    c = await chat(db, people)
    reads(POSTING)
    (card,) = cards(await turn(c, "모아페이 공고 읽어 줘"))
    await db.q().execute(
        "UPDATE approvals SET created_at = now() - interval '11 minutes', "
        "expires_at = now() - interval '1 minute' WHERE id = $1",
        card["id"],
    )
    (expired,) = await TurnStore(db).cards(c.thread, [card["id"]])

    # As core's 닫기 (an expired card answered reject) leaves the row: closed, and no job queued.
    await db.q().execute(
        "UPDATE approvals SET status = 'REJECTED', option_id = 'reject' WHERE id = $1", card["id"]
    )

    (closed,) = await TurnStore(db).cards(c.thread, [card["id"]])
    assert (expired["status"], expired["retryable"]) == ("EXPIRED", True)
    assert (closed["status"], closed["retryable"]) == ("REJECTED", False)


async def test_a_card_is_retryable_until_a_newer_chat_job_of_its_thread_exists(
    db, people, monkeypatch
):
    fake_web(monkeypatch, {POSTING: "공고 본문"})
    c = await chat(db, people)
    reads(POSTING)
    (card,) = cards(await turn(c, "모아페이 공고 읽어 줘"))
    (before,) = await TurnStore(db).cards(c.thread, [card["id"]])

    await db.q().execute(
        "INSERT INTO ai_jobs (id, type, queue, user_id, status, max_attempts, payload, "
        "conversation_id, created_at) VALUES ($1, 'chat', 'q:chat', $2, 'QUEUED', 3, '{}'::jsonb, "
        "$3, now() + interval '1 second')",
        uuid4(),
        c.user,
        c.thread,
    )

    (after,) = await TurnStore(db).cards(c.thread, [card["id"]])
    assert (before["retryable"], after["retryable"]) == (True, False)
