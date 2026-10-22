from __future__ import annotations
from app.clock import utcnow
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from app.db import DB, NotFoundError
from app.domain import entities as ent
from app.domain.access_mode import normalize_access_mode, resolve_access_mode
from app.domain.employer_chat import turn_from_payload
from app.domain.errors import (
    DomainError, internal, map_revision_err, not_found, revision_conflict,
    validation_field,
)
from app.domain.services.ai import AIGate
from app.domain.validators import code_point_len
from app.graphs.chat import build_chat_graph, byok_key_var as _BYOK_KEY
from app.graphs.chat import event_sink
from app.graphs.freeze import freeze_state, thaw_state
from app.jobs import (
    external_jobs, get_job_scheduler, schedule_chat_job, set_job_scheduler,
    sse_max_polls,
)
from app.infrastructure.store_ai import AiUsageStore
from app.infrastructure.store_applications import ApplicationStore
from app.infrastructure.store_chat_jobs import ChatJobStore
from app.infrastructure.store_evidence_chunks import EvidenceChunkStore
from app.infrastructure.store_conversations import ConversationStore
from app.infrastructure.store_documents import DocumentStore
from app.infrastructure.store_evidence import EvidenceStore
from app.infrastructure.store_operations import OperationStore


def _now() -> datetime:
    return utcnow()


# Workflow steps. prepare_reply is not a LangGraph node; the local graph
# still prepares inside generate_reply. Each name is one free-plan CPU budget.
WORKFLOW_NODES = (
    "resolve_context", "prepare_reply", "generate_reply", "persist")
MAX_STEP_FAILS = 3


def step_already_done(checkpoint: dict | None, name: str) -> bool:
    node = (checkpoint or {}).get("node") or ""
    if node not in WORKFLOW_NODES or name not in WORKFLOW_NODES:
        return False
    return WORKFLOW_NODES.index(node) >= WORKFLOW_NODES.index(name)


def step_fail_limit_reached(checkpoint: dict | None) -> bool:
    try:
        fails = int((checkpoint or {}).get("fails") or 0)
    except (TypeError, ValueError):
        return False
    return fails >= MAX_STEP_FAILS


_TOKEN_BATCH = 160
_TOKEN_FLUSH_S = 0.05
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


async def flush_chat_events(emit_many, job_id, queue: asyncio.Queue,
                            *, batch_chars: int = _TOKEN_BATCH,
                            flush_s: float = _TOKEN_FLUSH_S) -> None:
    """Write status immediately, the first token immediately, then chunks.

    ``emit_many`` is awaited between model deltas, so a streaming step
    publishes ``chat_events`` before the step returns. A retry deletes
    events after the checkpoint high-water, so a partial flush is safe.
    """
    batch: list[tuple[str, dict]] = []
    chars = 0
    saw_token = False

    async def flush() -> None:
        nonlocal batch, chars
        if not batch:
            return
        pending = batch
        batch = []
        chars = 0
        await emit_many(job_id, pending)

    while True:
        try:
            if batch:
                item = await asyncio.wait_for(queue.get(), flush_s)
            else:
                item = await queue.get()
        except asyncio.TimeoutError:
            await flush()
            continue
        if item is None:
            await flush()
            return
        if "status" in item:
            await flush()
            await emit_many(job_id, [("status", {"text": item["status"]})])
            continue
        live = _live_event(item)
        if live is not None:
            await flush()
            await emit_many(job_id, [live])
            continue
        if "token" not in item:
            continue
        text = item["token"]
        if not saw_token:
            await flush()
            await emit_many(job_id, [("token", {"text": text})])
            saw_token = True
            continue
        batch.append(("token", {"text": text}))
        chars += len(text or "")
        if chars >= batch_chars:
            await flush()


