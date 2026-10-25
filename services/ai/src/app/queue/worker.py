import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import timedelta

from app.clock import utcnow
from app.queue.backoff import backoff_seconds
from app.queue.config import job_deadlines
from app.queue.fairness import refresh_slot, release_slot, try_slot
from app.queue.locks import LockBusy, job_lock
from app.queue.streams import Message, StreamQueue


logger = logging.getLogger(__name__)

LOG_FIELDS = ("docIds", "promptHash", "tokensIn", "tokensOut")

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
        for queue in active:
            found = await self.queue.read(self.group, self.consumer, [queue], 1, 0)
            if found:
                return found
        if self.block_ms <= 0:
            return []
        if not active:
            await asyncio.sleep(self.block_ms / 1000)
            return []
        # A multi-stream read can return one message per stream; all are ours now.
        return await self.queue.read(self.group, self.consumer, active, 1, self.block_ms)

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
                await self.queue.ack(msg.queue, self.group, msg.id)
                return "failed"
            finally:
                beat.cancel()
            await self.db.finish(job["id"], result, self.now())
            await self.settle(self.db, job["id"])
            await self.queue.ack(msg.queue, self.group, msg.id)
            return "done"
        except asyncio.CancelledError:
            # Shutdown: hand the job back; the un-acked message is reclaimed later.
            with contextlib.suppress(Exception):
                await self.db.release_claim(job["id"], self.now())
            raise
        except Exception as err:
            info = await self.db.fail(job["id"], {"message": str(err)}, self.now())
            if info is None:
                # Not RUNNING any more (cancelled, finished or requeued elsewhere).
                await self.queue.ack(msg.queue, self.group, msg.id)
                return "lost"
            if info["status"] == "DEAD":
                await self.queue.dead(job["id"], str(err))
                await self.release(self.db, job["id"])
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
