# AI chat gaps (gateway + AI)

> Implement with superpowers-hooks:subagent-driven-development. One fresh implementer per task. The parent runs a fresh reviewer against this plan and feature-spec after each task. Checkbox steps.

**Goal:** Close the AI-service and gateway gaps for the mobile AI chat screens. Core-api privacy, apply, notifications, sorting, replies, and counts stay on `feat/fo-web-employer-api`. Do not edit those handlers.

**Architecture:** Gateway already owns conversation list and SSE replay from `chat_events`. The AI worker emits those rows from LangGraph `_emit` custom chunks. New event types are extra `chat_events` rows. New reads that are not conversation-list or SSE live on the Python app, which the gateway already proxies. Schema is only `db/migrations/0022_ai_chat_gaps.sql`.

**Tech stack:** gateway and core-api `node --experimental-strip-types --test` and `tsc --noEmit`. AI `pytest` from `services/ai`. Fake `query`. No remote database. No live HTTP in tests.

**Docs that win:** feature-spec §2, §3.4, §9, §15, §18 and this plan. Design text is `/Users/cyjoon/push-design/design-text.md`. Do not edit `packages/api-client`.

## Global constraints

- No push, no PR, no remote migration, no live Stripe/GitHub/OpenRouter calls in tests.
- New TypeScript functions are arrow functions. Do not convert existing `function` declarations. Python stays `def`. No code comments.
- Add fields. Do not rename or remove fields fo-mobile already reads (`id`, `revision`, `applicationId`, `title`, `pinned`, `createdAt`, `updatedAt`, SSE `token|status|error|done`).
- Commit each task. Conventional Commits, scope required, summary under 72 characters, trailer `Co-Authored-By: Grok 4.7 Fast <noreply@x.ai>`.
- TDD: failing test, run it, then implement. Full suite of the service you touch before the commit.
- Migration file is only `db/migrations/0022_ai_chat_gaps.sql`. Task 1 creates the whole file. Later tasks do not add a migration.

## Event schema

SSE frame stays `id: <seq>\ndata: <json>\n\n`. `seq` is `chat_events.id`. Old bodies stay:

- `token`: `{type, seq, text}`
- `status`: `{type, seq, text}`
- `error`: `{type, seq, error:{code, message, details}}`
- `done`: `{type, seq, operation}`

New bodies. Unknown `type` is forwarded as `{type, seq, ...payload}` and is not terminal. Terminal types are `done`, `error`, `cancelled`.

- `tool`: `{type, seq, name, state, summary}`. `state` is `run|ok|err|wait`.
- `todo`: `{type, seq, items:[{id, text, state}]}`. `state` is `todo|now|done`.
- `diff`: `{type, seq, documentId, revisionId, hunks:[{line, sign, text}]}`. `sign` is `+`, `-`, or `""`.
- `approval`: `{type, seq, id, kind, title, options:[{id, label}]}`.
- `choice`: `{type, seq, id, options:[{id, label}]}`.
- `fit`: `{type, seq, score, parts:{techStack, experienceLink, keyword}, topGap}`. `score` is 0–10, one decimal. Each part is an integer 0–100.
- `cancelled`: `{type, seq}`.

`fit.score` is the 10-point design score. It is not `gap_analyses.fit_score` (0–100).

Mobile mock nests `approval` and uses different item shapes. This wire format wins. Clients map it.

## Rulings

1. `GET /sources` merges uploads and AI documents. No `GET /me/documents`.
2. `POST /api/v1/postings/{id}/fit` is Python. Gateway `isAi` matches it before `isCore`. Core `GET /postings?minFit=` is not implemented here. The cache table is the contract.
3. `default_effort` and `confirm_before_edit` are core columns. AI reads them. A missing column or missing row means effort `MEDIUM` and `confirmBeforeEdit` true. Do not add the columns in 0022.
4. AI_DONE: when a chat job finishes `DONE`, AI inserts one `notifications` row if that table exists. On any failure, log and continue. No core route. Row: `type = 'AI_DONE'`, `title = 'AI 작업이 끝났어요'`, `body = ''`, `target = {"kind":"conversation","id":"<conversationId>"}`.
5. Interview-question export has no server endpoint. The client prints the message.
6. Approval `POST` stores the choice. It does not resume the graph. The client sends the next message.
7. Template write accepts `SIMPLE|MODERN|CREATIVE|ATS` and the old names. `CLASSIC` maps to `SIMPLE`. `COMPACT` maps to `ATS`. Stored and returned values are the new names. `MODERN` stays.
8. Conversation `q` is a case-insensitive substring on `title` and the latest message text. No es-hangul on the server.
9. List order is `updated_at DESC, id DESC`. Cursor is that pair. `createdAt` stays on the item.
10. List `status`: a `PENDING` approval on the conversation is `NEEDS_APPROVAL`. Else a `PENDING` or `RUNNING` chat job is `RUNNING`. Else `DONE`.
11. `photo=1` on export draws `profiles.avatar_key` when the object exists. Missing photo still exports.
12. GitHub link read and posting-link save run inside the chat job. Tests stub HTTP and the database.

