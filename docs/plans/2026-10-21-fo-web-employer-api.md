# fo-web employer API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-hooks:subagent-driven-development. The parent also runs a fresh reviewer against the docs after each task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email auth, guest job-board reads, companies, employer postings and applicants, consents, company billing plus personal IAP, and employer AI plan routing on `feat/fo-web-employer-api` without breaking fo-mobile or fo-desktop.

**Architecture:** Keep the existing core-api route style (handlers plus SQL). New policy that is not HTTP lives in small modules (`mail/`, `billing/credits.ts`, `billing/stores.ts`) and in the Python domain layer. Gateway keeps owning `GET /auth/me` and proxies new core paths. AI keeps owning chat execution and applies plan levers there.

**Tech Stack:** core-api and gateway TypeScript Workers (`node --test`, `tsc --noEmit`). ai Python FastAPI (`pytest`). Postgres migrations in `db/migrations`. Neon HTTP in tests is a fake `query`. No remote database, no live Stripe, App Store, Google, or NTS calls.

**Spec:** `/Volumes/Untitled/Documents/Github/push-workspace/.worktrees/fo-web-docs/docs/superpowers/specs/2026-10-21-fo-web-design.md`

**Docs that win when they disagree with the spec:**

- `.../docs/PRD.md` 7.11, 7.13–7.16
- `.../docs/feature-spec.md` 1, 3.4, 4, 9, 12.3, 12.4, 16, 17, 18
- `.../docs/api-spec.md` 2.2, 3.2, 3.15, 4.1, 4.5–4.9, 5, 6
- `.../docs/tech-stack.md` 3

**Frontend contract (wins over api-spec when they disagree):** `/Users/cyjoon/.paseo/worktrees/2ynrrxah/fo-web-employer/packages/api-client/src/endpoints.ts` and `types.ts`.

## Global Constraints

- Do not run migrations on any remote database. Do not call live Stripe, App Store, Google, or NTS. Do not deploy, push, or open a PR.
- Never commit secrets. New env vars go in `README.md` and `.env.example` with empty values.
- Existing fo-mobile and fo-desktop requests keep working. Add fields. Do not rename or remove response fields they already read.
- Arrow functions for new functions. Do not mass-convert existing `function` declarations. No comments.
- Tests mock `fetch` and `query`. Personal Stripe credit grants stay `PRO = 30_000_000` and `ULTRA = 100_000_000` micro credits.
- Commit each task. Conventional Commits, scope required, summary under 72 characters, trailer `Co-Authored-By: Grok 4.7 Fast <noreply@x.ai>`.
- TDD: write the failing test, run it, then implement.

## Decisions

