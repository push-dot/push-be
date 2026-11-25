import re
from pathlib import Path

VPS = Path(__file__).resolve().parents[3] / "infra/vps"


def _compose_text(name: str = "compose.yaml") -> str:
    return VPS.joinpath(name).read_text()


def _block(text: str, service: str, until: str) -> str:
    return text[text.index(f"\n  {service}:\n"):text.index(f"\n  {until}:\n")]


def test_dispatcher_reads_the_data_volume_and_blobs_stay_in_db():
    text = _compose_text()
    assert "BLOB_STORE: db" in text
    block = _block(text, "dispatcher", "push-bot")
    assert "ai-data:/data:ro" in block
    assert "STORAGE_DIR: /data/sources" in block


def test_push_bot_slots_do_not_exceed_the_db_pool():
    block = _block(_compose_text(), "push-bot", "push-agent")
    slots = int(re.search(r"QUEUE_CONCURRENCY: \$\{AI_WORKER_CONCURRENCY:-(\d+)\}", block).group(1))
    pool = re.search(r"DB_POOL_MAX_SIZE: \$\{DB_POOL_MAX_SIZE:-\$\{AI_WORKER_CONCURRENCY:-(\d+)\}\}", block)
    assert pool, "push-bot must derive DB_POOL_MAX_SIZE from AI_WORKER_CONCURRENCY"
    assert int(pool.group(1)) == slots
    assert f"AI_WORKER_CONCURRENCY={slots}\n" in VPS.joinpath("env.example").read_text()


def test_push_agent_slots_do_not_exceed_the_db_pool():
    block = _block(_compose_text(), "push-agent", "ingest-worker")
    slots = int(re.search(r"QUEUE_CONCURRENCY: \$\{AGENT_WORKER_CONCURRENCY:-(\d+)\}", block).group(1))
    pool = re.search(r"DB_POOL_MAX_SIZE: \$\{AGENT_WORKER_CONCURRENCY:-(\d+)\}", block)
    assert pool, "push-agent must derive DB_POOL_MAX_SIZE from AGENT_WORKER_CONCURRENCY"
    assert int(pool.group(1)) == slots
    assert f"AGENT_WORKER_CONCURRENCY={slots}\n" in VPS.joinpath("env.example").read_text()


def test_each_service_runs_its_own_worker_image_and_consumer_group():
    for name, bot, agent, after in (
        ("compose.yaml", "push-bot", "push-agent", "ingest-worker"),
        ("compose.staging.yaml", "staging-push-bot", "staging-push-agent", "staging-ingest-worker"),
    ):
        text = _compose_text(name)
        bot_block, agent_block = _block(text, bot, agent), _block(text, agent, after)
        assert '<<: *bot-image' in bot_block and 'command: ["python", "-m", "push_bot.worker"]' in bot_block
        assert "QUEUE_GROUP: ai\n" in bot_block
        assert '<<: *agent-image' in agent_block and 'command: ["python", "-m", "push_agent.worker"]' in agent_block
        assert "QUEUE_GROUP: agent\n" in agent_block
        # Both answer /healthz on 8080 from the worker process; only push-bot may write the data volume.
        assert 'SERVE_API: "1"' in bot_block and 'SERVE_API: "1"' in agent_block
        assert "/data:ro" in agent_block and "/data:ro" not in bot_block
        assert "target: push-bot\n" in text and "target: push-agent\n" in text
        assert "app.workers.ai_worker_main" not in text
        # The old service name survives only as the staging alias the not-yet-redeployed production proxy uses.
        assert text.count("ai-worker") == (1 if name == "compose.staging.yaml" else 0)
        assert ("aliases: [staging-ai-worker]" in bot_block) == (name == "compose.staging.yaml")


def test_the_proxy_routes_each_service_by_its_own_host():
    routes = VPS.joinpath("traefik/dynamic.yml").read_text()
    for host, target in (
        ("AI_HOST", "http://push-bot:8080"), ("AGENT_HOST", "http://push-agent:8080"),
        ("STAGING_AI_HOST", "http://staging-push-bot:8080"),
        ("STAGING_AGENT_HOST", "http://staging-push-agent:8080"),
    ):
        assert f'Host(`{{{{ env "{host}" }}}}`)' in routes
        assert target in routes
    proxy = _block(_compose_text(), "proxy", "dispatcher")
    for name in ("AI_HOST", "AGENT_HOST", "STAGING_AI_HOST", "STAGING_AGENT_HOST"):
        assert f"      {name}: " in proxy
