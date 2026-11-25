"""Which posting a document flow is about.

A bot has one thread for ever, and the flow keeps its state per thread. A new quick start carries
the saved inputs, analysis, and drafts forward, which is right only while it works on the same
posting. So a quick start that names another posting starts clean, and one that names none goes on.

A link alone cannot tell a posting from a portfolio: core passes attached links without their kind,
and a pasted link has none. So a link counts as new only when the saved flow has not read it, and a
new link starts clean. Asking for the posting again costs one answer; carrying A's analysis into B's
flow writes a wrong document.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.ingest.web_page import find_urls


def _dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def turn_links(payload: dict[str, Any]) -> list[str]:
    """Every link a turn brings, pasted ones first: a turn reads only its first two pages, and a
    link typed into this message must not lose its page to links attached from 자료."""
    context = _dict(payload.get("context"))
    attached = [url for url in context.get("urls") or [] if isinstance(url, str)]
    found = find_urls(payload.get("text") or "")
    return list(dict.fromkeys([*found, *attached]))


def turn_posting(payload: dict[str, Any], bot: dict[str, Any] | None) -> str | None:
    """The Push posting a turn works on: an attached one, else a company bot's own."""
    posting = _dict(payload.get("context")).get("postingId") or (bot or {}).get("postingId")
    return str(posting) if posting else None


def _url_key(url: str) -> str:
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip()
    return urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), parts.query, "")
    )


def own_material(url: str) -> bool:
    # A GitHub link is the user's own work, never the posting a flow is about.
    try:
        host = (urlsplit(url.strip()).hostname or "").lower()
    except ValueError:
        return False
    return host == "github.com" or host.endswith(".github.com")


def saved_for_turn(saved: dict[str, Any], posting: str | None, links: list[str]) -> dict[str, Any]:
    """The saved flow state a new quick start may build on: all of it while the turn stays on the
    flow's posting, else only the tone, which is the user's preference and not a fact about a
    posting. A turn that names a Push posting stays when the flow is about that posting. One that
    names none stays unless it brings a link the flow has not read."""
    inputs = _dict(saved.get("inputs"))
    if posting is not None:
        same = str(inputs.get("postingId") or "") == posting
    else:
        read = {_url_key(url) for url in inputs.get("pages") or {}}
        same = all(_url_key(url) in read for url in links if not own_material(url))
    if same:
        return saved
    return {"tone": saved["tone"]} if saved.get("tone") else {}


_DOCUMENT = re.compile(
    r"이력서|자소서|자기소개서|포트폴리오|\b(?:resume|cv|cover letter|portfolio)\b", re.I
)
# "써" only as a request: "이력서에 써 있는" names the document without asking for one.
_MAKE = re.compile(
    r"만들|작성|고쳐|고치|수정|맞춰|다듬|써\s*(?:줘|주|봐|달)"
    r"|\b(?:write|make|tailor|fix|draft|create|edit|polish)\b",
    re.I,
)


def resume_request(text: str, context: dict[str, Any] | None) -> bool:
    """A plain chat turn that asks to make or fix a document from material it attaches. Without
    attachments it is a question about documents, which the agent answers in chat."""
    context = _dict(context)
    material = bool(context.get("evidenceIds") or context.get("documentId"))
    return material and bool(_DOCUMENT.search(text or "")) and bool(_MAKE.search(text or ""))


def github_links(value: Any) -> list[str]:
    """inputs.github is a list of links; a lone string from older saved state still counts."""
    items = [value] if isinstance(value, str) else value if isinstance(value, list) else []
    return [str(item).strip() for item in items if str(item).strip()]
