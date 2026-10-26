# Audit notes: core-b (services/core-api)

Changes that belong to files outside core-b. Each entry: file, line, problem, proposed fix.

## Proposed migration (db/migrations, next free number)

Not added here because the migrations directory is shared and seven branches could pick the same number.

```sql
-- Applicant counts, "applied" flags and member cards join jobs by source_posting_id for every posting row.
-- Without these, each posting row in a list scans jobs and applications.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_source_posting ON jobs (source_posting_id) WHERE source_posting_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_applications_job ON applications (job_id);

-- GET /sources pages by (user_id, created_at, id); there is no index on sources at all.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sources_list ON sources (user_id, created_at DESC, id DESC);

-- POST /me/devices now removes the token from other accounts (DELETE ... WHERE token = $2).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_devices_token ON user_devices (token);

-- One application per user per posting. applyPosting already treats 23505 as "the other request won".
-- Check for duplicates first: SELECT user_id, source_posting_id, count(*) FROM jobs
--   WHERE source_posting_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS jobs_user_posting_uniq ON jobs (user_id, source_posting_id) WHERE source_posting_id IS NOT NULL;

-- 0018 turned every FK that leads back to users into ON DELETE CASCADE, including
-- profiles.resume_source_id -> sources. Deleting a source then deleted the whole profile.
-- core-b now clears the pointer in the delete statement; the FK should say what it means.
ALTER TABLE profiles DROP CONSTRAINT profiles_resume_source_id_fkey,
  ADD CONSTRAINT profiles_resume_source_id_fkey FOREIGN KEY (resume_source_id) REFERENCES sources(id) ON DELETE SET NULL;
```

The race and the cascade above were reproduced on a scratch Postgres 18 with migrations 0001-0026 applied.

## core-a

- `src/handler.ts:203` (`idempotent`): reads the whole request body with `arrayBuffer()` before any route runs, so
  the upload size checks in images/sources only help after the body is already in memory. Fix: before buffering,
  refuse with 413 when `content-length` is above the largest route limit (20 MiB + 64 KiB for /sources, 10 MiB +
  64 KiB for /uploads/images, and something like 1 MiB for JSON routes).
- `src/jobs/credits.ts` is core-b, but the race it has needs a transaction: `reserveCredits` reads the available
  balance and `enqueueJob` inserts the reservation in a later statement. Neon HTTP queries are separate
  transactions, so N concurrent enqueues can all pass the check and overdraw by N times the estimate. Fix needs
  `Query` (types.ts/index.ts, core-a) to expose `sql.transaction([...])`, or a per-owner lock row:
  `UPDATE credit_owners SET touched = now() WHERE owner = $1` inside the same statement as the reservation
  insert, with the balance check in that statement's WHERE.
- `src/jobs/credits.ts` `availableMicro`: three sequential round trips (ledger, settled, reserved) on every enqueue
  and every billing status. One CTE returning all three would save two round trips, but every billing test in
  `test/billing-employer.test.ts`, `test/cov-billing.test.ts` and `test/enqueue.test.ts` mocks them as separate
  queries. Left for core-a so the mocks change together with `routes/billing.ts`.
- `src/jobs/credits.ts:15` `COMPANY_SETTLED`: company balance subtracts settled usage of every member, including
  members' personal (non-company) jobs. Check against Python before changing; it may be intended.
- `src/routes/billing.ts:89-90`: `availableMicro` and `reservedMicro` run sequentially and `availableMicro` already
  computes reserved. Return both from one call.

## gateway / infra

- `oauth_states` and `integration_codes` rows are only deleted when used. Expired rows accumulate. Add a cleanup
  to the hourly cron (core `scheduled`, core-a) : `DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day'`
  and the same for `integration_codes`.
- `search_queries` stores every search term, including guest searches, and `GET /search/trending` shows the top 8
  publicly. Anyone at 60 req/min per IP can push a term into trending. Consider counting distinct users per term,
  excluding guests, and a retention delete.

## Behaviour changes in core-b worth knowing

- Guest views of a posting no longer write `posting_views` (they failed with 23503 and answered 500). Guest views
  no longer increase `view_count`.
- `POST /profiles/{id}/offer` with `postingId` now requires the posting to belong to the sender's company (404
  otherwise, as for a closed posting).
- Cursors whose id is not a UUID are now 400 `field=cursor` (were 500). Test fixtures in `test/cov-billing.test.ts`
  used ids like `"l2"`; they now use UUIDs.
