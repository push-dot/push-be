from uuid import uuid4

import pytest
from fakeredis.aioredis import FakeRedis

from app.queue.streams import StreamQueue


class RecordingRedis(FakeRedis):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.blocks = []

    async def xreadgroup(self, *args, block=None, **kwargs):
        self.blocks.append(block)
        return await super().xreadgroup(*args, block=block, **kwargs)


@pytest.mark.asyncio
async def test_zero_block_is_a_poll_not_block_forever():
    # Redis treats XREADGROUP BLOCK 0 as "wait forever"; the worker's per-queue poll passes 0.
    redis = RecordingRedis(decode_responses=True)
    queue = StreamQueue(redis)
    assert await queue.read("ai", "w1", ["q:chat:priority"], 1, 0) == []
    assert redis.blocks == [None]


@pytest.mark.asyncio
async def test_positive_block_is_kept_and_messages_are_read():
    redis = RecordingRedis(decode_responses=True)
    queue = StreamQueue(redis)
    job = uuid4()
    await queue.read("ai", "w1", ["q:chat"], 1, 0)
    await queue.add("q:chat", job)
    found = await queue.read("ai", "w1", ["q:chat:priority", "q:chat"], 1, 50)
    assert redis.blocks[-1] == 50
    assert [str(m.job_id) for m in found] == [str(job)]
