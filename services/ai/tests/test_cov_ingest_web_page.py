from __future__ import annotations

import asyncio
import socket
import sys
from types import ModuleType, SimpleNamespace

import httpx
import pytest

from app.ingest import web_page

_REAL_GETADDRINFO = socket.getaddrinfo
_REAL_CLIENT = httpx.AsyncClient


def _dns(monkeypatch, table: dict) -> list:
    """Fake resolver: listed hosts resolve to the given IPs, others hit the real one."""
    lookups = []

    def fake(host, *args, **kwargs):
        if host in table:
            lookups.append(host)
            ips = table[host]
            if ips is None:
                raise socket.gaierror("nx")
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0)) for ip in ips]
        return _REAL_GETADDRINFO(host, *args, **kwargs)

    monkeypatch.setattr(web_page.socket, "getaddrinfo", fake)
    return lookups


class _MockPinned(httpx.MockTransport):
    def __init__(self, handler):
        super().__init__(handler)
        self.pins: dict = {}


def _pinned(monkeypatch, handler) -> _MockPinned:
    transport = _MockPinned(handler)
    monkeypatch.setattr(web_page, "_PinnedTransport", lambda: transport)
    return transport


def _html(body: str) -> str:
    return f"<html><head><style>.x{{}}</style></head><body>{body}</body></html>"


# --- pure helpers -----------------------------------------------------------

def test_find_urls_strips_trailing_punctuation_and_dedupes():
    text = ("see https://a.example/x, and (https://b.example/y) "
            "again https://a.example/x. <http://c.example/z>")
    assert web_page.find_urls(text) == [
        "https://a.example/x", "https://b.example/y", "http://c.example/z"]
    assert web_page.find_urls("") == []
    assert web_page.find_urls(None) == []


def test_html_to_text_drops_scripts_styles_and_tags():
    html = ("<script>var secret=1;</script><STYLE>p{}</STYLE>"
            "<noscript>enable js</noscript><svg><path d='x'/></svg>"
            "<h1>Title</h1>\n\n<p>Body&nbsp;text</p>")
    assert web_page._html_to_text(html) == "Title Body text"


@pytest.mark.parametrize("html", [
    "<script>" * 125_000, "<" * 1_000_000, "<style>" * 125_000, "<a " * 300_000])
def test_html_to_text_is_linear_on_adversarial_markup(html):
    import time
    start = time.perf_counter()
    web_page._html_to_text(html)
    assert time.perf_counter() - start < 2


def test_html_to_text_stops_parsing_once_text_cap_is_reached():
    html = "<p>word</p>" * 1_000_000
    assert len(web_page._html_to_text(html)) == web_page._MAX_TEXT


def test_html_to_text_truncates_to_max_text():
    assert len(web_page._html_to_text("<p>" + "a" * 20000 + "</p>")) == web_page._MAX_TEXT


def test_github_usernames_lowercases_dedupes_and_skips_reserved():
    text = ("github.com/Alice github.com/alice https://github.com/settings "
            "github . com/bob-dev github.com/pricing")
    assert web_page.github_usernames(text) == ["alice", "bob-dev"]
    assert web_page.github_usernames(None) == []


# --- SSRF guard ---------------------------------------------------------------

@pytest.mark.parametrize("url", [
    "ftp://example.com/", "file:///etc/passwd", "https://user:pw@example.com/",
    "https:///nohost"])
def test_assert_public_rejects_bad_urls(url):
    with pytest.raises(ValueError):
        web_page._assert_public_sync(url)


@pytest.mark.parametrize("url", [
    "https://localhost/", "https://metadata.google.internal/",
    "https://db.internal/", "https://printer.local/", "https://nas.lan/",
    "https://router.home/", "https://api.localhost/"])
def test_assert_public_rejects_blocked_hostnames(url):
    with pytest.raises(ValueError, match="host not allowed"):
        web_page._assert_public_sync(url)


@pytest.mark.parametrize("ip", [
    "127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "[::1]", "[fe80::1]", "[::ffff:127.0.0.1]",
    # NAT64, 6to4 and v4-compatible forms of 127.0.0.1 / 169.254.169.254
    "[64:ff9b::7f00:1]", "[64:ff9b::a9fe:a9fe]", "[2002:7f00:1::]", "[::127.0.0.1]",
    "224.0.0.1", "[ff02::1]"])
