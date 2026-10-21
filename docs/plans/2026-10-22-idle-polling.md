# Idle polling keeps Neon awake

Date: 2026-10-22. Branch: `fix/chat-worker-idle-polling`. Production tip before this work: `01e44e1`.

## What production showed

While container `push-ai-ai-1` was up, with almost no user traffic:

- VPS CPU about 13–15% (about 2.5% when the container was down).
- Incoming traffic about 0.3–0.6 GB per 30 min. Outgoing about 75–98 MB per 30 min (about 2 MB per 30 min when the container was down).
- Neon project `push-be` (free plan, 0.25 CU, suspend after 5 min with no activity) logged about 92 h active over about 4.6 days. Compute did not suspend.

This doc is from the code. The live VPS and Neon were not measured again.

## Cause

One uvicorn process (`python -m uvicorn app.main:app`) is the only `chat_jobs` consumer. `CHAT_EXECUTOR=local`, `DB_DRIVER=asyncpg`, `CHECKPOINTER=postgres`. Bootstrap starts the resident worker (`services/ai/src/app/main.py` `start_worker` when `external_jobs()` is false).

Before this branch, `ConversationService._worker_loop` (`01e44e1`, `services/ai/src/app/domain/services/conversation.py` lines 185–199) did this while idle:

- empty `claim()` → `asyncio.sleep(0.3)`
- `claim()` exception → `asyncio.sleep(1)`

`claim()` is one statement (`services/ai/src/app/infrastructure/store_chat_jobs.py` lines 92–100):

```sql
UPDATE chat_jobs SET status='RUNNING', attempt=attempt+1, updated_at=$1
WHERE id = (
  SELECT id FROM chat_jobs WHERE status='PENDING' AND run_at<=now()
  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
) RETURNING id, user_id, conversation_id, payload, attempt
```

An empty queue returns no row (`UPDATE 0`).

Rate: `1 / 0.3 = 3.333` claims/s = 200/min = 6,000 per 30 min.

Payload: the SQL text is about 280 bytes plus one timestamp. After asyncpg prepares it, a steady round trip is on the order of 0.4–1.5 KB. 6,000 of those are about 3–9 MB per 30 min.

That query rate alone resets Neon's 5-minute inactivity timer, so the compute cannot suspend. It does not explain 0.3–0.6 GB per 30 min (about 50–100× the claim payload). It also does not by itself explain 13–15% of a 2 vCPU box (about 0.26–0.30 cores). A 0.3 s sleep with no I/O would be near 1% or less. No second idle loop was found. The extra CPU and bytes are unproven; candidates are TLS and pool churn around the same poll, not a second timer.

## What else was checked

These do not poll Neon while the VPS is idle:

- `/healthz` (`main.py` line 92) is JSON. The compose healthcheck (`infra/vps/compose.yaml` lines 47–53) is local HTTP every 30 s.
- SSE `_pump_job_events` sleeps 0.2 s (`conversation.py` line 594) only while a client is connected, then stops.
- `nudge_pending` (`conversation.py` lines 835–840) returns 0 when `remote_executor()` is true (`AI_ORIGIN` or `CHAT_EXECUTOR_REMOTE`). The cron that calls it is the Cloudflare worker, not the VPS process.
- Experiment `seed` runs once at bootstrap.
- Playwright, rate-limit sweep, and account purge are not VPS timers.
- No `LISTEN`/`NOTIFY`.

## Connections that stayed open

`asyncpg.create_pool` was called with library defaults: `min_size=10`, `max_size=10`, `max_inactive_connection_lifetime=300`. Startup opened 10 sessions. The claim reused one of them every 0.3 s, so that socket never went idle. asyncpg arms `call_later` and `terminate()`s an idle connection (`PoolConnectionHolder._setup_inactive_callback`). The other 9 could die after 300 s. One hot connection remained for the life of the process.

`AsyncPostgresSaver.from_conn_string` (the old bootstrap) holds one `AsyncConnection` until process shutdown. psycopg's pool does not `SELECT 1` on a timer unless `check=` is set. Default `check` is `None`. libpq TCP keepalives default on (often a 2 h idle). They are not the gigabytes. They were still disabled.

Either the 0.3 s query or the open session is enough to stop a 5-minute suspend.

