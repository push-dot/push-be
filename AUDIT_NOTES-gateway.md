# Gateway audit: changes needed outside services/gateway and packages/contracts

## 1. Missing indexes behind gateway reads (db/migrations, new file 0027)

The gateway runs these on every conversation list, message page and stream poll.
None of them has a supporting index today (checked with `pg_indexes` on a local
DB built from 0001–0026; EXPLAIN numbers were not collected).

- `ai_jobs` has no index on `conversation_id`. Every `chat_jobs` lookup by
  conversation (active-job, cancel, and the `RUNNING` status subquery run once per
  row of a conversation list page) scans all of `ai_jobs`, and finished jobs are kept.
  The view maps status through `CASE`, so a status-partial index would not match.
- `approvals` has no index on `conversation_id`; the list's `NEEDS_APPROVAL`
  subquery runs once per row.
- The conversation list orders by `(updated_at, id)`, but `idx_conversations_list`
  and `idx_conversations_company` are on `created_at`, so each page sorts every
  conversation the user or company has.

```sql
-- 0027_gateway_read_indexes.sql
CREATE INDEX IF NOT EXISTS idx_ai_jobs_conversation
    ON ai_jobs (conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approvals_conversation_pending
    ON approvals (conversation_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
    ON conversations (user_id, updated_at DESC, id DESC) WHERE archived = false AND company_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_company_updated
    ON conversations (company_id, updated_at DESC, id DESC) WHERE archived = false AND company_id IS NOT NULL;
```

Use `CREATE INDEX CONCURRENTLY` if the migration runner allows running outside a transaction.

## 2. `chat_jobs` INSTEAD OF UPDATE does not re-check status (db/migrations, Medium)

`chat_jobs_view_update()` runs `UPDATE ai_jobs ... WHERE id = OLD.id`. The outer
`WHERE status IN ('PENDING','RUNNING')` is evaluated on the view's snapshot, and the
view row is not locked. A cancel racing a worker that just set `DONE` overwrites it
with `CANCELLED`. This is not new; the gateway's cancel used the same UPDATE before
this audit. Proposed fix in a new migration: add
`AND status = chat_jobs_view_status(OLD.status)` to the inner UPDATE and
`IF NOT FOUND THEN RETURN NULL; END IF;` so the outer statement reports no row
(the gateway then answers 409).

## 3. FastAPI serves /docs, /redoc and /openapi.json (services/ai/src/app/main.py, Low)

The gateway now denies these paths, but anyone who reaches the VPS with the shared
secret, or the Python worker over the service binding, still gets the full schema,
internal routes included. `FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)`
closes it. `packages/contracts/scripts/export_openapi.py` calls `app.openapi()`
directly, so the export keeps working.

## 4. Gateway allowlist for python has to track main.py (services/ai, process note)

`services/gateway/src/routes/owner.ts` `isPython` mirrors the routers mounted in
`services/ai/src/app/main.py`. A new public FastAPI route returns the gateway's 404
until it is added there. The gateway tests (`test/owner-deny.test.ts`) list the current set.

## 5. `secrets_match` length check (services/ai/src/app/api/gateway_secret.py, Low)

The early return on `len(got) != len(expected)` reveals the secret's length by timing.
`hmac.compare_digest` already handles unequal lengths, so the check can go.

## 6. Unauthenticated token floods cost one Neon query each (gateway + core, Low)

A bearer token that does not exist is not rate limited by the gateway: each request
is one Neon query before the 401. Core limits public routes per IP in Neon, so the
same pattern exists there. An isolate-local per-IP counter of 401s (no Neon write)
would cut this; not done here because it changes 401 into 429 for clients that retry
with a stale token.

## 7. Stale packages/contracts/openapi.json (Low)

The export still lists billing, calendar, auth and conversation routes that moved to
core, and lacks the approvals and share routes. `src/contracts.ts` uses
`satisfies (keyof paths)[]` on the gateway routes, so regenerating from the current
FastAPI app would fail typecheck (those paths now belong to the gateway and core).
Before regenerating, `GATEWAY_ROUTES` should check against a merged spec, or the check
should be dropped.