def test_assert_public_rejects_private_ip_literals(ip):
    with pytest.raises(ValueError, match="private"):
        web_page._assert_public_sync(f"https://{ip}/")


def test_assert_public_returns_public_ip_literal_without_dns(monkeypatch):
    lookups = _dns(monkeypatch, {})
    assert web_page._assert_public_sync("https://1.1.1.1/") == ["1.1.1.1"]
    assert lookups == []


def test_assert_public_resolves_hostname(monkeypatch):
    _dns(monkeypatch, {"jobs.example": ["93.184.216.34"]})
    assert web_page._assert_public_sync("https://Jobs.Example/path") == ["93.184.216.34"]


def test_assert_public_rejects_if_any_record_is_private(monkeypatch):
    _dns(monkeypatch, {"rebind.example": ["93.184.216.34", "10.1.2.3"]})
    with pytest.raises(ValueError, match="private"):
        web_page._assert_public_sync("https://rebind.example/")


def test_assert_public_rejects_nat64_dns_answer(monkeypatch):
    _dns(monkeypatch, {"nat64.example": ["64:ff9b::a9fe:a9fe"]})
    with pytest.raises(ValueError, match="private"):
        web_page._assert_public_sync("https://nat64.example/")


def test_assert_public_resolves_idna_host(monkeypatch):
    lookups = _dns(monkeypatch, {"xn--bcher-kva.de": ["93.184.216.34"]})
    assert web_page._assert_public_sync("https://bücher.de/") == ["93.184.216.34"]
    assert lookups == ["xn--bcher-kva.de"]


def test_assert_public_maps_dns_failure(monkeypatch):
    _dns(monkeypatch, {"nx.example": None})
    with pytest.raises(ValueError, match="cannot resolve host"):
        web_page._assert_public_sync("https://nx.example/")


# --- pinned transport (real sockets on loopback) -----------------------------

async def _http_server(seen: list):
    async def handle(reader, writer):
        head = b""
        while (line := await reader.readline()) not in (b"\r\n", b""):
            head += line
        seen.append(head.decode())
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"
                     b"Connection: close\r\n\r\nok")
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


def _closed_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def test_pinned_transport_connects_to_pinned_ip_and_keeps_host_header():
    seen: list = []
    server, port = await _http_server(seen)
    transport = web_page._PinnedTransport()
    # The first IP refuses, the second one serves: failover inside the pin set.
    transport.pins["pinned.invalid"] = ["::1", "127.0.0.1"]
    try:
        async with httpx.AsyncClient(transport=transport) as client:
            r = await client.get(f"http://pinned.invalid:{port}/page")
        assert r.status_code == 200
        assert r.text == "ok"
        assert f"Host: pinned.invalid:{port}" in seen[0]
        assert seen[0].startswith("GET /page ")
    finally:
        server.close()
        await server.wait_closed()


async def test_pinned_transport_refuses_unpinned_host():
    # Fails closed: an unvalidated host must never fall back to fresh DNS.
    seen: list = []
    server, port = await _http_server(seen)
    transport = web_page._PinnedTransport()
    try:
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(httpx.ConnectError, match="not validated"):
                await client.get(f"http://127.0.0.1:{port}/")
        assert seen == []
    finally:
        server.close()
        await server.wait_closed()


async def test_pinned_transport_raises_when_every_pinned_ip_fails():
    transport = web_page._PinnedTransport()
    transport.pins["pinned.invalid"] = ["127.0.0.1"]
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(httpx.ConnectError):
            await client.get(f"http://pinned.invalid:{_closed_port()}/")


def test_pinned_backend_delegates_other_attributes():
    backend = web_page._PinnedBackend({})
    assert backend.sleep == backend._inner.sleep


# --- egress proxy -------------------------------------------------------------

async def test_proxy_returns_502_when_no_validated_ip_accepts(monkeypatch):
    monkeypatch.setattr(web_page, "_resolve_public", lambda host: ["127.0.0.1"])
    server, port = await web_page._start_egress_proxy()
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(f"CONNECT pub.example:{_closed_port()} HTTP/1.1\r\n"
                     "Host: x\r\n\r\n".encode())
        await writer.drain()
        assert b"502" in await reader.readline()
        writer.close()
    finally:
        server.close()
        await server.wait_closed()


