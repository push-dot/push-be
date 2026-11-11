# Graph Report - push-be  (2026-11-11)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 9455 nodes · 28151 edges · 314 communities (273 shown, 41 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 2367 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5a874a9f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 104
- Community 105
- Community 106
- Community 107
- Community 108
- Community 109
- Community 110
- Community 111
- Community 112
- Community 113
- Community 114
- Community 115
- Community 116
- Community 117
- Community 118
- Community 119
- Community 120
- Community 121
- Community 122
- Community 123
- Community 124
- Community 125
- Community 126
- Community 127
- Community 128
- Community 129
- Community 130
- Community 131
- Community 132
- Community 133
- Community 134
- Community 135
- Community 136
- Community 137
- Community 138
- Community 139
- Community 140
- Community 141
- Community 142
- Community 143
- Community 144
- Community 145
- Community 146
- Community 147
- Community 148
- Community 149
- Community 150
- Community 151
- Community 152
- Community 153
- Community 154
- Community 155
- Community 156
- Community 157
- Community 158
- Community 159
- Community 160
- Community 161
- Community 162
- Community 163
- Community 164
- Community 165
- Community 166
- Community 167
- Community 168
- Community 169
- Community 170
- Community 171
- Community 172
- Community 173
- Community 174
- Community 175
- Community 176
- Community 177
- Community 178
- Community 179
- Community 180
- Community 181
- Community 182
- Community 183
- Community 184
- Community 185
- Community 186
- Community 187
- Community 188
- Community 189
- Community 190
- Community 191
- Community 192
- Community 193
- Community 194
- Community 195
- Community 196
- Community 197
- Community 198
- Community 199
- Community 200
- Community 201
- Community 202
- Community 203
- Community 204
- Community 205
- Community 206
- Community 207
- Community 208
- Community 209
- Community 210
- Community 211
- Community 212
- Community 213
- Community 214
- Community 215
- Community 216
- Community 217
- Community 218
- Community 219
- Community 220
- Community 221
- Community 222
- Community 223
- Community 224
- Community 225
- Community 226
- Community 227
- Community 228
- Community 229
- Community 230
- Community 231
- Community 232
- Community 233
- Community 234
- Community 235
- Community 236
- Community 237
- Community 238
- Community 239
- Community 240
- Community 241
- Community 242
- Community 243
- Community 244
- Community 245
- Community 246
- Community 247
- Community 248
- Community 249
- Community 250
- Community 251
- Community 252
- Community 253
- Community 254
- Community 255
- Community 256
- Community 258
- Community 259
- Community 261
- Community 262
- Community 263
- Community 264
- Community 265
- Community 266
- Community 267
- Community 268
- Community 269
- Community 270
- Community 271
- Community 272
- Community 273
- Community 274
- Community 275
- Community 276
- Community 277
- Community 279
- Community 280
- Community 281
- Community 282
- Community 283
- Community 284
- Community 285
- Community 286
- Community 287
- Community 289
- Community 290
- Community 291
- Community 292
- Community 293
- Community 294
- Community 295
- Community 296
- Community 297
- Community 298
- Community 299
- Community 301
- Community 302
- Community 303
- Community 304
- Community 305
- Community 308
- Community 309

## God Nodes (most connected - your core abstractions)
1. `HttpError` - 235 edges
2. `one()` - 209 edges
3. `query()` - 182 edges
4. `data()` - 164 edges
5. `NotFoundError` - 153 edges
6. `DomainError` - 150 edges
7. `ts()` - 121 edges
8. `fake_db()` - 120 edges
9. `fieldError()` - 111 edges
10. `requireUuid()` - 111 edges

## Surprising Connections (you probably didn't know these)
- `fetch()` --indirect_call--> `body()`  [INFERRED]
  services/gateway/test/cov-conversations.test.ts → packages/contracts/spec/shared.ts
- `pytest_configure()` --uses--> `Store`  [INFERRED]
  scripts/sql-check/sql_capture.py → services/ai/src/app/infrastructure/store_common.py
- `test_data_and_page_body()` --uses--> `Page`  [INFERRED]
  services/ai/tests/test_cov_api_deps.py → services/ai/src/app/domain/pagination.py
- `test_effective_limit()` --uses--> `PageRequest`  [INFERRED]
  services/ai/tests/test_pagination.py → services/ai/src/app/domain/pagination.py
- `test_ingest_requires_tenant()` --uses--> `Tenant`  [INFERRED]
  services/ai/tests/test_rag_pipeline.py → services/ai/src/app/rag/tenant.py

## Import Cycles
- 2-file cycle: `services/core-api/src/ai-jobs.ts -> services/core-api/src/routes/conversations.ts -> services/core-api/src/ai-jobs.ts`

## Communities (314 total, 41 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.04
Nodes (210): RFC-6266, isMissingRelation(), isUndefinedColumn(), compact(), QueryForms, queryForms(), SearchFields, searchFields() (+202 more)

### Community 1 - "Community 1"
Cohesion: 0.04
Nodes (45): DocumentExport, DocumentVersion, RevisionProposal, CalendarEvent, GapAnalysis, CliRun, ProjectBlueprint, ProjectEvidence (+37 more)

### Community 2 - "Community 2"
Cohesion: 0.03
Nodes (171): CARRIED, carried(), enqueueResumeJob(), ResumeJob, WAITING, isLockTimeout(), Query, Session (+163 more)

### Community 3 - "Community 3"
Cohesion: 0.04
Nodes (174): invalid(), strictBody(), strictObject(), ALLOWED, Block, BLOCK_NODES, blocksOf(), children() (+166 more)

### Community 4 - "Community 4"
Cohesion: 0.04
Nodes (59): code_point_slice(), _validate_url(), _walk(), Document, Approval, approval_required(), approval_stale(), document_not_finalized() (+51 more)

### Community 5 - "Community 5"
Cohesion: 0.04
Nodes (128): chosen_document_text(), draft_text(), drafts_from_chosen(), _advance(), _after_analyze(), _answer_ids(), _apply_answer(), _apply_fields() (+120 more)

### Community 6 - "Community 6"
Cohesion: 0.05
Nodes (55): pytest_configure(), main(), Config, checkpointer_pool_config(), create_pool(), DB, migrations_dir(), NotFoundError (+47 more)

### Community 7 - "Community 7"
Cohesion: 0.05
Nodes (79): AICompletion, AIModelInfo, AiUsage, valid_ai_provider(), valid_effort(), Application, ApplicationEvent, can_patch_stage() (+71 more)

### Community 8 - "Community 8"
Cohesion: 0.05
Nodes (97): b64url(), fromB64url(), macOf(), PendingSignup, readPendingSignup(), same(), secretOf(), signPendingSignup() (+89 more)

### Community 9 - "Community 9"
Cohesion: 0.04
Nodes (36): utcnow(), unauthenticated(), work(), work(), work(), _now(), GoogleService, work() (+28 more)

### Community 10 - "Community 10"
Cohesion: 0.06
Nodes (94): boundTransaction(), DISPLAY_MICRO, EMPLOYER, EMPLOYER_TIERS, ensureMonthlyGrant(), grantMicro(), grantPeriod(), iapTopupMicro() (+86 more)

### Community 11 - "Community 11"
Cohesion: 0.05
Nodes (50): Gate, managed_ai(), Rows, run(), ScriptedLC, service(), _payload(), _saved() (+42 more)

### Community 12 - "Community 12"
Cohesion: 0.06
Nodes (54): ApiMiddleware, _client_ip(), _is_public(), _public_error(), allow(), _missing_table(), reset_for_tests(), SlidingWindow (+46 more)

### Community 13 - "Community 13"
Cohesion: 0.09
Nodes (70): _Approvals, _base(), _blueprint(), _config(), _drive(), _graph(), _interrupt_gate(), _on_cap() (+62 more)

### Community 14 - "Community 14"
Cohesion: 0.04
Nodes (37): CountingPool, _main(), known_intent(), turn_from_payload(), missing_provider_key(), ConversationService, _schedule(), _live_event() (+29 more)

### Community 15 - "Community 15"
Cohesion: 0.06
Nodes (75): Body, FieldKind, FieldSpec, fits(), asBuffer(), base64ToBytes(), bytesToBase64(), decryptAes() (+67 more)

### Community 16 - "Community 16"
Cohesion: 0.07
Nodes (80): one(), query(), noContent(), blockUser(), dispatchBlocks(), unblockUser(), acceptInvite(), businessError() (+72 more)

### Community 17 - "Community 17"
Cohesion: 0.07
Nodes (54): _bucket(), eligible(), features_of(), _in_score(), _in_tenure(), prompt_lines(), prompt_samples(), _scrub() (+46 more)

