import asyncio
import contextlib
import json
import logging
import os
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import timedelta

from app.clock import utcnow
from app.domain.errors import missing_provider_key
from app.queue.backoff import backoff_seconds
from app.queue.config import TURN_QUEUES, job_deadlines
from app.queue.fairness import refresh_slot, release_slot, try_slot
from app.queue.locks import LockBusy, job_lock
from app.queue.streams import Message, StreamQueue


logger = logging.getLogger(__name__)

LOG_FIELDS = ("docIds", "promptHash", "tokensIn", "tokensOut")
_TURN = frozenset({"chat", "employer_ai"})


def core_from_env():
    origin = os.environ.get("CORE_ORIGIN", "").strip()
    token = os.environ.get("INTERNAL_JOB_TOKEN", "").strip()
    if not origin or not token:
        return None
    from app.harness.core_client import CoreClient

    return CoreClient(origin, os.environ.get("INTERNAL_API_SECRET", "").strip(), job_token=token)


def _outcome(result) -> str | None:
    if not isinstance(result, dict):
        return None
    if result.get("awaiting"):
        return "waiting"
    return "done" if "operationId" in result else None


async def notify_turn_done(core, job, result, outcome: str | None = None) -> None:
    outcome = outcome or _outcome(result)
    if core is None or outcome is None or job.get("type") not in _TURN:
        return
    # Only bot threads push a wait or a failure; employer turns run on the web.
    if outcome != "done" and job.get("type") != "chat":
        return
    conversation_id = job.get("conversation_id")
    if not conversation_id:
        return
    try:
        await core.call(
            "POST",
            "/api/v1/internal/notifications/ai-done",
            user_id=str(job["user_id"]),
            json={
                "userId": str(job["user_id"]),
                "conversationId": str(conversation_id),
                "jobId": str(job["id"]),
                **({} if outcome == "done" else {"outcome": outcome}),
            },
        )
    except Exception:
        logger.exception("ai-done notify failed")

type Renew = Callable[[], Awaitable[object]]


class JobCancelled(Exception):
    pass


class JobFailed(Exception):
    def __init__(self, error: dict):
        super().__init__(error.get("message", ""))
        self.error = error


class JobContext:
    def __init__(self, job, heartbeat, emit, log=None):
        self.job = job
        self.heartbeat = heartbeat
        self.emit = emit
        self.log = {} if log is None else log