## Schema (0022)

```sql
ALTER TABLE approvals ADD COLUMN conversation_id uuid REFERENCES conversations(id);
ALTER TABLE approvals ADD COLUMN title text NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN options jsonb NOT NULL DEFAULT '[]';
ALTER TABLE approvals ADD COLUMN option_id text;

ALTER TABLE sources ADD COLUMN page_count int;
ALTER TABLE sources ADD COLUMN origin text NOT NULL DEFAULT 'UPLOAD';
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_origin_chk;
ALTER TABLE sources ADD CONSTRAINT sources_origin_chk CHECK (origin IN ('UPLOAD', 'AI'));

CREATE TABLE posting_fit_cache (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    posting_id uuid NOT NULL,
    document_id uuid NOT NULL,
    fit_score numeric(3,1) NOT NULL,
    parts jsonb NOT NULL,
    top_gap text NOT NULL DEFAULT '',
    plan text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, posting_id, document_id)
);

CREATE TABLE conversation_shares (
    conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);
```

`chat_jobs.status` already has no check. `CANCELLED` needs no column. `documents` stay the AI half of "내 서류" and are not given `origin`.

Core contract for `minFit` (do not implement in core-api):

```sql
SELECT p.* FROM job_postings p
JOIN posting_fit_cache f
  ON f.posting_id = p.id AND f.user_id = $user AND f.document_id = $document
WHERE f.fit_score >= $minFit
```

## File map

```
db/migrations/0022_ai_chat_gaps.sql
services/core-api/test/migration-0022.test.ts
services/gateway/src/routes/conversations.ts
services/gateway/src/handler.ts
services/gateway/src/middleware/ratelimit.ts
services/gateway/src/routes/owner.ts
services/ai/src/app/graphs/chat.py
services/ai/src/app/graphs/chat_surface.py
services/ai/src/app/domain/services/conversation.py
services/ai/src/app/domain/entities.py
services/ai/src/app/api/routers/evidence.py
services/ai/src/app/api/routers/documents.py
services/ai/src/app/api/routers/conversations.py
services/ai/src/app/infrastructure/doc_render.py
docs/plans/2026-10-22-be-ai-chat-gaps.md
```

---

### Task 1: Structured chat stream events

**Files:**

- Create: `db/migrations/0022_ai_chat_gaps.sql`
- Create: `services/core-api/test/migration-0022.test.ts`
- Create: `services/ai/src/app/graphs/chat_surface.py`
- Create: `services/ai/tests/test_chat_surface.py`
- Modify: `services/ai/src/app/domain/services/conversation.py` (`_run_job` custom chunk mapping only)
- Modify: `services/ai/src/app/graphs/chat.py` (call the surface emitter from the existing prepare and persist paths)
- Modify: `services/gateway/src/routes/conversations.ts` (`sseFrame` and the terminal check)
- Modify: `services/ai/src/app/api/routers/conversations.py` (approval resolve)
- Test: `services/gateway/test/stream-events.test.ts`

**Interfaces:**

- Consumes: `chat_events(job_id, type, payload)`, `_emit`, `event_sink`, approvals table.
- Produces: the event schema above. `POST /api/v1/conversations/{id}/approvals/{approvalId}` body `{optionId}` → `{data:{id, status:"APPROVED", optionId}}`. Unknown option `400 VALIDATION_ERROR`. Missing row `404`. Second decide `409 CONFLICT`.

- [ ] **Step 1: Write the failing tests**

  Gateway: a `tool` row is framed as `type: tool` with `name`, `state`, `summary`, and `seq`. A `todo`, `diff`, `approval`, `choice`, `fit` row round-trips its fields. An unknown type `future` is forwarded and the poll loop does not stop. `done` still stops the loop. `token` shape is unchanged.

  AI: `surface_events(state)` returns no structured events for a plain chat. For a state with a tool name, a todo list, a diff hunk, `confirm_before_edit` true, a fit score, and a choice, it returns those event dicts. `_run_job` (or the small mapper it calls) writes `type` `tool` rather than dropping the chunk. Approval insert uses `conversation_id` and the options JSON. Resolve endpoint tests use the app's existing fake-db or router test style.

  Migration: file contains `posting_fit_cache`, `conversation_shares`, `approvals` `conversation_id`, `sources` `origin`.