### Community 18 - "Community 18"
Cohesion: 0.06
Nodes (42): handle(), corsHeaders(), preflight(), requestIdOf(), withCors(), fetch(), neonQuery(), resetLimits() (+34 more)

### Community 19 - "Community 19"
Cohesion: 0.10
Nodes (51): ConflictError, assert_scoped(), entity(), page(), row(), sample(), _value(), _app_row() (+43 more)

### Community 20 - "Community 20"
Cohesion: 0.08
Nodes (23): current_employer_plan(), AiOptions, feature_disabled(), not_configured(), provider_error(), PlanLevers, AIGate, work() (+15 more)

### Community 21 - "Community 21"
Cohesion: 0.07
Nodes (50): AccessMode, normalize_access_mode(), quick_start_seed(), _after_resume(), _attachment_inputs(), build_harness_graph(), after_agent(), agent() (+42 more)

### Community 22 - "Community 22"
Cohesion: 0.08
Nodes (29): bound_claim(), LostClaim, _affected(), ChatJobStore, work(), _dump(), _now(), _DB (+21 more)

### Community 23 - "Community 23"
Cohesion: 0.06
Nodes (37): _artifact_id(), ArtifactArgs, AttachmentArgs, _document_id(), _explore_github(), _fetch_url(), _fit(), FitArgs (+29 more)

### Community 24 - "Community 24"
Cohesion: 0.05
Nodes (38): replay_receive(), receive(), _closed_port(), _dns(), _html(), _http_server(), _MockPinned, _pinned() (+30 more)

### Community 25 - "Community 25"
Cohesion: 0.07
Nodes (31): fragments, programs, sites, statements, migrationPath, REQUIRED, migrationPath, REQUIRED (+23 more)

### Community 26 - "Community 26"
Cohesion: 0.09
Nodes (30): FakeRedis, _deliver(), _flow(), _job(), notify_job(), NotifyQuery, test_notify_handler_is_idempotent_per_notification(), handler() (+22 more)

### Community 27 - "Community 27"
Cohesion: 0.04
Nodes (41): applicationRow, ENV, linkedFit, NOW, Body, Call, env, NOW (+33 more)

### Community 28 - "Community 28"
Cohesion: 0.06
Nodes (35): inTransaction(), QueryResult, anonymous(), base(), guestUser(), handle(), fetch(), neonQuery() (+27 more)

### Community 29 - "Community 29"
Cohesion: 0.06
Nodes (27): lock_source(), RagNodeStore, work(), vector_literal(), work(), Conn, Embedder, FakeNode (+19 more)

### Community 30 - "Community 30"
Cohesion: 0.03
Nodes (59): ADMIN_TOKEN, AI_BASE_URL, AI_HOST, AI_SHARED_SECRET, AI_WORKER_CONCURRENCY, ALERT_EMAIL_FROM, ALERT_EMAIL_TO, BASE_SHA (+51 more)

### Community 31 - "Community 31"
Cohesion: 0.13
Nodes (25): ai_options(), bind_json(), current_user(), data(), deps(), optional_query_uuid(), param_id(), ai_generate() (+17 more)

### Community 32 - "Community 32"
Cohesion: 0.07
Nodes (47): card_options(), insert_chat_approval(), CalendarCreate, CalendarUpdate, _Camel, CareerQuery, _cell(), CommentBody (+39 more)

### Community 33 - "Community 33"
Cohesion: 0.09
Nodes (43): _ai(), _ClosedJobUsage, _code(), _drain(), _Embedder, _gate(), _svc(), test_a_refused_settle_stops_the_job_without_a_provider_error() (+35 more)

### Community 34 - "Community 34"
Cohesion: 0.06
Nodes (27): resolve_access_mode(), apply_employer_turn(), bind_employer_plan(), reset_employer_plan(), with_managed_default(), settle_turn(), stub_reply(), StubModel (+19 more)

### Community 35 - "Community 35"
Cohesion: 0.09
Nodes (25): ApiEmbedder, _cosine(), SimilarityReranker, cache_key(), CachedEmbedder, _api(), _env(), get_embedder() (+17 more)

### Community 36 - "Community 36"
Cohesion: 0.08
Nodes (31): astream_harness(), select_harness(), HarnessSpec, test_draft_posting_tool_event_has_draft(), _Approvals, _CoreEdits, _drain(), _edit_graph() (+23 more)

### Community 37 - "Community 37"
Cohesion: 0.07
Nodes (11): backoff_seconds(), Message, StreamQueue, JobContext, Renew, Worker, main(), test_backoff_sequence() (+3 more)

### Community 38 - "Community 38"
Cohesion: 0.10
Nodes (46): APPLE_ROOT_G3_PEM, appleApiJwt(), appleHost(), appleRootPem(), appleSide(), appleToken(), appleVerified(), b64url() (+38 more)

### Community 39 - "Community 39"
Cohesion: 0.06
Nodes (37): resetLimits(), env(), files, get(), PDF, query(), atLedgerWrite(), balanceGap() (+29 more)

### Community 40 - "Community 40"
Cohesion: 0.08
Nodes (50): environment, environment, ADMIN_TOKEN, AI_BASE_URL, AI_SHARED_SECRET, ALERT_EMAIL_FROM, ALERT_EMAIL_TO, APP_ENV (+42 more)

### Community 41 - "Community 41"
Cohesion: 0.08
Nodes (40): fake_db(), test_unique_violation(), claimed(), test_attach_operations_empty_skips_query(), test_attach_operations_returns_rows_changed(), test_create_for_job_passes_job_id_last(), test_create_with_claim_inserts_only_for_owned_job(), test_create_with_claim_noop_upsert_still_owned() (+32 more)

### Community 42 - "Community 42"
Cohesion: 0.07
Nodes (29): _Analyses, _analysis(), _Apps, _Blueprints, _code(), _Gate, _gen_svc(), _Locks (+21 more)

### Community 43 - "Community 43"
Cohesion: 0.04
Nodes (18): SmsSender, Deps, NOW, OPTIONS, Row, Call, empty, Call (+10 more)

### Community 44 - "Community 44"
Cohesion: 0.09
Nodes (32): test_profile_result_without_a_fit_says_the_profile_was_fixed(), test_result_reports_the_fit_change_and_what_changed(), _DB, _Docs, _events(), _named(), fetchrow(), _NoDocs (+24 more)

### Community 45 - "Community 45"
Cohesion: 0.08
Nodes (26): tools(), _Approvals, _ctx(), emitted(), _Record, _ResumeDB, _run(), test_each_edit_in_a_job_gets_its_own_approval() (+18 more)

### Community 46 - "Community 46"
Cohesion: 0.13
Nodes (29): ScriptedChat, _call(), _config(), _events(), _graph(), IdArgs, _input(), MemApprovals (+21 more)

### Community 47 - "Community 47"
Cohesion: 0.12
Nodes (43): _approved(), _client(), _draft(), _raises(), _run(), _svc(), test_chat_approval_kinds_are_not_decided_here(), test_consume_evidence_use_is_reusable() (+35 more)

### Community 48 - "Community 48"
Cohesion: 0.13
Nodes (44): test_create_document_finalize_hash_and_application_scope(), _approve(), _content(), _doc(), _export_client(), _finalized(), _generated(), _raises() (+36 more)

### Community 49 - "Community 49"
Cohesion: 0.09
Nodes (31): _marks(), _open(), _Reread, test_missing_requirements_routes_to_read_failed_gate_and_skips_fit(), test_paste_answer_reruns_analyze_with_pasted_page(), test_pick_answer_stores_a_posting_id_from_the_next_message(), test_proceed_continues_to_analyze_gate(), test_typed_answer_counts_as_paste() (+23 more)

### Community 50 - "Community 50"
Cohesion: 0.09
Nodes (28): _draft_event(), _fence(), flow_summary(), leave_message(), Matches, Person, _profiles(), RoleOption (+20 more)

### Community 51 - "Community 51"
Cohesion: 0.14
Nodes (36): available(), cancel(), deadlocks(), grant(), job(), release_by_lost_heartbeat(), release_by_reconcile(), release_directly() (+28 more)

### Community 52 - "Community 52"
Cohesion: 0.07
Nodes (28): framework(), use_langchain(), _apply_usage(), _attach(), _built_model(), complete_langchain(), complete_or_none(), _content() (+20 more)

### Community 53 - "Community 53"
Cohesion: 0.07
Nodes (13): StubChatJobStore, StubCipher, StubDocumentStore, StubEvidenceStore, _Chunks, _Conn, _DB, test_finish_does_not_overwrite_cancelled() (+5 more)

### Community 54 - "Community 54"
Cohesion: 0.05
Nodes (27): memory, memoryAllow(), memoryBuckets(), Body, Call, env, NOW, Row (+19 more)

