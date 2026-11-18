import re
from pathlib import Path


def test_dispatcher_reads_the_data_volume_and_blobs_stay_in_db():
    text = Path(__file__).resolve().parents[3].joinpath("infra/vps/compose.yaml").read_text()
    assert "BLOB_STORE: db" in text
    start = text.index("\n  dispatcher:\n")
    end = text.index("\n  ai-worker:\n")
    block = text[start:end]
    assert "ai-data:/data:ro" in block
    assert "STORAGE_DIR: /data/sources" in block


def _compose_text() -> str:
    return Path(__file__).resolve().parents[3].joinpath("infra/vps/compose.yaml").read_text()


def test_ai_worker_slots_do_not_exceed_the_db_pool():
    text = _compose_text()
    block = text[text.index("\n  ai-worker:\n"):text.index("\n  ingest-worker:\n")]
    slots = int(re.search(r"QUEUE_CONCURRENCY: \$\{AI_WORKER_CONCURRENCY:-(\d+)\}", block).group(1))
    pool = re.search(r"DB_POOL_MAX_SIZE: \$\{DB_POOL_MAX_SIZE:-\$\{AI_WORKER_CONCURRENCY:-(\d+)\}\}", block)
    assert pool, "ai-worker must derive DB_POOL_MAX_SIZE from AI_WORKER_CONCURRENCY"
    assert int(pool.group(1)) == slots
    env_example = Path(__file__).resolve().parents[3].joinpath("infra/vps/env.example").read_text()
    assert f"AI_WORKER_CONCURRENCY={slots}\n" in env_example
