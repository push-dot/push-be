# push-be: Python on VPS, LangGraph/LangChain/LlamaIndex, super-resume harness — Implementation Plan

> **For agentic workers:** Execute PR by PR. Each PR = its own branch from fresh `origin/develop`, tests first, `npm run typecheck` + `npm test` + `cd services/ai && uv run pytest -q` green, PR to `develop`, **never merge**. Steps use checkbox syntax.

**Goal:** Python runs only on the VPS; orchestration on LangGraph, model calls and tools on LangChain, RAG on LlamaIndex; the resume flow becomes a real super-resume subgraph inside one personal (job-seeker) harness.

**Architecture:** TS Workers (`push-be` gateway, `push-be-core`) stay on Cloudflare and reach Python only over HTTPS at `AI_ORIGIN` (the VPS `ai-worker`, which already serves the full FastAPI app with `SERVE_API=1`). The harness graphs (`AI_HARNESS`) become the only chat path; the legacy 4-step `graphs/chat.py` path is deleted at the end once every feature it carries is ported.

**Tech Stack:** Python 3.15 (Docker, `uv`), FastAPI, langgraph 1.2.x + `AsyncPostgresSaver`, langchain-core/langchain-openai 1.7.x, llama-index-core 0.12.x, Neon Postgres + pgvector + pg_trgm, Redis Streams, TypeScript Workers (npm).

**Sources (read before your track):**
- `/tmp/cdesign/survey-a-vps.md` (Worker vs VPS, routes, CI lines)
- `/tmp/cdesign/survey-b-harness.md` (harness, resume graph, super-resume mapping, target graph)
- `/tmp/cdesign/survey-c-lang.md` (LangGraph/LangChain/LlamaIndex inventory, tests that pin behaviour)
- Workspace docs `../docs/feature-spec.md` (chapters 3.4 fit, 9 levers, 15 agent, 18 reference data), `../docs/PRD.md`
- super-resume upstream: https://github.com/cyjoon68/super-resume (HEAD `225e303`)

## Global Constraints
- npm only for TS. `uv` only for Python, `uv.lock` updated in the same PR. No pnpm/bun/yarn, no `||` fallback chains between package managers.
- Branch `feat|fix|refactor|chore|docs|test/<kebab>`; commit and PR title `type(scope): summary`, English, < 72 chars.
- coding-hooks `backend` + `solid-layers`: domain → infrastructure direction only; LangChain/LlamaIndex/LangGraph adapters live in infrastructure/framework, not in domain.
- Contracts first (`packages/contracts/spec/*.ts` → `npm run contracts`) when an API shape changes.
- New migrations start at `0031_`.
- Never touch `main`, deployed secrets, live Cloudflare/VPS resources, push-fe, workspace docs, or anything desktop.
- User-facing Korean strings: 해요체, product names as in the app (에이전트, 마이 › 서류, 제안함, 휴대폰 번호).
- No user API keys (BYOK) anywhere; models come from `plan_levers.py`.
- Usage metering into `ai_usage` and plan levers must keep working in every PR.
- **Nothing in push-be may stay undeployed.** Python (`services/ai`) runs only on the VPS. Everything else (`services/gateway`, `services/core-api`) runs on Cloudflare Workers. Every merged wave is released to `main`, deployed, migrated and verified before the next wave starts. No code may sit behind a flag that production leaves off: at the end, `AI_HARNESS` is on and `RAG_ENGINE=llamaindex` in production.

