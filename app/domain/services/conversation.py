from __future__ import annotations
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from app.db import DB, NotFoundError
from app.domain import entities as ent
from app.domain.errors import (
    DomainError, internal, map_revision_err, not_found, revision_conflict,
    validation_field,
)
from app.domain.services.ai import AIGate
from app.domain.validators import code_point_len
from app.graph.chat import build_chat_graph, byok_key_var as _BYOK_KEY
from app.infrastructure.store_ai import AiUsageStore
from app.infrastructure.store_applications import ApplicationStore
from app.infrastructure.store_chat_jobs import ChatJobStore
from app.infrastructure.store_evidence_chunks import EvidenceChunkStore
from app.infrastructure.store_conversations import ConversationStore
from app.infrastructure.store_documents import DocumentStore
from app.infrastructure.store_evidence import EvidenceStore
from app.infrastructure.store_operations import OperationStore


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ConversationService:
    def __init__(self, db: DB, ai: AIGate, checkpointer=None,
                 document_svc=None):
        self.db = db
        self.conversations = ConversationStore(db)
        self.applications = ApplicationStore(db)
        self.documents = DocumentStore(db)
        self.evidence = EvidenceStore(db)
        self.ops = OperationStore(db)
        self.ai = ai
        self.usage = AiUsageStore(db)
        self.jobs = ChatJobStore(db)
        self.chunks = EvidenceChunkStore(db)
        self.document_svc = document_svc
        self._byok_keys: dict[UUID, str] = {}
        self._sem = asyncio.Semaphore(4)
        self._worker_task: Optional[asyncio.Task] = None
        self.graph = build_chat_graph(self, checkpointer)

    async def start_worker(self) -> None:
        recovered = await self.jobs.reset_stale()
        if recovered:
            logging.getLogger(__name__).info(
                "requeued %d stale chat jobs", recovered)
        self._worker_task = asyncio.create_task(self._worker_loop())

    async def stop_worker(self) -> None:
        if self._worker_task:
            self._worker_task.cancel()
            self._worker_task = None

    async def _worker_loop(self) -> None:
        log = logging.getLogger(__name__)
        while True:
            try:
                job = await self.jobs.claim()
            except Exception:
                log.exception("chat job claim failed")
                await asyncio.sleep(1)
                continue
            if job is None:
                await asyncio.sleep(0.3)
                continue
            asyncio.create_task(self._run_job(job))

    async def _run_job(self, job: dict) -> None:
        log = logging.getLogger(__name__)
        job_id = job["id"]
        async with self._sem:
            p = job["payload"]
            byok = self._byok_keys.pop(job_id, "")
            token = _BYOK_KEY.set(byok)
            try:
                async for mode, chunk in self.graph.astream(
                        {
                            "user_id": job["user_id"],
                            "conversation_id": job["conversation_id"],
                            "text": p["text"],
                            "context": p.get("context") or {},
                            "ai": p.get("ai"),
                            "access_mode": p.get("access_mode") or "SUGGEST",
                            "operation": None,
                        },
                        config={"configurable": {
                            "thread_id": str(job["conversation_id"])}},
                        stream_mode=["custom", "values"]):
                    if mode == "custom" and isinstance(chunk, dict):
                        if "token" in chunk:
                            await self.jobs.emit(
                                job_id, "token", {"text": chunk["token"]})
                        elif "status" in chunk:
                            await self.jobs.emit(
                                job_id, "status", {"text": chunk["status"]})
                    elif mode == "values" and chunk.get("operation"):
                        from app.jsonutil import to_jsonable
                        await self.jobs.emit(
                            job_id, "done",
                            {"operation": to_jsonable(chunk["operation"])})
                await self.jobs.finish(job_id, "DONE")
            except DomainError as e:
                await self.jobs.emit(
                    job_id, "error",
                    {"error": {"code": e.code, "message": e.message,
                               "details": e.details}})
                await self.jobs.finish(job_id, "FAILED", e.code)
            except Exception as e:
                log.exception("chat job %s failed", job_id)
                if job["attempt"] < 3:
                    await self.jobs.requeue(job_id, 2.0 * job["attempt"])
                else:
                    await self.jobs.emit(
                        job_id, "error",
                        {"error": {"code": "INTERNAL",
                                   "message": str(e)[:500]}})
                    await self.jobs.finish(job_id, "FAILED", str(e)[:500])
            finally:
                _BYOK_KEY.reset(token)

    async def list(self, user_id: UUID, application_id: Optional[UUID], page):
        try:
            return await self.conversations.list(user_id, application_id, page)
        except Exception:
            raise internal()

    async def get(self, user_id: UUID, id_: UUID) -> ent.Conversation:
        try:
            return await self.conversations.get(user_id, id_)
        except NotFoundError:
            raise not_found()
        except Exception:
            raise internal()

    async def create(self, user_id: UUID, application_id: Optional[UUID],
                     title: str) -> ent.Conversation:
        if len(title) > 300:
            raise validation_field("title", "title must be at most 300 characters")
        if application_id is not None:
            try:
                await self.applications.get(user_id, application_id)
            except NotFoundError:
                raise not_found()
            except Exception:
                raise internal()
        now = _now()
        c = ent.Conversation(
            id=uuid4(), user_id=user_id, revision=1, application_id=application_id,
            title=title, created_at=now, updated_at=now)
        try:
            await self.conversations.create(c)
        except Exception:
            raise internal()
        return c

    async def patch(self, user_id: UUID, id_: UUID, expected: int,
                    title: Optional[str], pinned: Optional[bool]) -> ent.Conversation:
        out = None

        async def work():
            nonlocal out
            try:
                v = await self.conversations.get(user_id, id_)
            except NotFoundError:
                raise not_found()
            if v.revision != expected:
                raise revision_conflict(v.revision)
            if title is not None:
                if len(title) > 300:
                    raise validation_field(
                        "title", "title must be at most 300 characters")
                v.title = title
            if pinned is not None:
                v.pinned = pinned
            v.updated_at = _now()
            try:
                await self.conversations.update(v, expected)
            except Exception as err:
                raise map_revision_err(err)
            v.revision = expected + 1
            out = v

        await self.db.run(work)
        return out

    async def archive(self, user_id: UUID, id_: UUID,
                      expected: int) -> ent.Conversation:
        out = None

        async def work():
            nonlocal out
            try:
                v = await self.conversations.get(user_id, id_)
            except NotFoundError:
                raise not_found()
            if v.revision != expected:
                raise revision_conflict(v.revision)
            v.archived = True
            v.updated_at = _now()
            try:
                await self.conversations.update(v, expected)
            except Exception as err:
                raise map_revision_err(err)
            v.revision = expected + 1
            out = v
            for eid in await self.conversations.evidence_ids_in(user_id, id_):
                if await self.conversations.evidence_refs_elsewhere(
                        user_id, id_, eid):
                    continue
                try:
                    e = await self.evidence.get(user_id, eid)
                except NotFoundError:
                    continue
                if e.archived:
                    continue
                e.archived = True
                e.updated_at = _now()
                try:
                    await self.evidence.update(e, e.revision)
                except Exception:
                    continue

        await self.db.run(work)
        return out

    async def list_messages(self, user_id: UUID, conversation_id: UUID, page):
        await self.get(user_id, conversation_id)
        try:
            return await self.conversations.list_messages(user_id, conversation_id, page)
        except Exception:
            raise internal()

    async def post_message(self, user_id: UUID, conversation_id: UUID, text: str,
                           context: dict, ai: Optional[ent.AiOptions],
                           access_mode: str,
                           byok_key: str = "") -> ent.Operation:
        self._validate_message(text, access_mode)
        token = _BYOK_KEY.set(byok_key)
        try:
            result = await self.graph.ainvoke(
                self._chat_input(user_id, conversation_id, text, context, ai,
                                 access_mode),
                config={"configurable": {"thread_id": str(conversation_id)}},
            )
        finally:
            _BYOK_KEY.reset(token)
        return result["operation"]

    def _validate_message(self, text: str, access_mode: str) -> None:
        if not text or code_point_len(text) > 20000:
            raise validation_field("text", "text must be 1-20000 characters")
        if not ent.valid_access_mode(access_mode):
            raise validation_field(
                "accessMode", "must be SUGGEST or CONFIRM_ACTIONS")

    def _chat_input(self, user_id: UUID, conversation_id: UUID, text: str,
                    context: dict, ai: Optional[ent.AiOptions],
                    access_mode: str) -> dict:
        return {
            "user_id": user_id,
            "conversation_id": conversation_id,
            "text": text,
            "context": context or {},
            "ai": ai.model_dump(by_alias=True) if ai else None,
            "access_mode": access_mode,
            "operation": None,
        }

    async def stream_message(self, user_id: UUID, conversation_id: UUID,
                             text: str, context: dict,
                             ai: Optional[ent.AiOptions], access_mode: str,
                             byok_key: str = ""):
        self._validate_message(text, access_mode)
        if self._worker_task is not None:
            async for ev in self._stream_via_queue(
                    user_id, conversation_id, text, context, ai, access_mode,
                    byok_key):
                yield ev
            return
        token = _BYOK_KEY.set(byok_key)
        try:
            async for mode, chunk in self.graph.astream(
                    self._chat_input(user_id, conversation_id, text, context,
                                     ai, access_mode),
                    config={"configurable": {"thread_id": str(conversation_id)}},
                    stream_mode=["custom", "values"]):
                if mode == "custom" and isinstance(chunk, dict) and "token" in chunk:
                    yield ("token", chunk["token"])
                elif mode == "custom" and isinstance(chunk, dict) and "status" in chunk:
                    yield ("status", chunk["status"])
                elif mode == "values" and chunk.get("operation") is not None:
                    yield ("done", chunk["operation"])
        finally:
            _BYOK_KEY.reset(token)

    async def _stream_via_queue(self, user_id, conversation_id, text, context,
                                ai, access_mode, byok_key):
        await self.get(user_id, conversation_id)
        payload = {
            "text": text,
            "context": context or {},
            "ai": ai.model_dump(by_alias=True) if ai else None,
            "access_mode": access_mode,
        }
        job_id = await self.jobs.enqueue(user_id, conversation_id, payload)
        if byok_key:
            self._byok_keys[job_id] = byok_key
        async for ev in self._pump_job_events(job_id):
            yield ev

    async def active_job_id(self, user_id: UUID,
                            conversation_id: UUID) -> Optional[UUID]:
        await self.get(user_id, conversation_id)
        return await self.jobs.active_for_conversation(
            user_id, conversation_id)

    async def stream_active(self, user_id: UUID, conversation_id: UUID):
        job_id = await self.active_job_id(user_id, conversation_id)
        if job_id is None:
            return
        async for ev in self._pump_job_events(job_id):
            yield ev

    async def _pump_job_events(self, job_id: UUID):
        last_id = 0
        idle = 0
        while True:
            rows = await self.jobs.events_since(job_id, last_id)
            for r in rows:
                last_id = r["id"]
                t = r["type"]
                p = r["payload"]
                if t == "token":
                    yield ("token", p.get("text", ""))
                elif t == "status":
                    yield ("status", p.get("text", ""))
                elif t == "done":
                    yield ("done", p.get("operation"))
                    return
                elif t == "error":
                    yield ("error", p.get("error") or {})
                    return
            if rows:
                idle = 0
            else:
                idle += 1
                if idle >= 30:
                    st = await self.jobs.status(job_id)
                    if st == "FAILED":
                        yield ("error", {"code": "INTERNAL",
                                         "message": "job failed"})
                        return
                    if st == "DONE":
                        return
                    idle = 0
            await asyncio.sleep(0.2)
