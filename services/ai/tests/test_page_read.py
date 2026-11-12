"""Whether a page read asks, which hosts it may reach, and what its card offers."""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

import httpx
import pytest

from app.domain.access_mode import AccessMode
from app.harness.approval import CARDS, DEFAULT_CARD, normalize_url, site_host
from app.harness.graph import write_needs_approval
from app.harness.policy import Decision, Tier, decide
from app.ingest import web_page
from tests.test_cov_ingest_web_page import _dns, _pinned


def fake_web(monkeypatch, pages: dict) -> list[str]:
    """Every host of `pages` resolves to a public address. A value is the body, or ("redirect", location).
    Returns the URLs fetched, in order."""
    hosts = {httpx.URL(url).host for url in pages} | {
        httpx.URL(value[1]).host for value in pages.values() if isinstance(value, tuple)}
    _dns(monkeypatch, {host: ["93.184.216.34"] for host in hosts})
    fetched: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        fetched.append(str(request.url))
        value = pages.get(str(request.url))
        if value is None:
            return httpx.Response(404)
        if isinstance(value, tuple):
            return httpx.Response(302, headers={"location": value[1]})
        return httpx.Response(200, headers={"content-type": "text/plain"}, text=value)

    _pinned(monkeypatch, handler)
    return fetched


@pytest.mark.parametrize("mode", list(AccessMode))
def test_a_page_the_user_gave_or_a_granted_host_is_read_in_every_mode(mode):
    for facts in ({"supplied": True}, {"granted": True}):
        assert decide(mode, Tier.EXTERNAL_READ, "read_page", **facts) is Decision.EXECUTE
        assert decide(mode, Tier.EXTERNAL_READ, "read_page", quick_start=True, **facts) is Decision.EXECUTE


def test_a_page_the_bot_chose_asks_unless_the_mode_is_run_at_once():
    asked = {mode for mode in AccessMode if decide(mode, Tier.EXTERNAL_READ, "read_page") is Decision.ASK}
    assert asked == {AccessMode.ALWAYS_ASK, AccessMode.AUTO}
    assert not write_needs_approval(AccessMode.BYPASS, Tier.EXTERNAL_READ, {"intent": "applications"}, "read_page")


@pytest.mark.parametrize("mode", list(AccessMode))
@pytest.mark.parametrize("tier", [Tier.SAFE_WRITE, Tier.RISKY_WRITE])
def test_a_write_in_a_quick_start_still_asks_in_every_mode(mode, tier):
    assert decide(mode, tier, quick_start=True) is Decision.ASK
    assert write_needs_approval(mode, tier.value, {"intent": "calendar"})
    assert not write_needs_approval(mode, Tier.READ, {"intent": "calendar"})


def test_the_page_card_has_three_answers_ten_minutes_and_a_foot_that_names_the_lifetime():
    card = CARDS["read_page"]
    assert [(o["id"], o["label"], o.get("desc")) for o in card.options] == [
        ("approve", "한 번 허용", None),
        ("approve_always", "항상 허용", "이 봇이 이 사이트를 읽을 때 다시 묻지 않아요"),
        ("reject", "거절", None),
    ]
    assert card.ttl == timedelta(minutes=10)
    assert card.foot == "10분 동안 답이 없으면 이 요청은 만료돼요"


def test_other_tool_cards_keep_two_answers_and_a_day():
    for name in ("apply_to_posting", "delete_calendar_event"):
        card = CARDS.get(name, DEFAULT_CARD)
        assert [o["id"] for o in card.options] == ["approve", "reject"]
        assert card.ttl == timedelta(hours=24)
        assert not card.site


def test_a_grant_is_one_host_and_a_supplied_url_is_one_page():
    assert site_host("https://WWW.Moapay.co.kr./jobs/1") == "moapay.co.kr"
    assert site_host("https://careers.moapay.co.kr/jobs") == "careers.moapay.co.kr"
    same = ("HTTPS://Careers.Moapay.co.kr:443/jobs/1/?a=1#top", "https://careers.moapay.co.kr/jobs/1?a=1")
    assert normalize_url(same[0]) == normalize_url(same[1])
    assert normalize_url("https://a.example/jobs/1?a=1") != normalize_url("https://a.example/jobs/1?a=2")
    assert normalize_url("https://a.example/jobs/1") != normalize_url("https://a.example/jobs/2")
    assert normalize_url("https://[::1/x") is None and normalize_url("https://a.example:99999/") is None


async def test_a_redirect_to_a_host_the_permission_does_not_cover_reads_nothing_of_it(monkeypatch):
    fetched = fake_web(monkeypatch, {
        "https://moapay.example/jobs": ("redirect", "https://other-site.example/jobs"),
        "https://other-site.example/jobs": "다른 사이트",
    })
    with pytest.raises(web_page.LeftSite) as left:
        await web_page.fetch_page("https://moapay.example/jobs", allow_hop=lambda u: site_host(u) == "moapay.example")
    assert left.value.to == "https://other-site.example/jobs"
    assert fetched == ["https://moapay.example/jobs"]


async def test_without_a_hop_limit_a_redirect_is_followed_and_the_page_names_where_it_ended(monkeypatch):
    fetched = fake_web(monkeypatch, {
        "https://short.example/x": ("redirect", "https://careers.moapay.example/jobs/1"),
        "https://careers.moapay.example/jobs/1": "백엔드 엔지니어",
    })
    page = await web_page.fetch_page("https://short.example/x")
    assert page == web_page.Page("https://careers.moapay.example/jobs/1", "백엔드 엔지니어")
    assert fetched == ["https://short.example/x", "https://careers.moapay.example/jobs/1"]
    assert await web_page.fetch_page_text("https://short.example/x") == "백엔드 엔지니어"


async def test_the_browser_render_does_not_navigate_to_a_host_the_permission_does_not_cover(monkeypatch):
    seen = {}

    async def browser(url, guard):
        seen["guard"] = guard
        return ""

    monkeypatch.setattr(web_page, "_render_with_browser", browser)
    monkeypatch.setattr(web_page, "_assert_public_sync", lambda url: ["93.184.216.34"])
    await web_page._render_text("https://moapay.example/", lambda u: site_host(u) == "moapay.example")

    class Route:
        def __init__(self, url, navigation):
            self.request = SimpleNamespace(url=url, is_navigation_request=lambda: navigation)
            self.done = ""

        async def continue_(self):
            self.done = "continued"

        async def abort(self):
            self.done = "aborted"

    routes = [
        Route("https://other-site.example/", True),
        Route("https://moapay.example/jobs", True),
        Route("https://cdn.other.example/app.js", False),
    ]
    for route in routes:
        await seen["guard"](route)
    assert [route.done for route in routes] == ["aborted", "continued", "continued"]