### Community 55 - "Community 55"
Cohesion: 0.04
Nodes (44): accessLog, fields, format, storage, tlsChallenge, api, dashboard, insecure (+36 more)

### Community 56 - "Community 56"
Cohesion: 0.09
Nodes (16): Alerts, alerts_from_env(), db_conditions(), redis_conditions(), close_each(), Dispatcher, DispatchStats, kick_app() (+8 more)

### Community 57 - "Community 57"
Cohesion: 0.07
Nodes (9): ApplicationStore, ApprovalStore, DocumentStore, EvidenceStore, OperationStore, OwnedStore, ProjectStore, SubmissionStore (+1 more)

### Community 58 - "Community 58"
Cohesion: 0.16
Nodes (43): route(), asBool(), codedError(), errorResponse(), fieldError(), freshRead(), jsonResponse(), jsonRows() (+35 more)

### Community 59 - "Community 59"
Cohesion: 0.05
Nodes (43): image, use_api_socket, context, network, privileged, build, external, device (+35 more)

### Community 60 - "Community 60"
Cohesion: 0.10
Nodes (21): ByteStream, connect(), _cstr(), PgConnection, PgError, test_bytestream_base_methods(), test_connect_closes_stream_when_startup_fails(), test_connect_over_websocket_runs_startup() (+13 more)

### Community 61 - "Community 61"
Cohesion: 0.07
Nodes (20): alerts(), client(), open_db(), FakeAdminDb, Sent, test_admin_requires_token(), test_alert_debounces_30_minutes_and_sends_recovery(), test_alert_falls_back_to_email_when_discord_fails() (+12 more)

### Community 62 - "Community 62"
Cohesion: 0.11
Nodes (18): _Acquire, PgPool, _ScopeState, _patch(), test_acquire_keeps_connection_on_pg_error_and_drops_on_other(), test_acquire_releases_lock_when_connect_fails(), test_end_request_scope_from_another_context_clears_var(), test_end_request_scope_ignores_foreign_objects() (+10 more)

### Community 63 - "Community 63"
Cohesion: 0.15
Nodes (39): baseline_stats(), build_flows(), after_posting(), after_review(), after_sourcing(), iv_start(), pf_confirm(), pf_draft() (+31 more)

### Community 64 - "Community 64"
Cohesion: 0.12
Nodes (28): _env_int(), heartbeat_limits(), job_deadlines(), _resolve(), visibility_limits(), box_with_pool(), dispatcher(), job() (+20 more)

### Community 65 - "Community 65"
Cohesion: 0.10
Nodes (22): JobFailed, ctx(), handler(), Ingestor, _ProfileQuery, Query, Store, test_company_posting_is_indexed_under_the_company_only() (+14 more)

### Community 66 - "Community 66"
Cohesion: 0.11
Nodes (26): _Analyses, _code(), _DB, _Jobs, _Query, _Samples, _seed(), _svc() (+18 more)

### Community 67 - "Community 67"
Cohesion: 0.10
Nodes (42): ADMIN_TOKEN, AI_BASE_URL, AI_SHARED_SECRET, APP_ENV, BLOB_STORE, CHAT_EXECUTOR, CHECKPOINTER, CORE_ORIGIN (+34 more)

### Community 68 - "Community 68"
Cohesion: 0.09
Nodes (38): clientIp(), authTtlMs(), employerFlag(), resolveDevUser(), textOrNull(), TokenCtx, userFrom(), userFromCached() (+30 more)

### Community 69 - "Community 69"
Cohesion: 0.11
Nodes (24): page_body(), page_request(), get_shared_conversation(), list_conversation_artifacts(), list_conversation_turns(), _present(), share_conversation(), _shares() (+16 more)

### Community 70 - "Community 70"
Cohesion: 0.10
Nodes (36): approval_id_for(), idempotency_key(), ApplicantArgs, ApplicantsArgs, ApplicationArgs, _arg(), AttachmentReviewArgs, DraftArgs (+28 more)

### Community 71 - "Community 71"
Cohesion: 0.11
Nodes (18): Hit, _hit(), Retriever, _Reranker, _row(), test_search_career_context_returns_reranked_nodes_for_the_caller_only(), Embedder, FakeDb (+10 more)

### Community 72 - "Community 72"
Cohesion: 0.13
Nodes (25): StubAiUsageStore, StubChatCompleter, StubUserStore, _ai_svc(), _gate(), _managed(), _now(), test_gate_complete_managed() (+17 more)

### Community 73 - "Community 73"
Cohesion: 0.10
Nodes (18): StubOperationStore, _app(), _Approvals, _Apps, _Documents, _Evidence, _evidence(), _job() (+10 more)

### Community 74 - "Community 74"
Cohesion: 0.16
Nodes (34): auth(), complete(), conn(), _Custom, datarow(), err(), msg(), _param_desc() (+26 more)

### Community 75 - "Community 75"
Cohesion: 0.09
Nodes (28): appleChain(), authed(), b64std(), b64url(), bytesText(), Call, certDer(), claimQuery() (+20 more)

### Community 76 - "Community 76"
Cohesion: 0.10
Nodes (22): admin_router(), cancel(), job_id(), jobs(), known(), ok(), pause(), resume() (+14 more)

### Community 77 - "Community 77"
Cohesion: 0.07
Nodes (21): database_driver(), _init_conn(), _CodecConn, _Pool, test_create_pool_neon_uses_wire_client(), test_create_pool_strips_sslmode_disable(), test_database_driver(), test_database_driver_ignores_cf_worker() (+13 more)

### Community 78 - "Community 78"
Cohesion: 0.11
Nodes (19): approx_tokens(), Ingestor, split_nodes(), test_split_nodes_uses_512_64_sentence_splitter_with_tokenizer(), tok(), ctx_for(), beat(), Embedder (+11 more)

### Community 79 - "Community 79"
Cohesion: 0.10
Nodes (14): _filters_of(), _fuse(), _node(), RagNodesStore, require_tenant(), _uuid(), Embedder, FakeDb (+6 more)

### Community 80 - "Community 80"
Cohesion: 0.08
Nodes (18): BodyLimitMiddleware, Body, client(), _drive(), receive(), send(), test_bad_content_length_is_ignored_and_small_body_passes(), app() (+10 more)

### Community 81 - "Community 81"
Cohesion: 0.10
Nodes (17): verify_stripe_signature(), _now(), RetryBillingStore, _sign(), StubBillingStore, StubStripeGateway, _svc(), test_checkout_not_configured_without_price() (+9 more)

### Community 82 - "Community 82"
Cohesion: 0.11
Nodes (22): settle_job(), ai_handlers(), build_chat(), main(), settle(), serve_api(), chat(), configure_harness() (+14 more)

### Community 83 - "Community 83"
Cohesion: 0.10
Nodes (19): FakeDB, _billing(), _doc(), _event(), _FailMessageStore, _JobRunner, _LedgerStore, _now() (+11 more)

### Community 84 - "Community 84"
Cohesion: 0.09
Nodes (20): _turn_inputs(), _assert_public(), _assert_public_sync(), _decode(), fetch_page_text(), pin_hop(), find_urls(), HopCheck (+12 more)

### Community 85 - "Community 85"
Cohesion: 0.09
Nodes (18): AdminJobs, _num(), retry(), Busy, Conn, test_cancel_counts_ten_rows_as_changed(), test_cancel_leaves_the_hold_to_reconcile_while_the_owner_row_is_busy(), execute() (+10 more)

### Community 86 - "Community 86"
Cohesion: 0.06
Nodes (35): DATABASE_URL, PG_TRANSPORT, default, description, options, required, type, environment (+27 more)

### Community 87 - "Community 87"
Cohesion: 0.08
Nodes (34): es-hangul, @push/contracts, dependencies, es-hangul@2.4.0, @neondatabase/serverless@1.2.0, devDependencies, @types/node@22.20.5, typescript@7.0.2 (+26 more)

### Community 88 - "Community 88"
Cohesion: 0.09
Nodes (22): apply_chat_settings(), _confirm(), insert_ai_done(), load_chat_settings(), resolve_chat_settings(), _stored_effort(), _DB, _Graph (+14 more)

### Community 89 - "Community 89"
Cohesion: 0.12
Nodes (24): _canon(), _default_fetch(), has_https(), _https_urls(), _in_context(), ingest_chat_links(), older_message_counted(), _read_repo() (+16 more)

### Community 90 - "Community 90"
Cohesion: 0.09
Nodes (23): _docx_paragraph(), _node_lines(), render_docx(), render_pdf(), _stamp_photo(), _text(), image_bytes(), _DB (+15 more)

### Community 91 - "Community 91"
Cohesion: 0.10
Nodes (15): CountingStore, _now(), StubGoogleClient, StubGoogleStore, StubSessionStore, StubTokenCipher, _svc(), test_complete_pkce_mismatch() (+7 more)