1. **Pending email signup** lives in `email_signups`, not in `users`. The account row is inserted only by `POST /auth/email/verify`. `email_tokens.user_id` stays nullable so a VERIFY token can exist before the user. RESET tokens always have `user_id`.
2. **Passwords** are PBKDF2-SHA256 via `crypto.subtle`, 210000 iterations, 16-byte salt, stored as `pbkdf2$210000$<saltB64>$<hashB64>`.
3. **Email uniqueness** is `UNIQUE (lower(email)) WHERE email IS NOT NULL` on `users`, plus the same rule on pending `email_signups`. A second signup for an email that is only pending replaces that pending row and sends a new mail (202). A real user row returns 409 `EMAIL_TAKEN` with `details.accountType` of the existing account and `message` `이 이메일은 개인 계정으로 가입되어 있어요` or `이 이메일은 기업 계정으로 가입되어 있어요`.
4. **OAuth account linking.** `oauth_states.account_type` stores `PERSONAL` or `EMPLOYER` (default `PERSONAL`). GitHub plus `EMPLOYER` is 400 `VALIDATION_ERROR` before any insert. Callback still returns 302. It stores the provider profile on the exchange code. `POST /auth/exchange` creates or links the user. Same account type and a verified email links to the existing user. A different account type returns 409 `EMAIL_TAKEN` and creates nobody. An unverified provider email returns 400 `EMAIL_NOT_VERIFIED`. GitHub uses `GET https://api.github.com/user/emails` and accepts only the primary email with `verified: true`. Google uses `email_verified === true` on userinfo.
5. **Redirect URIs.** Keep `push://auth/callback` and `http://localhost:5173/auth/callback`. Also allow `http://localhost:<port>/auth/callback` and `http://127.0.0.1:<port>/auth/callback`. Extra origins come from `OAUTH_REDIRECT_ORIGINS` (comma-separated, no trailing path; the path must still be `/auth/callback`).
6. **Guest reads.** `GET /postings`, `GET /postings/locations`, `GET /postings/{id}`, and `GET /search` with missing `type` or `type=postings` are public. Bookmark and applied flags use the nil user `00000000-0000-0000-0000-000000000000`, so both are false. `type=people` or `type=posts` without a token is 401. Other methods on those paths stay authenticated.
7. **Backfill companies.** One company per distinct `job_postings.company_user_id`. That company's id is the old user id. `b_no` is null and `verified_at` is null until `POST /companies/verify`. The user becomes `ADMIN`. Then `company_id` is set and `company_user_id` is dropped. New verifies get a fresh company id. `b_no` is unique when not null.
8. **Posting revision and preferred.** `job_postings.revision bigint NOT NULL DEFAULT 1` and `preferred jsonb NOT NULL DEFAULT '[]'`. `PATCH /postings/{id}` requires `expectedRevision`. `POST /postings/{id}/close` requires `expectedRevision` and sets `closed_at`. Both bump revision. Company members of a verified company may create, update, and close. Unverified or non-members get 403 `FORBIDDEN`. Public list and detail hide `closed_at IS NOT NULL`. `GET /companies/me/postings` returns the company's rows, including closed ones.
9. **Employer stage jumps.** Applicant `can_patch_stage` stays sequential. `PATCH /postings/{id}/applicants/{applicationId}` may set `SCREENING`, `INTERVIEW`, `OFFER`, or `REJECTED` from any non-terminal stage, including skips. `ACCEPTED`, `REJECTED`, and `WITHDRAWN` return 409 `INVALID_TRANSITION`. The body is `{ stage }` only. Revision still increments. Notification type `APPLICATION_STAGE`, target `{ kind: "activity", id: <applicationId> }`, title `지원 상태가 바뀌었어요`. Skip the insert when `notify_application_stage` is false. Missing settings row means the default true.
10. **Snapshots.** On apply, copy each owned document's latest `document_versions.content` into `application_snapshots.content` as text (`JSON.stringify` when the value is an object). Detail returns `{ id, title, content }`. Applying still copies the posting into `jobs` and creates the application. Employers get 403. Repeat apply returns the existing application and does not insert another snapshot.
11. **fitScore.** Core `applicationDto` adds `fitScore: null` when no analysis is joined. AI application JSON adds `fitScore` from the latest `gap_analyses.fit_score` for that application, or omits it when there is none. Do not require the field.
12. **Social author.** `Post.author` gains `employer: boolean` and `companyName: string | null` from `users.is_employer` and the member's company name. `displayName` stays in the payload.
13. **Chat retention.** Stop enforcing the FREE/PRO/ULTRA cap. Accept `null` or 1–3650 for every plan. `GET` returns the stored value, or `null` when unset. Do not substitute 7 or 30. Keep the response field.
14. **Credits.** One displayed credit is 6000 micro credits, because personal PRO is already `30_000_000` for 5,000 displayed credits. Do not change personal PRO or ULTRA grant amounts. New grants: FREE `1_800_000`, employer BASIC `18_000_000`, PRO `90_000_000`, ULTRA `180_000_000`. `POST /billing/topup` `amount` is a positive integer of displayed credits. Granted micro credits are `amount * 6000`.
15. **Billing shape.** Personal `GET /billing` adds `audience: "PERSONAL"` and `source: "STRIPE" | "APP_STORE" | "GOOGLE_PLAY" | null`. `plan` stays `FREE | PRO | ULTRA`. Employer responses use the company ledger and `plan` `BASIC | PRO | ULTRA | null`, `audience: "EMPLOYER"`. Checkout `BASIC | PRO | ULTRA` is employer-only and admin-only (403 otherwise). Personal checkout stays `PRO | ULTRA` and 409 `ALREADY_SUBSCRIBED` when an IAP subscription is active. IAP verify 409 `ALREADY_SUBSCRIBED` when Stripe subscription status is `ACTIVE`.
16. **Store webhooks** are public and write the same ledger. Verification is a `StoreReceipts` port on `deps`. The default adapter may `fetch` Apple or Google only when its env key is set. Tests pass a fake port and never hit the network. Missing configuration on the real webhook is 503 `NOT_CONFIGURED`.
17. **Sole admin delete.** `DELETE /me` for an admin with other members returns 409 `ADMIN_TRANSFER_REQUIRED` and does not mark deletion. An admin who is the only member cancels the company Stripe subscription (failure is 502 and does not delete) and sets `companies.deletion_requested_at`. Login clears both the user and company marks.
18. **Seats.** Limit is members with role `MEMBER` plus unexpired unaccepted invites. Admin is excluded. Limits: no plan or BASIC `0`, PRO `2`, ULTRA `5`. Over the limit blocks new invites with 403 `SEAT_LIMIT` and does not remove anyone.
19. **Employer AI** uses `/conversations`. `audience: "EMPLOYER"` sets `conversations.company_id`. List `audience=EMPLOYER` returns that company's rows for any member. `postingId` and `applicationId` are columns. PDF is `POST /conversations/{id}/attachments` multipart field `file`, Ultra only, stored in `conversation_attachments`, deleted when the conversation is archived. Interview intent requires PRO or ULTRA (`403 PLAN_REQUIRED`, `details.requiredPlan = "PRO"`). PDF requires ULTRA (`requiredPlan = "ULTRA"`). No verified company is `403 BUSINESS_NOT_VERIFIED`. A verified company with `plan` null is treated as BASIC for AI features and as seat limit 0. Employer managed calls ignore the client model and set `web_search` for posting intent.
20. **Model ids** come from config, defaults: FREE `deepseek/deepseek-v4.1-flash`, personal PRO and employer BASIC `anthropic/claude-sonnet-5-5`, personal ULTRA and employer PRO `anthropic/claude-opus-5-5`, employer ULTRA `anthropic/claude-fable-5-1`. FREE OpenRouter body sets `provider.ignore` to `["DeepSeek"]` and `provider.order` from `OPENROUTER_DEEPSEEK_PROVIDERS` (default `Together,Fireworks,Novita`).
21. **Reference samples** store metadata, feature flags, and generalized templates only. Raw résumé text is not inserted. A bucket is `job_category + tenure band + score band`. Bands with fewer than 30 samples are not injected into the prompt. Opt-out deletes that user's rows. Account purge relies on `ON DELETE CASCADE`.
22. **Project cap** counts blueprints the user still has. FREE 5, PRO 20, ULTRA unlimited. The next create returns 403 `PLAN_REQUIRED`.
23. **Mail links** use `APP_WEB_ORIGIN` (default `http://localhost:5174`): `/auth/verify?token=`, `/auth/reset?token=`, `/invites/{token}`. Tokens are stored as SHA-256. Invite TTL is 7 days. Verify and reset TTL is 1 hour.
24. **Members list** is `{ data: CompanyMember[] }`, not a page. api-spec's bare array loses to the frontend client and to section 2.3.
25. **NTS.** `POST https://api.odcloud.kr/api/nts-businessman/v1/validate?serviceKey=` and `.../status?serviceKey=` with JSON bodies. `valid !== "01"` is `MISMATCH`. `b_stt_cd === "02"` is `SUSPENDED`. `b_stt_cd === "03"` is `CLOSED`. Anything else unsuccessful is `MISMATCH`. 422 `BUSINESS_NOT_VERIFIED` message includes `개업 직후라면 1–2일 뒤 다시 시도해 주세요`. Duplicate `b_no` is 409 `COMPANY_EXISTS`.
26. **NTS call shape.** `serviceKey` is `encodeURIComponent`'d. Validate runs first; `valid !== "01"` or a 2xx JSON body with no `data[0]` is `MISMATCH` and status is not called. Non-2xx and non-JSON are 502 `PROVIDER_ERROR`.
27. **Non-admin deletion.** `DELETE /me` for a member who is not an admin follows the personal path: no company Stripe cancel and no `companies.deletion_requested_at`. A sole admin skips the extra Stripe call when the company customer is null or equal to the user's customer.
28. **Invite mail.** Stored email is lowercased. Trailing slashes on `APP_WEB_ORIGIN` are stripped, then the link is `/invites/{token}`. Missing `deps.mailer` uses `createMailer(env)`. An already accepted invite is 409 even if it is also expired.
29. **Company tables missing.** Core and gateway user lookup retry without `company_members` when that relation or column is absent, and `companyId` / `companyRole` stay null. `DELETE /me` and login then follow the personal path. Company routes still need migration 0019.
30. **Unverified shell.** `POST /companies/verify` updates the caller's existing company when they are `ADMIN` and `verified_at` is null (the migration backfill). Any other membership is 409 `CONFLICT` before NTS. A seat insert is one statement that rechecks the count, so a lost race is 403 `SEAT_LIMIT` and sends no mail. An invite to a company with `deletion_requested_at` set is 409. Login clears that mark only when the caller is `ADMIN`.
31. **Posting conflicts and AI fitScore.** A stale posting patch compares `revision` in the handler and throws 409 before any `UPDATE`. Closing an already closed company posting is 409 `REVISION_CONFLICT` with `details.currentRevision`, even when `expectedRevision` matches. Another company's posting is 404. `GET /companies/me/postings` allows any member, including an unverified company. An applicant stage patch to the same stage returns the row and does not bump revision or insert a notification, including `REJECTED` to `REJECTED`, before the terminal check. AI `Application` omits `fitScore` when there is no score. `ApplicationStore` selects the latest `gap_analyses.fit_score` on read only. `can_patch_stage` stays sequential.
32. **Closed detail and pre-migration reads.** `GET /postings/{id}` returns a closed posting only to a member of that company. Guests and everyone else still get 404. RAG indexes a user's open company postings through `company_members`, not `company_id = user id`. Post reads retry without the company join when `company_members` is missing, and `companyName` is null. Settings reads and writes retry without `notify_application_stage` when that column is missing, and the response still sends `notifyApplicationStage: true`.
33. **Consents dispatch.** `routes/consents.ts` exports `dispatchConsents`. `handler.ts` calls it before the 404, not from `dispatchRecruiting`. `PUT /me/consents` is not an idempotent POST. Opt-out upserts `reference_data = false` before deleting `reference_samples`. There is no multi-statement transaction. A failed delete can be retried.
34. **Employer periodEndsAt.** Employer `GET /billing` returns `periodEndsAt: null`. `companies` has no period column. Do not add one.
35. **Employer source.** `source` is `"STRIPE"` only when `companies.plan` is set. A null plan returns `source: null` and `subscriptionStatus: "NONE"`.
36. **IAP top-up credits.** The verify body has no amount. Grant `IAP_TOPUP_CREDITS` displayed credits, default 300 (`1_800_000` micro). A top-up does not change `users.plan` and is allowed while Stripe `subscription_status` is `ACTIVE`.
37. **Monthly grant is separate.** `GET /billing` inserts one `PURCHASE` with `reference_id` `monthly:YYYY-MM`. Checkout keeps a separate `PURCHASE` whose `reference_id` is the Stripe session id. Do not merge them.
38. **Personal monthly amounts.** Personal PRO stays `30_000_000` and personal ULTRA stays `100_000_000`. Personal FREE monthly is `1_800_000`. Employer BASIC, PRO, and ULTRA are `18_000_000`, `90_000_000`, and `180_000_000`.
39. **Store webhook signatures and top-up quantity.** App Store and Google Play webhooks grant only after `crypto.subtle.verify` of a JWS. `APPLE_IAP_KEY` and `GOOGLE_PLAY_KEY` are imported as an SPKI public key (ES256 or RS256). A key that cannot be imported is 503 `NOT_CONFIGURED` and nothing is granted. A bad or missing signature is 400 `VALIDATION_ERROR` with message `invalid webhook signature`. Apple `signedTransactionInfo` is verified with the same key. Plain Google Pub/Sub JSON is rejected. Apple x5c and Google OIDC are not checked. This is stricter than api-spec 3.15, which describes Google Play RTDN as a Pub/Sub push: an unsigned push does not change a plan. `POST /billing/topup` sets Stripe `line_items[0][quantity]` to the displayed credit `amount`. `STRIPE_PRICE_TOPUP` is the price of one displayed credit. The webhook still grants `metadata.amountMicroCredits`.
40. **Docs 8c64ec3.** api-spec 4.1 create already accepts `requirements[]`, `preferred[]`, and `workConditions`, and detail returns them. `PATCH /postings/{id}` and `POST /postings/{id}/close` take `expectedRevision` and return 409 on a mismatch. `GET /companies/me/postings` includes closed rows. `GET /billing` employer `plan` is `BASIC|PRO|ULTRA|null`; personal stays `FREE|PRO|ULTRA|null`. Section 6 optional fields (`fitScore`, `author.employer`, `author.companyName`, `notifyApplicationStage`, `APPLICATION_STAGE` with `target.kind` `activity`) match the handlers already shipped. `GET /companies/me/members` stays `{ data: [...] }` (Decision 24); api-spec 4.6 still shows a bare array. Task 9 must also accept `POST /conversations/{id}/messages` and return a `posting-draft` fenced block.
41. **Null plan levers.** `levers_for("PERSONAL", None or "")` is FREE, including `monthly_micro` `1_800_000`. `levers_for("EMPLOYER", None or "")` uses BASIC model, effort, reference, tenure, and score band, and `monthly_micro` 0. A set employer plan uses that plan's monthly amount. Do not change the core billing grants. Project caps in this task read `users.plan` only. Core `POST /conversations/{id}/messages` uses the same personal allowances, so FREE and a null plan get `1_800_000`. It does not reject an `opencode-go/` model before the AI service replaces the managed model. PRO stays `30_000_000` and ULTRA stays `100_000_000`.
42. **PDF attachment cap.** api-spec 4.8, feature-spec 17.5, and PRD 7.15 set no byte cap for `POST /conversations/{id}/attachments`. Reject a file over 10 MiB (`10 * 1024 * 1024`) with 413 `PAYLOAD_TOO_LARGE`. A file of exactly 10 MiB is allowed. The mime type stays `application/pdf`.
43. **Shared employer chats.** A conversation with `company_id` set can be read, posted, patched, and archived by any member of that company. Personal rows stay on `user_id` with `company_id IS NULL`. Company message and active-job reads use `conversation_id` only. The new message still stores the caller's `user_id`. Interview intent returns HTTP 403 `PLAN_REQUIRED` with `details.requiredPlan` `PRO` before a `chat_jobs` insert when the company plan is not PRO or ULTRA, including null and BASIC. Membership authorizes that check. A missing `postingId` or `applicationId` on employer create is 404. An existing posting from another company is allowed. When the client omits `ai` on a company conversation, reply preparation still applies employer levers, turns on web search for posting intent, and appends the posting-draft fence.
44. **Templates stay out of prompts.** `eligible` groups by `job_category` + `tenure_years` + `score_band`. Thirty samples qualify. Twenty-nine do not. `prompt_lines` states that score band and the feature counts only. It never includes a raw line or `sentence_templates`, so employer AI cannot quote another user's sentence.
45. **Reference sample save.** The hook runs after the `gap_analyses` insert, inside the same `db.run`. It reads `user_consents.reference_data`, `profiles.job_category`, `profiles.tenure_years`, and `users.plan`. Missing consent, false, null category, or null tenure inserts nothing. Null or blank plan stores `FREE`. A plan outside `FREE|PRO|ULTRA` skips. No posting requirements skips the document, because `fit_score` is NOT NULL. `fit_score` is the requirements that document alone matches, times 100, integer-divided by the requirement count. A missing `user_consents` or `reference_samples` relation, or a failed sample write, rolls back to a savepoint and does not fail the gap analysis. Do not store the model name or raw `source_text`. Do not seed samples and do not re-consent existing users.
46. **Template markers.** An email is any non-space span that contains `@`, including a Hangul local-part, a Hangul domain, and a one-letter TLD. A company span may include `Co.,` before `Ltd`, `Inc`, `Corp`, or `Company`, and the suffix `Corporation`. A name with no marker, such as `카카오에서` or an unquoted person name, stays in the template. A trailing `(주)` or `㈜` can leave the name in front of `{대상}`. `eligible` matches exact `tenure_years`, not the plan window in feature-spec 9. `prompt_lines` is not injected into a chat prompt. `part_scores` stays `{}`. The same document can be inserted again on a later analysis. Samples stay until consent opt-out, or until the 30-day purge deletes the user and the foreign key cascades.
47. **Posting drafts and counts.** `job_postings.status` is `DRAFT|OPEN|CLOSED` in migration 0020. Public list, search, bookmarks, locations, and `GET /postings/facets` require `status = 'OPEN' AND closed_at IS NULL`. On undefined column 42703 those reads, plus `GET /companies/me/postings` and member closed detail, retry without `status` and derive `CLOSED` when `closed_at` is set, otherwise `OPEN`. A `?status=DRAFT` company filter returns an empty page before that column exists. Create defaults to `OPEN`. `CLOSED` on create or PATCH is 400. PATCH `status: OPEN` on a row that already has `closed_at` is 400 and does not clear `closed_at`. Close sets `CLOSED` and `closed_at`. Member list, member detail, create, PATCH, and close include `applicantCount`. Create is 0. PATCH and close return the application count in `RETURNING`. Public cards and non-member detail omit it. `GET /postings/{id}/applicant-counts` is reachable without a bearer token and returns 404 unless the caller is a member. The body is `{ data: { total, applied, screening, interview, offer, rejected } }`. `total` is the sum of those five. Other stages are excluded. Facets are `{ data: { career, category, location } }`. Career ids are always `0`, `1-3`, `4-6`, `7-9`, `10+`. Every job category is always present. Locations are stored strings with count > 0, count descending then location ascending. Each facet ignores its own filter and still applies `q`, skills, and employment type. Counts use open postings only.
48. **Company profile and invite preview.** `PATCH /companies/me` is admin only. It accepts `logoKey`, `industry`, `website`, `intro`, and `representativeName`. `bNo` and `name` stay locked and return 400. `logoUrl` is `/api/v1/uploads/images/` plus the encoded key. `GET /companies/me` includes those fields when the columns exist and omits them on 42703. `GET /companies/me/invites` is admin only and returns pending unexpired invites as `{ data: [{ id, email, expiresAt }] }` with no token. A second `POST /companies/me/invites` for the same pending email mails a new token before replacing the hash and does not take another seat. New inserts store `inviter_user_id`. `GET /companies/invites/{token}` is public, does not accept, and returns `{ data: { companyName, inviterName, inviterRole, email, expiresAt } }`. A null inviter uses the earliest company admin. Unknown, accepted, expired, or a company pending deletion is 404.
49. **Monthly spend on billing status.** `GET /billing` adds `spentMicroCredits` and `monthlyMicroCredits`. Spend is the sum of `ai_usage.cost_micro_credits` with status `SETTLED` in the UTC calendar month of the request. Employer spend is the company members. Personal spend is the caller. `RESERVED` is ignored. The company ledger is not spend. A missing `ai_usage` relation yields 0. `monthlyMicroCredits` is `grantMicro`: employer BASIC/PRO/ULTRA are 18000000/90000000/180000000 and a null employer plan is 0. Personal FREE/PRO/ULTRA stay 1800000/30000000/100000000, and a null personal plan uses FREE. Live Stripe invoices are not fetched. `GET /billing/ledger` remains the payment history.
50. **Reference windows and part scores.** This supersedes the Decision 46 sentences that say `eligible` ignores the plan window, `prompt_lines` is unwired, and `part_scores` stays `{}`. `eligible` still keeps only exact `(job_category, tenure_years, score_band)` cells of at least 30. Prompt injection uses `prompt_samples`: filter to the subject category, the plan tenure window, and the plan score window, then `eligible`. Cells under 30 are not merged. Tenure `same|plus1|plus2|all` is the exact year, ±1, ±2, or any year. Score `same|up1|top|all` is the subject band, that band and the next 10, that band through 100, or any band. A missing category, tenure, or score anchor injects nothing unless the score window is `all`. Lines are appended for a personal resume and for employer `review` and `interview` only. `posting` and `general` do not get them. The sample query selects `job_category, tenure_years, score_band, features` and does not select `sentence_templates`. A failed read injects nothing and does not fail the chat. `part_scores` stores integer percents `techStack` (기술 스택), `experienceLink` (경험 연관성), and `keyword` (키워드). `techStack` is the share of `job.keywords` found in evidence skills or source text, and 0 when there are no keywords. `experienceLink` is the link-marker count times 100 divided by the matched-requirement count, capped at 100, and 0 when nothing matched. `keyword` is the share of significant requirement words found in the evidence, and 0 when there are none. The gap-analysis create payload includes `partScores`. A later GET is `{}` because `gap_analyses` has no such column. No migration was added.
51. **Resend mail.** Production mail uses `POST https://api.resend.com/emails` when `RESEND_API_KEY` is non-whitespace. Otherwise the Cloudflare `EMAIL` binding is used when it is present. Otherwise the process logs the message and does not send. The binding is not required, and `services/core-api/wrangler.jsonc` does not declare `send_email`, because this account has no Cloudflare zone. The body is `{ from, to, subject, html, text }` with `Authorization: Bearer` the key and an `Idempotency-Key` of the email or invite token. A non-2xx response is logged by status and thrown. The key is not logged. Production `MAIL_FROM` is `Push <no-reply@push.mail.devcyjoon.tech>`. The AI host example is `https://push.devcyjoon.tech`.