## Fix

Claim loop (`conversation.py` lines 63–86 and 246–269):

- After work, the next claim is immediate and the delay resets to 1 s.
- Empty claim or claim error waits on `asyncio.Event`, then doubles: 1, 2, 4, 8, 16, 32, 60.
- `start_worker` installs the scheduler as `wake()` (`jobs.py` `get_job_scheduler`). `POST /internal/chat/schedule` (`internal.py` lines 21–37) already calls `schedule_chat_job`, so the existing route wakes the loop. No `LISTEN`.
- `reset_stale()` with the default age (not 0) runs at most every `STALE_SWEEP_S` (900 s). Startup still calls `reset_stale(0)` once.

Wake path: core `postMessage` (`services/core-api/src/routes/conversations.ts` lines 209–227 and 276–291), when `AI_ORIGIN` is set, `POST`s `{origin}/internal/chat/schedule` with `x-push-internal: 1` and `x-push-ai-secret` when `AI_SHARED_SECRET` is set. A failed wake still returns 202. The poll picks the row up within 60 s. The gateway cannot forward this: it strips `x-push-internal`. Core must call the origin itself.

Pools (`db.py` lines 26–86 and 204–218, `main.py` lines 177–178 and 219–224):

- asyncpg `min_size=0`, `max_size=10`, `max_inactive_connection_lifetime=30`, `application_name=push-ai`. `_init_conn` sets `SO_KEEPALIVE` to 0.
- Checkpointer uses `AsyncConnectionPool` (`min_size=0`, `max_size=4`, `max_idle=60`, `keepalives=0`) instead of one connection for the process life. `setup()` borrows a connection once at boot. Shutdown calls `pool.close()`.

## Idle rate

| | Before | After (once the delay is capped) |
| --- | --- | --- |
| Claim queries | 200/min | 1/min |
| Stale sweep | not on this loop | 2 statements / 15 min |
| Sockets left open | 1 asyncpg + 1 psycopg, for the process life | none, about 30 s after the last asyncpg use and within 60 s for the checkpointer |

A job inserted while the worker sleeps starts on the wake (HTTP plus the interrupted wait, under 2 s when the wake arrives). A lost wake waits at most 60 s.

## Neon will still not suspend at a 60 s cap

Free-plan suspend needs about 5 minutes with no queries. A claim every 60 s resets that timer. `min_size=0` drops the socket between claims (asyncpg's 30 s `call_later` is shorter than the 60 s poll) but the next claim wakes the compute again.

Always-on 0.25 CU is about 180 CU-hours per 30 days. The free allowance is 100 CU-hours (100 / 0.25 = 400 h, about 16.7 days).

The 60 s cap is the product requirement for a lost wake. The one-line change if suspend is mandatory is `IDLE_MAX_S` in `conversation.py` line 64. Set it above 300. The comment on line 65 says the same thing. A lost wake would then wait that long.

No new VPS environment variable. Core needs dashboard vars `AI_ORIGIN` and `AI_SHARED_SECRET` (same values as gateway `push-be`). `infra/vps/env.example` notes that. CI does not upload `AI_SHARED_SECRET`. Without it on `push-be-core`, the wake is 401 and the 60 s poll is the only pickup.

## Check after deploy

```bash
cd services/ai
DB_DRIVER=asyncpg DATABASE_URL=... python scripts/idle_db_probe.py
```

Default window is 130 s, which includes the ramp to 60 s, so queries/min over the whole window is higher than 1. Steady state after the ramp is 1 claim per minute. `pool_size_after_idle` should be 0. Do not aim this at a database with PENDING jobs.

## Deploy

Pushes to `develop` run tests only. CD runs on `DEPLOY_BRANCH` (default `main`) in `.github/workflows/ci.yml`.

1. Merge this branch to `develop` and let CI pass.
2. Merge `develop` to `main`.
3. On that push, CI deploys the Python worker, then the VPS image (`services/ai/` changed, so the `vps` path filter is true), then `push-be-core`, then the gateway.
4. Before the under-2 s wake is real, set `AI_ORIGIN` and `AI_SHARED_SECRET` on worker `push-be-core` to the gateway values.

Do not SSH to the VPS and do not change Neon settings for this rollout.
