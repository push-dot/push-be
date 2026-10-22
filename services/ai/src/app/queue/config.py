import os

STREAM_MAXLEN = 100_000
DELAYED_KEY = "q:delayed"
DEAD_QUEUE = "q:dead"
SWEEP_S = 15 * 60
ALERT_S = 60
PAUSE_PREFIX = "pause:"

QUEUE_GROUPS = {
    "q:chat:priority": "ai",
    "q:chat": "ai",
    "q:document": "ai",
    "q:ingest": "ingest",
    "q:notify": "notify",
}

_HEARTBEAT_DEFAULTS = {
    "chat": ("HEARTBEAT_LIMIT_CHAT_S", 120),
    "employer_ai": ("HEARTBEAT_LIMIT_EMPLOYER_AI_S", 120),
    "document": ("HEARTBEAT_LIMIT_DOCUMENT_S", 300),
    "fit": ("HEARTBEAT_LIMIT_FIT_S", 180),
    "ingest": ("HEARTBEAT_LIMIT_INGEST_S", 600),
    "notify": ("HEARTBEAT_LIMIT_NOTIFY_S", 60),
}

_VISIBILITY_DEFAULTS = {
    "q:chat:priority": ("VISIBILITY_Q_CHAT_PRIORITY_S", 60),
    "q:chat": ("VISIBILITY_Q_CHAT_S", 60),
    "q:document": ("VISIBILITY_Q_DOCUMENT_S", 120),
    "q:ingest": ("VISIBILITY_Q_INGEST_S", 180),
    "q:notify": ("VISIBILITY_Q_NOTIFY_S", 30),
}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return int(raw)


def _resolve(defaults: dict) -> dict[str, int]:
    return {key: _env_int(env, value) for key, (env, value) in defaults.items()}


def heartbeat_limits() -> dict[str, int]:
    return _resolve(_HEARTBEAT_DEFAULTS)


def visibility_limits() -> dict[str, int]:
    return _resolve(_VISIBILITY_DEFAULTS)


HEARTBEAT_LIMIT_S = {key: value for key, (_, value) in _HEARTBEAT_DEFAULTS.items()}
VISIBILITY_S = {key: value for key, (_, value) in _VISIBILITY_DEFAULTS.items()}