class Worker:
    def __init__(
        self,
        queue: StreamQueue,
        db,
        group: str,
        consumer: str,
        queues: list[str],
        handlers: dict,
        concurrency: int,
        *,
        now=None,
        user_slots: int = 4,
        company_slots: int = 8,
        lock_ttl: int = 120,
        beat_s: float = 30,
        drain_s: float = 8,
        block_ms: int = 1000,
        min_idle_ms: int = 120_000,
        settle=None,
        release=None,
        core=None,
        fair_queue: str | None = None,
        fair_every: int = 3,
    ):
        self.queue = queue
        self.db = db
        self.group = group
        self.consumer = consumer
        self.queues = list(queues)
        self.handlers = handlers
        self.concurrency = concurrency
        self.now = now or utcnow
        self.user_slots = user_slots
        self.company_slots = company_slots
        self.lock_ttl = lock_ttl
        self.beat_s = beat_s
        self.drain_s = drain_s
        self.block_ms = block_ms
        self.min_idle_ms = min_idle_ms
        self.settle = settle or _noop
        self.release = release or _noop
        self.core = core
        self.fair_queue = fair_queue
        self.fair_every = fair_every
        self._passed = 0
        self._stop = asyncio.Event()

    async def run_forever(self) -> None:
        tasks = [asyncio.create_task(self._loop()) for _ in range(self.concurrency)]
        try:
            await self._stop.wait()
            # Loops finish the job in hand; whatever outlives the drain is cancelled
            # and released back to the queue by _run.
            await asyncio.wait(tasks, timeout=self.drain_s)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    def stop(self) -> None:
        self._stop.set()

    def _core(self):
        if self.core is not None:
            return self.core
        return core_from_env()

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self.reclaim()
                for msg in await self.next_messages():
                    await self.process(msg)
            except Exception:
                # A Redis or DB blip must not end the loop for the life of the process.
                logger.exception("worker loop iteration failed")
                await asyncio.sleep(1)

    async def next_messages(self) -> list[Message]:
        paused = await self.queue.paused_set(self.queues)
        active = [queue for queue in self.queues if queue not in paused]
        for queue in self._read_order(active):
            found = await self.queue.read(self.group, self.consumer, [queue], 1, 0)
            if found:
                self._note(found[0].queue)
                return found
            if queue == self.fair_queue:
                self._passed = 0
        if self.block_ms <= 0:
            return []
        if not active:
            await asyncio.sleep(self.block_ms / 1000)
            return []
        # A multi-stream read can return one message per stream; all are ours now.
        found = await self.queue.read(self.group, self.consumer, active, 1, self.block_ms)
        for msg in found:
            self._note(msg.queue)
        return found

    def _read_order(self, active: list[str]) -> list[str]:
        # Strict priority starves the fair queue under steady chat load (fit waited 20-170s
        # for a 0.4s job), so after fair_every passes it is read first.
        if self.fair_queue in active and self._passed >= self.fair_every:
            return [self.fair_queue] + [queue for queue in active if queue != self.fair_queue]
        return active

    def _note(self, queue: str) -> None:
        self._passed = 0 if queue == self.fair_queue else self._passed + 1

    async def reclaim(self, min_idle_ms: int | None = None) -> int:
        idle = self.min_idle_ms if min_idle_ms is None else min_idle_ms
        count = 0
        for queue in self.queues:
            messages = await self.queue.claim_stale(queue, self.group, self.consumer, idle)
            for msg in messages:
                await self.process(msg)
                count += 1
        return count

    async def process(self, msg: Message) -> str:
        now = self.now()
        job = await self.db.claim(msg.job_id, now)
        if job is None:
            await self.queue.ack(msg.queue, self.group, msg.id)
            return "skip"
        home = self._home(job, msg)
        if home is not None:
            # The row first: if the add is lost, the dispatcher rehydrates the job from its new queue.
            await self.db.forward(job["id"], home, now)
            await self.queue.add(home, job["id"])
            await self.queue.ack(msg.queue, self.group, msg.id)
            logger.info(json.dumps({"jobId": str(job["id"]), "type": job["type"], "step": "forwarded", "queue": home}))
            return "forwarded"
        started = time.perf_counter()
        log: dict = {}
        try:
            async with self._lock(job) as renew_lock:
                outcome = await self._run(job, msg, log, renew_lock)
        except LockBusy:
            await self._delay(job, msg, self.now())
            outcome = "delayed"
        logger.info(json.dumps({
            "jobId": str(job["id"]),
            "type": job["type"],
            "step": outcome,
            **{key: log.get(key) for key in LOG_FIELDS},
            "latencyMs": int((time.perf_counter() - started) * 1000),
        }, ensure_ascii=False))
        return outcome

    def _home(self, job, msg: Message) -> str | None:
        """The other service's stream for a turn this worker has no handler for.

        Core routes employer turns to q:agent*; a core deployed before the split, or rolled back, still
        sends them to q:chat*, where push-bot's worker reads them.
        """
        if job["type"] in self.handlers:
            return None
        base = TURN_QUEUES.get(job["type"])
        if base is None:
            return None
        home = base + ":priority" if msg.queue.endswith(":priority") else base
        return None if home in self.queues else home

    async def _run(self, job, msg: Message, log: dict, renew_lock: Renew) -> str:
        slots: list[str] = []
        member = str(job["id"])
        try:
            for scope, limit in self._slot_scopes(job):
                if not await try_slot(self.queue.redis, scope, limit, member, self.now().timestamp()):
                    await self._delay(job, msg, self.now())
                    return "delayed"
                slots.append(scope)

            async def heartbeat():
                await self.db.touch(job["id"], self.now())

            async def emit(kind, payload):
                await self.db.emit(job["id"], kind, payload)

            deadlines = job_deadlines()
            beat = asyncio.create_task(self._beat(job, renew_lock, slots, member))
            try:
                async with asyncio.timeout(deadlines.get(job["type"], deadlines["chat"])):
                    result = await self.handlers[job["type"]](JobContext(job, heartbeat, emit, log))
            except JobCancelled:
                await self.db.cancel(job["id"], self.now())
                await self.release(self.db, job["id"])
                await self.queue.ack(msg.queue, self.group, msg.id)
                return "cancelled"
            except JobFailed as err:
                await self.db.fail_final(job["id"], err.error, self.now())
                await self.release(self.db, job["id"])
                await notify_turn_done(self._core(), job, None, "failed")
                await self.queue.ack(msg.queue, self.group, msg.id)
                return "failed"
            finally:
                beat.cancel()
            await self.db.finish(job["id"], result, self.now())
            await self.settle(self.db, job["id"])
            await notify_turn_done(self._core(), job, result)
            await self.queue.ack(msg.queue, self.group, msg.id)
            return "done"
        except asyncio.CancelledError:
            # Shutdown: hand the job back; the un-acked message is reclaimed later.
            with contextlib.suppress(Exception):
                await self.db.release_claim(job["id"], self.now())
            raise
        except Exception as err:
            if missing_provider_key(err):
                error = {
                    "code": "NOT_CONFIGURED",
                    "message": "managed AI is not configured",
                    "details": None,
                }
                with contextlib.suppress(Exception):
                    await self.db.emit(job["id"], "error", {"error": error})
                await self.db.fail_final(job["id"], error, self.now())
                await self.release(self.db, job["id"])
                await notify_turn_done(self._core(), job, None, "failed")
                await self.queue.ack(msg.queue, self.group, msg.id)
                return "failed"
            info = await self.db.fail(job["id"], {"message": str(err)}, self.now())
            if info is None:
                # Not RUNNING any more (cancelled, finished or requeued elsewhere).
                await self.queue.ack(msg.queue, self.group, msg.id)
                return "lost"
            if info["status"] == "DEAD":
                await self.queue.dead(job["id"], str(err))
                await self.release(self.db, job["id"])
                await notify_turn_done(self._core(), job, None, "failed")
            else:
                when = self.now() + timedelta(seconds=backoff_seconds(info["attempts"]))
                await self.queue.delay(job["queue"], job["id"], when)
            await self.queue.ack(msg.queue, self.group, msg.id)
            return "failed"
        finally:
            for scope in slots:
                await release_slot(self.queue.redis, scope, member)

    def _slot_scopes(self, job) -> list[tuple[str, int]]:
        scopes = [(f"slots:user:{job['user_id']}", self.user_slots)]
        if job.get("company_id"):
            scopes.append((f"slots:company:{job['company_id']}", self.company_slots))
        return scopes

    async def _beat(self, job, renew_lock: Renew, slots: list[str], member: str) -> None:
        """Keep the job, its conversation lock and its fairness slots alive while it runs."""
        while True:
            await asyncio.sleep(self.beat_s)
            try:
                now = self.now()
                await self.db.touch(job["id"], now)
                await renew_lock()
                for scope in slots:
                    await refresh_slot(self.queue.redis, scope, member, now.timestamp())
            except Exception:
                logger.warning("heartbeat failed for job %s", job["id"], exc_info=True)

    async def _delay(self, job, msg: Message, now) -> None:
        await self.db.release_claim(job["id"], now)
        when = now + timedelta(seconds=backoff_seconds(1))
        await self.queue.delay(job["queue"], job["id"], when)
        await self.queue.ack(msg.queue, self.group, msg.id)

    @asynccontextmanager
    async def _lock(self, job) -> AsyncIterator[Renew]:
        conversation_id = job.get("conversation_id")
        if not conversation_id:
            yield _noop
            return
        async with job_lock(self.queue.redis, f"lock:conversation:{conversation_id}", self.lock_ttl) as renew:
            yield renew


async def _noop(*_args, **_kwargs):
    return None
