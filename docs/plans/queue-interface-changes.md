# Queue interface changes

Where the code differs from `2026-10-22-push-be-queue-rag.md`, and why.

## Task 1: table name

The plan's table name `jobs` is already the saved-job table from `0001_init.sql`. The queue table is `ai_jobs`. Views, FKs, and enqueue SQL use that name. `chat_jobs` stays the compatibility view. The view covers `type IN ('chat', 'employer_ai')`, because core enqueues employer conversations as `employer_ai` and the chat graph reads them through the view.

## Task 7: job status and async endpoints

- `GET /api/v1/jobs/{id}` is a saved job. Queue status is `GET /api/v1/ai/jobs/{id}` with the body `{data:{id,type,status,progress?,result?,error?,createdAt,updatedAt}}`. Owner or a member of the job's company can read it; anyone else gets 404.
- `POST /api/v1/postings/{id}/fit` (body `{documentId}`) and `POST /api/v1/documents/{id}/generate` (same body as before) now go to core and return `202 {data:{jobId}}`. The job `result` holds what the sync endpoint used to return: the fit view, or `{operationId, document, version}`.
- Employer AI has no separate endpoint. Employer conversation messages were already enqueued by core as `employer_ai`; the ai-worker now runs them with the chat handler. There is no `handlers/employer_ai.py`.
- Document export is not queued. `POST /documents/{id}/exports` only records a `READY_TO_RENDER` row; the client renders the PDF/DOCX and posts the result. There is no server work to queue, so the planned `test_document_export_handler_stores_file_and_result_url` was not written.
- A handler can raise `JobFailed(error)` for errors a retry cannot fix (validation, revision conflict, not found). The job goes to `FAILED`, the reservation is released, and no retry is scheduled.

## Task 8: notifications

- Core sends every in-app notification through `sendNotification` (`services/core-api/src/push/notify.ts`). With `QUEUE_BACKEND=redis` it enqueues a `notify` job on `q:notify` with payload `{notificationId, userId, kind, title, body, target, createdAt}` and no credit reservation. Any other value keeps the old inline insert + Expo push, so core can roll back without a deploy of the worker.
- The worker inserts the `notifications` row with `ON CONFLICT (id) DO NOTHING` and pushes only when the row is new, so a duplicate delivery does not push twice. If the worker dies between the insert and the push, the retry skips the push.
- Notification preference checks (`user_settings`) stay in core, before enqueue.
- The notify handler sends no mail. No notification type sends mail today; signup verification and password reset mail stay in core.

## Task 9: plan gates

- `assertPlanAllows(plan, gate)` takes a gate name (`employer_interview` → PRO, `pdf_attachment` → ULTRA), not `(user, type, payload)`. Those are the only plan gates on routes core owns. The rule table is `REQUIRED_PLAN` in `services/core-api/src/jobs/config.ts`.
- The ai-worker no longer checks the employer interview plan; core rejects it before enqueue.
- Per-user request rate limiting was already in core (`allow(..., "user", ...)` in `handler.ts`), so `ratelimit.ts` is unchanged.
- Not moved yet: the project blueprint cap (FREE 5 / PRO 20 / ULTRA none) and Python's request limiter. Both guard routes that still run in Python. The blueprint cap guards `POST /projects/blueprints`, which is AI work and stayed in Python when 10d moved the other project routes.

## Task 10c: sources, images, career evidence