### Community 92 - "Community 92"
Cohesion: 0.06
Nodes (35): x-ai-env, AI_BASE_URL, AI_SHARED_SECRET, APP_ENV, BLOB_STORE, CHAT_EXECUTOR, CHECKPOINTER, CORE_ORIGIN (+27 more)

### Community 93 - "Community 93"
Cohesion: 0.10
Nodes (21): ai_cost_micro_credits(), astructured_reply(), _callback_type(), _finish(), __init__(), on_llm_end(), on_llm_error(), _release() (+13 more)

### Community 94 - "Community 94"
Cohesion: 0.07
Nodes (31): _done(), _body_line(), done_summary(), _md_heading(), paper_event(), strategy_plan(), _strip_md(), judged() (+23 more)

### Community 95 - "Community 95"
Cohesion: 0.11
Nodes (18): ConcurrentUserStore, _refresh_rec(), StubSessionStore, StubUserStore, _svc(), test_oauth_concurrent_first_login(), test_refresh_reuse_kills_all_sessions(), test_refresh_rotates_and_issues_new_session() (+10 more)

### Community 96 - "Community 96"
Cohesion: 0.09
Nodes (15): _conv(), _DB, _Docs, _Q, root(), test_kind_of_maps_file_names(), test_md_to_pdf_falls_back_to_plain_writer(), test_sync_documents_creates_then_versions_documents() (+7 more)

### Community 97 - "Community 97"
Cohesion: 0.11
Nodes (33): ALIASES, ascii(), base64(), declaredTooLarge(), dispatchImages(), EXT, getImage(), HEIC_BRANDS (+25 more)

### Community 98 - "Community 98"
Cohesion: 0.08
Nodes (13): main(), migrate(), assert_development(), main(), posting_system_prompt(), personal_prompt(), media_type(), test_media_type_by_extension() (+5 more)

### Community 99 - "Community 99"
Cohesion: 0.10
Nodes (21): baseline_lines(), _clean_flag(), verify_claims(), Flag, ReviewReport, _generate(), _draft(), _FakeStructured (+13 more)

### Community 100 - "Community 100"
Cohesion: 0.06
Nodes (33): x-ai-env, AI_BASE_URL, AI_SHARED_SECRET, APP_ENV, BLOB_STORE, CHAT_EXECUTOR, CHECKPOINTER, CORE_ORIGIN (+25 more)

### Community 101 - "Community 101"
Cohesion: 0.13
Nodes (16): CareerEvidence, JobPosting, link_count(), score_band(), document_fit_score(), match_evidence(), _now(), part_scores() (+8 more)

### Community 102 - "Community 102"
Cohesion: 0.06
Nodes (31): build, depends_on, environment, ports, volumes, context, postgres, APP_ENV (+23 more)

### Community 103 - "Community 103"
Cohesion: 0.09
Nodes (18): _negotiate_tls(), _open_python_websocket(), open_websocket_stream(), parse_dsn(), _parse_error_fields(), _parse_scram_attrs(), _pg_error(), _raise_first_error() (+10 more)

### Community 104 - "Community 104"
Cohesion: 0.18
Nodes (22): _blocks_text(), read_document(), read_evidence(), read_github(), read_job(), read_posting(), read_source(), read_web() (+14 more)

### Community 105 - "Community 105"
Cohesion: 0.11
Nodes (24): docx_text(), github_client(), make_docx(), RowQuery, source_row(), test_docx_text_caps_inflation_when_declared_size_lies(), test_docx_text_joins_runs_per_paragraph_and_trims(), test_docx_text_refuses_a_zip_bomb_without_inflating_it() (+16 more)

### Community 106 - "Community 106"
Cohesion: 0.11
Nodes (13): _assert_plain_path(), CoreClient, CoreError, apply_edit(), env_core(), test_204_is_empty_object(), test_4xx_raises_core_error(), test_apply_edit_rejects_non_uuid_document_id() (+5 more)

### Community 107 - "Community 107"
Cohesion: 0.11
Nodes (31): if, needs, runs-on, steps, timeout-minutes, if, needs, runs-on (+23 more)

### Community 108 - "Community 108"
Cohesion: 0.11
Nodes (19): get_source_profile_draft(), import_evidence(), _career(), _label(), parse_profile_draft(), _skills(), _tenure(), _AsUser (+11 more)

### Community 109 - "Community 109"
Cohesion: 0.11
Nodes (13): StubApplicationStore, StubJobStore, _FailingStore, _job(), _ListStore, _RecordingAppStore, _svc(), test_create_copies_job_fields_and_starts_discovered() (+5 more)

### Community 110 - "Community 110"
Cohesion: 0.17
Nodes (21): _experiment(), _now(), StubExperimentStore, _svc(), test_assignment_deterministic_repeated(), test_assignment_is_deterministic(), test_assignment_persisted_once(), test_assignment_unknown_key_not_found() (+13 more)

### Community 111 - "Community 111"
Cohesion: 0.07
Nodes (15): hmacSha256Hex(), signedStripe(), Call, NOW, planCompleted, Row, signed(), StripeCall (+7 more)

### Community 112 - "Community 112"
Cohesion: 0.11
Nodes (8): TeiEmbedding, TeiRerank, client_for(), embed_handler(), test_adapter_returns_the_same_vectors_as_the_tei_embedder(), test_adapter_reuses_the_redis_embedding_cache(), handler(), test_reranker_reorders_by_tei_score_and_keeps_metadata()

### Community 113 - "Community 113"
Cohesion: 0.09
Nodes (12): _command_tag(), _data_row(), _frame(), _i16(), _i32(), Row, _row_description(), _Transaction (+4 more)

### Community 114 - "Community 114"
Cohesion: 0.12
Nodes (14): domain_error_handler(), error_body(), http_error_handler(), request_id_of(), RequestIDMiddleware, _status_phrase(), unhandled_error_handler(), validation_error_handler() (+6 more)

### Community 115 - "Community 115"
Cohesion: 0.20
Nodes (20): main(), _capture(), handler(), _client(), _sse(), test_chat_maps_error_status_to_value_error(), test_chat_non_json_gateway_page_raises_value_error(), test_chat_omits_empty_system_and_defaults_usage_to_zero() (+12 more)

### Community 116 - "Community 116"
Cohesion: 0.09
Nodes (15): assert_closed(), configured(), Env, FakeClient, FakeDispatcher, Svc, test_ai_worker_boots_app_then_runs_chat_and_document_queues(), test_build_chat_wires_the_harness() (+7 more)

### Community 117 - "Community 117"
Cohesion: 0.14
Nodes (7): aborts(), converts(), main(), bucket_variant(), ExperimentService, _now(), ExperimentStore

### Community 118 - "Community 118"
Cohesion: 0.11
Nodes (19): begin_request_scope(), open_tcp_stream(), _FakeConn, _listen(), _patch_connect(), fake_connect(), _recv_exact(), _self_signed() (+11 more)

### Community 119 - "Community 119"
Cohesion: 0.08
Nodes (12): _Convs, _svc(), test_graph_uses_one_harness_runtime(), test_notify_failure_never_fails_the_job(), test_start_worker_failure_restores_the_previous_scheduler(), test_start_worker_requeues_stale_jobs_then_stops_cleanly(), test_stop_worker_waits_for_inflight_jobs(), test_worker_loop_backs_off_on_claim_errors_and_resets_after_work() (+4 more)

### Community 120 - "Community 120"
Cohesion: 0.11
Nodes (17): _CompanyPostings, _ctx(), _employer_ctx(), _owned_posting(), _PlanDb, _Scripted, test_employer_basic_pro_and_ultra_pick_different_levers(), capture() (+9 more)

### Community 121 - "Community 121"
Cohesion: 0.12
Nodes (22): actual(), Case, DIR, drop(), expected(), fakeFetch(), Golden, HttpRule (+14 more)

### Community 122 - "Community 122"
Cohesion: 0.10
Nodes (12): _RacingUsage, __init__(), _CountingUsage, _Recording, _reserved(), _stream(), _StreamModel, test_callback_settles_with_the_generation_the_attempt_reserved() (+4 more)

### Community 123 - "Community 123"
Cohesion: 0.16
Nodes (17): _purge(), purge_deleted(), remove_images(), _sweep(), redact(), image_dir(), image_path(), _safe_key() (+9 more)

### Community 124 - "Community 124"
Cohesion: 0.10
Nodes (12): _blueprint_service(), _Gate, _now(), _Projects, StubProjectStore, _svc(), test_count_blueprints_excludes_archived(), test_generate_blueprints_allows_batch_that_lands_on_free_cap() (+4 more)

### Community 125 - "Community 125"
Cohesion: 0.15
Nodes (19): apply_settle(), book(), CreditBook, make_worker(), do_release(), do_settle(), queued(), release() (+11 more)