## File map

```
db/migrations/0019_fo_web_employer.sql
services/ai/scripts/seed_local.py
services/core-api/src/mail/mailer.ts
services/core-api/src/mail/password.ts
services/core-api/src/billing/credits.ts
services/core-api/src/billing/stores.ts
services/core-api/src/routes/email-auth.ts
services/core-api/src/routes/companies.ts
services/core-api/src/routes/auth.ts
services/core-api/src/routes/billing.ts
services/core-api/src/routes/recruiting.ts
services/core-api/src/routes/conversations.ts
services/core-api/src/handler.ts
services/core-api/src/types.ts
services/gateway/src/models.ts
services/gateway/src/routes/owner.ts
services/gateway/src/routes/auth.ts
services/gateway/src/middleware/auth.ts
services/gateway/src/middleware/ratelimit.ts
services/ai/src/app/config.py
services/ai/src/app/domain/plan_levers.py
services/ai/src/app/domain/reference_text.py
services/ai/src/app/domain/services/ai.py
services/ai/src/app/domain/services/conversation.py
services/ai/src/app/domain/services/project.py
services/ai/src/app/infrastructure/openai_client.py
README.md
.env.example
infra/vps/env.example
```

---

### Task 1: Migration

**Files:**

- Create: `db/migrations/0019_fo_web_employer.sql`
- Modify: `services/ai/scripts/seed_local.py`
- Test: `services/core-api/test/migration-0019.test.ts`

