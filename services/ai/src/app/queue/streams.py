import logging
from dataclasses import dataclass
from typing import Final
from uuid import UUID

from redis.exceptions import ResponseError

from app.queue.config import DEAD_QUEUE, DELAYED_KEY, PAUSE_PREFIX, STREAM_MAXLEN

logger = logging.getLogger(__name__)

PROMOTE_BATCH: Final = 500
_PENDING_SCAN: Final = 1000


@dataclass(frozen=True, slots=True)
class Message:
    queue: str
    id: str
    job_id: UUID


class StreamQueue:
    def __init__(self, redis):
        self.redis = redis
        self._groups: set[tuple[str, str]] = set()

    async def add(self, queue: str, job_id: UUID) -> str:
        return await self.redis.xadd(
            queue,
            {"jobId": str(job_id)},
            maxlen=STREAM_MAXLEN,
            approximate=True,
        )

    async def read(self, group: str, consumer: str, queues: list[str], count: int, block_ms: int) -> list[Message]:
        if not queues:
            return []
        streams = {queue: ">" for queue in queues}
        # Redis reads BLOCK 0 as "wait forever"; 0 here means a non-blocking poll.
        block = block_ms if block_ms > 0 else None
        found = await self._with_groups(
            queues, group, lambda: self.redis.xreadgroup(group, consumer, streams, count=count, block=block))
        out: list[Message] = []
        for queue, messages in found or []:
            for msg_id, fields in messages:
                if (msg := await self._parse(queue, group, msg_id, fields)) is not None:
                    out.append(msg)
        return out

    async def ack(self, queue: str, group: str, msg_id: str) -> None:
        await self.redis.xack(queue, group, msg_id)

    async def claim_stale(self, queue: str, group: str, consumer: str, min_idle_ms: int) -> list[Message]:
        claimed = await self._with_groups(
            [queue], group,
            lambda: self.redis.xautoclaim(queue, group, consumer, min_idle_ms, start_id="0-0", count=32))
        out: list[Message] = []
        for msg_id, fields in (claimed[1] if claimed else []):
            if (msg := await self._parse(queue, group, msg_id, fields)) is not None:
                out.append(msg)
        return out

    async def delay(self, queue: str, job_id: UUID, run_at) -> None:
        await self.redis.zadd(DELAYED_KEY, {self._member(queue, job_id): run_at.timestamp()})

    async def promote_due(self, now) -> int:
        due = await self.redis.zrangebyscore(
            DELAYED_KEY, "-inf", now.timestamp(), start=0, num=PROMOTE_BATCH)
        moved = 0
        for member in due:
            # ZREM is the claim: a concurrent promoter that loses gets 0 and skips.
            if not await self.redis.zrem(DELAYED_KEY, member):
                continue
            queue, job_id = str(member).split("|", 1)
            await self.add(queue, UUID(job_id))
            moved += 1
        return moved

    async def live_job_ids(self, queue: str, group: str) -> set[str]:
        """Jobs with a message still to be read or acked; acked history doesn't count."""
        try:
            groups = await self.redis.xinfo_groups(queue)
        except ResponseError:  # no stream yet
            return set()
        info = next((g for g in groups if g["name"] == group), None)
        if info is None:  # no reader yet: everything in the stream is still to be delivered
            rows = list(await self.redis.xrange(queue))
        else:
            rows = list(await self.redis.xrange(queue, min="(" + info["last-delivered-id"]))
            if int(info["pending"]):
                pending = await self.redis.xpending_range(
                    queue, group, min="-", max="+", count=_PENDING_SCAN)
                async with self.redis.pipeline(transaction=False) as pipe:
                    for entry in pending:
                        pipe.xrange(queue, min=entry["message_id"], max=entry["message_id"], count=1)
                    for found in await pipe.execute():
                        rows.extend(found)
        return {str(fields["jobId"]) for _, fields in rows if fields.get("jobId")}

    async def delayed_job_ids(self) -> set[str]:
        members = await self.redis.zrange(DELAYED_KEY, 0, -1)
        found = set()
        for member in members:
            parts = str(member).split("|", 1)
            if len(parts) == 2:
                found.add(parts[1])
        return found

    async def dead(self, job_id: UUID | str, reason: str) -> None:
        await self.redis.xadd(
            DEAD_QUEUE,
            {"jobId": str(job_id), "reason": reason},
            maxlen=STREAM_MAXLEN,
            approximate=True,
        )

    async def paused(self, queue: str) -> bool:
        return bool(await self.redis.exists(PAUSE_PREFIX + queue))

    async def paused_set(self, queues: list[str]) -> set[str]:
        if not queues:
            return set()
        flags = await self.redis.mget([PAUSE_PREFIX + queue for queue in queues])
        return {queue for queue, flag in zip(queues, flags) if flag is not None}

    async def pause(self, queue: str) -> None:
        await self.redis.set(PAUSE_PREFIX + queue, "1")

    async def resume(self, queue: str) -> None:
        await self.redis.delete(PAUSE_PREFIX + queue)

    async def stream_stats(self, queue: str, group: str, now) -> dict:
        length = await self.redis.xlen(queue)
        last, pending, oldest = "0-0", 0, []
        try:
            groups = await self.redis.xinfo_groups(queue)
        except ResponseError:
            groups = []
        for info in groups:
            if info["name"] == group:
                last, pending = info["last-delivered-id"], int(info["pending"])
        if pending:
            oldest.append((await self.redis.xpending(queue, group))["min"])
        undelivered = await self.redis.xrange(queue, min="(" + last, count=1)
        if undelivered:
            oldest.append(undelivered[0][0])
        now_ms = int(now.timestamp() * 1000)
        age = max((now_ms - int(str(i).split("-")[0]) for i in oldest), default=0)
        return {"length": length, "oldestAgeSec": max(age // 1000, 0), "pending": pending}

    async def dead_since(self, since) -> int:
        rows = await self.redis.xrange(DEAD_QUEUE, min=str(int(since.timestamp() * 1000)))
        return len(rows)

    async def _with_groups(self, queues: list[str], group: str, call):
        """Create consumer groups once per process; recreate and retry once if they vanished."""
        for queue in queues:
            if (queue, group) not in self._groups:
                await self._group(queue, group)
                self._groups.add((queue, group))
        try:
            return await call()
        except ResponseError:  # NOGROUP after a flush or stream delete
            for queue in queues:
                await self._group(queue, group)
            return await call()

    async def _group(self, queue: str, group: str) -> None:
        try:
            await self.redis.xgroup_create(queue, group, id="0", mkstream=True)
        except ResponseError as err:
            if "BUSYGROUP" not in str(err):
                raise

    async def _parse(self, queue: str, group: str, msg_id: str, fields: dict) -> Message | None:
        try:
            return Message(str(queue), str(msg_id), UUID(str(fields["jobId"])))
        except (KeyError, ValueError):
            # A poison message would be reclaimed and crash every loop forever.
            logger.error("dropping malformed stream message %s on %s", msg_id, queue)
            await self.dead(fields.get("jobId", ""), "malformed message " + str(msg_id))
            await self.ack(queue, group, msg_id)
            return None

    def _member(self, queue: str, job_id: UUID) -> str:
        return f"{queue}|{job_id}"
