from dataclasses import dataclass
from uuid import UUID

from redis.exceptions import ResponseError

from app.queue.config import DEAD_QUEUE, DELAYED_KEY, STREAM_MAXLEN


@dataclass(frozen=True)
class Message:
    queue: str
    id: str
    job_id: UUID


class StreamQueue:
    def __init__(self, redis):
        self.redis = redis

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
        for queue in queues:
            await self._group(queue, group)
        found = await self.redis.xreadgroup(
            group,
            consumer,
            {queue: ">" for queue in queues},
            count=count,
            block=block_ms,
        )
        out: list[Message] = []
        for queue, messages in found or []:
            for msg_id, fields in messages:
                out.append(self._message(queue, msg_id, fields))
        return out

    async def ack(self, queue: str, group: str, msg_id: str) -> None:
        await self.redis.xack(queue, group, msg_id)

    async def claim_stale(self, queue: str, group: str, consumer: str, min_idle_ms: int) -> list[Message]:
        await self._group(queue, group)
        claimed = await self.redis.xautoclaim(queue, group, consumer, min_idle_ms, start_id="0-0", count=32)
        messages = claimed[1] if claimed else []
        return [self._message(queue, msg_id, fields) for msg_id, fields in messages]

    async def delay(self, queue: str, job_id: UUID, run_at) -> None:
        await self.redis.zadd(DELAYED_KEY, {self._member(queue, job_id): run_at.timestamp()})

    async def promote_due(self, now) -> int:
        due = await self.redis.zrangebyscore(DELAYED_KEY, "-inf", now.timestamp())
        for member in due:
            queue, job_id = str(member).split("|", 1)
            await self.add(queue, UUID(job_id))
            await self.redis.zrem(DELAYED_KEY, member)
        return len(due)

    async def job_ids(self, queue: str) -> set[str]:
        rows = await self.redis.xrange(queue)
        return {str(fields["jobId"]) for _, fields in rows if fields.get("jobId")}

    async def delayed_job_ids(self) -> set[str]:
        members = await self.redis.zrange(DELAYED_KEY, 0, -1)
        found = set()
        for member in members:
            parts = str(member).split("|", 1)
            if len(parts) == 2:
                found.add(parts[1])
        return found

    async def dead(self, job_id: UUID, reason: str) -> None:
        await self.redis.xadd(
            DEAD_QUEUE,
            {"jobId": str(job_id), "reason": reason},
            maxlen=STREAM_MAXLEN,
            approximate=True,
        )

    async def _group(self, queue: str, group: str) -> None:
        try:
            await self.redis.xgroup_create(queue, group, id="0", mkstream=True)
        except ResponseError as err:
            if "BUSYGROUP" not in str(err):
                raise

    def _message(self, queue: str, msg_id: str, fields: dict) -> Message:
        return Message(str(queue), str(msg_id), UUID(str(fields["jobId"])))

    def _member(self, queue: str, job_id: UUID) -> str:
        return f"{queue}|{job_id}"