# --- fetch_page_text (local runtime) ------------------------------------------

async def test_fetch_page_text_pins_resolved_ip_and_extracts_html(monkeypatch):
    monkeypatch.delenv("CF_WORKER", raising=False)
    _dns(monkeypatch, {"jobs.example": ["93.184.216.34"]})
    long_body = "<p>" + "Backend engineer " * 120 + "</p><script>x()</script>"
    pins_seen = []

    def handler(request):
        pins_seen.append(dict(transport.pins))
        return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"},
                              text=_html(long_body))

    transport = _pinned(monkeypatch, handler)

    async def no_render(url):
        raise AssertionError("long static text must not trigger a browser render")

    monkeypatch.setattr(web_page, "_render_text", no_render)
    text = await web_page.fetch_page_text("https://jobs.example/role")
    assert text.startswith("Backend engineer")
    assert "x()" not in text
    assert pins_seen == [{"jobs.example": ["93.184.216.34"]}]


async def test_fetch_page_text_pins_idna_host_as_connected(monkeypatch):
    monkeypatch.delenv("CF_WORKER", raising=False)
    _dns(monkeypatch, {"xn--bcher-kva.de": ["93.184.216.34"]})
    pins_seen = []

    def handler(request):
        pins_seen.append(dict(transport.pins))
        return httpx.Response(200, headers={"content-type": "text/plain"}, text="ok")

    transport = _pinned(monkeypatch, handler)
    assert await web_page.fetch_page_text("https://bücher.de/") == "ok"
    assert pins_seen == [{"xn--bcher-kva.de": ["93.184.216.34"]}]


async def test_fetch_page_text_caps_total_time_for_slow_drip(monkeypatch):
    monkeypatch.delenv("CF_WORKER", raising=False)
    monkeypatch.setattr(web_page, "_FETCH_DEADLINE", 0.2)
    _dns(monkeypatch, {"slow.example": ["93.184.216.34"]})

    async def drip():
        while True:
            await asyncio.sleep(0.05)
            yield b"a"

    _pinned(monkeypatch, lambda r: httpx.Response(
        200, headers={"content-type": "text/plain"}, content=drip()))
    with pytest.raises(TimeoutError):
        await web_page.fetch_page_text("https://slow.example/")


async def test_fetch_page_text_caps_render_time(monkeypatch):
    monkeypatch.delenv("CF_WORKER", raising=False)
    monkeypatch.setattr(web_page, "_RENDER_DEADLINE", 0.05)
    _dns(monkeypatch, {"spa.example": ["93.184.216.34"]})
    _pinned(monkeypatch, lambda r: httpx.Response(
        200, headers={"content-type": "text/html"}, text=_html("Loading")))

    async def hang(url):
        await asyncio.sleep(10)
        return "never"

    monkeypatch.setattr(web_page, "_render_text", hang)
    assert await web_page.fetch_page_text("https://spa.example/") == "Loading"


async def test_fetch_page_text_revalidates_each_redirect_hop(monkeypatch):
    monkeypatch.delenv("CF_WORKER", raising=False)
    _dns(monkeypatch, {"a.example": ["93.184.216.34"], "b.example": ["93.184.216.35"]})
    pins_seen = []

    def handler(request):
        pins_seen.append((request.url.host, dict(transport.pins)))
        if request.url.host == "a.example":
            return httpx.Response(302, headers={"location": "https://b.example/final"})
        return httpx.Response(200, headers={"content-type": "text/plain"}, text="plain body")

    transport = _pinned(monkeypatch, handler)
    assert await web_page.fetch_page_text("https://a.example/") == "plain body"
    assert pins_seen == [
        ("a.example", {"a.example": ["93.184.216.34"]}),
        ("b.example", {"b.example": ["93.184.216.35"]}),
    ]


