"""Which posting a document flow is about.

A bot has one thread for ever, and the flow keeps its state per thread. A new quick start carries
the saved inputs, analysis, and drafts forward, which is right only while it works on the same
posting. So a saved flow is about one subject, and a quick start that names another starts clean.
One that names the same subject, or none, continues. The subject is read from the flow's own
inputs, so a state saved before this rule has one too.
"""

from __future__ import annotations

from typing import TypedDict
from urllib.parse import urlsplit, urlunsplit

from app.ingest.web_page import find_urls


class Subject(TypedDict, total=False):
    postingId: str
    url: str


def _url_key(url: str) -> str:
    parts = urlsplit(url.strip())
    return urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), parts.query, "")
    )


def _posting_url(url: object) -> bool:
    # A GitHub link is the user's own material, never the posting a flow works on.
    return (
        isinstance(url, str)
        and url.startswith(("http://", "https://"))
        and "github.com" not in url.lower()
    )


def turn_subject(payload: dict, bot: dict | None) -> Subject | None:
    """What this turn names: an attached posting, then the first posting link it carries or its
    text holds, then a company bot's own posting. None means "go on with what we were doing"."""
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    if context.get("postingId"):
        return {"postingId": str(context["postingId"])}
    urls = [*(context.get("urls") or []), *find_urls(payload.get("text") or "")]
    for url in urls:
        if _posting_url(url):
            return {"url": _url_key(url)}
    if bot and bot.get("postingId"):
        return {"postingId": str(bot["postingId"])}
    return None


def subject_of(saved: dict) -> Subject | None:
    inputs = saved.get("inputs") if isinstance(saved.get("inputs"), dict) else {}
    if inputs.get("postingId"):
        return {"postingId": str(inputs["postingId"])}
    for url in inputs.get("pages") or {}:
        if _posting_url(url):
            return {"url": _url_key(url)}
    return None


def saved_for_turn(saved: dict, subject: Subject | None) -> dict:
    """The saved flow state a new quick start may build on: all of it for the same subject, else
    only the tone, which is the user's preference and not a fact about a posting."""
    if subject is None or subject_of(saved) == subject:
        return saved
    return {"tone": saved["tone"]} if saved.get("tone") else {}
