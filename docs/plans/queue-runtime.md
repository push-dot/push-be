# Queue runtime notes

These values are the code defaults. Each one reads an environment variable when the dispatcher sweeps, so a process restart picks up a change. Unset or blank keeps the default.

## Heartbeat limits

A `RUNNING` job returns to `RETRY` when `now - heartbeat_at` is at least the limit for its type.

| Type | Default | Env |
|---|---|---|
| chat | 120s | `HEARTBEAT_LIMIT_CHAT_S` |
| employer_ai | 120s | `HEARTBEAT_LIMIT_EMPLOYER_AI_S` |
| document | 300s | `HEARTBEAT_LIMIT_DOCUMENT_S` |
| fit | 180s | `HEARTBEAT_LIMIT_FIT_S` |
| ingest | 600s | `HEARTBEAT_LIMIT_INGEST_S` |
| notify | 60s | `HEARTBEAT_LIMIT_NOTIFY_S` |

## Visibility and rehydrate

The 15-minute sweep re-adds a job with `XADD` when all of these are true:

- `jobs.status` is `QUEUED`, `RETRY`, or `PENDING` (`PENDING` is the `chat_jobs` view name for `QUEUED` and `RETRY`; the `jobs` check allows it and stores the other two).
- `run_after` is due.
- `updated_at` is older than that queue's visibility limit.
- The stream has no message whose field `jobId` is this job.
- `q:delayed` has no member for this job.

A fresh row stays on the outbox path. A second `XADD` for a job that is already `RUNNING`, `DONE`, or `DEAD` is ignored by the worker, which claims only `QUEUED` or `RETRY`.

| Queue | Default | Env |
|---|---|---|
| `q:chat:priority` | 60s | `VISIBILITY_Q_CHAT_PRIORITY_S` |
| `q:chat` | 60s | `VISIBILITY_Q_CHAT_S` |
| `q:document` | 120s | `VISIBILITY_Q_DOCUMENT_S` |
| `q:ingest` | 180s | `VISIBILITY_Q_INGEST_S` |
| `q:notify` | 30s | `VISIBILITY_Q_NOTIFY_S` |

No public interface was renamed.