@pytest.mark.parametrize("location,match", [
    ("https://intranet.example/", "private"),
    ("https://localhost/admin", "host not allowed"),
    ("file:///etc/passwd", "http"),
])
async def test_fetch_page_text_blocks_redirect_to_unsafe_target(monkeypatch, location, match):
    monkeypatch.delenv("CF_WORKER", raising=False)
    _dns(monkeypatch, {"pub.example": ["93.184.216.34"], "intranet.example": ["10.0.0.5"]})
    hosts = []

    def handler(request):
        hosts.append(request.url.host)
        return httpx.Response(302, headers={"location": location})

    _pinned(monkeypatch, handler)
    with pytest.raises(ValueError, match=match):
        await web_page.fetch_page_text("https://pub.example/")
    assert hosts == ["pub.example"]


async def test_fetch_page_text_follows_relative_redirect_and_caps_hops(monkeypatch):
    monkeypatch.delenv("CF_WORKER", raising=False)
    _dns(monkeypatch, {"loop.example": ["93.184.216.34"]})
    paths = []

    def handler(request):
        paths.append(request.url.path)
        return httpx.Response(301, headers={"location": f"/hop{len(paths)}"})

    _pinned(monkeypatch, handler)
    with pytest.raises(ValueError, match="too many redirects"):
        await web_page.fetch_page_text("https://loop.example/start")
    assert paths == ["/start", "/hop1", "/hop2", "/hop3", "/hop4", "/hop5"]


async def test_fetch_page_text_rejects_error_status_and_binary(monkeypatch):
    monkeypatch.delenv("CF_WORKER", raising=False)
    _dns(monkeypatch, {"pub.example": ["93.184.216.34"]})
    _pinned(monkeypatch, lambda r: httpx.Response(404))
    with pytest.raises(ValueError, match="http status 404"):
        await web_page.fetch_page_text("https://pub.example/")
    _pinned(monkeypatch, lambda r: httpx.Response(
        200, headers={"content-type": "application/pdf"}, content=b"%PDF"))
    with pytest.raises(ValueError, match="unsupported content type application/pdf"):
        await web_page.fetch_page_text("https://pub.example/")


async def test_fetch_page_text_stops_reading_after_max_bytes(monkeypatch):
    monkeypatch.delenv("CF_WORKER", raising=False)
    _dns(monkeypatch, {"big.example": ["93.184.216.34"]})
    sent = []

    async def body():
        for _ in range(200):  # 12.8 MB if fully drained
            sent.append(1)
            yield b"a" * 65536

    _pinned(monkeypatch, lambda r: httpx.Response(
        200, headers={"content-type": "text/plain"}, content=body()))
    text = await web_page.fetch_page_text("https://big.example/")
    assert text == "a" * web_page._MAX_TEXT
    assert len(sent) * 65536 <= web_page._MAX_BYTES + 65536


async def test_fetch_page_text_short_page_uses_longer_render(monkeypatch):
    monkeypatch.delenv("CF_WORKER", raising=False)
    _dns(monkeypatch, {"spa.example": ["93.184.216.34"]})
    _pinned(monkeypatch, lambda r: httpx.Response(
        200, headers={"content-type": "text/html"}, text=_html("<div id=app>Loading</div>")))
    rendered = []

    async def render(url):
        rendered.append(url)
        return "Rendered job description with many details"

    monkeypatch.setattr(web_page, "_render_text", render)
    assert await web_page.fetch_page_text("https://spa.example/") == \
        "Rendered job description with many details"
    assert rendered == ["https://spa.example/"]

    async def shorter(url):
        return "x"

    monkeypatch.setattr(web_page, "_render_text", shorter)
    assert await web_page.fetch_page_text("https://spa.example/") == "Loading"

    async def broken(url):
        raise RuntimeError("chromium missing")

    monkeypatch.setattr(web_page, "_render_text", broken)
    assert await web_page.fetch_page_text("https://spa.example/") == "Loading"


# --- _render_text with a fake Playwright --------------------------------------

