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
- Not moved yet: the project blueprint cap (FREE 5 / PRO 20 / ULTRA none) and Python's request limiter. Both guard routes that still run in Python (`POST /projects/blueprints` and the rest of `ai-api`). They move with Task 10d.

## Task 10: Python CRUD to core

Only part of 10c is done in this branch.

- `POST /api/v1/sources` moved to core. Core always stores the bytes in `sources.content` with path `db://sources/<id>` (Python's `BLOB_STORE=db` mode); Workers cannot write VPS disk. Validation and error bodies match Python (`kind`/`file` required, 20 MiB, same MIME list). The 201 body adds `jobId` (the `ingest` job) after the Python fields.
- `ingest` jobs reserve no credits (`ESTIMATE_MICRO.ingest = 0n`). Embedding runs on the self-hosted TEI service, and a reservation would make uploads fail for users with no balance, which they never did before.
- Still in Python: `GET /sources`, `GET /sources/{id}`, `GET /sources/{id}/content`, `GET /sources/{id}/profile-draft`, `DELETE /sources/{id}`, `/uploads/images`, and the `career-evidence` routes. Older sources live on VPS disk, which core cannot read, and the profile draft parses files, which core must not do.
- 10a (documents), 10b (applications), and 10d (integrations, experiments, interviews, projects) were not started. See the final report.

## Task 12: RAG nodes and ingest

- `rag_nodes.user_id` is nullable. A row needs a user or a company (`rag_nodes_tenant_chk`). Company postings are stored with only `company_id`.
- A trigger on `sources` deletes that source's `rag_nodes` rows, so a deleted upload stops being searchable without a code change in the Python delete route. Account purge reaches `rag_nodes` through `ON DELETE CASCADE`.
- LlamaIndex `PGVectorStore` is not used. It owns its table layout (`data_<name>`, a `metadata_` JSON column) and cannot hold the tenant columns that the mandatory filter and deletion rely on. LlamaIndex `SentenceSplitter(512, 64)` builds the `TextNode`s; `RagNodeStore` (asyncpg) writes them.
- The splitter counts tokens with an offline approximation (one Hangul syllable or one Latin word per token), so ingest never downloads a tokenizer at runtime.
- `ingest_source(source_id, tenant)` is `Ingestor.ingest_text(tenant, source_type, source_id, text)` plus the `ingest` job handler. The handler picks the reader from the payload: `sourceId`, `postingId`, `url`, `githubRepo` (`owner/name`: README + last 20 commit subjects), or `reindex: true`.
- `reindex_all` walks `sources` that have no rows for the current embedding model and writes new rows. Rows for other models stay until they are dropped by hand after the switch.
- `llama-index-core` is in the `local` extra (already listed), not in the base dependencies. `tests/test_rag_pipeline.py` skips when it is not installed.

## Task 13: retrieval

- `Retriever(db, embedder, reranker).search(query, tenant, k=5, *, kinds=None)` matches the planned signature as a method. `Hit` also carries `source_type`.
- The keyword side uses `pg_trgm` `word_similarity` with `pg_trgm.word_similarity_threshold = 0.3` (set per transaction), on the first 200 characters of the query.
- `RAG_ENGINE=llamaindex` switches chat retrieval (personal and employer, both use `collect_evidence`) to `rag_nodes`. Any other value keeps the old `rag_chunks` path. The chat tenant is the calling user; company-wide nodes are not searched from chat yet.

## Task 14: evaluation

- `eval/rag/run_eval.py` runs both methods in memory over `fixtures/docs.json` (21 made-up documents, 3 tenants) and `fixtures/queries.json` (55 queries). It writes nothing to a database.
- `grounded_rate` is a retrieval proxy: the share of queries whose top-k text contains one of the expected answer terms. No LLM answer is generated.
- The real baseline (legacy, 1536-d API embeddings) and the llamaindex run (TEI bge-m3) were not measured in this branch, because both need live embedding calls. Run them on the VPS before switching `RAG_ENGINE`.

## Task 15: LangChain by default

- `AI_FRAMEWORK` is gone. The VPS always uses LangChain (prompt templates, `ChatOpenAI` for OpenAI-compatible providers, `StructuredTool`, `SentenceSplitter`).
- The non-LangChain path stays only for `CF_WORKER=1`, because the Cloudflare Python Worker (`push-be-python`) runs on Pyodide and cannot load LangChain. The gateway still falls back to that Worker when `AI_ORIGIN` is unset. Delete the path together with `push-be-python`, once `AI_ORIGIN` is fixed and the last Python CRUD routes have moved (Task 10).
- The `ImportError` fallbacks in `domain/services/ai.py` are kept for the same reason.

## Task 16: operations

- The admin endpoints are served by the dispatcher (`kick_app` mounts `api/routers/admin_queue.py`), not by `ai-api`. `ai-api` is temporary and sits behind the gateway-secret middleware; the dispatcher outlives it and already holds the queue. Paths are `/admin/...` on `DISPATCH_HOST`.
- Retry and cancel answer 409 when the job is not in a state that allows it.
- Alerts are split by cost: Redis-only checks (`queue_wait`, `dead_recent`) every minute, DB checks (`heartbeat_lost`, `db_size`) on the 15-minute sweep, so the dispatcher never wakes Neon once a minute. Alert state lives in dispatcher memory; a restart can resend an active alert once. There is no embedding-throughput alert; `bench_embed.py` measures it before deploy.
- `ai_jobs.started_at` was added to 0023 for wait and run percentiles. Retention runs on each sweep and relies on the cascades fixed in 747d56a.
- Workers skip a stream while `pause:<stream>` exists in Redis.
- `ragNodes` in the stats comes from `pg_class.reltuples`, an estimate that is 0 before the first `ANALYZE`.

## VPS memory (follow-up to Task 16)

- The spec §6 budget (7.3 GB) did not subtract the 1.6–2.0 GB Dokploy, Traefik and other apps already use. Compose limits now sum to 5,056 MB, which leaves at least 1 GB free.
- The temporary `ai` container is gone. `ai-worker` serves the remaining Python HTTP routes in the same process when `SERVE_API=1`.
- `RERANK_PROVIDER` (new): `similarity` (default) reranks with embedding cosine similarity; `tei` uses the `rerank` container, which is now behind the `rerank` compose profile. bge-reranker-v2-m3 needs about 2.5 GB, which does not fit next to `embed`.