**Interfaces:**

- Produces tables and columns later tasks select by these exact names: `companies(id, b_no, name, verified_at, plan, stripe_customer_id, deletion_requested_at, created_at)`, `company_members(company_id, user_id, role, created_at)`, `company_invites(id, company_id, email, token_hash, expires_at, accepted_at)`, `email_signups(id, email, password_hash, is_employer, display_name, consent_reference, created_at)`, `email_tokens(id, user_id, signup_id, kind, token_hash, expires_at, used_at)`, `application_snapshots(id, application_id, document_id, title, content, created_at)`, `reference_samples(id, source_user_id, job_category, tenure_years, fit_score, score_band, part_scores, plan, features, sentence_templates, created_at)`, `user_consents(user_id, reference_data, updated_at)`, `iap_subscriptions(id, user_id, platform, original_transaction_id, product_id, expires_at, status)`, `conversation_attachments(id, conversation_id, company_id, file_name, mime_type, content, created_at)`.
- `users.password_hash`, `users.email_verified_at`. `oauth_states.account_type`. `job_postings.company_id`, `job_postings.revision`, `job_postings.preferred`. `billing_ledger.company_id`. `conversations.company_id`, `conversations.posting_id`. `user_settings.notify_application_stage`. Notification check includes `APPLICATION_STAGE`.