def _fake_playwright(monkeypatch, sub_urls):
    rec = SimpleNamespace(routes=[], launch=None, closed=False, goto=None)

    class Route:
        def __init__(self, url):
            self.request = SimpleNamespace(url=url)
            self.result = None

        async def continue_(self):
            self.result = "continue"

        async def abort(self):
            self.result = "abort"

    class Page:
        async def route(self, pattern, handler):
            rec.handler = handler

        async def goto(self, url, **kwargs):
            rec.goto = (url, kwargs)
            for u in sub_urls:
                route = Route(u)
                await rec.handler(route)
                rec.routes.append((u, route.result))

        async def wait_for_load_state(self, *args, **kwargs):
            raise TimeoutError("still busy")

        async def evaluate(self, expr):
            return "  Senior\n\n  Engineer \t role "

    class Browser:
        async def new_page(self, **kwargs):
            rec.page_kwargs = kwargs
            return Page()

        async def close(self):
            rec.closed = True

    class Chromium:
        async def launch(self, **kwargs):
            rec.launch = kwargs
            return Browser()

    class PW:
        async def __aenter__(self):
            return SimpleNamespace(chromium=Chromium())

        async def __aexit__(self, *exc):
            return False

    mod = ModuleType("playwright.async_api")
    mod.async_playwright = lambda: PW()
    monkeypatch.setitem(sys.modules, "playwright.async_api", mod)
    return rec


