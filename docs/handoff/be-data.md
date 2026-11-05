# BE data tasks

Paseo design only. Cursor writes the code. One PR-sized section per ID.

Repo: `/Volumes/Untitled/Documents/Github/push-workspace/push-be` (origin `push-dot/push-be`).
Work in a clean git worktree. Do not use the workspace checkout. It can be dirty and behind `origin/develop`.
npm for TypeScript. Do not touch `services/ai`. No pytest. Do not add a dependency.

Hard rules: never push or merge to `main`. Never force-push. Never merge the PR (the owner merges). Never run a migration. Never write to Neon main or staging. Never print a secret. CI may apply migrations to its ephemeral database. That is the only apply.

Envelope, already in `services/core-api/src/http.ts`. Do not invent another.

- Success: `data(status, value, rid)` → `{ "data": value }`. Request id is the `x-request-id` header, not a success-body field.
- Page: `pageBody(items, nextCursor, hasMore, rid, total)` → `{ "data": items, "page": { "nextCursor": string|null, "hasMore": boolean, "total"?: number } }`.
- Error: `{ "error": { "code", "message", "requestId", "details" } }`.
- 400 `VALIDATION_ERROR` via `fieldError(field, message)` → `details.field`.
- 422 `VALIDATION_ERROR` via `unprocessable(field, message)` in `recruiting-shared.ts`.
- 401 `UNAUTHENTICATED`. 404 `NOT_FOUND`. 409 `REVISION_CONFLICT` with `details.currentRevision`.

OpenAPI: edit `packages/contracts/spec` only. Run `npm run contracts`. Do not hand-edit `openapi.json` or `schema.ts`. Contract parity is the three openapi route tests.

SQL: cast every untyped `jsonb_build_object` argument (`$n::text`, `$n::timestamptz`, `$n::jsonb`, `$n::boolean`). A new statement must run inside a test so `scripts/sql-check/coverage.mjs` counts it. Missing column `42703` is `isUndefinedColumn`. Missing table `42P01` is `isMissingRelation` (`services/core-api/src/db.ts`).

Code style: arrow functions, no comments, keep the route file's current shape. Conventional commits. TDD: write the failing test, then the code.

`BE-01` is its own PR. `BE-02` through `BE-13` are one branch and one PR, opened only after `BE-01` is on `origin/develop`. A second PR fights the OpenAPI regen. Commit per task on that branch. Regenerate contracts once at the end of the branch. PR title: `feat(api): data for the new design screens`. PR body ends with this exact line:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Category labels used by BE-07 and BE-08. Unknown or null → `커리어`.

| job_category | label |
| --- | --- |
| dev | 개발 |
| data | 데이터 |
| design | 디자인 |
| plan | 기획 |
| marketing | 마케팅 |
| sales | 영업 |
| hr | 인사 |
| ops | 운영 |

`JOB_CATEGORIES` in `services/core-api/src/routes/recruiting-shared.ts` is that set. No other codes.