- [ ] **Step 1: Write the failing test** that reads `db/migrations/0019_fo_web_employer.sql` and asserts it contains each table name, `DROP COLUMN company_user_id`, `notify_application_stage`, `APPLICATION_STAGE`, and `company_id`.

- [ ] **Step 2: Run** `node --experimental-strip-types --test test/migration-0019.test.ts` from `services/core-api`. Expected: FAIL because the file is missing.

- [ ] **Step 3: Write the migration** with the SQL below. Update `seed_local.py` so the posting insert uses `company_id` and the script inserts the backfill-shaped company and admin member for `EMPLOYER_ID` before the posting. Do not run the migration against a database.

```sql
ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL;

ALTER TABLE oauth_states ADD COLUMN account_type text NOT NULL DEFAULT 'PERSONAL';
ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_account_type_chk CHECK (account_type IN ('PERSONAL', 'EMPLOYER'));

CREATE TABLE companies (
    id uuid PRIMARY KEY,
    b_no text,
    name text NOT NULL,
    verified_at timestamptz,
    plan text,
    stripe_customer_id text,
    deletion_requested_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT companies_plan_chk CHECK (plan IS NULL OR plan IN ('BASIC', 'PRO', 'ULTRA'))
);
CREATE UNIQUE INDEX companies_b_no_idx ON companies (b_no) WHERE b_no IS NOT NULL;

CREATE TABLE company_members (
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, user_id),
    CONSTRAINT company_members_role_chk CHECK (role IN ('ADMIN', 'MEMBER'))
);

INSERT INTO companies (id, name, created_at)
SELECT DISTINCT p.company_user_id, COALESCE(NULLIF(u.display_name, ''), '회사'), now()
FROM job_postings p JOIN users u ON u.id = p.company_user_id;

INSERT INTO company_members (company_id, user_id, role, created_at)
SELECT c.id, c.id, 'ADMIN', now() FROM companies c
WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = c.id);

ALTER TABLE job_postings ADD COLUMN company_id uuid;
ALTER TABLE job_postings ADD COLUMN revision bigint NOT NULL DEFAULT 1;
ALTER TABLE job_postings ADD COLUMN preferred jsonb NOT NULL DEFAULT '[]';
UPDATE job_postings SET company_id = company_user_id;
ALTER TABLE job_postings ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE job_postings ADD CONSTRAINT job_postings_company_fk FOREIGN KEY (company_id) REFERENCES companies(id);
ALTER TABLE job_postings DROP COLUMN company_user_id;
CREATE INDEX idx_postings_company ON job_postings (company_id, created_at DESC, id DESC);

CREATE TABLE company_invites (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz
);

CREATE TABLE email_signups (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    is_employer boolean NOT NULL,
    display_name text NOT NULL,
    consent_reference boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_tokens (
    id uuid PRIMARY KEY,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    signup_id uuid REFERENCES email_signups(id) ON DELETE CASCADE,
    kind text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    CONSTRAINT email_tokens_kind_chk CHECK (kind IN ('VERIFY', 'RESET')),
    CONSTRAINT email_tokens_owner_chk CHECK ((user_id IS NULL) <> (signup_id IS NULL))
);

CREATE TABLE application_snapshots (
    id uuid PRIMARY KEY,
    application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    document_id uuid,
    title text NOT NULL,
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_application_snapshots ON application_snapshots (application_id, created_at DESC, id DESC);

CREATE TABLE reference_samples (
    id uuid PRIMARY KEY,
    source_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_category text NOT NULL,
    tenure_years int NOT NULL,
    fit_score int NOT NULL,
    score_band int NOT NULL,
    part_scores jsonb NOT NULL DEFAULT '{}',
    plan text NOT NULL,
    features jsonb NOT NULL DEFAULT '{}',
    sentence_templates jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reference_samples_plan_chk CHECK (plan IN ('FREE', 'PRO', 'ULTRA'))
);
CREATE INDEX idx_reference_samples_bucket ON reference_samples (job_category, tenure_years, score_band);

CREATE TABLE user_consents (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reference_data boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE iap_subscriptions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform text NOT NULL,
    original_transaction_id text NOT NULL UNIQUE,
    product_id text NOT NULL,
    expires_at timestamptz,
    status text NOT NULL,
    CONSTRAINT iap_subscriptions_platform_chk CHECK (platform IN ('APP_STORE', 'GOOGLE_PLAY'))
);

ALTER TABLE billing_ledger ADD COLUMN company_id uuid REFERENCES companies(id);
-- Purged personal rows already have user_id NULL (migration 0018). Reject only rows that name both owners.
ALTER TABLE billing_ledger ADD CONSTRAINT billing_ledger_owner_chk CHECK (NOT (user_id IS NOT NULL AND company_id IS NOT NULL));
CREATE UNIQUE INDEX idx_billing_ledger_company_ref ON billing_ledger (company_id, type, reference_id) WHERE company_id IS NOT NULL;
CREATE INDEX idx_billing_ledger_company ON billing_ledger (company_id, created_at DESC, id DESC) WHERE company_id IS NOT NULL;

ALTER TABLE conversations ADD COLUMN company_id uuid REFERENCES companies(id);
ALTER TABLE conversations ADD COLUMN posting_id uuid REFERENCES job_postings(id);
CREATE INDEX idx_conversations_company ON conversations (company_id, created_at DESC, id DESC) WHERE company_id IS NOT NULL;

CREATE TABLE conversation_attachments (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    content bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_settings ADD COLUMN notify_application_stage boolean NOT NULL DEFAULT true;

ALTER TABLE notifications DROP CONSTRAINT notifications_type_chk;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_chk CHECK (type IN ('DEADLINE', 'OFFER', 'COMMENT', 'AI_DONE', 'APPLICATION_STAGE'));
```

The `billing_ledger.user_id` column is already nullable from migration 0018. If a local database still has it NOT NULL, this migration's check still allows user-owned rows.

- [ ] **Step 4: Run the migration test.** Expected: PASS. Do not apply SQL to a database.