- [ ] **Step 2: Run the new tests.** Expected: FAIL because the modules and migration are missing.

- [ ] **Step 3: Implement.** Mapper in the worker:

  `token` and `status` stay as they are. A chunk with `type` in the new set is `emit(job_id, type, payload without type)`. `surface_events` is a pure function. Call it from prepare when the turn names a tool or a posting read, and from persist when saved document hunks or a fit result exist. When `confirm_before_edit` is not false and a diff exists, emit `approval` and insert the approvals row, and skip applying that diff. Default the flag to true only when the key is absent. A plain chat emits nothing new.

  Gateway `sseFrame` copies the payload for the new types and for unknown types. Terminal check includes `cancelled` so task 2 can reuse it.

- [ ] **Step 4: Run** gateway `npm test`, gateway `npx tsc --noEmit`, ai `pytest`, core `node --experimental-strip-types --test test/migration-0022.test.ts`.

- [ ] **Step 5: Commit** `feat(chat): emit structured stream events`.

---

### Task 2: Stream cancel

**Files:**

- Modify: `services/gateway/src/handler.ts`
- Modify: `services/gateway/src/routes/conversations.ts`
- Modify: `services/ai/src/app/domain/services/conversation.py`
- Test: `services/gateway/test/stream-cancel.test.ts`
- Test: `services/ai/tests/test_chat_cancel.py`

**Interfaces:**

- `POST /api/v1/conversations/{id}/stream/cancel` → `{data:{jobId, status:"CANCELLED"}}`.
- No active `PENDING` or `RUNNING` job: `409 CONFLICT`.
- Sets `chat_jobs.status` to `CANCELLED` and inserts `chat_events` type `cancelled` payload `{}`.
- Worker, before `finish(..., "DONE")` and before each structured or token emit, re-reads status. `CANCELLED` means stop, do not emit `done`, do not overwrite the status.
- SSE poll treats `cancelled` as terminal.

- [ ] **Step 1: Failing gateway test** that the route returns 200 and the next SSE read contains `type: cancelled` then ends. Failing AI test that a job flipped to `CANCELLED` during the stream does not call `finish` with `DONE`.

- [ ] **Step 2: Run them and see the failure.**

- [ ] **Step 3: Implement the gateway route and the worker check.**

- [ ] **Step 4: Gateway `npm test` and `tsc`. AI `pytest`.**

- [ ] **Step 5: Commit** `feat(chat): cancel an active stream`.

---

### Task 3: Conversation list

**Files:**

- Modify: `services/gateway/src/routes/conversations.ts`
- Modify: `services/gateway/src/middleware/ratelimit.ts` (`LIST_SQL` only)
- Test: `services/gateway/test/conversation-list.test.ts`

**Interfaces:**

- Item adds `status` (`NEEDS_APPROVAL|RUNNING|DONE`), `lastMessagePreview` (latest message text, empty string when none, trim to 140 chars), `createdBy: {displayName}`, `postingId` (nullable uuid string).
- `q` filters title or last message, case-insensitive. Empty `q` changes nothing.
- Order and cursor: `updated_at DESC, id DESC`.
- Employer audience keeps company scope. Personal scope stays `company_id IS NULL`.
- Update both `listConversationsFor` and `LIST_SQL`. Same JSON shape.

- [ ] **Step 1: Failing test** with a fake `query` that records SQL. A newer `updated_at` row comes first. `q` is bound. Pending approval forces `NEEDS_APPROVAL` even if no job is running. A running job without an approval is `RUNNING`. Otherwise `DONE`.

- [ ] **Step 2: Run the test.**

- [ ] **Step 3: Implement.** One SQL, not a per-row follow-up query. Join `users` for `display_name`. Lateral or scalar subqueries for last message, pending approval, and active job.

- [ ] **Step 4: Gateway `npm test` and `tsc`.**

- [ ] **Step 5: Commit** `feat(chat): add conversation list status and search`.

---

### Task 4: Sources list

**Files:**

- Modify: `services/ai/src/app/api/routers/evidence.py`
- Test: `services/ai/tests/test_sources_list.py`

**Interfaces:**

