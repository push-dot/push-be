from __future__ import annotations

import socket
from types import SimpleNamespace
from uuid import UUID

from app.domain.link_ingest import ingest_chat_links

USER_ID = UUID("00000000-0000-4000-8000-0000000000aa")
CONV_ID = UUID("00000000-0000-4000-8000-0000000000bb")
LINK_ID = UUID("00000000-0000-4000-8000-0000000000c1")
OTHER_ID = UUID("00000000-0000-4000-8000-0000000000c2")
REPO_URL = "https://github.com/acme/widget"
README_URL = "https://api.github.com/repos/acme/widget/readme"
COMMITS_URL = "https://api.github.com/repos/acme/widget/commits?per_page=5"
JOB_URL = "https://jobs.example/role/9"


class Query:
    def __init__(self, rows=None):
        self.rows = [dict(row) for row in (rows or [])]
        self.inserts = []
        self.executes = []

    async def fetch(self, sql, *args):
        if "user_links" not in sql:
            return []
        user_id = args[0]
        return [dict(row) for row in self.rows if row["user_id"] == user_id]

    async def execute(self, sql, *args):
        self.executes.append((sql, args))
        if "SET status = 'READING'" in sql:
            self._row(args[0])["status"] = "READING"
            return
        if "SET status = 'READ'" in sql:
            row = self._row(args[0])
            row["status"] = "READ"
            row["title"] = args[2]
            return
        if "fit_count = fit_count + 1" in sql:
            self._row(args[0])["fit_count"] += 1
            return
        if "INSERT INTO user_links" in sql:
            self.inserts.append(sql)
            self.rows.append({
                "id": args[0],
                "user_id": args[1],
                "kind": "job",
                "url": args[2],
                "title": "",
                "status": "READING",
                "fit_count": 0,
                "ai_read": False,
            })

    def _row(self, link_id):
        for row in self.rows:
            if row["id"] == link_id:
                return row
        raise AssertionError(link_id)

    def fit_updates(self) -> int:
        return sum(1 for sql, _args in self.executes if "fit_count = fit_count + 1" in sql)


class Fetch:
    def __init__(self, query: Query, status_code: int = 200, error: bool = False):
        self.query = query
        self.status_code = status_code
        self.error = error
        self.urls = []
        self.statuses = []

    async def __call__(self, url):
        self.urls.append(url)
        github = [row["status"] for row in self.query.rows if row["url"] == REPO_URL]
        self.statuses.append(github[0] if github else None)
        if self.error:
            raise RuntimeError("network down")
        return SimpleNamespace(status_code=self.status_code, text="body")


def _link(link_id, url, *, title="", status="READ", fit_count=0, ai_read=True, kind="github"):
    return {
        "id": link_id,
        "user_id": USER_ID,
        "kind": kind,
        "url": url,
        "title": title,
        "status": status,
        "fit_count": fit_count,
        "ai_read": ai_read,
    }


def _run(query, fetch, text, context, already_counted):
    return ingest_chat_links(
        query,
        fetch=fetch,
        user_id=USER_ID,
        conversation_id=CONV_ID,
        text=text,
        context=context,
        already_counted=already_counted,
    )


def test_import_does_not_open_a_socket(monkeypatch):
    def blocked(*_args, **_kwargs):
        raise AssertionError("socket")

    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)
    import importlib
    import app.domain.link_ingest as link_ingest
    importlib.reload(link_ingest)


async def test_github_read_sets_read_and_repo_title():
    query = Query([_link(LINK_ID, REPO_URL, title="")])
    fetch = Fetch(query)
    await _run(query, fetch, "look at " + REPO_URL, {}, True)
    row = query._row(LINK_ID)
    assert fetch.statuses == ["READING", "READING"]
    assert fetch.urls == [README_URL, COMMITS_URL]
    assert row["status"] == "READ"
    assert row["title"] == "widget"
    assert "body" not in " ".join(sql for sql, _args in query.executes)


