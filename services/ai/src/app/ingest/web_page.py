from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import socket
from collections.abc import Awaitable, Callable
from html.parser import HTMLParser
from urllib.parse import urljoin

import httpx

try:  # Pyodide (Cloudflare Workers) ships httpx without httpcore.
    import httpcore
    from httpcore._backends.auto import AutoBackend
except ImportError:  # pragma: no cover - Workers only
    httpcore = None
    AutoBackend = None

from app.domain.validators import validate_https_url

_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")
# identity: a gzip bomb can inflate one 64 KB chunk far past _MAX_BYTES.
_HEADERS = {"User-Agent": _UA, "Accept-Language": "ko,en;q=0.8", "Accept-Encoding": "identity"}
_MAX_BYTES = 1_000_000
_MAX_TEXT = 8000
_MAX_HOPS = 6
_HTTP_TIMEOUT = 15
# httpx timeouts are per read; these cap a slow-drip server end to end.
_FETCH_DEADLINE = 25
_RENDER_DEADLINE = 60
_URL_RE = re.compile(r"https?://[^\s<>\"'\)\]]+")
_WS_RE = re.compile(r"\s+")
_BLOCKED_HOSTS = {"localhost", "metadata.google.internal"}
_BLOCKED_SUFFIX = (".localhost", ".internal", ".local", ".lan", ".home")
# IPv6 ranges that carry an IPv4 target (NAT64, 6to4, v4-compatible) and that
# ``is_global`` reports as public: 64:ff9b::7f00:1 reaches 127.0.0.1 via NAT64.
_V4_EMBEDDING_NETS = tuple(ipaddress.ip_network(n) for n in (
    "::/96", "64:ff9b::/96", "64:ff9b:1::/48", "2002::/16"))
_CHROMIUM_ARGS = [
    # Chromium skips the proxy for loopback unless told otherwise.
    "--proxy-bypass-list=<-loopback>",
    # WebRTC UDP does not go through the proxy.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
]

# Each render is a Chromium process; a few concurrent jobs must not OOM the worker.
_RENDER_SLOTS = asyncio.Semaphore(2)

type IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
type HopCheck = Callable[[str], Awaitable[None]]


def _is_public(ip: IPAddress) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif any(ip in net for net in _V4_EMBEDDING_NETS):
            return False
    return ip.is_global and not ip.is_multicast


def _url_host(url: str) -> str:
    """The IDNA-encoded host httpx and httpcore connect to."""
    try:
        return httpx.URL(url).raw_host.decode("ascii").lower()
    except (httpx.InvalidURL, UnicodeError) as e:
        raise ValueError("invalid url") from e


def _reject_blocked_name(host: str) -> None:
    if host in _BLOCKED_HOSTS or host.endswith(_BLOCKED_SUFFIX):
        raise ValueError("host not allowed")


def _resolve_public(host: str) -> list[str]:
    host = host.lower()
    _reject_blocked_name(host)
    try:
        ips = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror:
            raise ValueError("cannot resolve host") from None
        ips = {ipaddress.ip_address(i[4][0]) for i in infos}
    if not all(_is_public(ip) for ip in ips):
        raise ValueError("host resolves to a private address")
    return [str(ip) for ip in ips]


def _assert_public_sync(url: str) -> list[str]:
    validate_https_url(url)
    return _resolve_public(_url_host(url))


async def _assert_public(url: str) -> list[str]:
    return await asyncio.to_thread(_assert_public_sync, url)


class _PinnedBackend:
    """Connects only to IPs validated for the host; never re-resolves DNS."""

    def __init__(self, pins: dict[str, list[str]]):
        self._pins = pins
        self._inner = AutoBackend()

    def __getattr__(self, name: str):
        return getattr(self._inner, name)

    async def connect_tcp(self, host: str, port: int, timeout=None,
                          local_address=None, socket_options=None):
        ips = self._pins.get(host.lower())
        if not ips:
            raise httpcore.ConnectError("host was not validated: " + host)
        err: Exception | None = None
        for ip in ips:
            try:
                return await self._inner.connect_tcp(
                    ip, port, timeout, local_address, socket_options)
            except Exception as e:
                err = e
        raise err


class _PinnedTransport(httpx.AsyncBaseTransport):
    def __init__(self):
        self.pins: dict[str, list[str]] = {}
        self._pool = httpcore.AsyncConnectionPool(
            network_backend=_PinnedBackend(self.pins))

    async def handle_async_request(self, request: httpx.Request):
        from httpx._transports.default import (
            AsyncResponseStream, map_httpcore_exceptions)
        req = httpcore.Request(
            method=request.method,
            url=httpcore.URL(
                scheme=request.url.raw_scheme,
                host=request.url.raw_host,
                port=request.url.port,
                target=request.url.raw_path),
            headers=request.headers.raw,
            content=request.stream,
            extensions=request.extensions)
        with map_httpcore_exceptions():
            resp = await self._pool.handle_async_request(req)
        return httpx.Response(
            status_code=resp.status, headers=resp.headers,
            stream=AsyncResponseStream(resp.stream),
            extensions=resp.extensions)

    async def aclose(self) -> None:
        await self._pool.aclose()