### Community 126 - "Community 126"
Cohesion: 0.13
Nodes (12): cover(), ctx(), Embedder, _noop(), Query, Rec, Store, test_document_ingest_and_reindex() (+4 more)

### Community 127 - "Community 127"
Cohesion: 0.11
Nodes (10): _wait(), test_wait_times_out_without_a_wake(), _service(), test_idle_loop_claims_only_on_the_backoff_schedule(), fake_wait(), test_schedule_sets_the_wake_event(), test_stale_sweep_also_expires_old_approval_cards(), test_stale_sweep_runs_at_the_interval_not_every_claim() (+2 more)

### Community 128 - "Community 128"
Cohesion: 0.07
Nodes (27): driver, networks, edge, push-internal, driver, services, volume-init, cap_add (+19 more)

### Community 129 - "Community 129"
Cohesion: 0.12
Nodes (24): candidatePaths(), concretize(), expand(), INTERNAL_ROUTES, isInternal(), matches(), METHODS, Operation (+16 more)

### Community 130 - "Community 130"
Cohesion: 0.09
Nodes (9): secrets_match(), SharedSecretMiddleware, test_image_bytes_reads_postgres_and_rejects_bad_keys(), test_seed_refuses_unless_development(), test_shared_secret_constant_time_length(), test_shared_secret_middleware(), test_shared_secret_rejects_non_ascii_header_with_401(), app() (+1 more)

### Community 131 - "Community 131"
Cohesion: 0.10
Nodes (16): openrouter_route(), provider_for(), completion_body(), OpenAIClient, stream_body(), test_every_listed_model_has_a_pinned_provider(), test_completion_body_pins_providers_and_adds_reasoning_only_when_set(), test_stream_body_requests_usage_and_large_budget() (+8 more)

### Community 132 - "Community 132"
Cohesion: 0.14
Nodes (21): _client(), _raises(), _svc(), test_complete_import_input_finishes_import(), test_complete_import_input_rejects_non_string_text(), test_complete_import_input_rejects_unrequested_fields(), test_import_caps_text_like_evidence_create(), test_import_enforces_the_evidence_title_limit() (+13 more)

### Community 133 - "Community 133"
Cohesion: 0.12
Nodes (12): ScheduleReq, do_post(), make_app(), StubAuth, StubIdem, test_conflict_on_different_body(), test_different_key_runs_again(), test_get_skips() (+4 more)

### Community 134 - "Community 134"
Cohesion: 0.11
Nodes (16): accepted_hits(), chunk_text(), collect_evidence(), format_section(), _index_evidence(), _retriever(), search_career_context(), split_text() (+8 more)

### Community 135 - "Community 135"
Cohesion: 0.22
Nodes (18): _client(), _Db, _Deps, _document(), _export(), _png(), _stable(), test_export_accepts_aliases_without_a_write() (+10 more)

### Community 136 - "Community 136"
Cohesion: 0.27
Nodes (23): _accept(), _assert_kept(), _bag(), _choice(), _flat_fit(), fake(), _open(), _payload() (+15 more)

### Community 137 - "Community 137"
Cohesion: 0.11
Nodes (26): CENTS, check(), CREDITS, dbFor(), env, FIRST, Invoice, jittered() (+18 more)

### Community 138 - "Community 138"
Cohesion: 0.11
Nodes (19): active(), CONVS, dataSeen(), deps(), devEnv(), env(), Fake, fake() (+11 more)

### Community 139 - "Community 139"
Cohesion: 0.08
Nodes (13): Call, Company, empty, Err, Expired, Hit, Mail, NOW (+5 more)

### Community 140 - "Community 140"
Cohesion: 0.14
Nodes (5): validation(), BillingService, work(), _now(), BillingStore

### Community 141 - "Community 141"
Cohesion: 0.09
Nodes (23): phase_prompt_for_harness(), _cap_stem(), edited_pdf_name(), _file_label(), _file_part(), _is_resume_file(), _original_stem(), phase_instructions() (+15 more)

### Community 142 - "Community 142"
Cohesion: 0.13
Nodes (11): ResumeState, _call(), _ctx(), _pdf(), _Rows, test_explore_github_needs_a_linked_account(), test_fetch_url_only_returns_prefetched_pages(), test_parse_attachment_reads_evidence_then_conversation_pdfs() (+3 more)

### Community 143 - "Community 143"
Cohesion: 0.14
Nodes (13): copied_sentences(), design_interview(), draft_posting(), profile_is_fresh(), report_summary(), research_company(), review_posting(), _sentences() (+5 more)

### Community 144 - "Community 144"
Cohesion: 0.25
Nodes (17): _Db, _document(), _fit(), _posting(), _real_judge(), test_a_changed_plan_scores_again(), test_blank_db_plan_is_free(), test_cache_hit_writes_no_usage_row() (+9 more)

### Community 145 - "Community 145"
Cohesion: 0.21
Nodes (19): _client(), _events(), _Locks, _op(), _pending_import(), _raises(), _svc(), test_cancel_running_op_and_idempotent_on_terminal() (+11 more)

### Community 146 - "Community 146"
Cohesion: 0.18
Nodes (13): _CacheDb, _conditions(), _posting(), test_floor_does_not_score_past_the_cap_to_fill_the_list(), test_floor_stays_quiet_when_enough_postings_clear_seven(), test_load_corpus_asks_for_sixty_candidates(), test_min_fit_switch_drops_scores_under_seven(), test_rank_postings_orders_by_max_similarity_and_drops_closed() (+5 more)

### Community 147 - "Community 147"
Cohesion: 0.15
Nodes (14): work(), _AsUser, AIGate, job(), now(), _raises(), test_prepare_builds_questions_star_answers_and_research(), test_prepare_checks_ai_gate_first_and_writes_nothing_on_refusal() (+6 more)

### Community 148 - "Community 148"
Cohesion: 0.19
Nodes (17): db(), Embedder, ingest_document(), beat(), nodes(), seed_document(), seed_posting(), seed_user() (+9 more)

### Community 149 - "Community 149"
Cohesion: 0.23
Nodes (17): _AsUser, _client(), _db(), _iso(), _message(), _ordered_messages(), _share(), test_artifacts_returns_document_attachment_and_skips_bare_evidence() (+9 more)

### Community 150 - "Community 150"
Cohesion: 0.17
Nodes (19): ALLOWED_HEADERS, ALLOWED_ORIGINS, conditional(), flag(), USER_CACHE_CONTROL, weakEtag(), AI_PROVIDERS, EFFORTS (+11 more)

### Community 151 - "Community 151"
Cohesion: 0.09
Nodes (22): sysctls, AI_HOST, DISPATCH_HOST, STAGING_AI_HOST, STAGING_DISPATCH_HOST, cap_drop, command, environment (+14 more)

### Community 152 - "Community 152"
Cohesion: 0.16
Nodes (16): AiGenerateReq, AiOptionsReq, AnalyzeReq, BlueprintsReq, _coerce_uuid(), CreateApprovalReq, DecisionReq, ExpectedRevisionReq (+8 more)

### Community 153 - "Community 153"
Cohesion: 0.17
Nodes (15): stored_document_template(), _company_label(), _company_label_db(), _kind_of(), _load_mapping(), md_to_doc(), md_to_pdf(), _md_to_pdf_plain() (+7 more)

### Community 154 - "Community 154"
Cohesion: 0.11
Nodes (21): cap_drop, command, depends_on, expose, healthcheck, image, mem_limit, networks (+13 more)

### Community 155 - "Community 155"
Cohesion: 0.10
Nodes (18): applicationStage, careerYears, csv(), employmentType, facetItem, filterParams(), imageKey, jobCategory (+10 more)

### Community 156 - "Community 156"
Cohesion: 0.18
Nodes (16): _application_inputs(), _career(), _chips_from_text(), _coffee_inputs(), conditions_from_chips(), _deadline_inputs(), _document_id(), _find_inputs() (+8 more)

### Community 157 - "Community 157"
Cohesion: 0.17
Nodes (12): _markdown_file(), turn_events(), _client(), _db(), _Mem, _row(), test_turn_events_merge_tokens_and_drop_progress_rows(), test_turn_events_read_text_payload_and_attach_card_resolution() (+4 more)

### Community 158 - "Community 158"
Cohesion: 0.15
Nodes (19): node_text(), cached_view(), fit_inputs(), fit_view(), _point(), _reachable(), _requirements(), _scored() (+11 more)

### Community 159 - "Community 159"
Cohesion: 0.16
Nodes (16): _cfg(), levers_for(), plan_name(), FitDimensions, judge_fit(), _tier(), chat_model_for(), load_fit() (+8 more)