- `POST /api/v1/sources` moved to core first (`e8b0360`). Core stores the bytes in `sources.content` with path `db://sources/<id>`; Workers cannot write VPS disk. The 201 body adds `jobId` (the `ingest` job) after the Python fields.
- `ingest` jobs reserve no credits (`ESTIMATE_MICRO.ingest = 0n`). Embedding runs on the self-hosted TEI service, and a reservation would make uploads fail for users with no balance, which they never did before.
- Then moved, with parity tests (50 cases, all equal): `GET /sources`, `GET /sources/{id}`, `GET /sources/{id}/content`, `DELETE /sources/{id}`, `POST /uploads/images`, `GET /uploads/images/{key}` (public, as before), `GET/POST /career-evidence`, `GET /career-evidence/{id}`, `POST /career-evidence/{id}/archive`.
- Images now live in Postgres: table `upload_images` (added to 0024; 0023/0024 are this branch's migrations). No R2 bucket exists and creating one is a Cloudflare write outside this task.
- Nothing reads VPS disk for sources any more: Python's `_source_text` and the ingest reader read `sources.content` only. Deploy step: run `scripts/migrate_blobs_to_db.py` once on the VPS after applying 0024 and before switching gateway routing. It copies disk sources into `sources.content` and `STORAGE_DIR/images/*` into `upload_images` (safe to rerun).
- Still in Python, by design: `GET /sources/{id}/profile-draft` and `POST /career-evidence/import`. Both parse PDF/DOCX text, which core must not do.
- Follow-up for 10a (documents is off-limits in this branch): `documents.py` `_avatar_bytes` reads the avatar from disk via `image_path`. Avatars uploaded through core are only in `upload_images`, so the PDF photo is missing until that function calls `infrastructure/images.image_bytes(db, key)` (already added). This must land before the image routes are switched in production.

Parity gaps:
- `POST /sources` 201 body has the extra `jobId` field (ignored in the parity case).
- Binary responses (`/sources/{id}/content`, `/uploads/images/{key}`) match on status, content type and bytes. Python's `FileResponse` also sent `etag`, `last-modified` and `accept-ranges`; core does not.
- The middleware's public rule for `GET /uploads/images/*` stays in Python (dead now, harmless).

## Task 10: parity harness

- `services/ai/scripts/record_parity.py <group>` runs the Python routes against a scratch Postgres (`PARITY_PG_URL`) loaded with `services/core-api/test/parity/seed.sql`, clock frozen at 2026-10-22T12:00:00Z, and writes `<group>.golden.json`.
- `services/core-api/test/parity-<group>.test.ts` sends the same requests (`<group>.cases.json`) to core. With `PARITY_PG_URL` it runs against the real database (Neon driver through a local WebSocket proxy, `test/parity/pg.ts`); add `PARITY_RECORD=1` to save core's query results to `<group>.queries.json`. Without a database it replays that file, so `npm test` checks parity offline.
- Comparison: status code plus the JSON body with key order. Normalized before comparing: ids generated during the run (`<new-uuid>`), the order of rows created in the same instant (both sides break that tie with random ids), and pydantic's schema error text (see gaps).
- Re-recording needs the Python routes, which are deleted once a group moves. Check out the commit before the move to re-record a golden file.
- The core test script now quotes its glob (`'test/**/*.ts'`). Unquoted, the shell expanded it to the files in `test/parity/` only.

## Task 10b: applications

Moved to core: `GET/POST /applications`, `POST /applications/import`, `GET/PATCH /applications/{id}`, `GET /applications/{id}/timeline`, `GET /applications/{id}/checklist`, `POST /applications/{id}/submission-drafts`, `GET/POST /applications/{id}/submissions`. `POST /applications/{id}/resume-run` stays in Python (AI). 57 parity cases, all equal.

Parity gaps:
- Schema-level body errors (missing field, extra field, wrong JSON type, bad UUID) return the same 400 `VALIDATION_ERROR` with `details: null`, but the message is `invalid request body` instead of `invalid request body: <pydantic error text>`.
- `appliedAt` and `nextActionAt` accept the usual RFC3339 forms (date, date-time, fraction up to 6 digits, `Z` or offset). Python `datetime.fromisoformat` also accepts rarer ISO forms (basic format, week dates); core answers 400 for those.
- Submit: Python runs the checks and writes in one transaction. Core runs the checks, then one statement that consumes the approval only while the application revision is unchanged, and writes the submission, stage change and events with it. A concurrent edit between the checks and that statement gives 409 `REVISION_CONFLICT`, as in Python.

## Task 10d: experiments

Moved to core: `GET /experiments/{key}/assignment`, `POST /experiments/{key}/events`, `GET /experiments/{key}/stats`, `GET /experiments/{key}/results`. 22 parity cases, all equal. Seeding from `EXPERIMENTS` still runs in the Python bootstrap (ai-worker), which writes the same `experiments` table.

Parity gaps: schema-level body errors (message text only, as in 10b). `rate` of `0.0`/`1.0` is written as `0`/`1`; JSON readers see the same number.

## Task 10d: interviews

Moved to core: `GET/POST /interviews`, `GET/PATCH /interviews/{id}`. `POST /interviews/{id}/prepare` stays in Python (gateway treats it as AI). 33 parity cases, all equal, including SQL checks of the calendar event and `INTERVIEW` application event that create and patch write. Core writes the calendar event, interview and application event in one statement (Python used one transaction).

Parity gaps: schema-level body errors (message text only). Time zones are checked with `Intl.DateTimeFormat` (as core's calendar routes already do) instead of `zoneinfo`; `Intl` also accepts different capitalization (`utc`), which Python rejects on Linux.

## Task 10d: projects

Moved to core: `GET /projects`, `GET /projects/{id}`, `POST /projects/{id}/select`, `GET/POST /projects/{id}/runs`, `POST /projects/{id}/runs/{runId}/start|launch|recover|result`, `GET/POST /projects/{id}/evidence`. Still in Python (AI): `POST /projects/blueprints`, `POST /projects/{id}/evidence/{evidenceId}/verify`. 61 parity cases, all equal, including the run `payloadHash` for a Korean and emoji prompt and an SQL check of approval consumption.

- `hashJson` (`services/core-api/src/http.ts`) reproduces Python's `hash_json` exactly: sorted keys at every level, compact separators, non-ASCII escaped as `\uXXXX` (Python's default `ensure_ascii=True`). Applications drafts use it too.
- Starting a run consumes the `CLI_EXECUTE` approval only while the run revision is unchanged, in the same statement that moves the run to `RUNNING`.

Parity gaps: schema-level body errors (message text only).

## Task 10d: Google integration

Moved to core: `GET/DELETE /integrations/google`, `POST /integrations/google/connect|complete|sync`, `GET /integrations/google/callback` (public, as before), `GET /integrations/google/messages|events`, `POST /integrations/google/messages/{id}/link`. `GET /integrations/job-sites` was already answered by the gateway itself; the dead Python route is gone. 47 parity cases, all equal, with SQL checks of the synced messages, calendar events, integration row, operation row, used codes and OAuth states.

- Parity runs the real Python `GoogleClient` against an `httpx.MockTransport` and core against a fake `fetch`, both serving `test/parity/integrations.http.json`. No test calls Google.
- Tokens stay encrypted with the same AES-GCM key and AAD (`<userId>|google|v1`), so rows written by Python before the switch keep working.
- The OAuth callback URL is now built from the request origin core sees, which is the public gateway host. Python on the VPS built it from its own host. Deploy step: add `https://<gateway host>/api/v1/integrations/google/callback` to the Google OAuth client's authorized redirect URIs.

Parity gaps:
- Sync writes messages, events, the integration row and the operation one statement at a time; Python used one transaction. A failure in the middle can leave some synced rows behind, with the operation marked FAILED.
- Schema-level body errors (message text only).
