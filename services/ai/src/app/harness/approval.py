from __future__ import annotations

import contextvars
import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal
from urllib.parse import quote, unquote, urlsplit, urlunsplit
from uuid import NAMESPACE_URL, UUID, uuid5

from app.clock import utcnow
from app.ingest.web_page import find_urls

# Set only while a tool display hook runs, so the hook can scope rows to this conversation.
approval_conversation_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "approval_conversation_id", default=None)

APPROVE_ALWAYS = "approve_always"
# Core stores every answer but reject as APPROVED (conversations.ts resolveApproval), so both
# run the tool.
APPROVING = frozenset({"approve", APPROVE_ALWAYS})

_PAGE_TTL = timedelta(minutes=10)


@dataclass(frozen=True)
class CardSpec:
    """How a tool card asks: its answers, how long it waits for one, and the line under the answers.

    site: the card asks to read a web page. Its title and summary say what the page is (SitePage),
    and 항상 허용 is offered only in a bot thread, because a conversation without a bot has no bot
    to remember for.
    """

    options: tuple[dict, ...] = (
        {"id": "approve", "label": "실행"},
        {"id": "reject", "label": "취소"},
    )
    ttl: timedelta = timedelta(hours=24)
    foot: str | None = None
    site: bool = False


DEFAULT_CARD = CardSpec()

# The only list of card variants. Core never names a lifetime: a retry reuses the span stored on
# the row.
CARDS: dict[str, CardSpec] = {
    "apply_to_posting": CardSpec(foot="지원하면 취소할 수 없어요"),
    "read_page": CardSpec(
        options=(
            {"id": "approve", "label": "한 번 허용"},
            {
                "id": APPROVE_ALWAYS,
                "label": "항상 허용",
                "desc": "이 봇이 이 사이트를 읽을 때 다시 묻지 않아요",
            },
            {"id": "reject", "label": "거절"},
        ),
        ttl=_PAGE_TTL,
        foot=f"{_PAGE_TTL // timedelta(minutes=1)}분 동안 답이 없으면 이 요청은 만료돼요",
        site=True,
    ),
}


def approval_id_for(job_id: str, tool_call_id: str) -> str:
    return str(uuid5(NAMESPACE_URL, "push:tool-approval:" + job_id + ":" + tool_call_id))


def site_host(url: str) -> str:
    """The host a site grant is stored under and every hop of a page read is compared with."""
    return (urlsplit(url.strip()).hostname or "").rstrip(".").removeprefix("www.")


def normalize_url(url: str) -> str | None:
    """The form two URLs are compared in, None when it does not parse. Query strings are kept:
    one page of a site is not the site. Path and query are compared percent-encoded, so a Korean
    path typed as text equals the same link copied encoded."""
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").rstrip(".")
    netloc = host if port in (None, {"http": 80, "https": 443}.get(scheme)) else f"{host}:{port}"
    path, query = (_encoded(part) for part in (parts.path.rstrip("/"), parts.query))
    return urlunsplit((scheme, netloc, path, query, ""))


def _encoded(part: str) -> str:
    escaped = quote(part, safe="/%:@!$&'()*+,;=-._~?")
    return re.sub(r"%[0-9a-fA-F]{2}", lambda m: m.group().upper(), escaped)


# A URL the user gave in this thread, in a message or as an attached link, and with 내 자료 읽기
# 허용 on, a saved link, hub profile links included (they are user_links rows, contract.md 1.4).
_SUPPLIED = (
    "SELECT m.text, ARRAY(SELECT l.url FROM jsonb_array_elements(m.attachments) a "
    "JOIN user_links l ON l.id = (a->>'id')::uuid AND l.user_id = m.user_id "
    "WHERE a->>'kind' = 'link') AS links "
    "FROM messages m WHERE m.conversation_id = $1 AND m.user_id = $2 AND m.role = 'USER' "
    "AND (strpos(lower(m.text), $3) > 0 OR m.attachments @> '[{\"kind\": \"link\"}]') "
    "UNION ALL SELECT '', ARRAY(SELECT l.url FROM user_links l WHERE l.user_id = $2 "
    "AND l.deleted_at IS NULL AND strpos(lower(l.url), $3) > 0) "
    "WHERE COALESCE((SELECT s.allow_ai_read_my_files FROM user_settings s "
    "WHERE s.user_id = $2), true)"
)