## Decisions (made by the orchestrator — do not re-decide)
1. `AI_ORIGIN` = `https://${vars.AI_HOST}` injected by CI into both TS Workers at deploy (do not hardcode a host in wrangler files). No fallback to a service binding.
2. VPS sets `BLOB_STORE=db` so every artifact lands in `workspace_files` and core serves it.
3. Cron work the Python Worker used to own (`ratelimit.sweep`, `account_purge.purge_deleted`) moves into the dispatcher loop.
4. No migration for in-flight `<conv>:resume` threads — production has no users yet. Drop the separate resume thread.
5. Checkpointer everywhere = the stock `AsyncPostgresSaver` (already used by the harness). `chat_jobs.checkpoint` and `graphs/freeze.py` go away with the legacy path.
6. RAG = LlamaIndex, with a **custom** `BasePydanticVectorStore` over the existing `rag_nodes` table (keeps dense + `pg_trgm` hybrid, tenant check, Korean-safe; the stock `PGVectorStore` uses Postgres FTS with no Korean config). LangChain only wraps the retriever as a tool.
7. Fit score = super-resume's LLM-judged 5 dimensions (기술 스택 · 경험 연관성 · 경력 수준 · 키워드 · 도메인, weighted, 0–10), matching the app design. The rule-based `compute_fit` is removed. Cache per `(posting_id, document_id, plan)`.
8. Resume phases run in one graph run until the next GATE interrupt; core's `/resume-jobs` re-enqueue goes away. Each job still reserves usage once; the usage callback settles per model call.
9. Multi-select GATEs: approval decision API accepts `optionIds: string[]` in addition to `optionId` (contract change).
10. Harness `agent` node streams tokens (`stream_mode="messages"`) into `chat_events`.
11. The employer harness is redesigned and built by the orchestrator (Opus) in a separate design (`2026-10-30-employer-harness-design.md`). Grok tracks must not change `harness/employer/**` beyond mechanical updates required by Track L (tool base class), and must keep employer tests green.

## Review Focus
1. A conversation paused at a GATE survives a worker restart and resumes on the same thread (`<conv>`) — test in H1.
2. "그만하기" (option `cancel`, or text starting with 그만/취소/중단) at any GATE returns to the normal agent in the same turn — test in H1.
3. A model call that raises mid-stream releases the usage reservation and writes no settled row — test in L1.
4. Tenant isolation: a RAG query never returns another user's or company's nodes, even with an empty filter — test in R2.
5. Gateway with `AI_ORIGIN` unset returns 500 and never falls back to a binding — test in A1.

---

## Waves and tracks (parallel)

Each track is one Grok agent in its own worktree. Tracks inside a wave run in parallel. Start a wave only after the previous wave's PRs are merged (the orchestrator merges).

| Wave | Track | PRs | Owner |
|---|---|---|---|
| 1 | A — Python VPS-only | A1–A6 | Grok |
| 1 | L — LangChain foundation | L1–L2 | Grok |
| 1 | R — LlamaIndex RAG | R1–R3 | Grok |
| 1 | S — super-resume content | S1–S3 | Grok |
| 2 | H — one personal harness on LangGraph | H1–H4 | Grok |
| 2 | R — RAG bridge + flip | R4–R5 | Grok |
| 2 | E — employer harness | per its own design | Opus |
| 3 | P — super-resume as a real graph | P1–P7 | Grok |
| 3 | F — legacy removal | F1–F2 | Grok |

Expected conflicts: L2 and S3 both touch `harness/resume/graph.py` — S3 merges first, L2 rebases.

### After every wave (orchestrator)
1. Merge the wave's PRs into `develop` (CLEAN only), then release `develop` → `main` (release branch, `-s ours` when main has no unique content, squash).
2. CI on `main` deploys gateway + core to Cloudflare and the AI service to the VPS (after A3 the VPS deploys on every push to the deploy branch).
3. Back up Neon (branch), run `migrate.yml` when the wave added migrations, check `schema_migrations`.
4. Verify: gateway `/healthz`, `https://<AI_HOST>/healthz`, `https://<DISPATCH_HOST>/healthz`, one chat turn end to end, Worker secrets present.
5. After wave 1 deploys: delete the `push-be-python` Worker on Cloudflare and confirm nothing calls it.
6. Wave 3 ends with `AI_HARNESS=1` and `RAG_ENGINE=llamaindex` set in the VPS env (compose/env), deployed and verified.

---

## Track A — Python runs only on the VPS (wave 1)