async def _pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


def _parse_connect_target(line: bytes) -> tuple[str, int] | None:
    try:
        target = line.split()[1].decode("ascii", "replace")
        if target.startswith("["):
            host, _, port = target[1:].partition("]:")
            return host, int(port)
        host, _, port = target.rpartition(":")
        return host, int(port)
    except (IndexError, ValueError):
        return None


async def _start_egress_proxy() -> tuple[asyncio.AbstractServer, int]:
    async def handle(reader, writer):
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=10)
            parsed = _parse_connect_target(line) if line.startswith(b"CONNECT ") else None
            while await reader.readline() not in (b"\r\n", b"\n", b""):
                pass
            if parsed is None:
                writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                await writer.drain()
                return
            host, port = parsed
            try:
                ips = await asyncio.to_thread(_resolve_public, host)
            except Exception:
                writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                await writer.drain()
                return
            remote = None
            for ip in ips:
                try:
                    remote = await asyncio.open_connection(ip, port)
                    break
                except OSError:
                    continue
            if remote is None:
                writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                await writer.drain()
                return
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            r2, w2 = remote
            await asyncio.gather(_pipe(reader, w2), _pipe(r2, writer))
        except Exception:
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    return server, port


def find_urls(text: str) -> list[str]:
    seen, out = set(), []
    for u in _URL_RE.findall(text or ""):
        u = u.rstrip(".,;:!?")
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