### Community 160 - "Community 160"
Cohesion: 0.15
Nodes (12): chat_model(), _managed(), _now(), _patch_model(), test_chat_model_refuses_a_model_without_pinned_providers(), test_chat_model_refuses_an_empty_key_before_the_openai_sdk(), test_chat_model_sets_timeout_retries_and_provider_routing(), test_gate_import_error_falls_back() (+4 more)

### Community 161 - "Community 161"
Cohesion: 0.13
Nodes (5): FakeConn, _MigConn, test_db_q_uses_tx_inside_do(), fn(), test_run_migrations_unlocks_on_failure()

### Community 162 - "Community 162"
Cohesion: 0.15
Nodes (17): Call, calls(), createDb(), deps(), env(), Err, exchangeCode(), googleFetch() (+9 more)

### Community 163 - "Community 163"
Cohesion: 0.10
Nodes (20): volume-init, depends_on, depends_on, cap_drop, command, depends_on, expose, image (+12 more)

### Community 164 - "Community 164"
Cohesion: 0.12
Nodes (20): REDISCLI_AUTH, interval, retries, test, timeout, staging-redis, healthcheck, cap_drop (+12 more)

### Community 165 - "Community 165"
Cohesion: 0.10
Nodes (19): accepted, accountType, companyRole, email, employerPlan, imageTypes, inviteIdParam, notModified (+11 more)

### Community 166 - "Community 166"
Cohesion: 0.10
Nodes (19): chatEvents, chatJob, choiceSection, choiceSubmit, expectedRevision, hunk, id, option (+11 more)

### Community 167 - "Community 167"
Cohesion: 0.26
Nodes (12): _ai_done(), _Graph, _job(), _run_svc(), _RunJobs, test_run_job_cancelled_after_last_chunk_keeps_cancelled(), test_run_job_cancelled_before_done_never_finishes(), test_run_job_crash_on_last_attempt_fails_without_leaking_the_cause() (+4 more)

### Community 168 - "Community 168"
Cohesion: 0.11
Nodes (9): db(), owned_rows(), seed_company(), test_a_sweep_deletes_in_batches_and_leaves_the_rest_for_the_next_pass(), test_archived_documents_are_hard_deleted_after_30_days(), seed(), test_company_rows_are_gone_30_days_after_deletion(), test_only_unaccepted_invites_are_deleted_once_expired() (+1 more)

### Community 169 - "Community 169"
Cohesion: 0.14
Nodes (4): BufferedStream, _Conn, fake_connect(), test_buffered_stream_reassembles_frames()

### Community 170 - "Community 170"
Cohesion: 0.11
Nodes (8): authed(), Call, empty, Err, hubProfile, postingBody, tokenRow(), verified

### Community 171 - "Community 171"
Cohesion: 0.11
Nodes (19): runs-on, jobs, changes, lint-ai, test-vps, test-vps-logs, if, needs (+11 more)

### Community 172 - "Community 172"
Cohesion: 0.22
Nodes (16): _best(), cosine_similarity(), _open(), posting_matches(), present_match(), rank_postings(), render_matches(), _skill_set() (+8 more)

### Community 173 - "Community 173"
Cohesion: 0.11
Nodes (18): aiOpt, cliProvider, companySourceIn, companySourcesIn, expectedRevision, launchStatus, op, processInfo (+10 more)

### Community 174 - "Community 174"
Cohesion: 0.16
Nodes (14): _j(), _ts(), _field(), req(), test_bind_json(), test_current_user_missing_is_401(), test_data_and_page_body(), test_deps_reads_app_state() (+6 more)

### Community 175 - "Community 175"
Cohesion: 0.22
Nodes (12): _be(), decrypt(), encrypt(), _encrypt_block(), _expand(), _gf_mul(), _ghash(), hmac_equal() (+4 more)

### Community 176 - "Community 176"
Cohesion: 0.13
Nodes (6): Embedder, Evidence, RecordingDb, Retriever, test_conversation_evidence_flow_reads_and_writes_rag_nodes_for_the_user(), _touching()

### Community 177 - "Community 177"
Cohesion: 0.26
Nodes (17): parseTimeField(), CompanySource, companySources(), createInterview(), dispatchInterviews(), getInterview(), httpUrl(), interviewDto() (+9 more)

### Community 178 - "Community 178"
Cohesion: 0.12
Nodes (13): resetAppleJwks(), b64url(), Err, nonceClaim, NOW, PEM, Pending, prepare() (+5 more)

### Community 179 - "Community 179"
Cohesion: 0.18
Nodes (12): base(), decodeCursor(), encodeCursor(), formatCursorTimestamp(), formatJsonTimestamp(), fromEpoch(), pad(), parseUtc() (+4 more)

### Community 180 - "Community 180"
Cohesion: 0.20
Nodes (11): _cosine(), Engine, evaluate(), grounded(), llamaindex_chunks(), load(), main(), recall_at_k() (+3 more)

### Community 181 - "Community 181"
Cohesion: 0.11
Nodes (17): patterns, actions, npm, python, dependency-name, update-types, update-types, update-types (+9 more)

### Community 182 - "Community 182"
Cohesion: 0.12
Nodes (18): cap_drop, command, environment, expose, image, mem_limit, networks, pids_limit (+10 more)

### Community 183 - "Community 183"
Cohesion: 0.11
Nodes (17): services, volumes, staging-ai-data, staging-redis-data, x-hardened, cap_drop, read_only, restart (+9 more)

### Community 184 - "Community 184"
Cohesion: 0.16
Nodes (16): LAST_LINE, QUEUE_POSITION, assertQueuePositionSql(), assertStatusSql(), authRow(), deps(), env(), Fixture (+8 more)

### Community 185 - "Community 185"
Cohesion: 0.11
Nodes (17): calendarType, documentKind, evidenceKind, expectedRevision, exportBinary, id, key, routes (+9 more)

### Community 186 - "Community 186"
Cohesion: 0.11
Nodes (15): del, enumOf(), pageParams, pathParam(), CAREER_STATUS, id, IMAGE_KEY, JOB_CATEGORY (+7 more)

### Community 187 - "Community 187"
Cohesion: 0.20
Nodes (15): build_excerpt_content(), validate_document_content(), Block, add(), para(), test_block_mismatch(), test_build_excerpt_content_roundtrip(), test_duplicate_block_id() (+7 more)

### Community 188 - "Community 188"
Cohesion: 0.26
Nodes (11): reference_lines(), _ctx(), _pool(), _RefDB, _row(), test_personal_agent_adds_reference_lines_to_the_system_message(), test_reference_lines_need_a_score_for_a_bounded_plan(), test_reference_lines_need_consent() (+3 more)

### Community 189 - "Community 189"
Cohesion: 0.14
Nodes (12): _array_item(), _bind_param(), _decode_text(), _parse_array(), _parse_ts(), test_array_null_elements(), test_bind_param(), test_bind_text_array_preserves_non_ascii() (+4 more)

### Community 190 - "Community 190"
Cohesion: 0.16
Nodes (11): expo_push(), push(), make_notify(), notify(), main(), stop_on_signals(), test_stop_on_signals_routes_sigterm_to_graceful_stop(), test_expo_push_is_skipped_without_token_and_sends_bearer_with_one() (+3 more)

### Community 191 - "Community 191"
Cohesion: 0.20
Nodes (13): _avail(), _client(), test_analyze_defaults_to_rule_based_without_evidence(), test_analyze_rejects_bad_path_or_body(), test_analyze_routes_ids_revision_and_options(), test_generate_passes_user_prompt_and_options(), test_generate_rejects_bad_bodies(), test_generate_surfaces_plan_gate_errors() (+5 more)

### Community 192 - "Community 192"
Cohesion: 0.20
Nodes (12): _client(), _Recorder, test_domain_errors_from_service_keep_status_and_code(), test_generate_blueprints_passes_user_and_ids(), test_generate_blueprints_rejects_bad_bodies(), test_generate_blueprints_without_ai_passes_none(), test_resume_run_accepts_empty_object_and_rejects_bad_id(), test_resume_run_passes_application_and_ai() (+4 more)

### Community 193 - "Community 193"
Cohesion: 0.20
Nodes (15): opEvent(), arr(), Auth, body(), closed(), json(), Method, obj() (+7 more)

### Community 194 - "Community 194"
Cohesion: 0.21
Nodes (10): main(), passed(), run(), banned_in_interview(), banned_in_posting(), _hits(), verdicts_in(), test_eval_thresholds_match_the_design() (+2 more)

### Community 195 - "Community 195"
Cohesion: 0.20
Nodes (4): GoogleTokens, GoogleClient, _parse_google_time(), SyncTokenInvalid

### Community 196 - "Community 196"
Cohesion: 0.18
Nodes (10): create_tool_approval(), tool_action_event(), _Db, test_other_tool_events_have_no_rows(), test_stage_change_approval_names_the_applicant(), test_stage_change_without_a_company_row_adds_no_rows(), test_stage_rows_are_limited_to_the_conversation_company(), rows() (+2 more)