### A1: Gateway calls only `AI_ORIGIN`
**Files:** `services/gateway/src/proxy.ts:50-74`, `services/gateway/src/types.ts`, gateway tests that stub `API`.
- [ ] Test `AI_ORIGIN unset returns 500 and does not call a binding` (new case next to `strip-internal-headers.test.ts`) — fails today.
- [ ] `proxyPython` forwards to `AI_ORIGIN` with `x-push-ai-secret`; empty origin → 500 `NOT_CONFIGURED`. Remove `proxy(env.API)`.
- [ ] Remove `API` from `services/gateway/wrangler.jsonc:20-23` (keep `CORE`), `types.ts`, the 12 test stubs.
- [ ] CI: in the gateway deploy step pass `--var AI_ORIGIN:https://${{ vars.AI_HOST }}` (see `ci.yml:533-535` comment: dashboard vars are overwritten on deploy).
- [ ] `npm test -w push-be-front`, `npm run typecheck`. PR `refactor(gateway): call python only through ai origin`.

### A2: Core drops the `API` binding
**Files:** `services/core-api/src/routes/conversations.ts:327-344` (`scheduleChatJob`), `services/core-api/src/types.ts:12`, `services/core-api/wrangler.jsonc:14-16`, `test/chat-executor.test.ts:64`.
- [ ] Test `scheduleChatJob posts to AI_ORIGIN/internal/chat/schedule with the internal secret` and `AI_ORIGIN unset throws 500`.
- [ ] Replace the binding call with `fetch(AI_ORIGIN + "/internal/chat/schedule")`. CI passes the same `AI_ORIGIN` var to core.
- [ ] PR `refactor(core): reach python over https`.

### A3: CI stops deploying `push-be-python`
**Files:** `.github/workflows/ci.yml:208-233` (job `bundle-ai`), `:310`, `:320`, `:384-388`, `:398-422`; the VPS deploy step `:423-526` must run on every push to the deploy branch (not only when `vps` changed).
- [ ] PR `chore(ci): stop deploying python worker`. Note in the PR body: "After this deploys, the orchestrator deletes the `push-be-python` Worker."

### A4: Delete Worker-only code
**Files:** delete `services/ai/src/worker.py`, `services/ai/wrangler.jsonc`, `scripts/check_worker_bundle.py`, `tests/test_workflow_steps.py`, `test_chat_claim.py:132`; remove `CF_WORKER` branches (`main.py:218-222`, `api/middleware.py:111-116`, `db.py:190,199`, `framework/flag.py:8`, `ingest/web_page.py:323-324`), `_patch_to_thread`, `pgproto.py:426-488` Workers websocket path **only if** `migrate.yml` keeps working (it uses websocket by default — switch `migrate.yml` default to `tcp`, keep the module), dead `sse_max_polls`, pyodide dev deps in `pyproject.toml`.
- [ ] `uv run pytest -q` green. PR `refactor(ai): remove cloudflare worker code`.

### A5: Workflow scheduler cleanup + cron on the VPS
**Files:** `jobs.py:21-34` (`workflow` mode, `remote_executor`), `domain/services/conversation.py:390,574-584` (`claim_for_workflow`, `nudge_pending`), `graphs/chat.py:644-649`; `queue/dispatcher.py:122`; `infra/vps/compose.yaml` (dispatcher gets `STORAGE_DIR` volume read access, x-ai-env `BLOB_STORE: db`).
- [ ] Tests `dispatcher sweeps rate limits every loop` and `dispatcher purges accounts past 30 days` (fake pool).
- [ ] PR `fix(ai): run sweeps on the vps dispatcher`.

### A6: Docs
**Files:** `README.md` (Worker sections per survey A §6), `infra/vps/README.md:3,43-64,100,146,235-243`, `.env.example:10-22,103-104`, `infra/vps/env.example:94-106`.
- [ ] Also add this plan file in this PR. PR `docs(ai): python runs on the vps only`.

---

## Track L — LangChain foundation (wave 1)

