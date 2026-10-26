# AUDIT_NOTES — ai-runtime

Findings outside this area (services/ai queue, workers, harness, infrastructure stores, ingest, embedding). Not fixed here.

| Sev | File:line | Problem | Proposed fix |
|-----|-----------|---------|--------------|
| High | services/ai/src/app/domain/services/ai.py:29,170,194 | Every chat call in one job uses the same `usage_row_id(job_id, "chat")`. Each call's RESERVED row overwrites the previous one, so only the last call is billed. | Include a per-call sequence (or the LLM call id) in the usage row id. The settled upsert already adds rows that share an id (4c92d4e), but chat rows start RESERVED. |
| High | services/ai/src/app/domain/services/ai.py:163-177 | Redis-mode `_reserve` writes RESERVED with no `lock_user`, no `expire_stale` and no monthly allowance check. Concurrent jobs can overspend. | Use the same locked reserve path as Postgres mode, or reserve atomically in Redis. |
| High | services/ai/src/app/domain/services/google.py:234,356 | `put_google_integration` upserts a whole snapshot, so the last writer wins. A disconnect during a sync is undone by the sync's write, which brings the revoked tokens back. Overlapping syncs can roll back `gmail_history_id` and `calendar_sync_token`. | Take a per-user advisory lock around refresh/sync/disconnect, and make the write a conditional `UPDATE ... WHERE updated_at = $old` (no insert on sync). |
| Medium | services/ai/src/app/domain/services/interview.py:160 | `update_calendar_event` has no user argument, so the store update is scoped by id only. | Pass `user_id`; then add `AND user_id = $n` in `store_calendar.update_calendar_event`. Check `harness/personal/tools.py:340` too. |
| Low | db (new migration) | `job_postings` has no `updated_at`, so the fit cache cannot invalidate on posting edits (`posting_fit_cache.py`, shortcut comment). | Add `updated_at` (with a trigger or explicit writes in core-api), then add `AND c.created_at >= p.updated_at`. |

Behaviour changes callers should know about:
- `OperationStore.update` now raises 409 `invalid_transition` for finished operations (4c92d4e). `operation.py:54,74` return 409 on a finish race instead of overwriting. If a user cancels during a sync, `google.py:363` ends the sync as `provider_error`.
- Migration 0027 builds its indexes without `CONCURRENTLY`, because migrations run in a transaction. Writes to those tables block briefly while the indexes build. Apply it off-peak.
