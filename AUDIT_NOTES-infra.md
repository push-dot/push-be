# Audit notes: infra (cross-area)

Issues found while auditing infra, CI and db/migrations that need a change outside that area.
Migrations 0027 (audit/ai-runtime) and 0028 add the indexes these queries need. The query fixes below still matter.

| File | Line | Problem | Proposed fix |
| --- | --- | --- | --- |
| services/ai/src/app/queue/dispatcher.py | 55 | Filters `status IN ('QUEUED','RETRY','PENDING')`. `ai_jobs` has a CHECK that forbids `'PENDING'`, and the extra value stops the planner from using the partial index `idx_ai_jobs_queued` | Drop `'PENDING'` from the list |
| services/ai/src/app/infrastructure/store_chat_jobs.py | 51, 97, 106, 252 | Claim and stale sweeps go through the `chat_jobs` view. Its `status` is a `CASE` expression, so every poll scans all of `ai_jobs` | Query `ai_jobs` directly with `status IN ('QUEUED','RETRY')` and `type IN ('chat','employer_ai')` |
| services/gateway/src/routes/conversations.ts, services/gateway/src/middleware/ratelimit.ts | 54, 278 / 144, 186 | The per-row `EXISTS (SELECT 1 FROM chat_jobs ...)` runs through the same view | Use `ai_jobs` with `status IN ('QUEUED','RETRY','RUNNING')` (index `idx_ai_jobs_conversation` from 0027 covers it) |
| services/core-api/src/jobs/credits.ts | 12, 15 | `USER_SETTLED` and `COMPANY_SETTLED` sum the user's whole `ai_usage` history on every AI call | 0028 adds the covering index `idx_ai_usage_settled`, which makes this an index-only scan. It still grows with history. Keep a running settled total, or roll old usage into `billing_ledger` |
| services/ai/src/app/account_purge.py | 14 | Only users are purged. Companies with `deletion_requested_at` are never deleted. 0028 makes company FKs CASCADE/SET NULL, so a company purge can now complete | Add a company purge with the same 30-day rule |
| db (product decision) | 0002, 0018 | Employer conversations cascade on `conversations.user_id`. Purging one member deletes company-wide chats | Decide on the policy. Either transfer the conversation to the company (`user_id` SET NULL plus NOT NULL relaxed) or keep the cascade |
| services/ai (schema follow-up) | — | Orphan-prone columns with no FK: `workspace_files.conversation_id`, `approvals.job_id`, `posting_fit_cache.posting_id/document_id`, `application_files.source_id/document_id`, `operations.application_id`, `messages.operation_id`, `rag_nodes.source_id` (the trigger covers `sources` only). `upload_images.user_id` is nullable, so those rows are never purged | Add FKs with `NOT VALID` plus `VALIDATE` in a later migration after cleaning orphans. Delete orphans in the purge |
| services/ai/src/app/ingest/pdf_text.py | 10 | `opendataloader-pdf` needs a Java runtime. The image has none, so every PDF silently falls back to pypdf | Either add `default-jre-headless` to the image (about 200 MB, so check the memory budget), or drop the extra |
| services/ai/tests/test_migrate_workflow.py | 26 | Asserts the literal `websockets>=13,<17` in migrate.yml. The workflow now installs it through `uv sync --locked --extra migrate`, so only a comment satisfies the assert | Assert `--extra migrate` in migrate.yml and `websockets` in the `migrate` extra of pyproject.toml |
| services/ai/src (Python style) | — | `ruff check`: 1152 findings, 549 auto-fixable. `ruff format`: 245 files. `mypy --strict`: 1599 errors in 131 files. CI reports these and does not fail | Owners of each package: run `uv run ruff check --fix` and `ruff format` per area, then make lint-ai blocking |

## RLS

Every service connects as one Neon role, and tenancy is enforced in SQL (`WHERE user_id = $1` / `company_id`). Postgres RLS would need `SET LOCAL app.user_id` per transaction. The gateway and core use Neon's HTTP driver (one statement per request unless batched), and the Python Worker uses a wire client. Turning RLS on without that plumbing would deny every row or need `BYPASSRLS`. Recommendation: no RLS for now. Keep tenant filters in the store layer and the index set above. If RLS is adopted later, start with `rag_nodes` and `messages` through a `SECURITY DEFINER` search function that takes the tenant id.

## CI and deploy settings outside the repo

- Set the repository variable `VPS_SSH_HOST_KEY`. Deploy now stops without it instead of trusting `ssh-keyscan`.
- Recommended: move the deploy job's secrets into a GitHub `production` environment that only `main` may use, and add `environment: production` to the job. That keeps secrets away from a workflow edited on another branch.
- Re-run `harden.sh` on the VPS so the root-owned `check-compose` and `push-watchdog` pick up the new rules.
- Apply `db/migrations/0028_fk_actions_hot_indexes.sql` off-peak with the **Migrate database** workflow.