async def user_supplied(db, conversation_id, user_id, url: str) -> bool:
    """True when the user gave this URL (_SUPPLIED). Then the user already chose the page and
    nothing asks. The whole URL must match, never only the host."""
    wanted = normalize_url(url)
    if wanted is None:
        return False
    rows = await db.q().fetch(
        _SUPPLIED, UUID(str(conversation_id)), UUID(str(user_id)), site_host(url))
    return any(
        normalize_url(given) == wanted
        for row in rows
        for given in [*find_urls(row["text"]), *(row["links"] or [])]
    )


PageKind = Literal["posting", "company", "other"]


@dataclass(frozen=True)
class SitePage:
    """What Push knows of a page a card asks to open, and the company it belongs to."""

    kind: PageKind = "other"
    owner: str = ""


# What a page-read card says by the kind of page. Board ChatBotStatusApprove draws posting. A
# page Push cannot name claims nothing about itself.
_ASKS: dict[PageKind, tuple[str, str]] = {
    "posting": ("{owner} 채용 페이지를 열어도 될까요?", "{host} · 공고 1개를 읽어요"),
    "company": ("{owner} 회사 소개를 열어도 될까요?", "{host} · 회사 소개를 읽어요"),
    "other": ("{host} 페이지를 열어도 될까요?", "{host} · 페이지 1개를 읽어요"),
}

# The posting whose URL is this page, and the site of the company this bot works for. A posting is
# matched by host in SQL and by path when the stored URL is plain ASCII (case-folded, in the encoded
# and the decoded form), so a job board with thousands of postings answers about one row. A stored
# URL with raw Hangul or a percent escape in any part may equal the page in a form SQL cannot
# compare, so it always comes back; _covers makes the exact decision.
# shortcut: job_postings.source_url has no index, so this still scans the postings; index it when
# they grow past what a scan per page card can afford.
_KNOWN_PAGES = (
    "(SELECT 'posting' AS kind, p.company AS owner, p.source_url AS url FROM job_postings p "
    "CROSS JOIN LATERAL regexp_match(p.source_url, "
    "'^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^?#]*)(\\?[^#]*)?') AS m "
    "WHERE lower(m[1]) = $4 AND lower(m[2]) ~ $2 "
    "AND (lower(rtrim(m[3], '/') || COALESCE(m[4], '')) = ANY($3::text[]) "
    "OR p.source_url ~ '[^ -~]|%')) "
    "UNION ALL SELECT 'company', COALESCE(NULLIF(b.company_name, ''), co.name), co.website "
    "FROM conversations c JOIN bots b ON b.id = c.bot_id "
    "JOIN companies co ON co.id = COALESCE(b.company_id, "
    "(SELECT p.company_id FROM job_postings p WHERE p.id = b.posting_id)) "
    "WHERE c.id = $1 AND co.website IS NOT NULL"
)


def _posting_filter(url: str, wanted: str) -> tuple[str, list[str], str]:
    """The host pattern, the path-and-query forms (encoded and decoded, lowercase) and the scheme
    _KNOWN_PAGES compares a posting's URL with."""
    parts = urlsplit(wanted)
    path_query = parts.path + (f"?{parts.query}" if parts.query else "")
    forms = {path_query.lower(), unquote(path_query).lower()}
    return rf"^(www\.)?{re.escape(site_host(url))}(:[0-9]+)?$", sorted(forms), parts.scheme


async def site_page(db, conversation_id, url: str) -> SitePage:
    """Push names a page it knows: a posting it has, by the whole URL, or any page of the site of
    the company this bot works for. Anything else is other."""
    wanted = normalize_url(url)
    if wanted is None:
        return SitePage()
    rows = await db.q().fetch(
        _KNOWN_PAGES, UUID(str(conversation_id)), *_posting_filter(url, wanted))
    found = {row["kind"]: row["owner"] for row in rows if _covers(row, wanted)}
    named: tuple[PageKind, ...] = ("posting", "company")
    return next((SitePage(kind, found[kind]) for kind in named if kind in found), SitePage())


def _covers(row: Mapping[str, str], wanted: str | None) -> bool:
    known = normalize_url(row["url"])
    if wanted is None or known is None:
        return False
    return wanted == known or (row["kind"] == "company" and wanted.startswith(known + "/"))