- [ ] **Step 5: Commit** `feat(db): add fo-web employer schema`

---

### Task 2: Email auth, OAuth rules, and mailer

**Files:**

- Create: `services/core-api/src/mail/mailer.ts`, `services/core-api/src/mail/password.ts`, `services/core-api/src/routes/email-auth.ts`
- Modify: `services/core-api/src/types.ts`, `services/core-api/src/routes/auth.ts`, `services/core-api/src/handler.ts`, `services/core-api/wrangler.jsonc`
- Modify: `services/gateway/src/routes/owner.ts`, `services/gateway/src/routes/auth.ts`, `services/gateway/src/middleware/auth.ts`, `services/gateway/src/middleware/ratelimit.ts`, gateway user cache type
- Modify: `README.md`, `.env.example`, `infra/vps/env.example`
- Test: `services/core-api/test/email-auth.test.ts`, extend `services/gateway/test/handler.test.ts` if it asserts `/auth/me`

**Interfaces:**

```ts
export type Mail = { to: string; subject: string; text: string; html: string };
export interface Mailer { send(mail: Mail): Promise<void> }
export const createMailer = (env: { EMAIL?: { send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<unknown> }; APP_ENV?: string; MAIL_FROM?: string }): Mailer => {}
export const hashPassword = (password: string): Promise<string> => {}
export const verifyPassword = (password: string, stored: string): Promise<boolean> => {}
```

- `Deps.mailer?: Mailer`. When omitted, use `createMailer(env)`.
- `CoreEnv` gains `MAIL_FROM`, `APP_WEB_ORIGIN`, `OAUTH_REDIRECT_ORIGINS`, `NTS_SERVICE_KEY` (NTS is used in task 4; declare it here so the type exists).
- Wrangler `send_email`: `[{ "name": "EMAIL" }]`.
- Session user and `GET /auth/me` (gateway and core) add `accountType`, `companyId`, `companyRole`. Personal users with no membership send `companyId: null`, `companyRole: null`.
- Gateway `AUTH_SQL` and the dev-user select join `company_members` and `users.is_employer`. Cache those three fields. TTL stays 5 seconds.
- Public core paths: `POST /auth/email/signup|verify|login|password-reset|password-reset/confirm`. Gateway `isCore` matches those POSTs.
- Signup 202 `{ data: { accepted: true } }`. Verify returns Session. Login returns Session. Reset request 202 `{ data: { accepted: true } }` even when the email is unknown (no mail). Confirm 204 and revokes every refresh token.
- Password shorter than 8 or longer than 128 is 400 `VALIDATION_ERROR` field `password`.
- Login before verify is 403 `EMAIL_NOT_VERIFIED`. Wrong password is 401 `INVALID_CREDENTIALS`.
- OAuth start reads `accountType`. Missing means `PERSONAL`.

- [ ] **Step 1: Failing tests** for signup 202 and mailer called, verify creates the user and session, duplicate email 409, login before verify 403, login success, reset does not reveal existence, confirm changes password and revokes refresh tokens, GitHub `accountType=EMPLOYER` is 400, Google unverified email fails at exchange with 400 `EMAIL_NOT_VERIFIED`, `GET /auth/me` includes `accountType`.

- [ ] **Step 2: Run** the new test file. Expected: FAIL.

- [ ] **Step 3: Implement.** Logger mailer writes one line when `EMAIL` is missing. Cloudflare mailer calls `env.EMAIL.send`. `MAIL_FROM` defaults to `noreply@push.local` only in the logger path. Document `MAIL_FROM`, `APP_WEB_ORIGIN`, `OAUTH_REDIRECT_ORIGINS`.

- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit` in `services/core-api` and `services/gateway`. Existing auth tests must stay green. Update mocks that select a fixed user column list if the new select lists `is_employer` and they return a generic row.

- [ ] **Step 5: Commit** `feat(auth): add verified email accounts`

---

### Task 3: Guest postings and search

**Files:**

- Modify: `services/core-api/src/handler.ts`, `services/core-api/src/routes/recruiting.ts`
- Test: `services/core-api/test/guest-postings.test.ts`

**Interfaces:**

- `isPublic` returns true for `GET /api/v1/postings`, `GET /api/v1/postings/locations`, `GET /api/v1/postings/{uuid}`, and `GET /api/v1/search`.
- Guest `Ctx.user.id` is `00000000-0000-0000-0000-000000000000`.
- `GET /search` without a real user rejects `type=people` and `type=posts` with 401.

- [ ] **Step 1: Failing tests.** No Authorization header: list returns 200 and the SQL binds the nil uuid; detail 200; locations 200; search `type=postings` 200; search `type=people` 401; `POST /postings` without a token 401.

- [ ] **Step 2: Run** the test. Expected: FAIL with 401 on the guest list.

- [ ] **Step 3: Implement** only the public gate and the people/posts rejection. Do not change filter SQL.

- [ ] **Step 4: Run** core `npm test` and `npx tsc --noEmit`.

- [ ] **Step 5: Commit** `feat(postings): allow guest board reads`

---

### Task 4: Companies and NTS

**Files:**

- Create: `services/core-api/src/routes/companies.ts`
- Modify: `services/core-api/src/handler.ts`, `services/core-api/src/routes/auth.ts` (`deleteAccount`), `services/gateway/src/routes/owner.ts`
- Test: `services/core-api/test/companies.test.ts`

**Interfaces:**

```ts
export const dispatchCompanies = (ctx: Ctx, path: string): Promise<Response | null> => {}
```

Routes:

- `POST /companies/verify` → 201 `Company`. Caller becomes ADMIN. Non-employer 403. NTS via `ctx.deps.fetch`.
- `GET /companies/me` → `Company` including `seats: { used, limit }`.
- `GET /companies/me/members` → `{ data: [{ userId, email, role, joinedAt }] }`.
- `POST /companies/me/invites` admin, 201 `{ data: { email } }`, sends mail. 403 `SEAT_LIMIT` or 403 when not admin.
- `POST /companies/invites/{token}/accept` employer, 204. Other company 409 `CONFLICT`. Unknown token 404.
- `DELETE /companies/me/members/{userId}` admin, 204. Cannot remove the only admin.
- `PATCH /companies/me/members/{userId}` body `{ role: "ADMIN" }` transfers admin. The previous admin becomes `MEMBER`. 204.
- Gateway `isCore` is true for `/api/v1/companies` and `/api/v1/companies/*`.
- `DELETE /me` follows Decision 17. Cancel company Stripe with the same `cancelSubscriptions` path, using the company `stripe_customer_id` when the user is the sole member.

- [x] **Step 1: Failing tests** with a fake `fetch` that returns `valid: "01"` and `b_stt_cd: "01"`, then mismatch, suspended, closed, and duplicate `b_no`. Invite over the BASIC limit is 403. Transfer and sole-admin delete are covered.

- [x] **Step 2: Run** the test. Expected: FAIL 404.

- [x] **Step 3: Implement.** Read `NTS_SERVICE_KEY` from env. Missing key is 503 `NOT_CONFIGURED`.

- [x] **Step 4: Run** core tests and `tsc --noEmit`. Gateway `tsc` if `owner.ts` changed.

- [x] **Step 5: Commit** `feat(companies): verify businesses and manage seats`

---

### Task 5: Postings, snapshots, applicants, notifications

**Files:**

- Modify: `services/core-api/src/routes/recruiting.ts`, `services/ai/src/app/domain/services/application.py` and its schema if the JSON is built there
- Test: `services/core-api/test/applicants.test.ts`, `services/ai/tests/test_application.py` only if the AI DTO changes

**Interfaces:**

- `createPosting` requires a verified company membership. `company` defaults to `companies.name`. Insert uses `company_id`. Response includes `revision`, `preferred`, `closedAt`.
- `PATCH /postings/{id}` and `POST /postings/{id}/close`.
- `GET /companies/me/postings` page of posting DTOs.
- Apply inserts snapshots. Applicant list and detail. Stage patch sends `APPLICATION_STAGE` when the switch is on.
- Settings GET/PATCH include `notifyApplicationStage`. Retention gate removed (Decision 13).
- `postDto.author.employer` and `companyName`.
- `applicationDto.fitScore`.

- [x] **Step 1: Failing tests** for unverified create 403, verified create, patch conflict 409 `REVISION_CONFLICT` with `details.currentRevision`, close, apply snapshot insert, employer apply 403, stage patch notification SQL, terminal stage 409, settings patch of `notifyApplicationStage`, and a FREE user setting `chatRetentionDays: null` getting 200.

- [x] **Step 2: Run** the test. Expected: FAIL.

- [x] **Step 3: Implement** inside the existing recruiting module. Update every `company_user_id` reference, including `services/ai/src/app/infrastructure/store_rag.py`.

- [x] **Step 4: Run** core tests and `tsc`. Run `pytest tests/test_application.py tests/test_recruiting_local.py` in `services/ai` if those files import posting columns.

- [x] **Step 5: Commit** `feat(postings): add company ownership and applicant stages`

---

### Task 6: Consents

**Files:**

- Modify: `services/core-api/src/routes/recruiting.ts` or a tiny `routes/consents.ts` called from `dispatchRecruiting`
- Test: `services/core-api/test/consents.test.ts`

**Interfaces:**

- `GET /me/consents` → `{ referenceData, updatedAt }`. Missing row is `{ referenceData: false, updatedAt: null }`.
- `PUT /me/consents` body `{ referenceData: boolean }` → the same object. `false` runs `DELETE FROM reference_samples WHERE source_user_id = $1`.
- Email verify with `consent_reference` inserts the consent row.

- [x] **Step 1–4: TDD, then** core tests and `tsc`.

- [x] **Step 5: Commit** `feat(consents): store reference-data choice`

---

### Task 7: Billing, top-up, and IAP

**Files:**

- Create: `services/core-api/src/billing/credits.ts`, `services/core-api/src/billing/stores.ts`
- Modify: `services/core-api/src/routes/billing.ts`, `services/core-api/src/handler.ts`, `services/core-api/src/types.ts`, `services/gateway/src/routes/owner.ts`
- Modify: `README.md`, `.env.example`, `infra/vps/env.example`
- Test: `services/core-api/test/billing-employer.test.ts`

**Interfaces:**

```ts
export const DISPLAY_MICRO = 6000;
export const grantMicro = (audience: "PERSONAL" | "EMPLOYER", plan: string): number => {};
export interface StoreReceipts {
  verifyApple(signedTransaction: string): Promise<{ productId: string; originalTransactionId: string; expiresAt: string | null; consumable: boolean }>;
  verifyGoogle(purchaseToken: string, productId: string): Promise<{ productId: string; originalTransactionId: string; expiresAt: string | null; consumable: boolean }>;
  decodeAppleNotification(body: string): Promise<{ notificationType: string; originalTransactionId: string; productId: string; expiresAt: string | null }>;
  decodeGoogleNotification(body: unknown): Promise<{ notificationType: string; purchaseToken: string; productId: string; expiresAt: string | null }>;
}
```

- `Deps.stores?: StoreReceipts`.
- Personal status unchanged except `audience` and `source`.
- Employer status reads `companies.plan` and the company ledger.
- Checkout maps employer prices from `STRIPE_PRICE_EMPLOYER_BASIC|PRO|ULTRA` and metadata `audience=EMPLOYER`, `plan`. Personal prices stay `STRIPE_PRICE_PRO|ULTRA`.
- Top-up uses `STRIPE_PRICE_TOPUP` and metadata `amountMicroCredits`.
- `POST /billing/iap/verify` and the two webhooks are core routes. Webhooks are public. Product id map: env `IAP_PRODUCT_PRO`, `IAP_PRODUCT_ULTRA`, `IAP_PRODUCT_TOPUP`. Unknown product is 400.
- Active subscription check uses `users.subscription_status` and `iap_subscriptions.status = 'ACTIVE'`.
- Webhook writes are idempotent on the store's transaction id through the ledger unique key.
- `GET /billing` lazily grants the current month's plan credits once. The ledger `reference_id` is `monthly:YYYY-MM` and the unique index stops a second grant. Personal FREE uses `1_800_000`. Employer uses the company plan amount. A null employer plan grants nothing.
- Document every new env var.

- [x] **Step 1: Failing tests** using fake `fetch` for Stripe and a fake `StoreReceipts`. Cover employer admin checkout, member checkout 403, personal checkout of `BASIC` 400, IAP while Stripe is active 409, Apple webhook ledger insert, duplicate webhook no second insert.

- [x] **Step 2–4: TDD, then** core and gateway tests and `tsc`. Existing billing tests must pass. If they assert the exact status JSON, add the new fields to the expected object.

- [x] **Step 5: Commit** `feat(billing): add employer checkout and iap ledger`

---

### Task 8: AI plan routing and project caps

**Files:**

- Create: `services/ai/src/app/domain/plan_levers.py`
- Modify: `services/ai/src/app/config.py`, `services/ai/src/app/domain/services/ai.py`, `services/ai/src/app/domain/services/project.py`, `services/ai/src/app/infrastructure/openai_client.py`
- Modify: `services/gateway/src/models.ts` (`EFFORTS` includes `MAX`)
- Test: `services/ai/tests/test_plan_levers.py`, `services/gateway/test/handler.test.ts` or the models test if one exists

**Interfaces:**

```python
@dataclass(frozen=True)
class PlanLevers:
    model: str
    effort: str
    reference: str
    tenure: str
    score_band: str
    monthly_micro: int

def levers_for(audience: str, plan: str, config: object) -> PlanLevers: ...
```

Values match PRD 7.13. `reference` is `basic | extended | full`. `tenure` is `same | plus1 | plus2 | all`. `score_band` is `same | up1 | top | all`.

- Managed chat uses `levers_for` when the caller does not pass BYOK. Employer audience is read from the conversation's `company_id` in task 9; this task only needs the pure function and personal plan application.
- FREE OpenRouter payload includes the provider ignore and order from Decision 20.
- `generate_blueprints` counts existing blueprints and raises a domain 403 `PLAN_REQUIRED` when the cap is exceeded.
- Gateway model catalog accepts `MAX`.

- [x] **Step 1: Failing pytest** for all six columns of the table and for the DeepSeek provider payload. Failing gateway test that a model list containing `MAX` is not stripped.

- [x] **Step 2–4: TDD, then** `pytest` for the new file and `npm test` plus `tsc` in gateway.

- [x] **Step 5: Commit** `feat(ai): route managed models by plan`

---

### Task 9: Employer conversations

**Files:**

- Modify: `services/core-api/src/routes/conversations.ts`, `services/core-api/src/handler.ts`
- Modify: `services/gateway/src/routes/conversations.ts`, `services/gateway/src/routes/owner.ts`
- Modify: `services/ai/src/app/domain/services/conversation.py`, `services/ai/src/app/domain/services/ai.py`, the conversation router schema
- Test: `services/core-api/test/employer-conversations.test.ts`, `services/ai/tests/test_employer_conversation.py`

**Interfaces:**

- `POST /conversations` accepts optional `audience`, `postingId`, `applicationId`. Missing audience stays the current personal insert.
- `audience: "EMPLOYER"` requires a verified company. Otherwise 403 `BUSINESS_NOT_VERIFIED`.
- Gateway `GET /conversations?audience=EMPLOYER` lists `company_id` matches for the caller's company. Personal list stays user-owned and excludes company rows.
- `POST /conversations/{id}/attachments` is core (`isCore`). Multipart field `file`. PDF only. Company plan ULTRA. 403 `PLAN_REQUIRED` with `details.requiredPlan = "ULTRA"` otherwise. 201 `{ data: { id, fileName, mimeType } }`.
- AI message handling: intent `interview` on a BASIC company is 403 `PLAN_REQUIRED` `requiredPlan: "PRO"`. Employer managed options replace model and effort from `levers_for("EMPLOYER", plan)`. Posting intent sets `web_search=True`.
- `POST /conversations/{id}/messages` is the non-stream fallback from api-spec 4.8 (docs `8c64ec3`). Keep the existing stream path.
- An employer posting draft is a ```posting-draft fenced block in the assistant message: title, description, requirements, preferred, work conditions.
- Archiving an employer conversation deletes `conversation_attachments` (FK cascade is enough if archive does not delete the row; add an explicit delete on archive).

- [x] **Step 1: Failing tests** for personal create still working without `audience`, employer create without verification 403, Ultra PDF stored, BASIC PDF 403, interview intent on BASIC 403.

- [x] **Step 2–4: TDD, then** core, gateway, and the new pytest.

- [x] **Step 5: Commit** `feat(conversations): add company-owned employer chats`

---

### Task 10: Reference pipeline

**Files:**

- Create: `services/ai/src/app/domain/reference_text.py`
- Modify: the gap-analysis save path (search `fit_score` writers) so a consented user enqueues a sample
- Test: `services/ai/tests/test_reference_text.py`

**Interfaces:**

```python
def features_of(text: str) -> dict: ...
def templates_of(text: str) -> list[str]: ...
def score_band(score: int) -> int: ...
def eligible(samples: list[dict], minimum: int = 30) -> list[dict]: ...
def prompt_lines(samples: list[dict]) -> list[str]: ...
```

- `features_of` returns counts and flags only: `metric_count`, `has_metric`, `tech_depth` (`shallow | concrete`), `links_experience`. It must not return the input text.
- `templates_of` replaces numbers, emails, phone-like runs, and quoted proper names with `{수치}`, `{연락처}`, `{대상}`. The returned strings must not contain the original digits or an `@`.
- `score_band` is `score // 10 * 10`.
- `eligible` drops groups under 30.
- `prompt_lines` states the band and the feature counts. It does not include a template sentence from a group under 30, and it never includes a raw line.
- The save hook no-ops when `user_consents.reference_data` is not true. It inserts one `reference_samples` row per evaluated document. Tests of the pure functions do not need a database. One store test can assert the insert SQL omits the raw body.

- [x] **Step 1: Failing tests** with a résumé sentence that contains a company name, a number, and an email. Assert the template has no digit and no `@`, and a bucket of 29 samples produces an empty prompt list.

- [x] **Step 2–4: TDD, then** `pytest tests/test_reference_text.py` and the suite section that covers gap analysis if the hook touches it.

- [x] **Step 5: Commit** `feat(ai): store generalized reference samples`

---

## Verification before the final report

From `services/core-api`: `npm test` and `npx tsc --noEmit`.

From `services/gateway`: `npm test` and `npx tsc --noEmit`.

From `services/ai`: `pytest`.

Record failures that were already present on `origin/develop` separately from new ones.

## Manual steps (do not perform them)

- Apply `db/migrations/0019_fo_web_employer.sql` by hand on Neon. Deploy does not run it.
- Create Stripe products with `metadata.audience=EMPLOYER` and `metadata.plan=BASIC|PRO|ULTRA`, plus a one-time top-up price of one displayed credit. Checkout quantity is the requested amount. Put the price ids in the env vars from task 7.
- App Store Server Notifications V2 and Google Play RTDN point at `POST /api/v1/billing/webhook/app-store` and `POST /api/v1/billing/webhook/google-play`. Only a JWS that `crypto.subtle.verify` accepts with the env SPKI public key is granted (Decision 39). A plain Pub/Sub JSON body is rejected.
- Set `NTS_SERVICE_KEY`, `MAIL_FROM`, `APP_WEB_ORIGIN`, and `RESEND_API_KEY`. Production mail uses Resend when `RESEND_API_KEY` is set. The Cloudflare `EMAIL` binding is optional because this account has no Cloudflare zone.
- Confirm OpenRouter provider slugs for DeepSeek US hosting and set `OPENROUTER_DEEPSEEK_PROVIDERS` if the default is wrong.

## Contract differences versus api-spec

- `GET /companies/me/members` returns `{ data: [...] }`, not a bare array.
- Posting create, update, and detail include `preferred`, `revision`, and `closedAt`. Update is `PATCH /postings/{id}` with `expectedRevision`. Close is `POST /postings/{id}/close`.
- Company posting list is `GET /companies/me/postings`.
- Employer chat is `POST /conversations` with `audience: "EMPLOYER"`, not a new resource. PDF is `POST /conversations/{id}/attachments`.
- `GET /billing` adds optional `audience` and `source`. Employer `plan` may be `BASIC`.
- `Application.fitScore` is optional. `Settings.notifyApplicationStage` is optional in the type and present in the JSON.
- `Post.author` adds `employer` and `companyName`.
- Applicant stage PATCH does not take `expectedRevision`, matching the frontend client.
- Store webhooks grant only after JWS verification. api-spec 3.15 describes Google Play RTDN as a Pub/Sub push; an unsigned push is 400 (Decision 39).