- `GET /api/v1/sources?kind=&cursor=` page `{data:[{id, fileName, mimeType, size, pageCount, createdAt, origin}], page:{nextCursor, hasMore}}`.
- `kind` is `UPLOAD` or `AI`. Omit it to return both.
- Upload rows come from `sources` (`origin` column, default `UPLOAD`). AI rows come from `documents` for that user: `origin: "AI"`, `fileName` is `title`, `mimeType` is `application/json`, `size` is `0` when unknown, `pageCount` is null.
- Cursor is the same `(createdAt, id)` cursor the gateway uses. Order `created_at DESC, id DESC`.
- Another user's rows are absent. Missing auth follows the router's existing 401.

- [ ] **Step 1: Failing test** that both kinds merge, `kind=AI` drops uploads, and the cursor skips the first page.

- [ ] **Step 2: Run it.**

- [ ] **Step 3: Implement in the evidence router.** Reuse the app's page helper if one exists.

- [ ] **Step 4: `pytest`.**

- [ ] **Step 5: Commit** `feat(sources): list uploads and AI documents`.

---

### Task 5: Per-posting fit

**Files:**

- Create: `services/ai/src/app/domain/posting_fit.py`
- Modify: `services/gateway/src/routes/owner.ts` (`isAi` only)
- Modify: the Python router that owns postings or a new small router included by the app
- Test: `services/ai/tests/test_posting_fit.py`
- Test: `services/gateway/test/owner-fit.test.ts`

**Interfaces:**

- `POST /api/v1/postings/{id}/fit` body `{documentId}` → `{data:{fitScore, parts:{techStack, experienceLink, keyword}, topGap, plan}}`.
- `fitScore` is 0–10, one decimal. Parts are integers 0–100. `plan` is the caller's plan name or `FREE` when null.
- Second call with the same user, posting, and document returns the cached row and does not recompute.
- Compute with the existing part-score helpers when the posting text and document text are in the database. No model call.
- `topGap` is the lowest part's label: `기술 스택`, `경험 연관성`, or `키워드`. Ties prefer `기술 스택`, then `경험 연관성`.
- Unknown posting or document, or a document the user does not own: `404`.
- Gateway sends this POST to Python, not core.

- [ ] **Step 1: Failing domain test** for the score and the cache write. Failing owner test that the path is `python`.

- [ ] **Step 2: Run them.**

- [ ] **Step 3: Implement.** Upsert `posting_fit_cache`.

- [ ] **Step 4: AI `pytest`. Gateway `npm test`.**

- [ ] **Step 5: Commit** `feat(fit): cache a posting document score`.

---

### Task 6: PDF templates

**Files:**

- Modify: `services/ai/src/app/domain/entities.py`
- Modify: `services/ai/src/app/domain/services/document.py` (validation message only)
- Modify: `services/ai/src/app/infrastructure/doc_render.py`
- Modify: `services/ai/src/app/api/routers/documents.py` (export query)
- Test: `services/ai/tests/test_pdf_template.py`

**Interfaces:**

- Stored template is `SIMPLE|MODERN|CREATIVE|ATS`.
- Write `CLASSIC` stores `SIMPLE`. Write `COMPACT` stores `ATS`. Read returns the stored new name.
- Export query `template` overrides the document template for that render only and does not write the row. Invalid template is `400`.
- Export query `photo=1` embeds the profile image when `profiles.avatar_key` resolves. `photo` omitted or `0` draws no photo.
- `render_pdf(lines, template, photo_bytes=None)` changes the PDF bytes when the template or the photo changes. ATS keeps extractable text (the existing text PDF path). Do not add a dependency.

- [ ] **Step 1: Failing tests** for the four names, both aliases, and two different PDF byte prefixes or lengths for `SIMPLE` vs `ATS`. Photo present changes the bytes. Photo missing still returns a PDF.

- [ ] **Step 2: Run them.**

- [ ] **Step 3: Implement the map and a small template marker in the PDF** (a text line the test can read, or a deterministic byte difference). Keep the existing `md_to_pdf` call.

- [ ] **Step 4: `pytest`.**

- [ ] **Step 5: Commit** `feat(documents): add the four PDF templates`.

---

### Task 7: Source profile draft

**Files:**

- Create: `services/ai/src/app/domain/profile_draft.py`
- Modify: `services/ai/src/app/api/routers/evidence.py`
- Test: `services/ai/tests/test_profile_draft.py`

**Interfaces:**

- `GET /api/v1/sources/{id}/profile-draft` → `{data:{displayName, headline, tenureYears, intro, careers:[{company, title, start, end}], skills:string[]}}`.
- Parse the source text with the pure function. No model call. Missing pieces are `""`, `null` for `tenureYears`, or `[]`.
- A fixture that contains `이름: 김서준`, `한 줄: 백엔드`, `연차: 5`, a career block, and `기술: Kotlin, Spring` fills those fields.
- Another user's source is `404`.