## BE-01 Finish PR 222 CI
- Kind: logic
- Branch: existing `feat/design-api-fields` (PR https://github.com/push-dot/push-be/pull/222, base `develop`). Worktree `/Volumes/Untitled/tmp/wt-be-design-fields` at `a02775c919bbbd46c4f7e3bb044becbc01a9e63b`. At last check the branch was 0 behind `origin/develop` and 3 ahead. Do not merge `develop`. Do not open a new branch.
- Depends on: none
- Files:
  - `services/core-api/src/routes/applications.ts`
  - `services/core-api/test/applicants.test.ts`
  - PR 222 body only (no other product edit)
- Design: `마이-내-활동 › 마이 · 내 활동 · 지원한 공고 상세` (`stageEnteredAt`). `빠른 시작 › 빠른 시작 · 캘린더 관리` (event `location`). fo-web apply sheet `sources.kind`. No new endpoint.
- Logic design: CI run `41956949676` on `a02775c` is red for two reasons. Coverage itself passed. Do not chase uncovered c8 lines.

  1. `test-db` PREPARE error `42P08` `could not determine data type of parameter $6`. Import insert in `applications.ts` (~208) is `jsonb_build_object($6, $9::timestamptz)`. `$6` is `applications.stage` (text) and also the jsonb key. Change that call to `jsonb_build_object($6::text, $9::timestamptz)`. Leave the `queryLoose` fallback INSERT (the statement without `stage_entered_at`) as it is. Do not edit `db/migrations/0036_design_api_fields.sql`.

  2. `test-core` `TS2322` at `applications.ts` ~244. `ts()` returns `string | null`. `stageEnteredAt` returns `Record<string, string>`. `if (!times[to]) times[to] = now` assigns null. Change to `if (now && !times[to]) times[to] = now`.

  3. Employer stage fallback is already implemented in `patchApplicant` (`services/core-api/src/routes/postings.ts`, `PATCH /api/v1/postings/{id}/applicants/{applicationId}`) and has no test. Career `PATCH /api/v1/applications/{id}` and `POST /api/v1/postings/{id}/apply` already have missing-column tests. Do not add duplicates.

  4. Rewrite the PR body. Delete every "DO NOT MERGE" line. Say the handlers run when migration `0036` is applied and when it is not: reads use `to_jsonb`, writes retry without the new column on `42703`. The owner applies `0036` later. This PR does not apply it and does not write to Neon. Keep the Claude Code trailer line above.

  Normal push to `feat/design-api-fields` only. Never force-push. Never merge.
- Tests: `services/core-api/test/applicants.test.ts`, next to `a stage jump to OFFER notifies the applicant` (~371). Name: `employer stage update falls back when stage_entered_at is missing`. Use the file's `authed` helper. The fake query throws an `Error` with `code` `42703` only when the SQL contains both `UPDATE` and `stage_entered_at`, then succeeds on the bare `UPDATE`. Assert: response is the same success the OFFER test expects, first SQL contains `stage_entered_at`, second SQL is an `UPDATE` and does not contain `stage_entered_at`. The test fails if the catch is removed (the 42703 propagates) or if the first statement no longer stamps `stage_entered_at`.
- Done when:
  - `npm test -w push-be-core` passes.
  - `npm run typecheck -w push-be-core` passes.
  - The import INSERT that CI prepares contains `$6::text`.
  - PR 222 body has no "DO NOT MERGE" and states that `0036` is owner-applied later.
  - `gh pr view 222` shows that body. CI `test-db` and `test-core` are green. The owner merges. Cursor does not.

## BE-02 Recently viewed postings
- Kind: logic
- Branch: `feat/design-data-apis` from `origin/develop` after BE-01 is merged. Shared with BE-03–BE-13. One PR to `develop`.
- Depends on: BE-01
- Files:
  - `services/core-api/src/routes/me.ts` (next to `listBookmarks`)
  - spec file that already declares `GET /api/v1/me/bookmarks`
  - `services/core-api/test/` next to the bookmark list tests
- Design: `빠른 시작 › 빠른 시작 · 부족한 점 찾기`. `빠른 시작 › 빠른 시작 · 적합도 보기`.
- Logic design: Not covered. Writes already exist. There is no list.

  `recordPostingView` in `services/core-api/src/routes/postings.ts` inserts into `posting_views` (`db/migrations/0021_fo_web_design_gaps.sql`: `user_id`, `posting_id`, `viewed_on date`, primary key `(user_id, posting_id, viewed_on)`). One row per user per posting per UTC day. `ON CONFLICT DO NOTHING`. `job_postings.view_count` increments once on that insert. Guests are skipped. The catch swallows `42P01` and `42703`. Do not change that write. The list must not increment `view_count`.

  No migration.

  `GET /api/v1/me/posting-views`. Auth matches `GET /api/v1/me/bookmarks` (bearer required). No bearer → 401 `UNAUTHENTICATED`. Do not add the path to `isPublic` or `isGuestRead`.

  Query: same `pageOf` cursor and limit as bookmarks. No other query params.

  SQL: caller's rows only. One card per posting. Order by `max(viewed_on) DESC`, `job_postings.id DESC`. Cursor comparison matches bookmarks: `(viewed_on, posting id) < (cursor.createdAt, cursor.id)` using that max day. Reuse `withPublicStatus`, `POSTING_COLS`, `openClause`, and `postingDto(row, false)` so a closed posting is omitted the same way bookmarks omit it. Page `total` the same way `listBookmarks` does.

  Response: `pageBody` of posting cards. Each element is the posting card, not a wrapper.

  `42P01` or `42703` → `200` with `data: []`, `nextCursor: null`, `hasMore: false`, `total: 0`. Do not 500.
- Tests:
  - `lists a posting once, newest viewed day first` — two days for posting A, one older day for posting B → `[A, B]`.
  - `hides another user's views`.
  - `returns an empty page when posting_views is missing` — query throws `code` `42P01`, status 200, empty page.
  - `rejects a guest` — 401 `UNAUTHENTICATED`.
- Done when: the four tests pass, the route is in the regenerated OpenAPI, and `GET /api/v1/me/bookmarks` is unchanged.

## BE-03 Per-posting document status
- Kind: logic
- Branch: `feat/design-data-apis` (shared).
- Depends on: BE-01
- Files:
  - `services/core-api/src/routes/me.ts`
  - spec file next to the other `/api/v1/me/*` reads
  - `services/core-api/test/` new cases in the me/documents test file that already boots `authed`
- Design: `빠른 시작 › 빠른 시작 · 마감 임박 공고 정리`
- Logic design: Not covered. No migration. Do not add a column. Derive.

  `GET /api/v1/me/posting-document-status?postingIds=<uuid>,<uuid>`

  Auth: bearer. Missing bearer → 401 `UNAUTHENTICATED`.

  `postingIds` is one comma-separated query param. Trim each token. Duplicates collapse, first position wins. Missing, blank, or more than 50 unique ids → 400 `VALIDATION_ERROR` `details.field` `postingIds`. A token that is not a uuid → 400 `details.field` `postingIds`. Do not accept repeated params.

  Response `data()`:

  ```json
  { "data": { "items": [ { "postingId": "<uuid>", "status": "NONE", "label": "서류 없음" } ] } }
  ```

  `items` follows the deduped request order. Every requested id is present. An unknown id is `NONE`. Do not 404 the batch.

  Status and label, exact strings:

  | status | label |
  | --- | --- |
  | NONE | 서류 없음 |
  | DRAFT | 초안 있음 |
  | READY | 서류 준비됨 |

  Rule, caller only:

  1. Applications whose `jobs.source_posting_id` is in the id list and `applications.user_id` is the caller.
  2. Documents with `documents.application_id` in that set, `documents.user_id` = caller, `documents.status <> 'ARCHIVED'`.
  3. If any such document exists, pick the greatest `documents.updated_at`, then `documents.id`. `FINALIZED` → `READY`. `DRAFT` → `DRAFT`. Any other non-archived status → `NONE`. A version row does not upgrade `DRAFT` to `READY`.
  4. If no such document exists, and any of those applications has a row in `application_snapshots` → `READY`.
  5. Else `NONE`. A `DISCOVERED` application with no snapshot and no document stays `NONE`.

  Another user's document never counts. `ARCHIVED` is ignored. If the only document is `ARCHIVED` and a snapshot exists, status is `READY`.
- Tests:
  - `finalized document is READY and a draft is DRAFT` — labels `서류 준비됨` and `초안 있음`. Two documents on one posting: greatest `updated_at` wins.
  - `snapshot without a document is READY` — row in `application_snapshots`, no document.
  - `discovered application with no snapshot is NONE` — label `서류 없음`.
  - `unknown id is NONE and does not 404`.
  - `archived document is ignored`.
  - `empty postingIds is 400` — `details.field` `postingIds`.
  - `51 ids is 400`.
  - `other user's document stays NONE`.
- Done when: those tests pass and no column or migration was added.

## BE-04 This week's events
- Kind: logic
- Branch: `feat/design-data-apis` (shared).
- Depends on: BE-01
- Files: `packages/contracts/spec/documents.ts` (the existing `GET /api/v1/calendar/events` operation). No route file.
- Design: `빠른 시작 › 빠른 시작 · 캘린더 관리`
- Logic design: Covered. Do not add an endpoint. Do not change SQL. Do not change sort.

  Client calls `GET /api/v1/calendar/events?from=&to=`. Both required, RFC3339, `to` > `from`, span at most 366 days, `starts_at` inclusive on both ends. Optional `applicationId`. Cursor page. Server order is `created_at DESC, id DESC`. The client sorts the returned page by `startsAt`. Changing server order breaks the cursor.

  `location` is not on `origin/develop` before BE-01. After BE-01 it is on the event DTO, null when the column is missing (`to_jsonb`). Do not reimplement that.

  Add one description sentence, and nothing else:

  `A week is this range with from and to set to that week. Server order stays createdAt. The client sorts by startsAt. Badge text is client-only: DEADLINE 마감, INTERVIEW 면접, COFFEE_CHAT 커피챗, FOLLOW_UP 후속, CUSTOM 직접 추가. The subline is the client-formatted time plus location.`

  Server `type` stays the existing set: `INTERVIEW`, `DEADLINE`, `FOLLOW_UP`, `CUSTOM`, `COFFEE_CHAT`. Do not add a badge field.
- Tests: no new behavior test. If an OpenAPI snapshot asserts this description, update that assertion only.
- Done when: `npm run contracts` succeeds, the sentence is on that operation, and `services/core-api/src/routes/calendar.ts` has no diff.

## BE-05 Suggested experiences
- Kind: logic
- Branch: `feat/design-data-apis` (shared).
- Depends on: BE-01
- Files:
  - `services/core-api/src/routes/me.ts`
  - spec file for `/api/v1/me/*`
  - `services/core-api/test/` next to gap-analysis or application tests
- Design: `빠른 시작 › 빠른 시작 · 경험 만들기`
- Logic design: Not covered. `gap_analyses.missing` and `gap_analyses.preferred_missing` are `jsonb` string arrays (`db/migrations/0001_init.sql`), not cards. No LLM. No call to `services/ai`. No new table. No migration. `42P01` on `gap_analyses` → `items: []`.

  `GET /api/v1/me/suggested-experiences`. Bearer required. No query params. 401 `UNAUTHENTICATED` without a bearer.

  Response:

  ```json
  { "data": { "items": [ {
    "id": "<analysisId>:preferred:<index>",
    "title": "<requirement clipped to 80 code points>",
    "sub": "우대 사항",
    "meta": "<company> · <job title>",
    "postingId": null,
    "applicationId": "<uuid>"
  } ] } }
  ```

  Build the list from the caller's `gap_analyses` only. Newest `created_at DESC, id DESC`. From each row, walk `preferred_missing` first, then `missing`. Skip blank and whitespace-only strings. Skip a trimmed string already emitted. Stop at 5.

  `id` uses the original array index before the blank skip: `<analysisId>:preferred:<index>` or `<analysisId>:missing:<index>`.

  `title` is the trimmed requirement, clipped to 80 Unicode code points with the existing clip helper. Do not split it into the artboard's two lines. The artboard pair "Kafka 운영 경험" / "컨슈머 지연…" is not the algorithm.

  `sub` is `우대 사항` for `preferred_missing` and `자격 요건` for `missing`.

  `meta` uses the application's job `company` and `title` (same columns `appDto` already reads). Both present → `{company} · {title}` with ` · ` (space, U+00B7, space). One side blank → that side only, no separator. Both blank → `""`.

  `postingId` is `jobs.source_posting_id` or `null`. `applicationId` is `gap_analyses.application_id` (column is `NOT NULL`).

  No rows, or every string blank → `{ "items": [] }`.
- Tests:
  - `preferred_missing comes before missing, newest analysis first, cap 5`.
  - `blank and duplicate strings are skipped` — id keeps the original index.
  - `title is clipped to 80 code points and is not split`.
  - `no analyses returns items empty`.
  - `missing gap_analyses table returns items empty` — throw `42P01`.
  - `guest is 401`.
- Done when: those tests pass, no AI client was added, and `services/ai` has no diff.

## BE-06 Hub-recommended people
- Kind: logic
- Branch: `feat/design-data-apis` (shared).
- Depends on: BE-01
- Files: `packages/contracts/spec/social.ts` description of `GET /api/v1/profiles`. No route file unless the null-category test below is missing and the SQL is wrong. The SQL is already correct. Do not change it.
- Design: `빠른 시작 › 빠른 시작 · 커피챗 제안 쓰기`
- Logic design: Covered. Do not add an endpoint.

  Sheet segment `허브 추천` = `GET /api/v1/profiles?explore=recommended`. Existing filter (`profiles.ts` `listProfiles`): public profile, not self, `job_category` equal to the caller's `profiles.job_category`. Caller `job_category` null → the comparison is unknown → empty list. Do not invent a fallback (no popular people, no other category).

  Sheet segment `팔로잉` = `GET /api/v1/me/follows`.

  Fields the sheet reads, already on the profile card: `userId`, `displayName`, `headline`, `avatarUrl`. Segment counts are client-side. Do not add a count field.

  Unsupported `explore` stays 422 `VALIDATION_ERROR` `details.field` `explore`.

  Add one description sentence: `빠른 시작 커피챗 허브 추천 is explore=recommended and is empty when the caller has no job_category. 팔로잉 is GET /api/v1/me/follows. The sheet reads userId, displayName, headline, and avatarUrl. Counts are client-side.`
- Tests: grep first. Add `recommended is empty when the caller has no job_category` only if that case is not already asserted. Do not duplicate a passing test. No route change in that test.
- Done when: the sentence is in the spec, `npm run contracts` succeeds, and `listProfiles` has no diff.

## BE-07 Career-post topics
- Kind: logic
- Branch: `feat/design-data-apis` (shared).
- Depends on: BE-01
- Files:
  - `services/core-api/src/routes/me.ts`
  - spec file for `/api/v1/me/*`
  - `services/core-api/test/` next to profile tests
- Design: `빠른 시작 › 빠른 시작 · 커리어 글 쓰기`
- Logic design: Not covered. No topic table. No LLM. No migration. A missing `profiles`, `applications`, or `gap_analyses` relation (`42P01`) skips that slot. It does not 500 the whole response.

  `GET /api/v1/me/career-topics`. Bearer required. No query. 401 without a bearer.

  Response, max 3, skip an empty slot, this order only:

  ```json
  { "data": { "items": [ { "id": "career", "title": "...", "sub": "...", "source": "career" } ] } }
  ```

  `id` and `source` are the same string: `career`, `application`, or `gap`.

  1. `career`. First object in `profiles.careers` (array order, do not sort) that has a non-blank `role` or `description`. `title` = `role` if non-blank, else the first 40 code points of `description`. `sub` = `{categoryLabel} · 이력서 경력에서`. Label from the table at the top. Null or unknown `job_category` → `커리어`. No profile row, empty careers, or no usable entry → skip.

  2. `application`. Newest application of the caller that is not `REJECTED` and not `WITHDRAWN`, by `updated_at DESC, id DESC`. `title` = `{title} 준비`. Blank title → skip. `sub` = `커리어 · 지원 현황에서` (fixed, not the category label).

  3. `gap`. Newest `gap_analyses` row of the caller whose `missing` jsonb array has a non-blank element 0. `title` = that string clipped to 80 code points. `sub` = `{categoryLabel} · 역량 보완에서` using the caller's current `job_category` (dev → `개발 · 역량 보완에서`). Null or unknown → `커리어 · 역량 보완에서`.

  Do not generate a body, a post, or a second line under the title.
- Tests:
  - `returns career, then application, then gap when all three exist`.
  - `skips a rejected application and a blank career`.
  - `dev gap sub is 개발 · 역량 보완에서`.
  - `null category uses 커리어`.
  - `no profile and no applications returns items empty`.
  - `guest is 401`.
- Done when: those tests pass and no AI call was added.

## BE-08 Match chips
- Kind: logic
- Branch: `feat/design-data-apis` (shared).
- Depends on: BE-01
- Files:
  - `services/core-api/src/routes/me.ts`
  - spec file for `/api/v1/me/*`
  - `services/core-api/test/` next to profile tests
- Design: `빠른 시작 › 빠른 시작 · 나에게 맞는 공고 찾기`
- Logic design: Not covered. Profile columns that exist: `job_category`, `tenure_years`, `skills`, `careers`, `headline`. There is no location column. Do not add one. Do not emit a location chip. The artboard word `서울` is not a chip. The artboard band `경력 4–6년` is not a band.

  No migration.

  `GET /api/v1/me/match-chips`. Bearer required. No query. 401 without a bearer.

  Response: `{ "data": { "chips": ["개발 · 백엔드", "경력 3–5년", "Kotlin"] } }`. Max 8 strings. The client draws them as-is.

  No profile row → `{ "chips": [] }` and 200.

  Order:

  1. Category and role. Role is `profiles.careers` array order, first object whose `role` is non-blank. Category label from the table at the top. Both → `{label} · {role}` (space, U+00B7, space). Do not emit `role` again. Category only, no role → the label alone. Role only, null category → skip this step (do not emit a bare role). Unknown category → skip this step.
  2. Tenure, one chip, from the stored `tenure_years` key. The `TENURE` map in `profiles.ts` is numeric filter ranges. Do not read chip text from it.

     | key | chip |
     | --- | --- |
     | 0-2 | 경력 0–2년 |
     | 3-5 | 경력 3–5년 |
     | 6-9 | 경력 6–9년 |
     | 10+ | 경력 10년+ |

     The dash in `0–2`, `3–5`, and `6–9` is U+2013. Null, blank, or any other key → omit. Do not add `4–6`.
  3. `profiles.skills` in stored order. Skip blanks. Skip a skill equal to a chip already emitted. Stop at 8 chips total.

  Do not add `headline`.
- Tests:
  - `category and role make the first chip, then tenure, then skills, cap 8`.
  - `does not emit a location chip`.
  - `null tenure omits the tenure chip`.
  - `unknown tenure key omits the tenure chip`.
  - `no profile returns chips empty`.
  - `guest is 401`.
- Done when: those tests pass and no migration file was added.

## BE-09 Search sort
- Kind: logic
- Branch: `feat/design-data-apis` (shared).
- Depends on: BE-01
- Files:
  - `services/core-api/src/routes/search.ts`
  - `services/core-api/src/routes/postings.ts` (`searchPostings` only)
  - `services/core-api/src/routes/posts.ts` (`searchPosts` only)
  - `services/core-api/src/routes/profiles.ts` (`searchPeople` / the search branch of `listProfiles` only)
  - `packages/contracts/spec/postings.ts` (the `GET /api/v1/search` operation)
  - existing search tests
- Design: `02-Home › 검색 · 결과` (control `관련도순 ⌄`). The artboard shows the control on the jobs tab. This task still accepts `sort` for `postings`, `people`, and `posts`. `03-채용공고 › 채용공고 · 전체 목록` (`최신순`) is `GET /api/v1/postings?sort=latest|deadline|popular`. Do not change that API.
- Logic design: `GET /api/v1/search` has no `sort` today. Default order stays.

  Today, omit `sort`: `searchPostings` and `searchPosts` order by `relevance()` then `created_at DESC`. `searchPeople` goes through `listProfiles`: relevance when `q` is set, then `updated_at DESC`. `relevance()` in `recruiting-shared.ts`: 0 exact, 1 prefix, 2 choseong, 3 hangul contains, else 4. Keep that function. Do not change its scores.

  Add optional query `sort` on `GET /api/v1/search` only.

  | sort | order |
  | --- | --- |
  | omitted | current SQL, unchanged |
  | relevance | same SQL as omitted |
  | latest, type=postings | `job_postings.created_at DESC`, posting id DESC. No relevance term. |
  | latest, type=posts | `posts.created_at DESC`, post id DESC. No relevance term. |
  | latest, type=people | `profiles.updated_at DESC`, user id DESC. No relevance term. |

  Any other value, including `popular`, `deadline`, and `""` when the param is present → 422 `unprocessable("sort", "unsupported sort")` (`VALIDATION_ERROR`, `details.field` `sort`).

  Unchanged errors: blank `q` → 400 `fieldError("q", "required")`. Unsupported `type` → 422 `unprocessable("type", "unsupported type")`. Guest (`GUEST_ID`) on `people` or `posts` → 401 `UNAUTHENTICATED` `missing bearer token`. Guest postings search stays allowed. `sort` does not change that.

  Do not change `GET /api/v1/postings` sort (`latest` | `deadline` | `popular`, default `latest`). Do not change the posts list sort (`latest` | `popular`). Do not change `GET /api/v1/search/counts` or `GET /api/v1/search/trending`.

  Cursors are sort-specific. Encode `sort` in the cursor payload. Omitted `sort` encodes as `relevance`, so a cursor minted before this change still works for the default. `sort=latest` with a missing cursor sort, or with `relevance`, → 400 `fieldError("cursor", ...)`. `sort=relevance` (or omitted) with a cursor marked `latest` → 400 `details.field` `cursor`. `latest` does not continue a relevance page. Document that in the OpenAPI description.
- Tests:
  - `omitted sort matches relevance order` — a worse text match with a newer `created_at` still ranks below an exact match.
  - `latest postings ignore relevance` — newer `created_at` first.
  - `latest posts order by created_at`.
  - `latest people order by updated_at`.
  - `sort=deadline is 422 field sort`.
  - `relevance cursor with sort=latest is 400 field cursor`.
  - `GET /api/v1/postings?sort=deadline still orders by deadline`.
  - guest people search stays 401.
- Done when: those tests pass, list-posting sort enums are unchanged, and both new `ORDER BY` strings ran inside a test.

## BE-10 Application fit parts
- Kind: logic
- Branch: `feat/design-data-apis` (shared).
- Depends on: BE-01
- Files:
  - `services/core-api/src/routes/applications.ts` (`appDto` and the get-one read only)
  - `packages/contracts/spec/career.ts` `Application`
  - reuse the parts object already described in `packages/contracts/spec/conversations.ts` and `packages/contracts/spec/account.ts`
  - `services/core-api/test/applications.test.ts`
- Design: `마이-내-활동 › 마이 · 내 활동 · 지원한 공고 상세`
- Logic design: Not covered. `GET /api/v1/applications/{id}` returns integer `fitScore` from `gap_analyses`, omitted when none. It does not return parts.

  Parts are stored. `posting_fit_cache` (`0022`, primary key includes `plan` since `0032`, `posting_revision` since `0033`): `user_id`, `posting_id`, `document_id`, `fit_score numeric(3,1)`, `parts jsonb`, `top_gap`, `plan`, `created_at`. There is no `reachable` column. Do not add one. No migration.

  Do not call the model. Do not insert a chat job. Leave `POST /api/v1/postings/{id}/fit` (`202`, `{ jobId }`, poll `GET /api/v1/ai/jobs/{id}`) alone.

  On the career application DTO only, add optional `fit`. Omit the key when there is no cache row. Do not add `fit` to the employer applicant DTO (`PostingsApplicantApplication`, `companyApplicationDto`). `stageEnteredAt` stays BE-01. Do not touch it.

  Pick the row:

  1. `applications.job_id = jobs.id`, `jobs.source_posting_id = posting_fit_cache.posting_id`, `posting_fit_cache.user_id` = caller, `documents.id = posting_fit_cache.document_id`, `documents.application_id = applications.id`. Latest `posting_fit_cache.created_at DESC`.
  2. If none, latest cache row for that caller and `jobs.source_posting_id`, any `document_id` and any `plan`.
  3. If `source_posting_id` is null, or no row, omit `fit`. Keep the existing integer `fitScore`.

  `42P01` on `posting_fit_cache` → omit `fit`, still return 200 and the application.

  ```json
  "fit": {
    "fitScore": 6.9,
    "parts": { "techStack": 7.0, "experienceLink": 6.0, "careerLevel": 8.0, "keyword": 5.5, "domain": 7.0 },
    "topGap": "기술 스택",
    "plan": "FREE",
    "reachable": 8.2,
    "documentId": "<uuid>",
    "documentTitle": "<documents.title or null>"
  }
  ```

  Match `cached_view` in `services/ai/src/app/domain/posting_fit.py`. Copy the arithmetic into TypeScript. Do not import Python.

  - `fit.fitScore` is the stored `fit_score` (one decimal). Do not recompute it from weights. Integer `Application.fitScore` stays the gap score beside it.
  - `parts` always has all five keys. Missing key counts as `0` for this object. Each value is `min(10, max(0, round(n, 1)))`.
  - `topGap` is stored `top_gap` (may be `""`). Do not replace it with a recomputed label.
  - `plan` is stored `plan`. Blank or null → `FREE`.
  - Weights, index order: `techStack` 35, `experienceLink` 30, `careerLevel` 15, `keyword` 10, `domain` 10. Weakest part is min by `(point, index)`. `reachable = min(10, max(0, round(storedFitScore + (10 - gapPoint) * gapWeight / 100, 1)))`.
  - `documentId` is the cache `document_id` (column is `NOT NULL`). `documentTitle` is `documents.title` for that id, or `null` if the document row is gone. A missing document is not a 500.

  The Korean line `조금만 고치면 8점대예요` is client copy. Do not generate it. The client maps bars: `techStack` 기술 스택, `experienceLink` 경험 연관성, `keyword` 키워드. Return `careerLevel` and `domain` too. The client chooses which bars to draw.
- Tests:
  - `returns fit from the document linked to the application` — stored decimal, all five parts, stored topGap, computed reachable.
  - `falls back to the latest user posting cache row when no document is linked`.
  - `omits fit when no cache row and keeps integer fitScore`.
  - `missing posting_fit_cache still returns the application` — throw `42P01`.
  - `employer applicant payload has no fit`.
  - `GET does not insert an ai job`.
- Done when: those tests pass, the get handler issues no insert into `chat_jobs` or `posting_fit_cache`, and the employer DTO is unchanged.

## BE-11 Push document share URL
- Kind: logic
- Branch: `feat/design-data-apis` (shared).
- Depends on: BE-01 (so the next migration number is `0037`; do not edit `0036`)
- Files:
  - `db/migrations/0037_document_shares.sql` (new)
  - `services/core-api/src/routes/documents.ts`
  - `services/core-api/src/handler.ts` (`isPublic` only)
  - `services/gateway/src/routes/owner.ts` (`isCore` only)
  - `packages/contracts/spec` document operations
  - `services/core-api/test/documents.test.ts`
  - `services/core-api/test/migration-0037.test.ts` (same style as `migration-0036.test.ts`: assert the file text, do not connect to Neon)
  - the gateway test that asserts `ownerOf` for document routes
- Design: `마이-서류 › 마이 · 서류 보기`. Share today sends the file name only.
- Logic design: Not covered without a table. `conversation_shares` and `POST /api/v1/conversations/{id}/share` plus `GET /api/v1/conversations/shared/{token}` are a different resource. Do not reuse them. Do not add a column on `documents`.

  Ship the migration in this PR. Do not run it. The owner applies `0037` later. Until then, `42P01` on `document_shares` makes `POST`, `DELETE`, and `GET` return 404 with `error.code` `SHARING_UNAVAILABLE` (message `sharing unavailable`, `details` null). The app hides the button on that code. When the table exists, do not return `SHARING_UNAVAILABLE`.

  `db/migrations/0037_document_shares.sql`:

  ```sql
  CREATE TABLE document_shares (
      id uuid PRIMARY KEY,
      document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version_id uuid NOT NULL REFERENCES document_versions(id),
      token_hash text NOT NULL UNIQUE,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
  );
  CREATE UNIQUE INDEX document_shares_one_active
      ON document_shares (document_id)
      WHERE revoked_at IS NULL;
  ```

  The app generates `id` with `crypto.randomUUID()`. Token: `randomToken()` from `http.ts`. Persist `sha256Hex(token)` only. Never store or log the raw token.

  One active share per document. Create revokes the current active row (`revoked_at = now`) and inserts the new hash in one statement. Two active rows for one document cannot exist.

  `POST /api/v1/documents/{id}/share`. Owner only. A non-owner gets the same 404 `NOT_FOUND` as the other document mutations (do not reveal the document). Body optional: `{ "versionId"?: "<uuid>" }`. Omitted `versionId` pins `documents.latest_version_id`. A draft version is allowed. Do not require `FINALIZED`. No version → 404 `NOT_FOUND`. `versionId` not on this document → 404 `NOT_FOUND`.

  Success 200:

  ```json
  { "data": {
    "token": "<raw, this response only>",
    "path": "/api/v1/documents/shared/<token>",
    "versionId": "<uuid>",
    "createdAt": "<RFC3339>"
  } }
  ```

  `DELETE /api/v1/documents/{id}/share`. Owner only. Same 404 for a non-owner. Sets `revoked_at` on the active row. Does not delete the row. 200 `{ "data": { "revoked": true } }`. No active row → 200 `{ "data": { "revoked": false } }`.

  `GET /api/v1/documents/shared/{token}`. No auth. Hash the token. Active row only (`revoked_at` is null). Unknown and revoked are the same 404 `NOT_FOUND`. Do not use a revoked-specific code.

  Success 200, and no other fields:

  ```json
  { "data": {
    "title": "<documents.title at read time>",
    "kind": "RESUME",
    "content": { "type": "doc", "content": [] },
    "blocks": []
  } }
  ```

  `kind` is the document's kind: `RESUME`, `PORTFOLIO`, `COVER_LETTER`, `CAREER_STATEMENT`, or `HUB_PROFILE`. `content` and `blocks` come from the pinned `document_versions` row. A later edit does not change the shared snapshot. `title` and `kind` are read from `documents` at GET time. Do not return `userId`, `applicationId`, `documentId`, email, or any other document.

  Gateway: `isCore` must return core for `POST` and `DELETE` `/api/v1/documents/{id}/share` and for `GET` `/api/v1/documents/shared/{token}`. Otherwise `ownerOf` is `deny` and the route 404s in the gateway. Do not send them to python.

  Core `isPublic`: `GET /api/v1/documents/shared/{token}` is public with an empty `Authorization`. Do not add it to `isGuestRead`. The handler ignores `ctx.user`. The existing IP rate limit on public routes stays. Do not add a new limiter.

  `POST` and `DELETE` stay authenticated.
- Tests:
  - `share returns the raw token once and a later GET returns the pinned version`.
  - `a second share revokes the first token` — first GET is 404 `NOT_FOUND`, second GET is 200.
  - `DELETE revokes and a second DELETE returns revoked false`.
  - `non-owner POST is 404`.
  - `public GET does not include userId or applicationId`.
  - `missing document_shares returns SHARING_UNAVAILABLE` — throw `42P01` on `POST`, `DELETE`, and `GET`. Status 404. `error.code` `SHARING_UNAVAILABLE`.
  - `migration 0037 file declares document_shares and the partial unique index`.
  - `ownerOf sends the share routes to core` — `GET /api/v1/documents/shared/tok` is `core`, not `deny` or `python`.
- Done when: those tests pass, `0037` is in the diff and was not applied to Neon, and the PR body says the owner applies `0037` later. Code runs before that apply via `SHARING_UNAVAILABLE`.

## BE-12 Mobile section write
- Kind: logic
- Branch: `feat/design-data-apis` (shared).
- Depends on: BE-01
- Files:
  - `packages/contracts/spec` operation `POST /api/v1/documents/{id}/versions`
  - `services/core-api/test/documents.test.ts`
  - no route file unless the example uncovers a validator bug. Do not add a field.
- Design: `마이-서류 › 마이 · Push 서류 보기` (decision 2026-10-29)
- Logic design: Covered. Do not add a route. Do not add a section-scoped body. Do not use `POST /api/v1/documents/{id}/edits` (chat hunks).

  `POST /api/v1/documents/{id}/versions` already calls `createVersion` → `saveVersion`.

  Request:

  ```json
  {
    "expectedRevision": 3,
    "content": { "type": "doc", "content": [] },
    "blocks": [ { "id": "block-1", "text": "...", "evidenceRefs": [], "claimStatus": "UNSUPPORTED" } ],
    "changeNote": "intro"
  }
  ```

  `expectedRevision` is the document `revision` from `GET /api/v1/documents/{id}` (integer, required). It is not the version `number`. `content` is a required object. `blocks` is optional. `changeNote` is an optional string.

  `validateDocumentContent` (`services/core-api/src/document-content.ts`): root `type` is `doc`. Allowed nodes: `doc`, `paragraph`, `heading`, `bulletList`, `orderedList`, `listItem`, `text`. Block nodes require `attrs.blockId`. `blocks[].text` equals the node text. Link marks need an `http` or `https` `href`. A failure stays the existing 400.

  Success 201, `versionDto`: `id`, `documentId`, `applicationId`, `number`, `content`, `blocks`, `changeNote`, `quality`, `createdAt`, inside `data`. Mismatched revision → 409 `REVISION_CONFLICT` `details.currentRevision`.

  One section is a full-document write:

  1. `GET /api/v1/documents/{id}` for `revision`, and `GET /api/v1/documents/{id}/versions` for the highest `number`.
  2. Replace the nodes under that one heading. Leave every other node in place.
  3. `POST` the full `content` and `blocks` with that `expectedRevision`.

  Headings `sectionName()` already recognizes (strip a trailing `:` or `：`, then trim, then lower case): `소개`|`intro`, `경력`|`careers`|`career`, `기술`|`기술 스택`|`skills`|`skill`, `링크`|`links`|`link`, `한 줄`|`헤드라인`|`headline`. Any other heading, including projects and education, is `skip`. Do not map those.

  Kinds stay `RESUME`, `PORTFOLIO`, `COVER_LETTER`, `CAREER_STATEMENT`, `HUB_PROFILE`. This POST already allows whatever `createVersion` allows. Do not narrow it.

  OpenAPI: add one literal example that changes the paragraph under heading `소개` and keeps the heading `경력` and its paragraph. Description says a one-section edit sends the whole document.
- Tests: `a version post that changes the intro keeps the career nodes`. Arrange a document whose content has heading `소개`, a paragraph, heading `경력`, a paragraph. POST content that changes only the intro paragraph, with the current `expectedRevision`. Assert 201, intro text is the new text, career text is unchanged, `revision` conflict on a second POST that reuses the old `expectedRevision` (409 `details.currentRevision`).
- Done when: that test passes and the versions route gained no new property.

## BE-13 Document to profile section picking
- Kind: logic
- Branch: `feat/design-data-apis` (shared).
- Depends on: BE-01. Independent of BE-12. Do not fold it into the version POST.
- Files:
  - `services/core-api/src/routes/documents.ts` (`copyOntoBaseProfile`, `convertProfile`, `setBaseProfile`, `REPLACE_PROFILE`)
  - spec operations `POST /api/v1/documents/{id}/profile` and `POST /api/v1/documents/{id}/base-profile`
  - `services/core-api/test/documents.test.ts`
- Design: `마이-서류 › 내 프로필로 전환`. Caption: `고른 항목만 허브 프로필에 반영돼요`.
- Logic design: Not covered. Today `POST /api/v1/documents/{id}/profile` body is `{ target?: "hub"|"application", applicationId?, expectedRevision? }`. Default `target` is `application`. `target=hub` calls `copyOntoBaseProfile`, which copies every parsed section whose heading exists. `POST /api/v1/documents/{id}/base-profile` has an empty body and copies the whole `HUB_PROFILE` document. There is no `sections` allow-list. No migration. Do not add a `profile_sections` table.

  Add optional `sections` to both routes. Values, exact: `headline`, `intro`, `careers`, `skills`, `links`. Duplicates are one entry. A non-array, a non-string entry, or any other name → 422 `unprocessable("sections", "unsupported section")`.

  On `POST /profile`, `sections` is valid only with `target: "hub"`. Present with omitted `target` or `target: "application"` → 422 `details.field` `sections`. The application-target behavior (link `applicationId`, require `expectedRevision`, do not write the hub profile) stays. Its response does not grow `applied`.

  `sections` absent on `target: "hub"` and on `base-profile`: today's write. Headline still comes from the parsed headline or the document title (`clip` 120) and the SQL still assigns it. Other keys still move only when that heading exists (`replaceIntro`, `replaceCareers`, `replaceSkills`, `replaceLinks`).

  `sections` present: replace only those keys. A requested key whose heading is absent does not clear the stored value. `sections: []` writes nothing, returns 200, and leaves the profile row unchanged.

  `headline` in the list: set it the way the function sets it today (parsed headline, else document title). `headline` not in the list: keep `profiles.headline`.

  Career lines stay `careerOf`: `company | role | startedOn | endedOn | description`. Dates `YYYY-MM-DD`. Do not change that parser. `HUB_PROFILE` is still required. Any other kind stays `fieldError("kind", "only a hub profile document can be converted")` on profile convert, and the existing base-profile kind error on base-profile.

  SQL: do not insert a placeholder in the middle of `REPLACE_PROFILE`. Tests assert the current replace-flag positions (`$10` links, `$12` careers, `$13` skills, `$14` intro). Append `replaceHeadline` as the next boolean, cast `$15::boolean` (or whichever index is last after the append). `headline = CASE WHEN $15::boolean THEN EXCLUDED.headline ELSE profiles.headline END`. Pass `true` when `sections` is absent, or when it includes `headline`. Pass `false` when `sections` is present and omits `headline`. One statement, so the old path and the new path share SQL.

  Response for hub convert and base-profile adds `applied: string[]`. Keep `documentId` and `profileUserId`. `applied` lists keys that were actually written, in this order: `headline`, `intro`, `careers`, `skills`, `links`. A requested key with no heading is absent from `applied`. When `sections` is absent, `applied` lists what today's flags wrote, and includes `headline` because headline is always written on that path. `sections: []` → `applied: []`.
- Tests:
  - `omitted sections on target hub still copies every present heading` — existing flag assertions stay true.
  - `sections skills replaces skills only` — intro, careers, links, and headline parameters stay false / SQL `ELSE profiles.*`.
  - `empty sections leaves the profile unchanged` — 200, `applied` `[]`.
  - `unknown section is 422 field sections`.
  - `sections without target hub is 422 field sections`.
  - `non hub profile kind still errors on kind`.
  - `base-profile sections intro does not overwrite headline`.
  - `empty base-profile body still sets headline from the title`.
- Done when: those tests pass, a client that sends `{ "target": "hub" }` with no `sections` still replaces every present heading, and no migration was added.

## Branch done when

After BE-02 through BE-13 are on `feat/design-data-apis`:

- `npm test -w push-be-core` passes.
- `npm run typecheck -w push-be-core` passes.
- `npm run contracts` has no diff outside the spec-driven generated files.
- The three openapi route tests pass.
- `services/ai` has no diff.
- PR base is `develop`. Title is `feat(api): data for the new design screens`. Body lists BE-02–BE-13, says `0037` is owner-applied later, and ends with the Claude Code line.
- Cursor does not merge.
