"""Every model call goes through OpenRouter with the provider pins (privacy policy 국외 이전).

Behavior is tested per path in test_cov_client_openai, test_framework and test_embedding.
This test fails when a new file starts calling a model some other way.
"""

from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "app"
# Ways to reach a model: an OpenAI-compatible endpoint or the LangChain client.
CALL_MARKERS = ("/chat/completions", "/embeddings", "ChatOpenAI")
# The only files that may send a model request, and the pin each one applies.
PINNED = {
    "infrastructure/openai_client.py": "openrouter_route(model)",
    "framework/models.py": "openrouter_route(model)",
    "embedding/api.py": "provider_for(self.model)",
}
OTHER_HOSTS = ("api.openai.com", "api.anthropic.com", "opencode", "api.deepseek.com")


def _sources():
    for path in SRC.rglob("*.py"):
        yield path.relative_to(SRC).as_posix(), path.read_text(encoding="utf-8")


def test_model_requests_are_sent_only_from_the_pinned_files():
    senders = {name for name, text in _sources() if any(m in text for m in CALL_MARKERS)}
    assert senders == set(PINNED)
    for name, text in _sources():
        if name in PINNED:
            assert PINNED[name] in text, name


def test_no_model_host_other_than_openrouter():
    for name, text in _sources():
        for host in OTHER_HOSTS:
            assert host not in text, f"{name} names {host}"