async def site_granted(db, conversation_id, url: str) -> bool:
    """False in a conversation without a bot: there every page the user did not give asks."""
    return bool(await db.q().fetchval(
        "SELECT EXISTS (SELECT 1 FROM bot_site_grants g "
        "JOIN conversations c ON c.bot_id = g.bot_id WHERE c.id = $1 AND g.host = $2)",
        UUID(str(conversation_id)), site_host(url)))


async def remember_site(db, conversation_id, url: str) -> None:
    """Written for an answered 항상 허용 just before the tool runs, with what the page is known
    to be now. A job that dies first remembers nothing."""
    page = await site_page(db, conversation_id, url)
    await db.q().execute(
        "INSERT INTO bot_site_grants (bot_id, host, kind) SELECT c.bot_id, $2, $3 "
        "FROM conversations c WHERE c.id = $1 AND c.bot_id IS NOT NULL ON CONFLICT DO NOTHING",
        UUID(str(conversation_id)), site_host(url), page.kind)


def tool_action_event(
    approval_id: str, summary: str, tool_name: str, args: dict, display=None, *,
    title: str | None = None,
    options: tuple[dict, ...] | None = None,
    expires_at: datetime | None = None,
) -> dict:
    card = CARDS.get(tool_name, DEFAULT_CARD)
    event = {
        "type": "approval",
        "id": approval_id,
        "kind": "TOOL_ACTION",
        "title": title or summary,
        "summary": summary,
        "toolName": tool_name,
        "args": args,
        "options": [dict(option) for option in options or card.options],
    }
    if card.foot:
        event["foot"] = card.foot
    if expires_at is not None:
        event["expiresAt"] = expires_at.isoformat()
    # display is the row list from the tool's display(args, db) hook. No colour.
    if display:
        event["rows"] = display
    return event


async def create_tool_approval(
    db, *, user_id, conversation_id, job_id, tool, args, tool_call_id,
) -> tuple[dict, bool]:
    approval_id = approval_id_for(str(job_id), str(tool_call_id))
    payload = args if isinstance(args, dict) else args.model_dump(mode="json")
    if isinstance(args, dict):
        summary = tool.summarize(tool.args_model.model_validate(args))
    else:
        summary = tool.summarize(args)
    token = approval_conversation_id.set(str(conversation_id) if conversation_id else None)
    try:
        hook = getattr(tool, "display", None)
        rows = await hook(args, db) if hook is not None else None
    finally:
        approval_conversation_id.reset(token)
    card = CARDS.get(tool.name, DEFAULT_CARD)
    title, options = summary, card.options
    if card.site:
        host = site_host(payload["url"])
        page = await site_page(db, conversation_id, payload["url"])
        title, summary = (
            form.format(owner=page.owner or host, host=host) for form in _ASKS[page.kind])
        in_bot = await db.q().fetchval(
            "SELECT bot_id IS NOT NULL FROM conversations WHERE id = $1",
            UUID(str(conversation_id)))
        if not in_bot:
            options = tuple(option for option in options if option["id"] != APPROVE_ALWAYS)
    # One clock for both times: a retry keeps the span between them as the card's lifetime.
    asked_at = utcnow()
    expires_at = asked_at + card.ttl
    event = tool_action_event(
        approval_id, summary, tool.name, payload, rows or None,
        title=title, options=options, expires_at=expires_at)
    existing = await db.q().fetchrow("SELECT id FROM approvals WHERE id = $1", UUID(approval_id))
    if existing is not None:
        return event, False
    stored = json.dumps(event["options"], ensure_ascii=False)
    await db.q().execute(
        "INSERT INTO approvals (id, user_id, kind, target_id, payload_hash, status, "
        "conversation_id, title, options, tool_name, tool_args, tool_call_id, job_id, "
        "expires_at, created_at) "
        "VALUES ($1,$2,'TOOL_ACTION',$3,$4,'PENDING',$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13) "
        "ON CONFLICT (id) DO NOTHING",
        UUID(approval_id),
        user_id,
        UUID(approval_id),
        hashlib.sha256(stored.encode()).hexdigest(),
        conversation_id,
        event["title"],
        stored,
        tool.name,
        json.dumps(payload, ensure_ascii=False),
        tool_call_id,
        job_id,
        expires_at,
        asked_at,
    )
    return event, True
