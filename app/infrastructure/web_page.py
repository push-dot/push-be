from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from urllib.parse import urljoin, urlparse

import httpx

from app.domain.validators import validate_https_url

_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")
_MAX_BYTES = 1_000_000
_MAX_TEXT = 8000
_URL_RE = re.compile(r"https?://[^\s<>\"'\)\]]+")
_STRIP_RE = re.compile(
    r"<script[^>]*>.*?</script>|<style[^>]*>.*?</style>|"
    r"<noscript[^>]*>.*?</noscript>|<svg[^>]*>.*?</svg>",
    re.S | re.I)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_BLOCKED_HOSTS = {"localhost", "metadata.google.internal"}
_BLOCKED_SUFFIX = (".localhost", ".internal", ".local", ".lan", ".home")


def _assert_public_sync(url: str) -> None:
    validate_https_url(url)
    host = (urlparse(url).hostname or "").lower()
    if host in _BLOCKED_HOSTS or host.endswith(_BLOCKED_SUFFIX):
        raise ValueError("host not allowed")
    try:
        ips = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, None)
            ips = {ipaddress.ip_address(i[4][0]) for i in infos}
        except socket.gaierror:
            raise ValueError("cannot resolve host")
    for ip in ips:
        if not ip.is_global:
            raise ValueError("host resolves to a private address")


async def _assert_public(url: str) -> None:
    await asyncio.to_thread(_assert_public_sync, url)


def find_urls(text: str) -> list[str]:
    seen, out = set(), []
    for u in _URL_RE.findall(text or ""):
        u = u.rstrip(".,;:!?")
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def _html_to_text(html: str) -> str:
    t = _STRIP_RE.sub(" ", html)
    t = _TAG_RE.sub(" ", t)
    t = _WS_RE.sub(" ", t).strip()
    return t[:_MAX_TEXT]


_MIN_TEXT = 1500


async def _render_text(url: str) -> str:
    from playwright.async_api import async_playwright

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

    async with async_playwright() as p:
        browser = await p.chromium.launch()
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


async def fetch_page_text(url: str) -> str:
    async with httpx.AsyncClient(
            headers={"User-Agent": _UA, "Accept-Language": "ko,en;q=0.8"},
            timeout=15) as client:
        buf = bytearray()
        ct = ""
        for _ in range(6):
            await _assert_public(url)
            async with client.stream("GET", url) as r:
                if r.is_redirect and "location" in r.headers:
                    url = urljoin(url, r.headers["location"])
                    continue
                if r.status_code != 200:
                    raise ValueError("http status " + str(r.status_code))
                ct = r.headers.get("content-type", "")
                if "text/html" not in ct and "text/plain" not in ct:
                    raise ValueError("unsupported content type " + ct)
                async for chunk in r.aiter_bytes():
                    buf += chunk
                    if len(buf) > _MAX_BYTES:
                        break
            break
        else:
            raise ValueError("too many redirects")
    if "text/plain" in ct:
        return bytes(buf).decode("utf-8", errors="replace")[:_MAX_TEXT]
    text = _html_to_text(bytes(buf).decode("utf-8", errors="replace"))
    if len(text) >= _MIN_TEXT:
        return text
    try:
        rendered = await _render_text(url)
        return rendered if len(rendered) > len(text) else text
    except Exception:
        return text


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


async def fetch_github_context(username: str) -> str:
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as c:
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
