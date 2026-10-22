import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import timedelta

from app.clock import utcnow
from app.queue.backoff import backoff_seconds
from app.queue.fairness import release_slot, try_slot
from app.queue.locks import LockBusy, job_lock
from app.queue.ratelimit import acquire_token
from app.queue.streams import Message, StreamQueue


logger = logging.getLogger(__name__)

LOG_FIELDS = ("docIds", "promptHash", "tokensIn", "tokensOut")


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
        rate: float = 100,
        burst: int = 20,
        rate_bucket: str = "rate:default",
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
        self.rate = rate
        self.burst = burst
        self.rate_bucket = rate_bucket
        self.block_ms = block_ms
        self.min_idle_ms = min_idle_ms
        self.settle = settle or _noop
        self.release = release or _noop
        self._stop = asyncio.Event()

    async def run_forever(self) -> None:
        tasks = [asyncio.create_task(self._loop()) for _ in range(self.concurrency)]
        try:
            await self._stop.wait()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    def stop(self) -> None:
        self._stop.set()

    async def _loop(self) -> None:
        while not self._stop.is_set():
            await self.reclaim()
            msg = await self.next_message()
            if msg is None:
                continue
            await self.process(msg)

    async def next_message(self):
        active = [queue for queue in self.queues if not await self.queue.paused(queue)]
        for queue in active:
            found = await self.queue.read(self.group, self.consumer, [queue], 1, 0)
            if found:
                return found[0]
        if self.block_ms <= 0:
            return None
        if not active:
            await asyncio.sleep(self.block_ms / 1000)
            return None
        found = await self.queue.read(self.group, self.consumer, active, 1, self.block_ms)
        return found[0] if found else None

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
            async with self._lock(job):
                outcome = await self._run(job, msg, log)
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

    async def _run(self, job, msg: Message, log: dict) -> str:
        slots = []
        try:
            user_key = f"slot:user:{job['user_id']}"
            if not await try_slot(self.queue.redis, user_key, self.user_slots):
                await self._delay(job, msg, self.now())
                return "delayed"
            slots.append(user_key)
            if job.get("company_id"):
                company_key = f"slot:company:{job['company_id']}"
                if not await try_slot(self.queue.redis, company_key, self.company_slots):
                    await self._delay(job, msg, self.now())
                    return "delayed"
                slots.append(company_key)
            await acquire_token(self.queue.redis, self.rate_bucket, self.rate, self.burst)

            async def heartbeat():
                await self.db.touch(job["id"], self.now())

            async def emit(kind, payload):
                await self.db.emit(job["id"], kind, payload)

            try:
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
            await self.db.finish(job["id"], result, self.now())
            await self.settle(self.db, job["id"])
            await self.queue.ack(msg.queue, self.group, msg.id)
            return "done"
        except Exception as err:
            info = await self.db.fail(job["id"], {"message": str(err)}, self.now())
            if info["status"] == "DEAD":
                await self.queue.dead(job["id"], str(err))
                await self.release(self.db, job["id"])
            else:
                when = self.now() + timedelta(seconds=backoff_seconds(info["attempts"]))
                await self.queue.delay(job["queue"], job["id"], when)
            await self.queue.ack(msg.queue, self.group, msg.id)
            return "failed"
        finally:
            for key in slots:
                await release_slot(self.queue.redis, key)

    async def _delay(self, job, msg: Message, now) -> None:
        await self.db.release_claim(job["id"], now)
        when = now + timedelta(seconds=backoff_seconds(1))
        await self.queue.delay(job["queue"], job["id"], when)
        await self.queue.ack(msg.queue, self.group, msg.id)

    @asynccontextmanager
    async def _lock(self, job):
        conversation_id = job.get("conversation_id")
        if not conversation_id:
            yield
            return
        async with job_lock(self.queue.redis, f"lock:conversation:{conversation_id}", self.lock_ttl):
            yield


async def _noop(*_args, **_kwargs):
    return None