### L1: Chat model factory + usage callback
**Files:** create `services/ai/src/app/framework/llm.py`; modify `domain/services/ai.py`, `infrastructure/openai_client.py`, `harness/model.py` (`GateModel`), `framework/models.py`.
**Interfaces (produces):**
- `chat_model_for(levers: PlanLevers, *, web_search: bool = False, streaming: bool = True, config: AppConfig) -> ChatOpenAI` — OpenRouter base_url; OpenCode Go when the model id starts with `opencode-go/`; appends `:online` when `web_search`; `extra_body={"provider": deepseek_provider(config)}` for the FREE DeepSeek model; `reasoning` effort from `levers.effort`; timeouts/retries equal to today's `AIGate` values (see `test_framework.py:524-640`).
- `class AiUsageCallback(AsyncCallbackHandler)` — `__init__(store, user_id, job_id, reservation_id)`; settles from `usage_metadata` on `on_llm_end`, releases on `on_llm_error`; idempotent per run id.
- [ ] Test `streamed reply with usage_metadata settles exactly one ai_usage row with real tokens`.
- [ ] Test `exception mid-stream releases the reservation and writes no settled row` (Review Focus 3).
- [ ] Test `free plan request carries deepseek provider order and ignore`.
- [ ] Route every existing model call (`AIGate.complete`, `GateModel.ainvoke`, web search) through `chat_model_for` + callback. Keep `test_cov2_svc_ai.py`, `test_ai.py` green (update only where they assert the HTTP shape).
- [ ] PR `refactor(ai): langchain chat model factory with usage callback`.

### L2: Tools as `StructuredTool`
**Files:** `harness/tools.py`, `harness/model.py`, `harness/graph.py`, `harness/{personal,employer,resume}/tools.py`.
**Interfaces (produces):** `to_structured_tool(spec: ToolSpec) -> StructuredTool` with `args_schema=spec.args_model`, a real Korean `description` (not the tool name), `metadata={"tier": spec.tier, "approval_kind": spec.approval_kind, "summary": ...}`; `ToolContext` passed via `RunnableConfig["configurable"]["tool_context"]`. `policy.decide` reads `tool.metadata["tier"]`. Delete `tool_schema`.
- [ ] Test `every tool keeps its tier` (table of old tiers vs `metadata["tier"]`).
- [ ] `test_harness_graph.py` (incl. 8-call cap), `test_harness_policy.py`, `test_harness_personal.py`, `test_harness_employer.py` green.
- [ ] PR `refactor(ai): harness tools as langchain structured tools`.

---

## Track R — RAG on LlamaIndex (waves 1–2)

### R1: Embedding and reranker adapters
**Files:** create `services/ai/src/app/rag/llama_adapters.py`; uses `embedding/` (TEI/API, redis cache).
**Interfaces:** `class TeiEmbedding(BaseEmbedding)` (1024-dim bge-m3), `class TeiRerank(BaseNodePostprocessor)` (bge-reranker-v2-m3, `top_n`).
- [ ] Tests: adapter returns the same vectors as `embedding.embed_texts`; reranker reorders by TEI score and keeps metadata.
- [ ] PR `feat(rag): llamaindex adapters for tei embedding and rerank`.

### R2: Custom vector store over `rag_nodes` + retriever
**Files:** create `rag/vector_store.py` (`class RagNodesStore(BasePydanticVectorStore)`), `rag/retriever.py` (llamaindex mode builds `VectorStoreIndex.from_vector_store(...).as_retriever(filters=MetadataFilters(...), similarity_top_k=...)` + keyword (`pg_trgm`) fusion + `TeiRerank`).
- [ ] Test `query never returns another tenant's nodes, even with empty filters` (Review Focus 4) — the store raises without a user or company filter.
- [ ] Test hybrid fusion ranks an exact Korean keyword hit above a weak vector hit.
- [ ] PR `feat(rag): llamaindex retriever over rag_nodes`.

### R3: Ingest coverage
**Files:** `workers/handlers/ingest.py`, `rag/pipeline.py`, `rag/readers.py`, enqueue points for career evidence, resumes/documents, jobs/postings.
- [ ] `IngestionPipeline` with `SentenceSplitter(512, 64)` + metadata (`user_id` or `company_id`, `kind`, `source_id`) for every source type; `reindex_all` covers them.
- [ ] Tests: one ingest + reindex test per source type.
- [ ] PR `feat(rag): ingest every source into rag_nodes`.

### R4 (wave 2): Retriever as an agent tool
**Files:** `framework/rag.py`, `harness/personal/tools.py` (`search_career_context` → LlamaIndex retriever via `StructuredTool`, tier READ).
- [ ] Test `search_career_context returns reranked nodes for the caller only`.
- [ ] PR `feat(ai): agent career search on llamaindex`.