### Community 198 - "Community 198"
Cohesion: 0.12
Nodes (8): authed(), Call, ConsentBody, empty, EMPTY_TERMS, Err, Terms, tokenRow()

### Community 199 - "Community 199"
Cohesion: 0.12
Nodes (16): POSTGRES_DB, POSTGRES_PASSWORD, POSTGRES_USER, test-db, env, image, options, ports (+8 more)

### Community 200 - "Community 200"
Cohesion: 0.16
Nodes (16): build, context, dockerfile, build, build, build, x-ai-image, build (+8 more)

### Community 201 - "Community 201"
Cohesion: 0.12
Nodes (16): cap_drop, command, depends_on, expose, image, mem_limit, networks, pids_limit (+8 more)

### Community 202 - "Community 202"
Cohesion: 0.12
Nodes (16): disable, healthcheck, cap_drop, command, depends_on, healthcheck, image, mem_limit (+8 more)

### Community 203 - "Community 203"
Cohesion: 0.16
Nodes (16): context, dockerfile, build, build, build, build, x-ai-image, build (+8 more)

### Community 204 - "Community 204"
Cohesion: 0.12
Nodes (16): disable, staging-notify-worker, healthcheck, cap_drop, command, depends_on, healthcheck, image (+8 more)

### Community 205 - "Community 205"
Cohesion: 0.12
Nodes (16): staging-ai-worker, cap_drop, command, depends_on, expose, image, mem_limit, networks (+8 more)

### Community 206 - "Community 206"
Cohesion: 0.27
Nodes (15): _clean(), _document_title(), _insert_source(), _page_count(), _pdf_bytes(), profile_card_names(), resolve_uploaded_source(), _row_text() (+7 more)

### Community 208 - "Community 208"
Cohesion: 0.13
Nodes (15): staging-dispatcher, cap_drop, command, depends_on, expose, image, mem_limit, networks (+7 more)

### Community 210 - "Community 210"
Cohesion: 0.17
Nodes (9): authed(), Call, chipsOf(), deps(), empty, env(), Err, get() (+1 more)

### Community 211 - "Community 211"
Cohesion: 0.22
Nodes (14): createDb(), deps(), env(), Err, NOW, pending(), post(), Row (+6 more)

### Community 212 - "Community 212"
Cohesion: 0.19
Nodes (11): deps(), Fake, fake(), isAuthOnly(), isShared(), noBinding, NOW, Seen (+3 more)

### Community 213 - "Community 213"
Cohesion: 0.21
Nodes (9): _parse_connect_target(), _pipe(), _start_egress_proxy(), handle(), _connect(), test_parse_connect_target(), test_proxy_pipes_to_validated_ip(), test_proxy_rejects_non_connect() (+1 more)

### Community 214 - "Community 214"
Cohesion: 0.14
Nodes (14): REDISCLI_AUTH, cap_drop, command, environment, image, mem_limit, networks, pids_limit (+6 more)

### Community 215 - "Community 215"
Cohesion: 0.14
Nodes (14): cap_drop, command, depends_on, image, mem_limit, networks, pids_limit, read_only (+6 more)

### Community 216 - "Community 216"
Cohesion: 0.14
Nodes (14): staging-ingest-worker, cap_drop, command, depends_on, image, mem_limit, networks, pids_limit (+6 more)

### Community 217 - "Community 217"
Cohesion: 0.25
Nodes (6): extract_pdf_bytes(), _pdf(), test_extract_pdf_bytes_keeps_blank_pages_as_empty_lines(), test_extract_pdf_bytes_raises_on_non_pdf(), test_extract_pdf_bytes_reads_every_page_in_order(), test_extract_pdf_bytes_stops_at_page_and_char_caps()

### Community 218 - "Community 218"
Cohesion: 0.23
Nodes (12): buildSpec(), danglingRefs(), IDEMPOTENCY_KEY, operationIdOf(), operationOf(), sortDeep(), areas, routes (+4 more)

### Community 219 - "Community 219"
Cohesion: 0.16
Nodes (6): _db_blobs(), external_jobs(), test_blob_store_db_still_selects_the_database(), test_chat_executor_still_selects_external_jobs(), test_dead_runtime_flag_does_not_select_external_jobs(), test_dead_runtime_flag_does_not_store_blobs_in_the_db()

### Community 220 - "Community 220"
Cohesion: 0.26
Nodes (9): InterviewStore, _iv(), test_calendar_event_writes(), test_create_dumps_json_columns(), test_get_missing_raises(), test_get_scoped_and_null_json_becomes_empty_lists(), test_list_all_filters_and_cursor(), test_list_no_filters() (+1 more)

### Community 221 - "Community 221"
Cohesion: 0.14
Nodes (3): _fake_playwright(), test_render_text_guards_subrequests_and_cleans_up(), test_render_text_keeps_sandbox_by_default()

### Community 222 - "Community 222"
Cohesion: 0.37
Nodes (12): _doc(), _error(), _para(), test_block_nodes_require_block_id(), test_blocks_must_have_ids_and_match_content(), test_code_point_slice_bounds(), test_duplicate_block_ids_in_content_rejected(), test_link_mark_without_href_and_unknown_marks_rejected() (+4 more)

### Community 223 - "Community 223"
Cohesion: 0.16
Nodes (5): _Chunks, _Store, _Streaming, test_one_reply_produces_multiple_token_events(), test_streamed_model_call_settles_usage_once()

### Community 225 - "Community 225"
Cohesion: 0.25
Nodes (12): createEvidence(), dispatchEvidence(), evidenceDto(), getEvidence(), httpUrl(), KINDS, loadEvidence(), location() (+4 more)

### Community 226 - "Community 226"
Cohesion: 0.15
Nodes (5): test_api_server_exit_stops_the_worker(), ai_env(), serve_api(), chat_globals(), dispatcher_env()

### Community 227 - "Community 227"
Cohesion: 0.27
Nodes (6): FakeStore, _review(), test_pdf_from_another_conversation_is_not_readable(), test_pdf_review_is_ultra_only(), test_posting_from_another_company_is_rejected(), test_ultra_reviews_an_attached_pdf_and_keeps_it_in_the_conversation()

### Community 228 - "Community 228"
Cohesion: 0.18
Nodes (6): _JobCtx, __init__(), test_queue_turn_checks_cancellation_once_per_second_and_before_done(), test_queue_turn_closes_the_graph_stream_when_cancelled(), cancelled(), test_queue_turn_stores_a_graph_result_for_the_stream_and_replay()

### Community 229 - "Community 229"
Cohesion: 0.18
Nodes (4): test_asyncpg_pool_is_empty_until_used_and_closes(), test_checkpointer_pool_holds_nothing_while_idle(), test_shutdown_stops_the_worker_first_and_closes_the_pool_last(), create_pool()

### Community 230 - "Community 230"
Cohesion: 0.35
Nodes (7): enclosing(), fold(), items(), literals(), locals_of(), module_constants(), param_values()

### Community 231 - "Community 231"
Cohesion: 0.18
Nodes (11): concurrency, cancel-in-progress, group, concurrency, name, on, pull_request, push (+3 more)

### Community 232 - "Community 232"
Cohesion: 0.30
Nodes (9): env(), env_json(), load_config(), OAuthProviderConfig, test_app_env_defaults_to_production(), test_app_env_development_is_explicit(), test_bad_dev_user_id_and_experiments_fall_back(), test_managed_key_comes_from_openrouter_only() (+1 more)

### Community 233 - "Community 233"
Cohesion: 0.20
Nodes (6): _ActiveFlow, _start(), test_continue_choice_names_the_draft_in_progress(), test_quality_copy(), test_review_choice_has_template_and_photo_sections(), test_review_gate_explains_the_pick_and_badges_the_recommended_template()

### Community 234 - "Community 234"
Cohesion: 0.21
Nodes (6): _Approvals, _service(), _Store, test_create_rejects_an_unknown_template(), test_create_stores_classic_as_simple(), test_create_stores_the_four_names()

### Community 235 - "Community 235"
Cohesion: 0.17
Nodes (3): Call, empty, posting

### Community 236 - "Community 236"
Cohesion: 0.29
Nodes (6): acquire_lock(), extend_lock(), _if_owner(), job_lock(), LockBusy, release_lock()

### Community 237 - "Community 237"
Cohesion: 0.20
Nodes (4): _postgres_up(), _DB, _postgres_up(), _Rec

### Community 238 - "Community 238"
Cohesion: 0.20
Nodes (3): _doc_list(), test_code_lists_match_fair_hiring_doc(), test_fair_hiring_reaches_every_writing_node()