async def test_render_text_guards_subrequests_and_cleans_up(monkeypatch):
    monkeypatch.setenv("PLAYWRIGHT_NO_SANDBOX", "1")
    _dns(monkeypatch, {"cdn.example": ["93.184.216.34"]})
    rec = _fake_playwright(monkeypatch, [
        "data:image/png;base64,AAAA",
        "https://cdn.example/app.js",
        "http://127.0.0.1:8080/admin",
        "https://169.254.169.254/latest/meta-data",
    ])
    text = await web_page._render_text("https://cdn.example/")
    assert text == "Senior Engineer role"
    assert rec.routes == [
        ("data:image/png;base64,AAAA", "continue"),
        ("https://cdn.example/app.js", "continue"),
        ("http://127.0.0.1:8080/admin", "abort"),
        ("https://169.254.169.254/latest/meta-data", "abort"),
    ]
    assert rec.launch["args"] == [
        "--proxy-bypass-list=<-loopback>",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--no-sandbox", "--disable-dev-shm-usage"]
    proxy = rec.launch["proxy"]["server"]
    assert proxy.startswith("http://127.0.0.1:")
    assert rec.closed
    # The egress proxy is shut down once rendering finishes.
    with pytest.raises(OSError):
        await asyncio.open_connection("127.0.0.1", int(proxy.rsplit(":", 1)[1]))


async def test_render_text_keeps_sandbox_by_default(monkeypatch):
    monkeypatch.delenv("PLAYWRIGHT_NO_SANDBOX", raising=False)
    rec = _fake_playwright(monkeypatch, [])
    await web_page._render_text("https://example.com/")
    assert "--no-sandbox" not in rec.launch["args"]
    # Loopback must go through the validating proxy too.
    assert "--proxy-bypass-list=<-loopback>" in rec.launch["args"]


# --- Workers runtime -----------------------------------------------------------

def _patch_client(monkeypatch, handler) -> list:
    calls = []

    def wrapped(request):
        calls.append(request)
        return handler(request)

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(wrapped)
        return _REAL_CLIENT(*args, **kwargs)

    monkeypatch.setattr(web_page.httpx, "AsyncClient", factory)
    return calls


def _doh(answers: dict):
    def respond(request):
        name = request.url.params["name"]
        rtype = request.url.params["type"]
        entry = answers.get((name, rtype))
        if entry == "error":
            return httpx.Response(500)
        return httpx.Response(200, json={"Answer": entry or []})
    return respond


async def test_reject_private_host_blocklist_and_literals(monkeypatch):
    calls = _patch_client(monkeypatch, lambda r: httpx.Response(500))
    with pytest.raises(ValueError, match="host not allowed"):
        await web_page._reject_private_host("LOCALHOST")
    with pytest.raises(ValueError, match="private"):
        await web_page._reject_private_host("10.0.0.1")
    await web_page._reject_private_host("8.8.8.8")
    assert calls == []


async def test_reject_private_host_checks_doh_answers(monkeypatch):
    answers = {
        ("pub.example", "A"): [{"type": 5, "data": "alias.example."},
                               {"type": 1, "data": "93.184.216.34"}],
        ("evil.example", "A"): [{"type": 1, "data": "93.184.216.34"}],
        ("evil.example", "AAAA"): [{"type": 28, "data": "::1"}],
        ("nat64.example", "A"): [{"type": 28, "data": "64:ff9b::a00:1"}],
        ("flaky.example", "A"): "error",
    }
    _patch_client(monkeypatch, _doh(answers))
    await web_page._reject_private_host("pub.example")
    with pytest.raises(ValueError, match="private"):
        await web_page._reject_private_host("evil.example")
    with pytest.raises(ValueError, match="private"):
        await web_page._reject_private_host("nat64.example")
    # A DoH failure fails closed instead of skipping the check.
    with pytest.raises(ValueError, match="cannot resolve"):
        await web_page._reject_private_host("flaky.example")


async def test_browser_markdown_requires_configuration(monkeypatch):
    monkeypatch.delenv("CF_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CF_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="not configured"):
        await web_page._browser_markdown("https://example.com/")


@pytest.mark.parametrize("payload,expected", [
    ({"result": {"markdown": "#  Title\n\nbody"}}, "# Title body"),
    ({"result": {"content": "content field"}}, "content field"),
    ({"result": "plain   result"}, "plain result"),
    ({"result": None}, ""),
    (["not", "a", "dict"], ""),
])
async def test_browser_markdown_parses_result_shapes(monkeypatch, payload, expected):
    monkeypatch.setenv("CF_ACCOUNT_ID", "acct")
    monkeypatch.setenv("CF_API_TOKEN", "tok")
    calls = _patch_client(monkeypatch, lambda r: httpx.Response(200, json=payload))
    assert await web_page._browser_markdown("https://example.com/") == expected
    req = calls[0]
    assert req.url.path == "/client/v4/accounts/acct/browser-rendering/markdown"
    assert req.headers["authorization"] == "Bearer tok"


async def test_browser_markdown_maps_http_error(monkeypatch):
    monkeypatch.setenv("CF_ACCOUNT_ID", "acct")
    monkeypatch.setenv("CF_API_TOKEN", "tok")
    _patch_client(monkeypatch, lambda r: httpx.Response(429))
    with pytest.raises(RuntimeError, match="http 429"):
        await web_page._browser_markdown("https://example.com/")


def _worker_handler(pages: dict, dns: dict, render=None):
    doh = _doh(dns)

    def handler(request):
        host = request.url.host
        if host == "cloudflare-dns.com":
            return doh(request)
        if host == "api.cloudflare.com":
            if render is None:
                return httpx.Response(500)
            return httpx.Response(200, json={"result": render})
        return pages[str(request.url)]()
    return handler


_PUBLIC = {("pub.example", "A"): [{"type": 1, "data": "93.184.216.34"}],
           ("next.example", "A"): [{"type": 1, "data": "93.184.216.35"}],
           ("intra.example", "A"): [{"type": 1, "data": "10.0.0.7"}]}


async def test_worker_fetch_dispatch_and_long_html(monkeypatch):
    monkeypatch.setenv("CF_WORKER", "1")
    body = "<p>" + "Role details " * 200 + "</p>"
    pages = {"https://pub.example/": lambda: httpx.Response(
        200, headers={"content-type": "text/html"}, text=body)}
    calls = _patch_client(monkeypatch, _worker_handler(pages, _PUBLIC))
    text = await web_page.fetch_page_text("https://pub.example/")
    assert text.startswith("Role details")
    assert not any(c.url.host == "api.cloudflare.com" for c in calls)


async def test_worker_fetch_follows_redirect_and_returns_plain(monkeypatch):
    monkeypatch.setenv("CF_WORKER", "1")
    pages = {
        "https://pub.example/": lambda: httpx.Response(
            302, headers={"location": "https://next.example/doc"}),
        "https://next.example/doc": lambda: httpx.Response(
            200, headers={"content-type": "text/plain"}, text="short plain"),
    }
    calls = _patch_client(monkeypatch, _worker_handler(pages, _PUBLIC))
    monkeypatch.delenv("CF_ACCOUNT_ID", raising=False)
    assert await web_page._fetch_page_text_worker("https://pub.example/") == "short plain"
    doh_names = [c.url.params["name"] for c in calls if c.url.host == "cloudflare-dns.com"]
    assert "next.example" in doh_names


@pytest.mark.parametrize("location,match", [
    ("https://intra.example/", "private"),
    ("ftp://pub.example/file", "http"),
])
async def test_worker_fetch_blocks_unsafe_redirect(monkeypatch, location, match):
    pages = {"https://pub.example/": lambda: httpx.Response(
        302, headers={"location": location})}
    calls = _patch_client(monkeypatch, _worker_handler(pages, _PUBLIC))
    with pytest.raises(ValueError, match=match):
        await web_page._fetch_page_text_worker("https://pub.example/")
    assert not any(c.url.host == "intra.example" for c in calls)


async def test_worker_fetch_rejects_private_origin_before_request(monkeypatch):
    calls = _patch_client(monkeypatch, _worker_handler({}, _PUBLIC))
    with pytest.raises(ValueError, match="private"):
        await web_page._fetch_page_text_worker("https://intra.example/")
    assert all(c.url.host == "cloudflare-dns.com" for c in calls)


async def test_worker_fetch_errors(monkeypatch):
    pages = {
        "https://pub.example/404": lambda: httpx.Response(404),
        "https://pub.example/bin": lambda: httpx.Response(
            200, headers={"content-type": "image/png"}, content=b"x"),
        "https://pub.example/loop": lambda: httpx.Response(
            302, headers={"location": "/loop"}),
    }
    _patch_client(monkeypatch, _worker_handler(pages, _PUBLIC))
    with pytest.raises(ValueError, match="http status 404"):
        await web_page._fetch_page_text_worker("https://pub.example/404")
    with pytest.raises(ValueError, match="unsupported content type"):
        await web_page._fetch_page_text_worker("https://pub.example/bin")
    with pytest.raises(ValueError, match="too many redirects"):
        await web_page._fetch_page_text_worker("https://pub.example/loop")


async def test_worker_fetch_stops_at_max_bytes(monkeypatch):
    sent = []

    async def body():
        for _ in range(200):
            sent.append(1)
            yield b"<p>" + b"a" * 65533

    pages = {"https://pub.example/": lambda: httpx.Response(
        200, headers={"content-type": "text/html"}, content=body())}
    _patch_client(monkeypatch, _worker_handler(pages, _PUBLIC))
    text = await web_page._fetch_page_text_worker("https://pub.example/")
    assert len(text) == web_page._MAX_TEXT
    assert len(sent) * 65536 <= web_page._MAX_BYTES + 65536


async def test_worker_short_page_prefers_longer_browser_render(monkeypatch):
    monkeypatch.setenv("CF_ACCOUNT_ID", "acct")
    monkeypatch.setenv("CF_API_TOKEN", "tok")
    pages = {"https://pub.example/": lambda: httpx.Response(
        200, headers={"content-type": "text/html"}, text=_html("Loading"))}
    _patch_client(monkeypatch, _worker_handler(
        pages, _PUBLIC, render={"markdown": "Full rendered posting"}))
    assert await web_page._fetch_page_text_worker("https://pub.example/") == \
        "Full rendered posting"

    _patch_client(monkeypatch, _worker_handler(pages, _PUBLIC, render=None))
    assert await web_page._fetch_page_text_worker("https://pub.example/") == "Loading"


# --- GitHub context ------------------------------------------------------------

async def test_fetch_github_context_formats_owned_repos():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=[
            {"name": "widget", "language": "Python", "stargazers_count": 5,
             "pushed_at": "2026-01-02T03:04:05Z", "description": "  A widget  "},
            {"name": "forked", "fork": True},
            {"name": "bare", "language": None, "stargazers_count": None,
             "pushed_at": None, "description": None},
        ])

    out = await web_page.fetch_github_context("alice", transport=httpx.MockTransport(handler))
    assert out == ("github.com/alice 공개 레포 (2개, 최근 push 순)\n"
                   "- widget | Python | ★5 | pushed 2026-01-02 | A widget\n"
                   "- bare | - | ★0 | pushed ")
    assert seen[0].url.path == "/users/alice/repos"
    assert seen[0].url.params["type"] == "owner"


async def test_fetch_github_context_returns_empty_on_failure():
    not_found = httpx.MockTransport(lambda r: httpx.Response(404))
    assert await web_page.fetch_github_context("ghost", transport=not_found) == ""

    def boom(request):
        raise httpx.ConnectError("down")

    assert await web_page.fetch_github_context("x", transport=httpx.MockTransport(boom)) == ""
