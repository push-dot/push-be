from __future__ import annotations

import re
from uuid import uuid4

# A pasted list of links must not turn into hundreds of inserts and queries for one turn.
MAX_URLS_PER_MESSAGE = 20
_URL_RE = re.compile(r"https://[^\s<>\"'\)\]]+")
_REPO_RE = re.compile(r"^https://github\.com/([^/\s?#]+)/([^/\s?#]+)$")
_INSERT = (
    "INSERT INTO user_links "
    "(id, user_id, kind, url, title, status, fit_count, ai_read) "
    "VALUES ($1, $2, 'job', $3, '', 'READING', 0, false)"
)
_READING = (
    "UPDATE user_links SET status = 'READING' WHERE id = $1 AND user_id = $2"
)
_READ = (
    "UPDATE user_links SET status = 'READ', title = $3 "
    "WHERE id = $1 AND user_id = $2"
)
_FIT = (
    "UPDATE user_links SET fit_count = fit_count + 1 "
    "WHERE id = $1 AND user_id = $2"
)
_OLDER = (
    "SELECT 1 FROM messages WHERE conversation_id = $1 "
    "AND ($2::uuid IS NULL OR id <> $2) "
    "AND EXISTS (SELECT 1 FROM unnest($3::text[]) AS u(url) "
    "WHERE strpos(messages.text, u.url) > 0) LIMIT 1"
)
_LINKS = (
    "SELECT id, kind, url, title, status, fit_count, ai_read "
    "FROM user_links WHERE user_id = $1"
)


def has_https(value) -> bool:
    if isinstance(value, str):
        return "https://" in value
    if isinstance(value, dict):
        return any(has_https(key) or has_https(item) for key, item in value.items())
    if isinstance(value, (list, tuple, set)):
        return any(has_https(item) for item in value)
    return False


def _https_urls(text: str) -> list[str]:
    found = []
    seen = set()
    for raw in _URL_RE.findall(text or ""):
        url = raw.rstrip(".,;:!?")
        if url not in seen:
            seen.add(url)
            found.append(url)
            if len(found) == MAX_URLS_PER_MESSAGE:
                break
    return found


def _canon(url: str) -> str:
    trimmed = url[:-1] if url.endswith("/") else url
    scheme, sep, rest = trimmed.partition("://")
    if not sep:
        return trimmed
    host, slash, path = rest.partition("/")
    return scheme.lower() + "://" + host.lower() + (slash + path if slash else "")


def _repo(url: str) -> tuple[str, str] | None:
    match = _REPO_RE.match(_canon(url))
    if match is None:
        return None
    owner, repo = match.group(1), match.group(2)
    if owner in {".", ".."} or repo in {".", ".."}:
        return None
    return owner, repo


def _in_context(context, needle: str) -> bool:
    if needle == "":
        return False
    if isinstance(context, str):
        return needle in context
    if isinstance(context, dict):
        return any(
            _in_context(key, needle) or _in_context(item, needle)
            for key, item in context.items())
    if isinstance(context, (list, tuple, set)):
        return any(_in_context(item, needle) for item in context)
    return str(context) == needle


async def _default_fetch(url: str):
    import httpx
    async with httpx.AsyncClient(timeout=20.0) as client:
        return await client.get(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "push-ai",
            },
        )


def _status(response) -> int:
    if isinstance(response, int):
        return response
    code = getattr(response, "status_code", None)
    if code is None and isinstance(response, dict):
        code = response.get("status_code", response.get("status"))
    if code is None:
        return 599
    return int(code)


async def older_message_counted(query, conversation_id, exclude_message_id, text: str) -> bool:
    urls = _https_urls(text)
    if not urls:
        return False
    return bool(await query.fetch(_OLDER, conversation_id, exclude_message_id, urls))


async def _read_repo(query, fetch, row, owner: str, repo: str, user_id) -> None:
    await query.execute(_READING, row["id"], user_id)
    readme = "https://api.github.com/repos/" + owner + "/" + repo + "/readme"
    commits = (
        "https://api.github.com/repos/" + owner + "/" + repo + "/commits?per_page=5"
    )
    try:
        readme_response = await fetch(readme)
        if _status(readme_response) >= 400:
            return
        commits_response = await fetch(commits)
        if _status(commits_response) >= 400:
            return
    except Exception:
        return
    current = str(row.get("title") or "")
    title = repo if current.strip() == "" else current
    await query.execute(_READ, row["id"], user_id, title)


async def ingest_chat_links(
    query,
    *,
    user_id,
    conversation_id,
    text,
    context,
    already_counted: bool,
    fetch=None,
    exclude_message_id=None,
) -> None:
    if fetch is None:
        fetch = _default_fetch
    urls = _https_urls(text)
    rows = [dict(row) for row in await query.fetch(_LINKS, user_id)]
    by_url = {}
    for row in rows:
        by_url.setdefault(_canon(row["url"]), row)
    for url in urls:
        repo = _repo(url)
        if repo is None:
            key = _canon(url)
            if key in by_url:
                continue
            link_id = uuid4()
            await query.execute(_INSERT, link_id, user_id, url)
            created = {
                "id": link_id,
                "user_id": user_id,
                "kind": "job",
                "url": url,
                "title": "",
                "status": "READING",
                "fit_count": 0,
                "ai_read": False,
            }
            rows.append(created)
            by_url[key] = created
            continue
        row = by_url.get(_canon(url))
        if row is None or not row["ai_read"]:
            continue
        await _read_repo(query, fetch, row, repo[0], repo[1], user_id)
    if already_counted:
        return
    bumped = set()
    for row in rows:
        ident = str(row["id"])
        if ident in bumped:
            continue
        url = str(row["url"])
        if not (
            _in_context(context, ident)
            or _in_context(context, url)
            or _in_context(context, _canon(url))
        ):
            continue
        if await older_message_counted(
                query, conversation_id, exclude_message_id, url):
            continue
        bumped.add(ident)
        await query.execute(_FIT, row["id"], user_id)