def _checkpoint_dict(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw:
        import json
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


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
        self.chunks = EvidenceChunkStore(db)
        self.document_svc = document_svc
        self.job_svc = job_svc
        self.application_svc = application_svc
        self._byok_keys: dict[UUID, str] = {}
        self._sem = asyncio.Semaphore(4)
        self._worker_task: Optional[asyncio.Task] = None
        self._inflight: set[asyncio.Task] = set()
        self._wake = asyncio.Event()
        self._scheduler_installed = False
        self._prev_scheduler = None
        self._checkpointer = checkpointer
        self._compiled = None

    @property
    def graph(self):
        # LangGraph compile is the heavy import. Health and auth requests
        # never touch it; the first local chat message in an isolate does.
        from app.config import harness_enabled
        if harness_enabled():
            from app.harness.runtime import HarnessRuntime
            runtime = getattr(self, "_harness_runtime", None)
            if runtime is None:
                runtime = HarnessRuntime(self)
                self._harness_runtime = runtime
            return runtime
        if self._compiled is None:
            self._compiled = build_chat_graph(self, self._checkpointer)
        return self._compiled

    def ensure_chat_nodes(self) -> None:
        # Workflow steps call node functions directly and skip compile.
        if getattr(self, "chat_nodes", None):
            return
        from app.graphs.chat import bind_chat_nodes
        bind_chat_nodes(self)

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

        async def _schedule(job_id, byok="", claim="") -> None:
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
        delay = IDLE_MIN_S
        last_stale = _loop_time()
        while True:
            if _loop_time() - last_stale >= STALE_SWEEP_S:
                try:
                    await self.jobs.reset_stale()
                except Exception:
                    log.exception("chat job stale sweep failed")
                last_stale = _loop_time()
            try:
                job = await self.jobs.claim()
            except Exception:
                log.exception("chat job claim failed")
                delay = await self._idle_pause(delay)
                continue
            if job is None:
                delay = await self._idle_pause(delay)
                continue
            delay = IDLE_MIN_S
            t = asyncio.create_task(self._run_job(job))
            self._inflight.add(t)
            t.add_done_callback(self._inflight.discard)

    async def _notify_ai_done(self, user_id, conversation_id) -> None:
        try:
            from app.domain.chat_settings import insert_ai_done
            await insert_ai_done(self.db.q(), user_id, conversation_id)
        except Exception:
            logging.getLogger(__name__).exception("AI_DONE insert failed")

    async def _run_job(self, job: dict) -> None:
        log = logging.getLogger(__name__)
        job_id = job["id"]
        async with self._sem:
            p = job["payload"]
            token = _BYOK_KEY.set(self._byok_keys.get(job_id, ""))
            terminal = False
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
                            "job_id": str(job_id),
                            **turn_from_payload(p),
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
                    await self.jobs.emit(
                        job_id, "error",
                        {"error": {"code": "INTERNAL",
                                   "message": str(e)[:500]}})
                    await self.jobs.finish(job_id, "FAILED", str(e)[:500])
                    terminal = True
            finally:
                _BYOK_KEY.reset(token)
                if terminal:
                    self._byok_keys.pop(job_id, None)

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
        access_mode = await self._canonical_access(user_id, access_mode)
        self._validate_message(text, access_mode)
        if external_jobs():
            return await self._enqueue(
                user_id, conversation_id, text, context, ai, access_mode, byok_key)
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

    async def _canonical_access(self, user_id, raw: str) -> str:
        try:
            requested = normalize_access_mode(raw if raw else None)
        except ValueError:
            raise validation_field(
                "accessMode",
                "must be ALWAYS_ASK, AUTO, BYPASS, SUGGEST, or CONFIRM_ACTIONS")
        if requested is not None:
            return requested.value
        saved = None
        try:
            row = await self.db.q().fetchrow(
                "SELECT to_jsonb(user_settings)->>'ai_access_mode' AS ai_access_mode "
                "FROM user_settings WHERE user_id = $1",
                user_id,
            )
            if row is not None:
                saved = row["ai_access_mode"]
        except Exception:
            saved = None
        return resolve_access_mode(None, saved).value

    def _validate_message(self, text: str, access_mode: str) -> None:
        if not text or code_point_len(text) > 20000:
            raise validation_field("text", "text must be 1-20000 characters")
        if not ent.valid_access_mode(access_mode):
            raise validation_field(
                "accessMode",
                "must be ALWAYS_ASK, AUTO, BYPASS, SUGGEST, or CONFIRM_ACTIONS")

    def _chat_input(self, user_id: UUID, conversation_id: UUID, text: str,
                    context: dict, ai: Optional[ent.AiOptions],
                    access_mode: str, intent: str | None = None,
                    application_id=None) -> dict:
        return {
            "user_id": user_id,
            "conversation_id": conversation_id,
            "text": text,
            "context": context or {},
            "ai": ai.model_dump(by_alias=True) if ai else None,
            "access_mode": access_mode,
            "operation": None,
            **turn_from_payload({"intent": intent, "application_id": application_id}),
        }

    async def stream_message(self, user_id: UUID, conversation_id: UUID,
                             text: str, context: dict,
                             ai: Optional[ent.AiOptions], access_mode: str,
                             byok_key: str = "", intent: str | None = None,
                             application_id=None):
        access_mode = await self._canonical_access(user_id, access_mode)
        self._validate_message(text, access_mode)
        if self._worker_task is not None or external_jobs():
            async for ev in self._stream_via_queue(
                    user_id, conversation_id, text, context, ai, access_mode,
                    byok_key, intent, application_id):
                yield ev
            return
        token = _BYOK_KEY.set(byok_key)
        try:
            async for mode, chunk in self.graph.astream(
                    self._chat_input(user_id, conversation_id, text, context,
                                     ai, access_mode, intent, application_id),
                    config={"configurable": {"thread_id": str(conversation_id)}},
                    stream_mode=["custom", "values"]):
                if mode == "custom" and isinstance(chunk, dict) and "token" in chunk:
                    yield ("token", chunk["token"], None)
                elif mode == "custom" and isinstance(chunk, dict) and "status" in chunk:
                    yield ("status", chunk["status"], None)
                elif mode == "custom" and isinstance(chunk, dict):
                    live = _live_event(chunk)
                    if live is not None:
                        yield (live[0], live[1], None)
                elif mode == "values" and chunk.get("operation") is not None:
                    yield ("done", chunk["operation"], None)
        finally:
            _BYOK_KEY.reset(token)

    async def _allow_chat(self, user_id, ai, byok_key: str = "") -> None:
        # The Workflow still checks inside the model call. This one runs
        # first so a rejected chat never enqueues, never embeds, and returns
        # the same 403 the synchronous path returned.
        if ai is None or self.ai is None:
            return
        await self.ai.check(user_id, ai, byok_key)

    async def _stream_via_queue(self, user_id, conversation_id, text, context,
                                ai, access_mode, byok_key, intent=None,
                                application_id=None):
        await self._allow_chat(user_id, ai, byok_key)
        payload = {
            "text": text,
            "context": context or {},
            "ai": ai.model_dump(by_alias=True) if ai else None,
            "access_mode": access_mode,
            "accessMode": access_mode,
            **turn_from_payload({"intent": intent, "application_id": application_id}),
        }
        payload = self._stash_byok(user_id, payload, byok_key)
        job_id = await self.jobs.enqueue_started(
            user_id, conversation_id, payload, "대기 중")
        if job_id is None:
            raise not_found()
        if byok_key:
            self._byok_keys[job_id] = byok_key
        if external_jobs():
            await schedule_chat_job(job_id, byok_key)
        async for ev in self._pump_job_events(job_id):
            yield ev

    async def active_job_id(self, user_id: UUID,
                            conversation_id: UUID) -> Optional[UUID]:
        await self.get(user_id, conversation_id)
        return await self.jobs.active_for_conversation(
            user_id, conversation_id)

    async def stream_active(self, user_id: UUID, conversation_id: UUID,
                            after: int = 0):
        job_id = await self.active_job_id(user_id, conversation_id)
        if job_id is None:
            return
        async for ev in self._pump_job_events(job_id, after):
            yield ev

    _PUMP_MAX_WAIT_S = 300.0

    async def _pump_job_events(self, job_id: UUID, after: int = 0):
        last_id = after
        idle = 0
        polls = 0
        limit = sse_max_polls()
        deadline = asyncio.get_running_loop().time() + self._PUMP_MAX_WAIT_S
        while polls < limit:
            polls += 1
            if asyncio.get_running_loop().time() > deadline:
                yield ("error", {"code": "INTERNAL",
                                 "message": "job timed out"}, None)
                return
            rows = await self.jobs.events_since(job_id, last_id)
            for r in rows:
                last_id = r["id"]
                t = r["type"]
                p = r["payload"]
                if t == "token":
                    yield ("token", p.get("text", ""), r["id"])
                elif t == "status":
                    yield ("status", p.get("text", ""), r["id"])
                elif t == "done":
                    yield ("done", p.get("operation"), r["id"])
                    return
                elif t == "error":
                    yield ("error", p.get("error") or {}, r["id"])
                    return
                elif t in _LIVE_EVENT_TYPES:
                    yield (t, p if isinstance(p, dict) else {}, r["id"])
                    if t == "cancelled":
                        return
            if rows:
                idle = 0
            else:
                idle += 1
                if idle >= 30:
                    st = await self.jobs.status(job_id)
                    if st == "FAILED":
                        yield ("error", {"code": "INTERNAL",
                                         "message": "job failed"}, None)
                        return
                    if st == "DONE":
                        return
                    idle = 0
            await asyncio.sleep(0.25 if external_jobs() else 0.2)

    def _stash_byok(self, user_id: UUID, payload: dict, byok_key: str) -> dict:
        cipher = getattr(self.ai, "cipher", None)
        if not byok_key or cipher is None:
            return payload
        import base64
        ct, nonce = cipher.encrypt(byok_key, user_id, "chat-job")
        stored = dict(payload)
        stored["_byok"] = {
            "ct": base64.b64encode(ct).decode(),
            "nonce": base64.b64encode(nonce).decode(),
        }
        return stored

    def _byok_from_payload(self, user_id, payload) -> str:
        cipher = getattr(self.ai, "cipher", None)
        blob = (payload or {}).get("_byok") if isinstance(payload, dict) else None
        if not blob or cipher is None:
            return ""
        import base64
        try:
            uid = user_id if isinstance(user_id, UUID) else UUID(str(user_id))
            return cipher.decrypt(
                base64.b64decode(blob["ct"]),
                base64.b64decode(blob["nonce"]),
                uid, "chat-job")
        except Exception:
            return ""

    async def _enqueue(self, user_id, conversation_id, text, context,
                                ai, access_mode, byok_key) -> ent.Operation:
        await self._allow_chat(user_id, ai, byok_key)
        payload = self._stash_byok(user_id, {
            "text": text,
            "context": context or {},
            "ai": ai.model_dump(by_alias=True) if ai else None,
            "access_mode": access_mode,
            "accessMode": access_mode,
        }, byok_key)
        # One statement checks the conversation, inserts the job, and writes
        # the first status so SSE shows progress before the Workflow starts.
        job_id = await self.jobs.enqueue_started(
            user_id, conversation_id, payload, "대기 중")
        if job_id is None:
            raise not_found()
        if byok_key:
            self._byok_keys[job_id] = byok_key
        await schedule_chat_job(job_id, byok_key)
        # The Workflow emits tokens and the finished operation. Waiting here
        # held the HTTP request for the whole model call (~10s plus a Neon
        # poll per tick). Clients already treat QUEUED as a 202 body and
        # follow the stream or the active SSE replay.
        now = _now()
        return ent.Operation(
            id=job_id, user_id=user_id, type=ent.OP_CHAT_MESSAGE,
            status=ent.OP_QUEUED,
            result=ent.OperationResult(
                kind=ent.OP_CHAT_MESSAGE, value={"jobId": str(job_id)}),
            created_at=now, updated_at=now)

    async def claim_for_workflow(self, job_id: str, claim: str = "") -> str:
        jid = UUID(str(job_id))
        if not claim:
            # Workflows scheduled before claim tokens. A RUNNING row is the
            # same run retrying its prepare step.
            job = await self.jobs.claim_id(jid)
            if job is None:
                existing = await self.jobs.get(jid)
                if existing is None or existing.get("status") != "RUNNING":
                    return "skip"
            return "ok"
        job = await self.jobs.claim_with_token(jid, claim)
        if job is not None:
            return "ok"
        if await self.jobs.touch_owner(jid, claim):
            return "ok"
        existing = await self.jobs.get(jid)
        if existing is not None and existing.get("status") == "DONE":
            return "ok"
        return "skip"

    async def exec_chat_node(self, job_id: str, name: str, claim: str = "") -> str:
        from app.claimctx import LostClaim, claim_job, claim_token
        jid = UUID(str(job_id))
        token_ctx = claim_token.set(claim or "")
        job_ctx = claim_job.set(str(jid) if claim else "")
        try:
            return await self._exec_chat_node(jid, name, claim)
        finally:
            claim_token.reset(token_ctx)
            claim_job.reset(job_ctx)

    async def _exec_chat_node(self, jid: UUID, name: str, claim: str) -> str:
        from app.claimctx import LostClaim
        if claim:
            if not await self.jobs.touch_owner(jid, claim):
                existing = await self.jobs.get(jid)
                if existing is not None and existing.get("status") == "DONE":
                    return "ok"
                return "skip"
        job = await self.jobs.get(jid)
        if job is None:
            return "skip"
        status = job.get("status")
        if status == "DONE":
            return "ok"
        if status == "FAILED":
            return "error"
        payload = job["payload"] if isinstance(job["payload"], dict) else {}
        ck = _checkpoint_dict(job.get("checkpoint"))
        if step_already_done(ck, name):
            if name == "persist" and status == "RUNNING":
                try:
                    await self.jobs.finish(jid, "DONE")
                    await self._notify_ai_done(
                        job["user_id"], job["conversation_id"])
                except LostClaim:
                    return "skip"
            return "ok"
        if step_fail_limit_reached(ck):
            await self._fail_step(jid, "step exceeded retry limit")
            return "error"
        # Drop events from a previous attempt of this step. Earlier steps
        # stay; their high-water id is stored on the checkpoint.
        hw = int(ck.get("event_id") or 0)
        try:
            await self.jobs.delete_events_after(jid, hw)
            fails = int(ck.get("fails") or 0) + 1
            await self.jobs.save_checkpoint(jid, {**ck, "fails": fails})
        except LostClaim:
            return "skip"
        byok = self._byok_keys.get(jid) or self._byok_from_payload(
            job["user_id"], payload)
        token = _BYOK_KEY.set(byok or "")
        queue: asyncio.Queue = asyncio.Queue()
        closed = False

        class _Sink:
            def append(self, item: dict) -> None:
                queue.put_nowait(item)

        async def close_pump() -> None:
            nonlocal closed
            if closed:
                return
            closed = True
            queue.put_nowait(None)
            try:
                await pump
            except LostClaim:
                pass

        sink = event_sink.set(_Sink())
        pump = asyncio.create_task(
            flush_chat_events(self.jobs.emit_many, jid, queue))
        try:
            state = thaw_state((ck or {}).get("state") or {})
            if not state:
                state = {
                    "user_id": job["user_id"],
                    "conversation_id": job["conversation_id"],
                    "text": payload.get("text") or "",
                    "context": payload.get("context") or {},
                    "ai": payload.get("ai"),
                    "access_mode": payload.get("access_mode") or "SUGGEST",
                    "operation": None,
                    "job_id": str(jid),
                    **turn_from_payload(payload),
                }
            self.ensure_chat_nodes()
            try:
                update = await self.chat_nodes[name](state)
                if update:
                    state.update(update)
                await close_pump()
                if name == "persist" and state.get("operation") is not None:
                    from app.jsonutil import to_jsonable
                    await self.jobs.emit(
                        jid, "done",
                        {"operation": to_jsonable(state["operation"])})
                    await self.jobs.finish(jid, "DONE")
                    await self._notify_ai_done(
                        job["user_id"], job["conversation_id"])
                    self._byok_keys.pop(jid, None)
                event_id = await self.jobs.max_event_id(jid)
                await self.jobs.save_checkpoint(
                    jid, {"state": freeze_state(state), "node": name,
                          "event_id": event_id, "fails": 0})
                return "ok"
            except LostClaim:
                await close_pump()
                return "skip"
            except DomainError as e:
                await close_pump()
                await self._drop_enqueued_user_message(jid)
                try:
                    await self.jobs.emit(
                        jid, "error",
                        {"error": {"code": e.code, "message": e.message,
                                   "details": e.details}})
                    await self.jobs.finish(jid, "FAILED", e.code)
                except LostClaim:
                    return "skip"
                return "error"
            except Exception:
                # Leave the incremented fails count in the checkpoint and let
                # the Workflow retry the step. A CPU-limit kill (Error 1102)
                # never reaches this handler; the same checkpoint makes that
                # retry idempotent. Events flushed during this attempt sit
                # above the saved high-water and are deleted on the retry.
                await close_pump()
                logging.getLogger(__name__).exception("chat node %s failed", name)
                raise
        finally:
            if not closed:
                closed = True
                queue.put_nowait(None)
                pump.cancel()
                try:
                    await pump
                except (asyncio.CancelledError, Exception):
                    pass
            event_sink.reset(sink)
            _BYOK_KEY.reset(token)

    async def _drop_enqueued_user_message(self, job_id: UUID) -> None:
        """A rejected chat must not keep the USER row written at enqueue."""
        from app.infrastructure.store_chat_jobs import user_message_id
        try:
            await self.conversations.delete_unlinked_user_message(
                user_message_id(job_id))
        except Exception:
            logging.getLogger(__name__).exception(
                "user message rollback failed")

    async def _fail_step(self, job_id: UUID, message: str) -> None:
        from app.claimctx import LostClaim
        try:
            await self.jobs.emit(
                job_id, "error",
                {"error": {"code": "INTERNAL", "message": message,
                           "details": None}})
            await self.jobs.finish(job_id, "FAILED", message)
        except LostClaim:
            return

    async def nudge_pending(self) -> int:
        from app.jobs import remote_executor
        # The resident VPS loop claims PENDING rows. A cron nudge here would
        # start a second Workflow on the same job.
        if remote_executor():
            return 0
        await self.jobs.reset_stale()
        ids = await self.jobs.pending_ids(5)
        for pending in ids:
            await schedule_chat_job(pending, "")
        return len(ids)