### R5 (wave 2): Flip the default
**Files:** `rag/retriever.py:36`, `.env.example:38`, `infra/vps/compose.yaml:70`, `infra/vps/env.example:88`, `infra/vps/README.md:167-169` (runbook: enqueue `{"reindex": true}`, run `run_eval.py` on both engines, flip).
- [ ] Update `test_rag_retriever.py:110-131` to the new default. PR `feat(rag): default to llamaindex`. The orchestrator runs the reindex and eval on the VPS before merging.

---

## Track S — super-resume content (wave 1)

### S1: Re-sync vendored files
**Files:** `services/ai/src/app/resources/super-resume/references/{checklist-formulas,portfolio,writing-voice}.md` from upstream `225e303`. Keep the Push edit in `skills/blueprint-generator.md` (blueprints in chat, not files).
- [ ] Test `test_super_resume_refs.py`: each vendored reference equals upstream except listed Push edits (store upstream sha in `resources/super-resume/UPSTREAM`).
- [ ] PR `chore(ai): sync super-resume references`.

### S2: Per-phase references in harness prompts
**Files:** `graphs/resume_prompt.py` (add `_PHASE_REFS`, used by `phase_prompt_for_harness`).
| phase | references |
|---|---|
| 1 analyze | core |
| 2 strategy | core, competency-signals, projects |
| 3 craft / 3-C boost | core, checklist-formulas, competency-signals, portfolio, projects, writing-voice |
| 4 review | checklist-formulas, writing-voice |
| 2-X blueprints | experience-blueprints, projects, checklist-formulas, core |
- [ ] Tests `craft prompt includes writing-voice`, `analyze prompt excludes writing-voice`.
- [ ] PR `feat(ai): apply super-resume references per phase`.

### S3: Gate cards and the start_document choice
**Files:** `harness/resume/graph.py` (`_GATES` carries the Korean question verbatim from the orchestrator as the card title), `harness/personal/tools.py` + `harness/runtime.py` (the "이어서 작성하기 / 그만하기" choice inserts an approval row and is handled).
- [ ] Tests `gate title is the question`, `start_document cancel choice resets the flow`.
- [ ] PR `fix(ai): readable resume gates and resumable start choice`.

---

## Track H — one personal harness on LangGraph (wave 2)

### H1: Resume as a subgraph of personal
**Files:** `harness/graph.py`, `harness/personal/tools.py`, move `harness/resume/` → `harness/personal/resume/`.
**Interfaces:** `PersonalState = HarnessState + resume: ResumeState | None`. Graph: `START → route`; `route → resume_flow` when `resume.status == "active"`, else `agent`; `agent ⇄ tools`; `start_document` returns `Command(update={"resume": {...status:"active"}}, goto="resume_flow")`; `resume_flow → agent` when status is `done|cancelled` (agent receives a summary message). The subgraph is compiled without its own checkpointer and uses the parent's (thread `<conv>`). `conversations.resume_state` stays as a mirror for the app.
- [ ] Test `paused gate survives a worker restart and resumes on <conv>` (Review Focus 1).
- [ ] Test `cancel at any gate returns to the agent in the same turn` (Review Focus 2).
- [ ] Test `start_document enters the flow without a new job`.
- [ ] PR `refactor(ai): resume flow as a personal subgraph`.

### H2: Registry and router down to two harnesses
**Files:** `harness/registry.py`, `harness/router.py`, `harness/runtime.py` (drop `_resume_turn`, the `:resume` thread, `_next_phase` re-enqueue), core `routes/conversations.ts:539-552` (`resume-jobs` path removed; RESUME_GATE answers resume the same job thread).
- [ ] Tests: registry keys are exactly `personal`, `employer`; an employer conversation never routes to resume.
- [ ] Contract change for Decision 9 (`optionIds[]`) here. PR `refactor(ai): one personal harness`.

### H3: Checkpointer and retries on every chat path
**Files:** `workers/handlers/chat.py`, `workers/ai_worker_main.py`, `main.py:190-193` (checkpointer must not be `None` when `external_jobs()` is on), `domain/services/conversation.py`.
- [ ] Node `RetryPolicy` replaces the `fails` counter.
- [ ] Test `job killed mid-reply resumes from the saver without re-running context and without duplicate chat_events`.
- [ ] PR `refactor(ai): langgraph checkpointer on the worker`.