- [ ] **Step 1: Failing parser test and route test.**

- [ ] **Step 2: Run them.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: `pytest`.**

- [ ] **Step 5: Commit** `feat(sources): draft a profile from a source`.

---

### Task 8: Link ingest

**Files:**

- Create: `services/ai/src/app/domain/link_ingest.py`
- Modify: `services/ai/src/app/graphs/chat.py` (one call from the existing job path)
- Test: `services/ai/tests/test_link_ingest.py`

**Interfaces:**

- Do not edit `services/core-api/src/routes/recruiting.ts`.
- A new `https://github.com/{owner}/{repo}` link with `ai_read` true is updated to `READING`, then `READ`, after the stub HTTP returns a README and commit subjects. The title becomes the repo name when it was empty. HTTP failure leaves `READING`.
- `fit_count` increments by 1 when a tailoring turn's context contains that link id or its URL, and this conversation has not already counted it. Store the guard in the function's SQL (`UPDATE ... WHERE` plus a note in `approvals` is the wrong table). Use `UPDATE user_links SET fit_count = fit_count + 1` only when a `chat_events` or a new use is not available. Guard with a `NOT EXISTS` against a row you can write without a new table: skip the increment when `fit_count` was already bumped for this URL in this process call, and make the function accept `already_counted: bool`. The route/job passes `already_counted` from a `SELECT` of messages in the conversation that contain the URL. One matching older message means already counted.
- A chat message that contains `https://` posting URL inserts `user_links` `kind = 'job'`, `status = 'READING'`, `ai_read = false` when that user does not already have that URL. It does not insert GitHub URLs here (those are profile links).
- Tests pass a fake fetch and a fake query. No socket.

- [ ] **Step 1: Failing tests** for READING→READ, failed fetch stays READING, fit count once, and one job URL insert.

- [ ] **Step 2: Run them.**

- [ ] **Step 3: Implement and call it from the chat job when the text has a URL.**

- [ ] **Step 4: `pytest`.**

- [ ] **Step 5: Commit** `feat(links): read GitHub links and save posting URLs`.

---

### Task 9: Share link and artifacts

**Files:**

- Modify: `services/ai/src/app/api/routers/conversations.py`
- Test: `services/ai/tests/test_conversation_share.py`

**Interfaces:**

- `POST /api/v1/conversations/{id}/share` → `{data:{token, path}}`. `path` is `/api/v1/conversations/shared/{token}`. Store SHA-256 of the token. A second POST returns the same path only if you kept the raw token. You did not. Second POST rotates the token and replaces the hash.
- `GET /api/v1/conversations/shared/{token}` is public. `{data:{title, messages:[{role, text, createdAt}]}}`. Unknown token `404`. No user ids in the body.
- `GET /api/v1/conversations/{id}/artifacts` → `{data:[{type, id, title}]}` from that conversation's message attachments (`DOCUMENT_VERSION` and any attachment that has `documentId`). Owner or company member only. Empty list is `{data:[]}`.
- Interview export: do not add an endpoint. This plan's ruling 5 is the documentation.

- [ ] **Step 1: Failing tests** for create, public get, wrong token, and artifacts.

- [ ] **Step 2: Run them.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: `pytest`.**

- [ ] **Step 5: Commit** `feat(chat): share a conversation and list artifacts`.

---

### Task 10: Chat settings

**Files:**

- Create: `services/ai/src/app/domain/chat_settings.py`
- Modify: `services/ai/src/app/graphs/chat.py` (read settings into the state that task 1 already consults)
- Test: `services/ai/tests/test_chat_settings.py`

**Interfaces:**

- `resolve_chat_settings(row)` → `{effort, confirm_before_edit}`.
- Missing row, missing keys, or a database error that means the column is absent: `MEDIUM` and `true`.
- `default_effort` `LOW|MEDIUM|HIGH|MAX` wins when the client omitted `ai.effort`. An invalid stored value falls back to `MEDIUM`. Client-sent effort still wins.
- `confirm_before_edit` false skips the approval emit from task 1. True keeps it when a diff exists.
- On `DONE`, try the AI_DONE insert from ruling 4. A test with a fake pool records the SQL. A raising pool does not fail the job.

- [ ] **Step 1: Failing tests** for defaults, client override, confirm false, and a swallowed notification error.

- [ ] **Step 2: Run them.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: `pytest`. Then gateway `npm test` and core `npm test` plus both `tsc --noEmit` if you touched them. You should not have touched them.**

- [ ] **Step 5: Commit** `feat(chat): honor effort and confirm-before-edit`.