async def test_failed_fetch_stays_reading():
    query = Query([_link(LINK_ID, REPO_URL, title="")])
    fetch = Fetch(query, error=True)
    await _run(query, fetch, REPO_URL, {}, True)
    row = query._row(LINK_ID)
    assert fetch.statuses == ["READING"]
    assert row["status"] == "READING"
    assert row["title"] == ""


async def test_http_error_stays_reading():
    query = Query([_link(LINK_ID, REPO_URL, title="Widget")])
    fetch = Fetch(query, status_code=404)
    await _run(query, fetch, REPO_URL, {}, True)
    row = query._row(LINK_ID)
    assert row["status"] == "READING"
    assert row["title"] == "Widget"
    assert all("SET status = 'READ'" not in sql for sql, _args in query.executes)


async def test_ai_read_false_skips_fetch():
    query = Query([_link(LINK_ID, REPO_URL, title="", ai_read=False)])
    fetch = Fetch(query)
    await _run(query, fetch, REPO_URL, {}, True)
    row = query._row(LINK_ID)
    assert fetch.urls == []
    assert row["status"] == "READ"
    assert row["title"] == ""
    assert query.executes == []


async def test_fit_count_increments_once():
    query = Query([
        _link(LINK_ID, "https://portfolio.example/ada", kind="portfolio", ai_read=False),
        _link(OTHER_ID, JOB_URL, kind="job", ai_read=False, fit_count=2),
    ])
    fetch = Fetch(query)
    context = {
        "linkId": str(LINK_ID),
        "posting": JOB_URL,
        "page": "https://portfolio.example/ada",
    }
    await _run(query, fetch, "tailor this", context, False)
    assert query._row(LINK_ID)["fit_count"] == 1
    assert query._row(OTHER_ID)["fit_count"] == 3
    assert query.fit_updates() == 2
    await _run(query, fetch, "tailor this", context, True)
    assert query._row(LINK_ID)["fit_count"] == 1
    assert query._row(OTHER_ID)["fit_count"] == 3
    assert query.fit_updates() == 2
    assert fetch.urls == []


async def test_job_url_inserts_once():
    query = Query()
    fetch = Fetch(query)
    text = "apply " + JOB_URL
    await _run(query, fetch, text, {}, False)
    await _run(query, fetch, text, {}, False)
    assert len(query.rows) == 1
    assert len(query.inserts) == 1
    sql = query.inserts[0]
    assert "job" in sql
    assert "READING" in sql
    assert "false" in sql
    row = query.rows[0]
    assert row["user_id"] == USER_ID
    assert row["url"] == JOB_URL
    assert row["kind"] == "job"
    assert row["status"] == "READING"
    assert row["ai_read"] is False
    assert row["fit_count"] == 0
    assert row["title"] == ""
    assert fetch.urls == []


async def test_github_url_is_not_a_job_link():
    query = Query()
    fetch = Fetch(query)
    await _run(query, fetch, "repo " + REPO_URL, {}, False)
    assert query.rows == []
    assert query.inserts == []
    assert fetch.urls == []


async def test_one_message_inserts_a_bounded_number_of_links():
    from app.domain.link_ingest import MAX_URLS_PER_MESSAGE
    query = Query()
    text = " ".join(f"https://jobs.example/role/{n}" for n in range(500))
    await _run(query, Fetch(query), text, {}, True)
    assert len(query.inserts) == MAX_URLS_PER_MESSAGE


async def test_older_message_check_is_one_query_for_many_urls():
    from app.domain.link_ingest import older_message_counted

    class Counting:
        def __init__(self):
            self.calls = []

        async def fetch(self, sql, *args):
            self.calls.append(args)
            return []

    q = Counting()
    text = " ".join(f"https://jobs.example/role/{n}" for n in range(5))
    assert await older_message_counted(q, CONV_ID, None, text) is False
    assert len(q.calls) == 1 and len(q.calls[0][2]) == 5
