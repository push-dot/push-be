from __future__ import annotations
from app.clock import utcnow
import asyncio
import logging
from datetime import datetime
from typing import Optional
from uuid import UUID

from app.db import DB
from app.domain.managed_ai import with_managed_default
from app.domain.employer_chat import turn_from_payload
from app.domain.errors import DomainError
from app.domain.services.ai import AIGate
from app.jobs import get_job_scheduler, set_job_scheduler
from app.infrastructure.store_ai import AiUsageStore
from app.infrastructure.store_applications import ApplicationStore
from app.infrastructure.store_chat_jobs import ChatJobStore
from app.rag.store import RagNodeStore
from app.infrastructure.store_conversations import ConversationStore
from app.infrastructure.store_documents import DocumentStore
from app.infrastructure.store_evidence import EvidenceStore
from app.infrastructure.store_operations import OperationStore


def _now() -> datetime:
    return utcnow()


_LIVE_EVENT_TYPES = frozenset({
    "tool", "todo", "diff", "approval", "choice", "fit", "cancelled", "file", "done"})


def _live_event(chunk: dict):
    kind = chunk.get("type")
    if kind not in _LIVE_EVENT_TYPES:
        return None
    return kind, {key: value for key, value in chunk.items() if key != "type"}

IDLE_MIN_S = 1.0
IDLE_MAX_S = 60.0
# shortcut: 60s claim keeps Neon compute warm (suspend needs 5 min quiet), raise IDLE_MAX_S past 300 when a lost wake may wait that long
STALE_SWEEP_S = 15 * 60
MAX_INFLIGHT_JOBS = 4


def next_idle_delay(current: float, *, reset: bool) -> float:
    if reset:
        return IDLE_MIN_S
    doubled = current * 2
    if doubled > IDLE_MAX_S:
        return IDLE_MAX_S
    return doubled


def _loop_time() -> float:
    return asyncio.get_running_loop().time()


async def _wait(event: asyncio.Event, delay: float) -> bool:
    try:
        await asyncio.wait_for(event.wait(), delay)
    except TimeoutError:
        return False
    event.clear()
    return True