### H4: Token streaming in the harness
**Files:** `harness/graph.py:76-81`.
- [ ] Test `one reply produces multiple token events`. PR `feat(ai): stream harness replies`.

---

## Track P — super-resume as a real graph (wave 3)

Graph shape and node list: survey B "Resume subgraph, one node per super-resume phase". Node prompts = `skills/<name>.md` + that phase's references (S2). Artifact names follow super-resume: `01_scenario.json`, `02_fit_score.json`, `03_draft_{target}_v{N}.md`, `05_final_{target}.md` (one PDF per target).

- **P1** Phase nodes p0…p6 with explicit gate nodes; `output_targets` produce one final per target. Tests: updated `stops at every gate in auto`; `two targets produce two finals and two PDFs`. PR `feat(ai): super-resume phases as graph nodes`.
- **P2** Phase 1 fan-out (`Send`: parse_resume | explore_github | analyze_job) → `classify_scenario`; scenario routing B/C/D/E/F. Tests `scenario E ends after the fit report`, `scenario C goes to design`. PR `feat(ai): super-resume scenario routing`.
- **P3** `work_mode=experience_blueprint` branch: approach → validate (fail loops back) → blueprints → gate. Tests `blueprint mode never enters craft`, `failed validation returns to approach`. PR `feat(ai): experience blueprint branch`.
- **P4** LLM 5-dimension fit (Decision 7) replacing `compute_fit`, shared by `get_fit_score` and the resume flow; score-booster loop (max 5 cycles, stop when gain < 0.1 twice, interrupt each cycle). Tests `fit returns five weighted dimensions`, `boost stops at five cycles`, `boost stops on stall`, `fit cached per posting, document and plan`. PR `feat(ai): llm fit score and booster loop`.
- **P5** Template choice persisted and passed to `md_to_pdf`. Test `template choice reaches the pdf renderer`. PR `fix(ai): pdf uses the chosen template`.
- **P6** Quick-start intents: personal `intent` values `match_posting | fit | gaps | experience | boost` (core `forbidExtra` list `conversations.ts:399` + INTENTS); each enters the matching flow entry (scenario A / E / strategy-only / blueprint / booster). Tests per intent. PR `feat(ai): quick start enters super-resume flows`.
- **P7** Personal system prompt rewritten, grounded in super-resume `core.md` and `writing-voice.md`: no invented experience, evidence for every claim, tool rules, approval tiers, plan scope, 해요체 copy, what it never does (결제 · 요금제 · 동의 · 계정 → point to the screen). Port the personal reference-data lines (feature-spec 18: writing reference by 직무 × 연차 × 점수대, plan ranges) from `graphs/chat.py:_reference_lines` into the personal harness. Tests: prompt includes the no-fabrication rule; reference samples respect the plan's 연차/점수 range. PR `feat(ai): personal agent grounded in super-resume`.

## Track F — legacy removal (wave 3, last)
- **F1** `AI_HARNESS` on by default, then delete the legacy path: `graphs/chat.py` nodes, `resume_prompt.py` phase inference, `# file:` regex in `resume_workspace.py`, `chat_surface` approval, `approved_edit`, `chat_jobs.checkpoint` use, `graphs/freeze.py`. Precondition: P7 merged and the employer harness (Track E) carries reference-data review and web search. Test: `flag_off_uses_legacy_graph` removed; all `test_harness_*` green. PR `refactor(ai): harness is the only chat path`.
- **F2** One release after R5: remove legacy RAG (`_legacy`, `_langchain`, `RagStore`, `EvidenceChunkStore`, `AIGate.embed`, `split_text` fallback) and migration `0031_drop_legacy_rag.sql` dropping `rag_chunks`, `evidence_chunks`. PR `refactor(rag): drop legacy stores`.

## Open questions (orchestrator answers; do not block on them)
- `AI_HOST` stays `ai.187-127-112-169.sslip.io` until `push.devcyjoon.tech` serves TLS on the VPS.
- Traefik `readTimeout: 60s` vs 20 MiB uploads and synchronous PDF renders — raise to 120s in A5 if a test shows timeouts.