class _TextExtractor(HTMLParser):
    _SKIP = frozenset({"script", "style", "noscript", "svg"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.size = 0
        self._skipping = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in self._SKIP:
            self._skipping += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._skipping:
            self._skipping -= 1

    def handle_data(self, data: str) -> None:
        if not self._skipping and (words := " ".join(data.split())):
            self.parts.append(words)
            self.size += len(words) + 1


def _html_to_text(html: str, chunk: int = 65536) -> str:
    # A linear parser: the old regex strip was quadratic on unclosed tags.
    parser = _TextExtractor()
    for start in range(0, len(html), chunk):
        parser.feed(html[start:start + chunk])
        if parser.size > _MAX_TEXT:
            break
    return " ".join(parser.parts)[:_MAX_TEXT]


_MIN_TEXT = 1500


async def _render_text(url: str) -> str:
    async def guard(route):
        req_url = route.request.url
        if not req_url.startswith(("http://", "https://")):
            await route.continue_()
            return
        try:
            await asyncio.to_thread(_assert_public_sync, req_url)
        except Exception:
            await route.abort()
            return
        await route.continue_()

    async with _RENDER_SLOTS:
        return await _render_with_browser(url, guard)


async def _render_with_browser(url: str, guard) -> str:
    from playwright.async_api import async_playwright

    proxy_server, proxy_port = await _start_egress_proxy()
    try:
        async with async_playwright() as p:
            args = list(_CHROMIUM_ARGS)
            if os.environ.get("PLAYWRIGHT_NO_SANDBOX") == "1":
                args += ["--no-sandbox", "--disable-dev-shm-usage"]
            launch = {"proxy": {"server": f"http://127.0.0.1:{proxy_port}"},
                      "args": args}
            browser = await p.chromium.launch(**launch)
            try:
                page = await browser.new_page(
                    user_agent=_UA, locale="ko-KR")
                await page.route("**/*", guard)
                await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                try:
                    await page.wait_for_load_state("networkidle", timeout=10000)
                except Exception:
                    pass
                text = await page.evaluate("document.body.innerText")
                return _WS_RE.sub(" ", text or "").strip()[:_MAX_TEXT]
            finally:
                await browser.close()
    finally:
        proxy_server.close()
        await proxy_server.wait_closed()


async def _reject_private_host(host: str) -> None:
    host = (host or "").lower()
    _reject_blocked_name(host)
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        if not _is_public(ip):
            raise ValueError("host resolves to a private address")
        return
    async with httpx.AsyncClient(timeout=5) as client:
        for rtype in ("A", "AAAA"):
            resp = await client.get(
                "https://cloudflare-dns.com/dns-query",
                params={"name": host, "type": rtype},
                headers={"accept": "application/dns-json"})
            if resp.status_code != 200:
                raise ValueError("cannot resolve host")
            for ans in resp.json().get("Answer") or []:
                if ans.get("type") not in (1, 28):
                    continue
                if not _is_public(ipaddress.ip_address(ans["data"])):
                    raise ValueError("host resolves to a private address")


async def _browser_markdown(url: str) -> str:
    account = os.environ.get("CF_ACCOUNT_ID", "")
    token = os.environ.get("CF_API_TOKEN", "")
    if not account or not token:
        raise RuntimeError("browser rendering is not configured")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://api.cloudflare.com/client/v4/accounts/"
            + account + "/browser-rendering/markdown",
            headers={"Authorization": "Bearer " + token},
            json={"url": url})
    if resp.status_code != 200:
        raise RuntimeError("browser rendering http " + str(resp.status_code))
    body = resp.json()
    result = body.get("result") if isinstance(body, dict) else ""
    if isinstance(result, dict):
        result = result.get("markdown") or result.get("content") or ""
    return _WS_RE.sub(" ", result or "").strip()[:_MAX_TEXT]


async def _read_page(client: httpx.AsyncClient, url: str,
                     check_hop: HopCheck) -> tuple[str, str, bool]:
    """Follow redirects, checking every hop. Returns (final url, text, is_html)."""
    for _ in range(_MAX_HOPS):
        await check_hop(url)
        async with client.stream("GET", url) as r:
            if r.is_redirect and "location" in r.headers:
                url = urljoin(url, r.headers["location"])
                continue
            if r.status_code != 200:
                raise ValueError("http status " + str(r.status_code))
            ct = r.headers.get("content-type", "")
            if "text/html" not in ct and "text/plain" not in ct:
                raise ValueError("unsupported content type " + ct[:100])
            buf = bytearray()
            async for chunk in r.aiter_bytes():
                buf += chunk
                if len(buf) > _MAX_BYTES:
                    break
        body = _decode(bytes(buf), r.charset_encoding)
        if "text/plain" in ct:
            return url, body[:_MAX_TEXT], False
        return url, _html_to_text(body), True
    raise ValueError("too many redirects")


def _decode(data: bytes, charset: str | None) -> str:
    try:
        return data.decode(charset or "utf-8", errors="replace")
    except LookupError:  # unknown charset label from the server
        return data.decode("utf-8", errors="replace")


async def _with_render_fallback(url: str, text: str, is_html: bool,
                                render: Callable[[str], Awaitable[str]]) -> str:
    if not is_html or len(text) >= _MIN_TEXT:
        return text
    try:
        async with asyncio.timeout(_RENDER_DEADLINE):
            rendered = await render(url)
    except Exception:
        return text
    return rendered if len(rendered) > len(text) else text


async def _fetch_page_text_worker(url: str) -> str:
    """HTTP fetch on Workers. No local CONNECT proxy and no Playwright.

    Cloudflare Browser Rendering (10 minutes/day on the free plan) is used
    when CF_ACCOUNT_ID and CF_API_TOKEN are set and the static extract is
    short. DNS is checked via DNS-over-HTTPS before the fetch; Workers
    cannot pin the TCP destination the way the local transport does.
    """
    async def check_hop(hop: str) -> None:
        validate_https_url(hop)
        await _reject_private_host(_url_host(hop))

    async with httpx.AsyncClient(headers=_HEADERS, timeout=_HTTP_TIMEOUT,
                                 follow_redirects=False) as client:
        async with asyncio.timeout(_FETCH_DEADLINE):
            url, text, is_html = await _read_page(client, url, check_hop)
    return await _with_render_fallback(url, text, is_html, _browser_markdown)


async def fetch_page_text(url: str) -> str:
    transport = _PinnedTransport()

    async def pin_hop(hop: str) -> None:
        ips = await _assert_public(hop)
        transport.pins.clear()
        transport.pins[_url_host(hop)] = ips

    async with httpx.AsyncClient(transport=transport, headers=_HEADERS,
                                 timeout=_HTTP_TIMEOUT) as client:
        async with asyncio.timeout(_FETCH_DEADLINE):
            url, text, is_html = await _read_page(client, url, pin_hop)
    return await _with_render_fallback(url, text, is_html, _render_text)


_GH_USER_RE = re.compile(
    r"github\s*\.?\s*com/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)",
    re.I)
_GH_SKIP = {"settings", "features", "pricing", "login", "signup", "explore",
            "topics", "collections", "marketplace", "sponsors", "orgs",
            "about", "contact", "security"}


def github_usernames(text: str) -> list[str]:
    seen, out = set(), []
    for u in _GH_USER_RE.findall(text or ""):
        u = u.lower()
        if u not in seen and u not in _GH_SKIP:
            seen.add(u)
            out.append(u)
    return out


async def fetch_github_context(username: str, transport=None) -> str:
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, transport=transport) as c:
            r = await c.get(
                f"https://api.github.com/users/{username}/repos",
                params={"per_page": 30, "sort": "pushed", "type": "owner"},
                headers={"Accept": "application/vnd.github+json",
                         "User-Agent": _UA})
            if r.status_code != 200:
                return ""
            repos = r.json()
    except Exception:
        return ""
    lines = []
    for repo in repos:
        if repo.get("fork"):
            continue
        desc = (repo.get("description") or "").strip()
        lang = repo.get("language") or "-"
        stars = repo.get("stargazers_count") or 0
        pushed = (repo.get("pushed_at") or "")[:10]
        line = f"- {repo['name']} | {lang} | ★{stars} | pushed {pushed}"
        if desc:
            line += f" | {desc}"
        lines.append(line)
    return f"github.com/{username} 공개 레포 ({len(lines)}개, 최근 push 순)\n" \
        + "\n".join(lines)