class ConversationService:
    def __init__(self, db: DB, ai: AIGate, checkpointer=None,
                 document_svc=None, job_svc=None, application_svc=None):
        self.db = db
        self.conversations = ConversationStore(db)
        self.applications = ApplicationStore(db)
        self.documents = DocumentStore(db)
        self.evidence = EvidenceStore(db)
        self.ops = OperationStore(db)
        self.ai = ai
        self.usage = AiUsageStore(db)
        self.jobs = ChatJobStore(db)
        self.nodes = RagNodeStore(db)
        self.document_svc = document_svc
        self.job_svc = job_svc
        self.application_svc = application_svc
        self._sem = asyncio.Semaphore(MAX_INFLIGHT_JOBS)
        self._worker_task: Optional[asyncio.Task] = None
        self._inflight: set[asyncio.Task] = set()
        self._wake = asyncio.Event()
        self._scheduler_installed = False
        self._prev_scheduler = None
        self._checkpointer = checkpointer

    @property
    def graph(self):
        # LangGraph compile is the heavy import. Health and auth requests
        # never touch it; the first local chat message in an isolate does.
        from app.harness.runtime import HarnessRuntime
        runtime = getattr(self, "_harness_runtime", None)
        if runtime is None:
            runtime = HarnessRuntime(self)
            self._harness_runtime = runtime
        return runtime

    def wake(self) -> None:
        event = getattr(self, "_wake", None)
        if event is not None:
            event.set()

    async def _idle_pause(self, delay: float) -> float:
        woke = await _wait(self._wake, delay)
        return next_idle_delay(delay, reset=woke)

    async def start_worker(self) -> None:
        # A restarted process has no live Workflow. Age 0 recovers immediately.
        # The cron path keeps the long threshold so it cannot steal a run
        # that is still inside its step timeout.
        if getattr(self, "_wake", None) is None:
            self._wake = asyncio.Event()
        self._prev_scheduler = get_job_scheduler()

        async def _schedule(job_id, claim="") -> None:
            self.wake()

        set_job_scheduler(_schedule)
        self._scheduler_installed = True
        try:
            recovered = await self.jobs.reset_stale(0)
            if recovered:
                logging.getLogger(__name__).info(
                    "requeued %d stale chat jobs", recovered)
            self._worker_task = asyncio.create_task(self._worker_loop())
        except Exception:
            set_job_scheduler(self._prev_scheduler)
            self._scheduler_installed = False
            raise

    async def stop_worker(self) -> None:
        try:
            if self._worker_task:
                self._worker_task.cancel()
                try:
                    await self._worker_task
                except asyncio.CancelledError:
                    pass
                self._worker_task = None
            if self._inflight:
                await asyncio.gather(*self._inflight, return_exceptions=True)
        finally:
            if getattr(self, "_scheduler_installed", False):
                set_job_scheduler(getattr(self, "_prev_scheduler", None))
                self._scheduler_installed = False

    async def _worker_loop(self) -> None:
        log = logging.getLogger(__name__)
        if getattr(self, "_sem", None) is None:  # built with __new__ by idle_db_probe
            self._sem = asyncio.Semaphore(MAX_INFLIGHT_JOBS)
        delay = IDLE_MIN_S
        last_stale = _loop_time()
        while True:
            if _loop_time() - last_stale >= STALE_SWEEP_S:
                try:
                    await self.jobs.reset_stale()
                except Exception:
                    log.exception("chat job stale sweep failed")
                try:
                    from app.queue.admin import AdminJobs
                    await AdminJobs(self.db.q()).expire_approvals(_now())
                except Exception:
                    log.exception("approval expiry sweep failed")
                last_stale = _loop_time()
            # Claim only with a free run slot. A claimed job that waits for one
            # ages toward the stale sweep and would be requeued and run twice.
            await self._sem.acquire()
            try:
                job = await self.jobs.claim()
            except BaseException as err:
                self._sem.release()
                if not isinstance(err, Exception):
                    raise
                log.exception("chat job claim failed")
                delay = await self._idle_pause(delay)
                continue
            if job is None:
                self._sem.release()
                delay = await self._idle_pause(delay)
                continue
            delay = IDLE_MIN_S
            t = asyncio.create_task(self._run_claimed(job))
            self._inflight.add(t)
            t.add_done_callback(self._inflight.discard)

    async def _run_claimed(self, job: dict) -> None:
        try:
            await self._run_job(job)
        finally:
            self._sem.release()

    async def _notify_ai_done(self, user_id, conversation_id) -> None:
        try:
            from app.domain.chat_settings import insert_ai_done
            await insert_ai_done(self.db.q(), user_id, conversation_id)
        except Exception:
            logging.getLogger(__name__).exception("AI_DONE insert failed")

    async def _run_job(self, job: dict) -> None:
        log = logging.getLogger(__name__)
        job_id = job["id"]
        p = job["payload"]
        terminal = False
        try:
            async for mode, chunk in self.graph.astream(
                    {
                        "user_id": job["user_id"],
                        "conversation_id": job["conversation_id"],
                        "text": p.get("text") or "",
                        "context": p.get("context") or {},
                        "ai": with_managed_default(p.get("ai")),
                        "access_mode": p.get("access_mode") or "SUGGEST",
                        "operation": None,
                        "job_id": str(job_id),
                        "event_id": 0,
                        **turn_from_payload(p),
                        **({"resume": p["resume"]} if p.get("resume") else {}),
                    },
                    config={"configurable": {
                        "thread_id": str(job["conversation_id"])}},
                    stream_mode=["custom", "values"]):
                if mode == "custom" and isinstance(chunk, dict):
                    if await self.jobs.status(job_id) == "CANCELLED":
                        terminal = True
                        break
                    if "token" in chunk:
                        await self.jobs.emit(
                            job_id, "token", {"text": chunk["token"]})
                    elif "status" in chunk:
                        await self.jobs.emit(
                            job_id, "status", {"text": chunk["status"]})
                    else:
                        live = _live_event(chunk)
                        if live is not None:
                            await self.jobs.emit(job_id, live[0], live[1])
                elif mode == "values" and chunk.get("operation"):
                    if await self.jobs.status(job_id) == "CANCELLED":
                        terminal = True
                        break
                    from app.jsonutil import to_jsonable
                    await self.jobs.emit(
                        job_id, "done",
                        {"operation": to_jsonable(chunk["operation"])})
            if not terminal:
                if await self.jobs.status(job_id) == "CANCELLED":
                    terminal = True
                else:
                    await self.jobs.finish(job_id, "DONE")
                    await self._notify_ai_done(
                        job["user_id"], job["conversation_id"])
                    terminal = True
        except DomainError as e:
            await self._drop_enqueued_user_message(job_id)
            await self.jobs.emit(
                job_id, "error",
                {"error": {"code": e.code, "message": e.message,
                           "details": e.details}})
            await self.jobs.finish(job_id, "FAILED", e.code)
            terminal = True
        except Exception as e:
            log.exception("chat job %s failed", job_id)
            if job["attempt"] < 3:
                await self.jobs.requeue(job_id, 2.0 * job["attempt"])
            else:
                # The cause can hold SQL or provider text; only the job row keeps it.
                await self.jobs.emit(
                    job_id, "error",
                    {"error": {"code": "INTERNAL", "message": "internal error"}})
                await self.jobs.finish(job_id, "FAILED", str(e)[:500])
                terminal = True

    async def _drop_enqueued_user_message(self, job_id: UUID) -> None:
        """A rejected chat must not keep the USER row written at enqueue."""
        from app.infrastructure.store_chat_jobs import user_message_id
        try:
            await self.conversations.delete_unlinked_user_message(
                user_message_id(job_id))
        except Exception:
            logging.getLogger(__name__).exception(
                "user message rollback failed")
