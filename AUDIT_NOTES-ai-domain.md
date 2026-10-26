# Audit notes: ai-domain (cross-area items)

Findings outside `services/ai/src/app/domain/**` that the domain audit could not fix in place.
Each entry: file:line, problem, proposed fix.

## Security / races

1. `services/core-api/src/jobs/enqueue.ts:125` with `jobs/credits.ts:39-49`. `reserveCredits` reads
   `availableMicro` and then inserts the reservation with no per-owner lock visible in this file.
   Two parallel enqueues can both pass the check, so credits get spent twice. Check whether
   `ensureMonthlyGrant` already serializes this. If it does not, take
   `pg_advisory_xact_lock(hashtext(owner))` before `availableMicro`.
2. `services/ai/src/app/infrastructure/store_operations.py:36-44`. `OperationStore.update` is
   `WHERE id=$1` with no status or user guard. The domain now serializes `submit_input`/`cancel`
   on the per-user advisory lock (7c7a9fb, 4e88d5b). For defense in depth, add
   `AND user_id=$n AND status=$old` and fail when 0 rows are updated.
3. `services/ai/src/app/infrastructure/store_ai.py:87` (`AiUsageStore.lock_user`) and the same
   helper in `BillingStore`. Move it to a single `UserLock` in `store_common.py`.
   `ProjectService` and `OperationService` currently borrow `AiUsageStore(db).lock_user`.
4. `services/ai/src/app/harness/jobs.py:37-39` (`approved_edit`). It marks the approval CONSUMED
   without checking `expires_at` and without `revision = revision + 1`. Add both to the UPDATE.
5. `services/ai/src/app/graphs/chat.py:496-506`. The job and application are found or created
   outside a transaction, so two concurrent turns with the same URL create duplicates. Add a new
   migration with a unique index `(user_id, source_url)` on jobs and use `ON CONFLICT`.
6. `services/ai/src/app/config.py:32,76`. `APP_ENV` defaults to `"development"`, so a deploy that
   sets `DEV_AUTH_TOKEN` without `APP_ENV` enables dev login. Default to `"production"`.
   (The token compare is now constant-time: 4004807.)
7. `services/ai/src/app/api/schemas.py:95`. Add `max_length=100` to `evidence_ids`. The domain now
   rejects more than 100 (03bd6b8), but the 20 MB body is still parsed first.
8. `services/ai/src/app/domain/services/conversation.py:start_worker` (postgres backend only).
   `reset_stale(0)` requeues every RUNNING job, including jobs owned by another process during a
   rolling restart. Scope the reset to this host's claims or use the default age. Left as is
   because it is documented as deliberate.

## Performance

9. `services/ai/src/app/infrastructure/store_jobs.py:144` (`list_for_prompt`). It loads every
   `reference_samples` row in the category, across all users and with JSON, then filters in
   Python. Push the filter and `GROUP BY … HAVING count(*) >= 30` into SQL and add a LIMIT.
10. `reference_samples` has no unique key (migration 0019:88), so each re-analysis inserts the
    same rows again. Add a new migration with a sample key (hash of user, job, evidence),
    `ON CONFLICT DO NOTHING`, and batch the inserts (`job.py:_write_reference_samples`).
11. Evidence N+1 in `JobService.analyze`, `DocumentService.generate` and resume-run: two to six
    queries per evidence id. Add `EvidenceStore.get_many(user_id, ids)` (`id = ANY($2)`) and
    `ApprovalStore.find_active_many(...)`, then use them in the domain.
12. `services/ai/src/app/domain/services/evidence.py:_source_text` runs `extract_pdf_bytes`
    (pypdf, synchronous, up to 20 MB) on the event loop. Use `asyncio.to_thread` on the VPS. It
    is not safe on Pyodide, so gate it by runtime.
13. `services/ai/src/app/infrastructure/posting_fit_cache.py:8-13`. The cache key (user, posting,
    document) is never invalidated. Add `latest_version_id` to the key.

## Dead code that needs edits outside domain

14. `BillingService` (all methods), `routers/billing.py`, `BillingStore`, `StripeClient`. The
    router is not mounted (`main.py:46-50,255-259`) and owner.ts sends `/billing*` to core.
    Remove them together with `Deps.billing`.
15. `AuthService`: everything except `resolve_access_token` (used by `api/middleware.py:125`). The
    router `routers/auth.py` is not mounted and owner.ts sends `/auth/*` to core or answers
    `/auth/me` itself. Remove it with the router and the auth-only entities (`Session`,
    `ExchangeCode`, `AccessToken`, `RefreshToken`, the TTL constants).
16. `GoogleService` (no router), `CalendarService` and `routers/calendar.py` (not mounted). Move
    `calendar._valid_tz` into `interview.py` first. `scripts/record_parity.py:161` references
    `deps.google.gapi`, and `scripts/record_parity.py:90` calls the nonexistent
    `documents.apply_hunks`.
17. `main.py:131-135`. `ProjectService(approvals=…)` and `ApplicationService(approvals, adapters)`
    no longer use those arguments. Drop them from the constructors and the call sites.
18. `record_usage(usage, user_id, op_id, ai, c, usage_ids, job_id)` (`domain/services/ai.py`).
    Only `usage`, `op_id` and `usage_ids` are used. Simplify it and update
    `graphs/chat.py:741` and `harness/runtime.py:386`.

## BYOK leftovers (managed-only)

19. `entities.AI_PROVIDERS` / `valid_ai_provider` and the required `provider`/`model` fields in
    `AiOptionsReq` (`api/schemas.py`), plus `graphs/chat.py:571-573`, which applies a
    client-chosen `models["generate"]`. `AIGate.check` overwrites provider and model today, so
    none of this is exploitable, but the API contract still asks clients for them.
    `config.byok_master_key` now only encrypts Google tokens; rename it.

## Product decisions (not changed)

20. `link_ingest._read_repo` leaves a link READING forever when the GitHub fetch fails. A test
    asserts this as intended. It also fetches and discards the README and commit bodies.
21. `entities.ai_cost_micro_credits` bills every model at one rate (Opus = DeepSeek Flash).
22. `JobService.analyze` runs `AIGate.check` (the quota gate) even though the analysis is purely
    rule-based, and labels it `AI_ASSISTED`.
23. `document.create_revision`, `interview.prepare` and `project.generate_blueprints` sit on
    "AI" routes but use templates or rules, with no model call.
