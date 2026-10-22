STREAM_MAXLEN = 100_000
DELAYED_KEY = "q:delayed"
DEAD_QUEUE = "q:dead"
SWEEP_S = 15 * 60
HEARTBEAT_LIMIT_S = {
    "chat": 120,
    "employer_ai": 120,
    "document": 300,
    "fit": 180,
    "ingest": 600,
    "notify": 60,
}
