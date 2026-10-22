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
