"""The scripted world the k-style loop runs in: an in-memory service, a model that answers by role or by
structured-output schema, and the interview rows a case seeds. Nothing here calls a provider."""
from __future__ import annotations

import importlib
import json
import re
from contextlib import contextmanager
from uuid import UUID

from langchain_core.messages import AIMessage

from app.domain import entities as ent
from app.harness.approval import _SUPPLIED
from app.infrastructure.posting_fit_cache import _PLAN
from app.harness.kstyle.subagent import LIGHT_MODEL
from app.ingest.web_page import Page
from tests import harness_fakes as hf
from tests import test_cov_svc_fakes as f
from tests.kstyle_fakes import RoleModel

# astructured_reply appends this rule to the system prompt; the schema name keys a structured reply.
_SCHEMA = re.compile(r"답은 반드시 `(\w+)` 도구")


class LoopRows(hf.Rows):
    """Rows that also know what the user said, so a URL from the opening message counts as supplied, as
    it does once the queue has stored the message, and the user's plan (FREE unless the case names one)."""

    def __init__(self, conversation: dict, said: list[str], plan: str = "FREE"):
        super().__init__(conversation)
        self.said = said
        self.plan = plan

    async def fetchrow(self, sql, *args):
        if sql == _PLAN:
            return {"plan": self.plan}
        return await super().fetchrow(sql, *args)

    async def fetch(self, sql, *args):
        if sql == _SUPPLIED:
            return [{"text": text, "links": []} for text in self.said]
        return await super().fetch(sql, *args)

    async def fetchval(self, sql, *args):
        return None


class LoopGate(hf.Gate):
    async def company_research(self, name, **kwargs):
        return ""


class ScriptedModel(RoleModel):
    """RoleModel keyed also by the structured-output schema name. A reply dict with "tool_calls" becomes an
    AIMessage with those calls, so the main agent can call tools from a JSON script."""

    def role(self, messages) -> str:
        system = "\n".join(str(m.content) for m in messages if getattr(m, "type", "") == "system")
        found = _SCHEMA.search(system)
        if found and found.group(1) in self.script:
            return found.group(1)
        return super().role(messages)

    async def ainvoke(self, messages, **kwargs):
        reply = await super().ainvoke(messages, **kwargs)
        try:
            data = json.loads(reply.content)
        except (TypeError, ValueError):
            return reply
        if not (isinstance(data, dict) and isinstance(data.get("tool_calls"), list)):
            return reply
        calls = [{"name": call["name"], "args": call.get("args") or {}, "type": "tool_call",
                  "id": call.get("id") or f"call-{len(self.calls)}-{i}"}
                 for i, call in enumerate(data["tool_calls"])]
        return AIMessage(content=data.get("content") or "", tool_calls=calls,
                         usage_metadata=reply.usage_metadata)


def model_cls(script: dict) -> type:
    """A class GateModel can build per call (cls(**kwargs)); every instance shares one script and call log.
    The log tier is "light" for the light model and "main" otherwise: mid runs the plan model too, so only
    the turn's stats tell main and mid apart."""
    calls: list = []

    class Scripted(ScriptedModel):
        log = calls

        def __init__(self, **kwargs):
            super().__init__(script, "light" if kwargs.get("model") == LIGHT_MODEL else "main", calls=calls)

    return Scripted


def _interviews(spec: dict, user_id: UUID):
    from app.domain.services.interview import InterviewService

    s = InterviewService(f.FakeDB(), f.AIGate())
    s.interviews, s.applications, s.jobs = f.OwnedStore(), f.ApplicationStore(), f.OwnedStore()
    s.evidence, s.ops = f.EvidenceStore(), f.OperationStore()
    job = s.jobs.put(f.job(user_id, requirements=spec["requirements"]))
    app = s.applications.put(f.application(user_id, job.id))
    evidence = [s.evidence.put(f.evidence(user_id, text=row["text"], title=row["title"], id=UUID(row["id"])))
                for row in spec["evidence"]]
    sources = [ent.CompanySource(source_url=row["url"], source_text=row["text"], accessed_at=f.now())
               for row in spec.get("company_sources") or []]
    s.interviews.put(ent.InterviewSession(
        id=UUID(spec["id"]), user_id=user_id, revision=1, application_id=app.id, title=spec.get("title", "면접"),
        scheduled_at=f.now(), evidence_ids=[e.id for e in evidence], company_sources=sources,
        created_at=f.now(), updated_at=f.now()))
    return s


def service(case: dict):
    conversation = dict(case.get("conversation") or {"company_id": None, "resume_state": None})
    svc = hf.service(LoopRows(conversation, [case.get("text") or ""], case.get("plan") or "FREE"))
    svc.ai = LoopGate()
    if case.get("interview"):
        svc.interviews = _interviews(case["interview"], hf.USER)
    return svc


# Every module that fetches a page or judges fit (its own provider call, outside the turn model) by a name
# bound at import; a scripted run reads the case's pages and gets a fixed fit score instead.
_PATCHED = (("app.harness.runtime", "fetch_page_text"), ("app.rag.readers", "fetch_page_text"),
            ("app.harness.personal.tools", "fetch_page"), ("app.harness.personal.resume.tools", "fetch_page"),
            ("app.harness.personal.resume.source_agents", "fetch_page"), ("app.framework.fit_judge", "judge_fit"),
            ("app.harness.personal.resume.tools", "judge_fit"), ("app.harness.personal.tools", "judge_fit"),
            ("app.harness.employer.tools", "judge_fit"), ("app.infrastructure.posting_fit_cache", "judge_fit"))


@contextmanager
def offline(pages: dict[str, str]):
    """No network: a URL in `pages` reads as that text, any other fails as an unreachable page would, and
    every fit judgement is the same middling score."""
    async def page(url, **_kwargs):
        if url not in pages:
            raise ConnectionError(url)
        return Page(url=url, text=pages[url])

    async def text(url):
        return pages.get(url, "")

    async def fit(*_args, **_kwargs):
        return {"fitScore": 50.0, "parts": {}, "topGap": "", "plan": "FREE"}

    fakes = {"fetch_page_text": text, "fetch_page": page, "judge_fit": fit}
    saved = []
    for name, attr in _PATCHED:
        module = importlib.import_module(name)
        if hasattr(module, attr):
            saved.append((module, attr, getattr(module, attr)))
            setattr(module, attr, fakes[attr])
    try:
        yield
    finally:
        for module, attr, old in saved:
            setattr(module, attr, old)


def stored_card(rows, approval_id: str) -> dict | None:
    """The card as the approvals row keeps it (id, kind, title, options): what the client reads when the
    stream did not carry the card. Stored options have no recommended pick."""
    for sql, args in reversed(rows.executed):
        if sql.lstrip().startswith("INSERT INTO approvals") and str(args[0]) == str(approval_id) and len(args) >= 8:
            options = json.loads(args[7]) if isinstance(args[7], str) else args[7]
            return {"id": str(args[0]), "kind": args[2], "title": args[6], "options": options}
    return None