### Community 239 - "Community 239"
Cohesion: 0.40
Nodes (10): dispatchConsents(), getConsents(), load(), putConsents(), putTerms(), readJson(), REQUIRED, TERMS_VERSION (+2 more)

### Community 240 - "Community 240"
Cohesion: 0.35
Nodes (10): authRow, deleteCall(), deps(), env(), headers(), interviewOnPlan(), messageBody(), NOW (+2 more)

### Community 241 - "Community 241"
Cohesion: 0.29
Nodes (10): archiveWorld(), Body, detailWorld(), env, messageWorld(), NOW, offerRow(), reportWorld() (+2 more)

### Community 242 - "Community 242"
Cohesion: 0.18
Nodes (3): WebSocket, WebSocketServer, ws

### Community 243 - "Community 243"
Cohesion: 0.18
Nodes (3): Call, LinkRow, NOW

### Community 244 - "Community 244"
Cohesion: 0.18
Nodes (10): compilerOptions, allowImportingTsExtensions, module, moduleResolution, noEmit, skipLibCheck, strict, target (+2 more)

### Community 245 - "Community 245"
Cohesion: 0.31
Nodes (10): secretEquals(), sha256Hex(), isolate, ACT_AS, forwardInit(), invalidateAfterWrite(), isInternalCall(), proxy() (+2 more)

### Community 246 - "Community 246"
Cohesion: 0.18
Nodes (3): WebSocket, WebSocketServer, ws

### Community 247 - "Community 247"
Cohesion: 0.18
Nodes (10): compilerOptions, allowImportingTsExtensions, module, moduleResolution, noEmit, skipLibCheck, strict, target (+2 more)

### Community 248 - "Community 248"
Cohesion: 0.38
Nodes (8): add_key(), DEBIAN_FRONTEND, die(), log(), purge_pre_14d_logs(), harden.sh script, supported(), valid_key()

### Community 249 - "Community 249"
Cohesion: 0.24
Nodes (5): BigramEmbedder, LengthFreeReranker, test_eval_computes_recall_and_mrr_on_tiny_fixture(), test_llamaindex_engine_runs_end_to_end_offline(), test_synthetic_set_has_50_queries_grounded_in_same_tenant_docs()

### Community 250 - "Community 250"
Cohesion: 0.22
Nodes (9): devDependencies, openapi-typescript@7.13.0, exports, name, private, scripts, generate, type (+1 more)

### Community 252 - "Community 252"
Cohesion: 0.51
Nodes (9): cstr(), dataRow(), fakePostgres(), int16(), int32(), msg(), ready, result() (+1 more)

### Community 253 - "Community 253"
Cohesion: 0.25
Nodes (7): RFC-3339, components, $defs, operations, paths, webhooks, GATEWAY_ROUTES

### Community 254 - "Community 254"
Cohesion: 0.25
Nodes (3): client(), scheduled(), test_schedule_rejects_anything_but_a_uuid_job_id()

### Community 255 - "Community 255"
Cohesion: 0.22
Nodes (9): env, environment, if, needs, runs-on, timeout-minutes, STAGE, WRANGLER_ENV (+1 more)

### Community 256 - "Community 256"
Cohesion: 0.22
Nodes (9): test-ai, python, fail-fast, matrix, if, needs, runs-on, strategy (+1 more)

### Community 258 - "Community 258"
Cohesion: 0.22
Nodes (3): NOW, Row, World

### Community 259 - "Community 259"
Cohesion: 0.25
Nodes (8): outputs, ai, core, db, deploy, gateway, stage, vps

### Community 261 - "Community 261"
Cohesion: 0.25
Nodes (8): x-queue-env, APP_ENV, DATABASE_URL, DB_DRIVER, PG_TRANSPORT, QUEUE_BACKEND, REDIS_URL, RUN_MIGRATIONS

### Community 262 - "Community 262"
Cohesion: 0.39
Nodes (5): boost_cycle(), _run(), test_a_short_score_list_does_not_count_as_the_cap(), test_stops_at_five_cycles(), test_stops_on_two_consecutive_gains_below_a_tenth()

### Community 263 - "Community 263"
Cohesion: 0.25
Nodes (7): name, private, scripts, contracts, test, typecheck, workspaces

### Community 264 - "Community 264"
Cohesion: 0.32
Nodes (4): import_pgvector_store(), main(), packages_available(), test_import_pgvector_store_returns_the_class_without_connecting()

### Community 267 - "Community 267"
Cohesion: 0.29
Nodes (3): conn(), statements(), test_0048_drops_orphans_then_cascades()

### Community 268 - "Community 268"
Cohesion: 0.25
Nodes (4): authRow, env, NOW, Row

### Community 270 - "Community 270"
Cohesion: 0.29
Nodes (7): external, name, networks, edge, push-internal, external, name

### Community 271 - "Community 271"
Cohesion: 0.33
Nodes (4): [input, flag, ...sources], norm(), out, statements

### Community 276 - "Community 276"
Cohesion: 0.33
Nodes (5): test_employer_core_tool_paths(), handler(), test_stage_is_closed(), test_update_posting_draft_leaves_open_postings_alone(), _tool()

### Community 277 - "Community 277"
Cohesion: 0.57
Nodes (5): _app_routes(), _shape(), _spec_routes(), test_every_ai_route_in_the_spec_is_mounted(), test_every_public_fastapi_route_is_in_the_spec()

### Community 279 - "Community 279"
Cohesion: 0.33
Nodes (3): empty, queryFor(), userRow()

### Community 280 - "Community 280"
Cohesion: 0.29
Nodes (3): Call, empty, openRow

### Community 281 - "Community 281"
Cohesion: 0.33
Nodes (6): test-core, if, needs, runs-on, steps, timeout-minutes

### Community 282 - "Community 282"
Cohesion: 0.33
Nodes (6): test-gateway, if, needs, runs-on, steps, timeout-minutes

### Community 283 - "Community 283"
Cohesion: 0.40
Nodes (4): checked, covered(), groups, norm()

### Community 287 - "Community 287"
Cohesion: 0.33
Nodes (3): env(), FakePool, fake_create_pool()

### Community 289 - "Community 289"
Cohesion: 0.50
Nodes (3): fail(), FAKE_ROOT, run.sh script

### Community 290 - "Community 290"
Cohesion: 0.60
Nodes (3): _client(), test_models_are_available_only_through_managed(), test_python_exposes_no_ai_key_routes()

### Community 291 - "Community 291"
Cohesion: 0.50
Nodes (3): operation_events(), emit(), stream()

## Knowledge Gaps
- **5 isolated node(s):** `RFC-6266`, `DEBIAN_FRONTEND`, `RFC-3339`, `FAKE_ROOT`, `push-be`
  These have ≤1 connection - possible missing edges. (Counts symbols only; 2818 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **41 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `DomainError` connect `Community 4` to `Community 131`, `Community 132`, `Community 6`, `Community 7`, `Community 135`, `Community 9`, `Community 11`, `Community 12`, `Community 140`, `Community 14`, `Community 145`, `Community 19`, `Community 20`, `Community 148`, `Community 149`, `Community 23`, `Community 147`, `Community 157`, `Community 29`, `Community 32`, `Community 33`, `Community 34`, `Community 160`, `Community 290`, `Community 42`, `Community 174`, `Community 47`, `Community 48`, `Community 46`, `Community 187`, `Community 191`, `Community 192`, `Community 66`, `Community 72`, `Community 81`, `Community 82`, `Community 83`, `Community 91`, `Community 222`, `Community 95`, `Community 106`, `Community 234`, `Community 108`, `Community 109`, `Community 110`, `Community 114`, `Community 123`, `Community 124`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **What connects `RFC-6266`, `DEBIAN_FRONTEND`, `RFC-3339` to the rest of the system?**
  _5 weakly-connected nodes found - possible missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.03841481295295547 - nodes in this community are weakly interconnected._
- **Why does `NotFoundError` connect `Community 6` to `Community 1`, `Community 4`, `Community 133`, `Community 7`, `Community 9`, `Community 140`, `Community 13`, `Community 19`, `Community 20`, `Community 292`, `Community 293`, `Community 41`, `Community 42`, `Community 44`, `Community 49`, `Community 53`, `Community 57`, `Community 69`, `Community 72`, `Community 207`, `Community 81`, `Community 83`, `Community 91`, `Community 220`, `Community 95`, `Community 101`, `Community 234`, `Community 108`, `Community 109`, `Community 110`, `Community 117`, `Community 124`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.037190286192798384 - nodes in this community are weakly interconnected._
- **Why does `test_compact_choice_document_template_matches_the_pdf()` connect `Community 13` to `Community 153`, `Community 83`, `Community 4`, `Community 6`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.03169998964052626 - nodes in this community are weakly interconnected._