"""In-memory stores shared by the test_cov_svc_* suites (no tests here).

Every fake scopes reads by user_id like the SQL stores do, returns deep
copies (a DB row is never the caller's object) and guards revisions with
ConflictError, so ownership and optimistic locking are exercised for real.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID, uuid4

from app.db import ConflictError, NotFoundError
from app.domain import entities as ent
from app.domain.pagination import Page

NIL = UUID(int=0)


def now() -> datetime:
    return datetime.now(timezone.utc)


class FakeDB:
    def __init__(self):
        self.runs = 0

    async def run(self, fn):
        self.runs += 1
        return await fn()

    async def do(self, fn):
        return await fn()


class _Table:
    def __init__(self):
        self.rows: dict = {}

    def put(self, row):
        self.rows[row.id] = row.model_copy(deep=True)
        return row

    def owned(self, user_id, id_):
        r = self.rows.get(UUID(str(id_)))
        if r is None or r.user_id != user_id:
            raise NotFoundError()
        return r.model_copy(deep=True)

    def guarded(self, row, expected: int):
        cur = self.rows.get(row.id)
        if cur is None or cur.user_id != row.user_id:
            raise NotFoundError()
        if cur.revision != expected:
            raise ConflictError(cur.revision)
        new = row.model_copy(deep=True)
        new.revision = expected + 1
        self.rows[row.id] = new


class ApprovalStore(_Table):
    async def create(self, a):
        self.put(a)

    async def get(self, user_id, id_):
        return self.owned(user_id, id_)

    async def list(self, user_id, application_id, status, page):
        items = [r.model_copy(deep=True) for r in self.rows.values()
                 if r.user_id == user_id
                 and (application_id is None or r.application_id == application_id)
                 and (status is None or r.status == status)]
        return Page(items=items)

    async def update(self, a, expected):
        self.guarded(a, expected)

    async def find_active(self, user_id, kind, application_id, target_id, at):
        hits = [r for r in self.rows.values()
                if r.user_id == user_id and r.kind == kind
                and r.application_id == application_id and r.target_id == target_id
                and r.status in (ent.APPROVAL_APPROVED, ent.APPROVAL_PENDING)
                and (r.expires_at is None or r.expires_at > at)]
        if not hits:
            raise NotFoundError()
        return max(hits, key=lambda r: r.created_at).model_copy(deep=True)


class EvidenceStore(_Table):
    async def create(self, e):
        self.put(e)

    async def get(self, user_id, id_):
        return self.owned(user_id, id_)

    async def list(self, user_id, kind, query, page):
        return Page(items=[r.model_copy(deep=True) for r in self.rows.values()
                           if r.user_id == user_id])

    async def update(self, e, expected):
        self.guarded(e, expected)


class DocumentStore(_Table):
    def __init__(self):
        super().__init__()
        self.versions: dict = {}
        self.proposals: list = []
        self.exports: list = []

    async def create(self, d):
        self.put(d)

    async def get(self, user_id, id_):
        return self.owned(user_id, id_)

    async def list(self, user_id, application_id, kind, page):
        return Page(items=[r for r in self.rows.values() if r.user_id == user_id])

    async def update(self, d, expected):
        self.guarded(d, expected)

    async def create_version(self, v):
        self.versions[v.id] = v.model_copy(deep=True)

    async def get_version(self, user_id, document_id, version_id):
        v = self.versions.get(UUID(str(version_id)))
        if (v is None or v.user_id != user_id
                or (document_id != NIL and v.document_id != document_id)):
            raise NotFoundError()
        return v.model_copy(deep=True)

    async def next_version_number(self, document_id):
        return 1 + sum(1 for v in self.versions.values()
                       if v.document_id == document_id)

    async def create_proposal(self, p):
        self.proposals.append(p)

    async def create_export(self, e):
        self.exports.append(e)


class OperationStore(_Table):
    def __init__(self):
        super().__init__()
        self.updates = 0

    async def create(self, o):
        self.put(o)

    async def get(self, user_id, id_):
        return self.owned(user_id, id_)

    async def update(self, o):
        if o.id not in self.rows:
            raise NotFoundError()
        self.updates += 1
        self.put(o)


class ApplicationStore(_Table):
    def __init__(self):
        super().__init__()
        self.events: list = []

    async def get(self, user_id, id_):
        return self.owned(user_id, id_)

    async def add_event(self, e):
        self.events.append(e)


class OwnedStore(_Table):
    """Generic owned lookup used for jobs / interviews."""

    async def get(self, user_id, id_):
        return self.owned(user_id, id_)


class SubmissionStore(_Table):
    async def get_draft(self, user_id, id_):
        return self.owned(user_id, id_)


class ProjectStore(_Table):
    async def get_run(self, user_id, project_id, run_id):
        r = self.owned(user_id, run_id)
        if project_id != NIL and r.project_id != project_id:
            raise NotFoundError()
        return r


class SourceStore:
    def __init__(self):
        self.rows: dict = {}

    def add(self, user_id, body: bytes, mime="text/plain", name="cv.txt"):
        s = ent.Source(id=uuid4(), user_id=user_id, file_name=name,
                       mime_type=mime, size=len(body), sha256="x",
                       path="db://x", created_at=now())
        self.rows[s.id] = (s, body)
        return s

    async def get(self, user_id, id_):
        row = self.rows.get(id_)
        if row is None or row[0].user_id != user_id:
            raise NotFoundError()
        return row[0]

    async def content(self, user_id, id_):
        await self.get(user_id, id_)
        return self.rows[id_][1]


class Boom:
    """Any awaited method raises a non-domain error (simulated DB outage)."""

    def __getattr__(self, name):
        async def fail(*a, **k):
            raise RuntimeError("db down")
        return fail


class AIGate:
    def __init__(self, err: Optional[Exception] = None):
        self.err = err
        self.checked: list = []

    async def check(self, user_id, ai):
        self.checked.append((user_id, ai))
        if self.err is not None:
            raise self.err


# ---- entity builders -------------------------------------------------------

def evidence(user_id, text="Built a Go API serving 1M req/day", **kw):
    return ent.CareerEvidence(
        id=kw.pop("id", uuid4()), user_id=user_id, kind=kw.pop("kind", "CAREER"),
        title=kw.pop("title", "Backend"), source_text=text,
        provenance=ent.Provenance(content_hash=kw.pop("content_hash", "h-" + text[:8])),
        created_at=now(), updated_at=now(), **kw)


def application(user_id, job_id=None):
    return ent.Application(id=uuid4(), user_id=user_id, job_id=job_id or uuid4(),
                           company="Acme", title="BE", created_at=now(),
                           updated_at=now())


def job(user_id, id_=None, requirements=("Go", "SQL")):
    return ent.JobPosting(id=id_ or uuid4(), user_id=user_id, company="Acme",
                          title="BE", source_kind="TEXT", source_text="t",
                          requirements=list(requirements), created_at=now(),
                          updated_at=now())


def document(user_id, application_id=None, **kw):
    return ent.Document(id=uuid4(), user_id=user_id, application_id=application_id,
                        title=kw.pop("title", "CV"), kind="RESUME",
                        template=kw.pop("template", "SIMPLE"), language="ko",
                        created_at=now(), updated_at=now(), **kw)


def version(user_id, doc, blocks_text=("hello world",), refs=None, number=1):
    nodes, blocks = [], []
    for i, t in enumerate(blocks_text, 1):
        bid = f"b{i}"
        nodes.append({"type": "paragraph", "attrs": {"blockId": bid},
                      "content": [{"type": "text", "text": t}]})
        blocks.append(ent.Block(id=bid, text=t,
                                evidence_refs=(refs or {}).get(bid, []),
                                claim_status=ent.CLAIM_SUPPORTED))
    return ent.DocumentVersion(
        id=uuid4(), user_id=user_id, document_id=doc.id,
        application_id=doc.application_id, number=number,
        content={"type": "doc", "content": nodes}, blocks=blocks,
        created_at=now())


def approval(user_id, kind=ent.APPROVAL_EVIDENCE_USE, target_id=None,
             application_id=None, status=ent.APPROVAL_PENDING,
             payload_hash="h", expires_in=timedelta(hours=1), revision=1):
    t = now()
    return ent.Approval(
        id=uuid4(), user_id=user_id, revision=revision, kind=kind,
        application_id=application_id, target_id=target_id or uuid4(),
        payload_hash=payload_hash, status=status,
        expires_at=None if expires_in is None else t + expires_in,
        created_at=t, updated_at=t)
