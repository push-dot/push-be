import type { Route, Schema } from "./shared.ts";
import {
  get, post, put, patch, del, ref, nullable, obj, arr, str, int, bool, uuid, dateTime, any, enumOf,
  body, ok, okPage, okList, noContent, redirect, pathParam, query, pageParams,
} from "./shared.ts";

const notModified: Schema = { description: "Not Modified (If-None-Match matched the ETag)" };
const accountType = enumOf("PERSONAL", "EMPLOYER");
const companyRole = enumOf("ADMIN", "MEMBER");
const employerPlan = enumOf("BASIC", "PRO", "ULTRA");
const accepted = ok(obj({ accepted: { type: "boolean", const: true } }), "Accepted");
const urlOnly = ok(obj({ url: str }));
const email: Schema = { type: "string", format: "email" };
const password: Schema = { type: "string", minLength: 8, maxLength: 128, description: "8 to 128 code points" };
const providerParam = pathParam("provider", enumOf("google", "github", "apple"));
const tokenParam = pathParam("token", str);
const userIdParam = pathParam("userId");
const imageTypes = ["image/jpeg", "image/png", "image/webp", "image/heic"];

export const routes: Route[] = [
  get("gateway", "/healthz", {
    tag: "health",
    summary: "Liveness check",
    auth: "public",
    responses: { 200: ok(obj({ status: enumOf("ok") })) },
  }),
  get("gateway", "/api/v1/healthz", {
    tag: "health",
    summary: "Liveness check (rate limited per IP)",
    auth: "public",
    responses: { 200: ok(obj({ status: enumOf("ok") })) },
  }),

  get("core", "/api/v1/auth/{provider}/start", {
    tag: "auth",
    summary: "Start OAuth login",
    auth: "public",
    description: "Returns the provider authorization URL. GitHub and Apple do not allow accountType=EMPLOYER. Apple uses response_mode=form_post; its callback is POST /api/v1/auth/apple/callback, not GET. redirectUri must be push://auth/callback, a localhost/127.0.0.1 /auth/callback URL, or an allowed web origin + /auth/callback.",
    params: [
      providerParam,
      query("accountType", { ...accountType, default: "PERSONAL" }),
      { name: "codeChallengeMethod", in: "query", required: true, schema: enumOf("S256") },
      { name: "codeChallenge", in: "query", required: true, schema: str, description: "PKCE S256 challenge" },
      { name: "redirectUri", in: "query", required: true, schema: str, description: "Final app callback that receives ?code=" },
    ],
    responses: { 200: ok(obj({ authorizationUrl: str, state: str, expiresAt: dateTime })) },
  }),
  get("core", "/api/v1/auth/{provider}/callback", {
    tag: "auth",
    summary: "OAuth provider callback",
    auth: "public",
    description: "Called by Google or GitHub. Redirects to the redirectUri given at start with ?code=<exchange code> (valid 60s) for POST /api/v1/auth/exchange. Apple uses POST /api/v1/auth/apple/callback.",
    params: [providerParam, query("code"), query("state")],
    responses: { 302: redirect("Redirect to the app callback with ?code=") },
  }),
  post("core", "/api/v1/auth/apple/callback", {
    tag: "auth",
    summary: "Apple form_post callback",
    auth: "public",
    description: "Apple sends application/x-www-form-urlencoded code and state. Redirects to the redirectUri from start with ?code= for POST /api/v1/auth/exchange. Does not join an existing account by email.",
    body: {
      required: true,
      content: {
        "application/x-www-form-urlencoded": {
          schema: obj({ code: str, state: str, user: str }, ["code", "state"]),
        },
      },
    },
    responses: { 302: redirect("Redirect to the app callback with ?code=") },
  }),
  post("core", "/api/v1/auth/apple/native", {
    tag: "auth",
    summary: "Apple native identity token",
    auth: "public",
    description: "Verifies an identity token from expo-apple-authentication. Audience is the iOS bundle id. The nonce claim is the lowercase hex SHA-256 of the raw nonce. A linked identity returns AuthTokens. First login returns pendingToken and creates no user. Does not join an existing account by email.",
    body: body(obj({ identityToken: str, nonce: str })),
    responses: {
      200: ok({
        oneOf: [
          ref("AuthTokens"),
          obj({ pendingToken: str, expiresIn: int }),
        ],
      }),
    },
  }),
  post("core", "/api/v1/auth/exchange", {
    tag: "auth",
    summary: "Exchange OAuth code for tokens",
    auth: "public",
    description: "A linked personal identity returns AuthTokens and creates no user. First personal Google, GitHub, or Apple login returns pendingToken (15 minutes) and creates no user. Employer login still creates or joins by email. Apple does not join an existing account by email. 400 EMAIL_NOT_VERIFIED when a new Google or GitHub email is not verified. 503 NOT_CONFIGURED when PENDING_SIGNUP_SECRET is empty. Clears a pending account deletion on session issue.",
    body: body(obj({ code: str, codeVerifier: str })),
    responses: {
      200: ok({
        oneOf: [
          ref("AuthTokens"),
          obj({ pendingToken: str, expiresIn: int }),
        ],
      }),
    },
  }),
  post("core", "/api/v1/auth/refresh", {
    tag: "auth",
    summary: "Rotate refresh token",
    auth: "public",
    description: "Reusing a revoked refresh token revokes every session of the user.",
    body: body(obj({ refreshToken: str })),
    responses: { 200: ok(ref("AuthTokens")) },
  }),
  post("core", "/api/v1/auth/logout", {
    tag: "auth",
    summary: "Log out (revoke refresh token)",
    auth: "public",
    body: body(obj({ refreshToken: str })),
    responses: { 204: noContent },
  }),
  get("gateway", "/api/v1/auth/me", {
    tag: "auth",
    summary: "Current user",
    description: "Answered by the gateway with an ETag (If-None-Match gives 304). Core returns the same fields.",
    responses: { 200: ok(ref("User")), 304: notModified },
  }),
  post("core", "/api/v1/auth/email/signup", {
    tag: "auth",
    summary: "Email signup (sends verification link)",
    auth: "public",
    description: "Employer accounts only. Rate limited to 3 mails per minute per email. 409 EMAIL_TAKEN (details.accountType) if a user already has the email.",
    body: body(obj({
      email,
      password,
      accountType: enumOf("EMPLOYER"),
      displayName: { type: "string", minLength: 1, maxLength: 80 },
    }, ["email", "password", "accountType", "displayName"])),
    responses: { 202: accepted },
  }),
  post("core", "/api/v1/auth/email/verify", {
    tag: "auth",
    summary: "Verify email and create the account",
    auth: "public",
    body: body(obj({ token: str })),
    responses: { 200: ok(ref("AuthTokens")) },
  }),
  post("core", "/api/v1/auth/email/login", {
    tag: "auth",
    summary: "Email login",
    auth: "public",
    description: "401 INVALID_CREDENTIALS, 403 EMAIL_NOT_VERIFIED. Rate limited to 10 per minute per email. Clears a pending account deletion.",
    body: body(obj({ email, password: str })),
    responses: { 200: ok(ref("AuthTokens")) },
  }),
  post("core", "/api/v1/auth/email/password-reset", {
    tag: "auth",
    summary: "Request password reset link",
    auth: "public",
    description: "Always 202, whether or not the email exists.",
    body: body(obj({ email })),
    responses: { 202: accepted },
  }),
  post("core", "/api/v1/auth/email/password-reset/confirm", {
    tag: "auth",
    summary: "Set new password with reset token",
    auth: "public",
    description: "Revokes every session of the user.",
    body: body(obj({ token: str, password })),
    responses: { 204: noContent },
  }),
  post("core", "/api/v1/auth/phone/send", {
    tag: "auth",
    summary: "Send a personal phone code",
    auth: "optional",
    description: "E.164 phone. Stores a hashed 6-digit code. Resend cooldown defaults to 168 seconds (429 RATE_LIMITED, details.retryAfterSec). 503 NOT_CONFIGURED unless PHONE_SMS_MODE=log and APP_ENV=development, or a test sender is injected. The code is never in the response. Employer sessions are 403.",
    body: body(obj({ phone: { type: "string", pattern: "^\\+[1-9]\\d{7,14}$" } }, ["phone"])),
    responses: { 202: ok(obj({ cooldownSeconds: int, expiresAt: dateTime }), "Accepted") },
  }),
  post("core", "/api/v1/auth/phone/verify", {
    tag: "auth",
    summary: "Verify a phone code and sign in",
    auth: "optional",
    description: "Authorization is ignored. Without pendingToken: log into the personal account for this phone, or create a phone-only account (created=true). With a pending social token and a new phone: create one account that has that identity and the phone (created=true). With a pending token and a phone-only account: link that one social identity (linked=true plus provider) and return its session. With a pending token and an account that already has a social identity, including the same provider with another subject: 409 PHONE_ALREADY_REGISTERED (details.existingProviders) and attach nothing. 400 PHONE_CODE_INVALID, 400 PHONE_CODE_EXPIRED, 401 UNAUTHENTICATED, 401 TOKEN_EXPIRED, 429 RATE_LIMITED, 409 PHONE_TAKEN if that identity belongs to another account. Signup terms are not stored here.",
    body: body(obj({
      phone: { type: "string", pattern: "^\\+[1-9]\\d{7,14}$" },
      code: { type: "string", pattern: "^\\d{6}$" },
      pendingToken: str,
    }, ["phone", "code"])),
    responses: {
      200: ok(obj({
        accessToken: str,
        refreshToken: str,
        expiresIn: int,
        created: bool,
        linked: bool,
        provider: str,
        user: obj({
          id: uuid,
          displayName: str,
          locale: str,
          accountType,
          companyId: nullable(uuid),
          companyRole: nullable(companyRole),
        }),
      }, ["accessToken", "refreshToken", "expiresIn", "created", "user"])),
    },
  }),
  del("core", "/api/v1/me", {
    tag: "auth",
    summary: "Delete account",
    description: "Marks the account for deletion (logging in within 30 days restores it), cancels Stripe subscriptions and revokes all sessions. A sole company ADMIN also marks the company; an ADMIN with other members gets 409 ADMIN_TRANSFER_REQUIRED.",
    responses: { 204: noContent },
  }),

  get("core", "/api/v1/billing", {
    tag: "billing",
    summary: "Billing status and credit balance",
    description: "EMPLOYER accounts get the company plan and balance (404 without a company).",
    responses: { 200: ok(ref("BillingStatus")) },
  }),
  post("core", "/api/v1/billing/checkout", {
    tag: "billing",
    summary: "Create Stripe subscription checkout session",
    description: "Employer company ADMIN only. planId is BASIC, PRO, or ULTRA. Anyone else gets 403. Personal plans are in-app only.",
    body: body(obj({ planId: enumOf("PRO", "ULTRA", "BASIC") })),
    responses: { 200: ok(obj({ url: str, expiresAt: nullable(dateTime) })) },
  }),
  post("core", "/api/v1/billing/topup", {
    tag: "billing",
    summary: "Create Stripe credit top-up checkout session",
    description: "EMPLOYER: company ADMIN only, credits go to the company.",
    body: body(obj({ amount: { type: "integer", minimum: 1, maximum: 100000, description: "Credit units (quantity of the top-up price)" } })),
    responses: { 200: urlOnly },
  }),
  post("core", "/api/v1/billing/portal", {
    tag: "billing",
    summary: "Create Stripe customer portal session",
    description: "409 INVALID_TRANSITION when the user has no Stripe customer.",
    responses: { 200: urlOnly },
  }),
  post("core", "/api/v1/billing/iap/verify", {
    tag: "billing",
    summary: "Verify an App Store / Google Play purchase",
    description: "signedTransaction is required for APP_STORE, purchaseToken for GOOGLE_PLAY. Subscriptions activate the plan (409 ALREADY_SUBSCRIBED if already active); top-up products only add credits and return the current plan.",
    body: body(obj({
      platform: enumOf("APP_STORE", "GOOGLE_PLAY"),
      productId: str,
      signedTransaction: str,
      purchaseToken: str,
    }, ["platform", "productId"])),
    responses: { 200: ok(obj({ plan: nullable(str), periodEndsAt: nullable(dateTime) })) },
  }),
  get("core", "/api/v1/billing/ledger", {
    tag: "billing",
    summary: "Credit ledger",
    description: "EMPLOYER accounts see the company ledger.",
    params: [...pageParams],
    responses: { 200: okPage(ref("LedgerEntry")) },
  }),

  get("core", "/api/v1/ai/usage", {
    tag: "ai",
    summary: "AI usage records",
    params: [
      ...pageParams,
      query("from", dateTime, "Inclusive lower bound on createdAt (RFC3339)"),
      query("to", dateTime, "Inclusive upper bound on createdAt (RFC3339)"),
    ],
    responses: { 200: okPage(ref("AccountAiUsage")) },
  }),
  get("core", "/api/v1/ai/jobs/{id}", {
    tag: "ai",
    summary: "AI job status",
    description: "Visible to the job owner and members of the job's company.",
    params: [pathParam("id")],
    responses: { 200: ok(ref("AiJob")) },
  }),
  post("core", "/api/v1/postings/{id}/fit", {
    tag: "ai",
    summary: "Queue a posting fit analysis",
    description: "Enqueues a fit job for one of the user's documents against the posting; poll GET /api/v1/ai/jobs/{jobId}. 429 QUEUE_BUSY (details.retryAfterSec) under backpressure.",
    params: [pathParam("id")],
    body: body(obj({ documentId: uuid })),
    responses: { 202: ok(obj({ jobId: uuid }), "Accepted") },
  }),
  get("gateway", "/api/v1/ai/models", {
    tag: "ai",
    summary: "AI model catalog",
    params: [query("provider", enumOf("OPENAI", "OPENROUTER", "CLAUDE", "GEMINI", "GROK"))],
    responses: { 200: okList(ref("AiModel")), 304: notModified },
  }),
  get("gateway", "/api/v1/integrations/job-sites", {
    tag: "ai",
    summary: "Job site integrations catalog",
    responses: { 200: okList(ref("JobSite")), 304: notModified },
  }),

  post("core", "/api/v1/companies/verify", {
    tag: "companies",
    summary: "Verify business registration and create company",
    description: "EMPLOYER only. Checks the business with the NTS API and makes the caller ADMIN. 422 BUSINESS_NOT_VERIFIED (details.reason MISMATCH, SUSPENDED or CLOSED); 409 COMPANY_EXISTS or CONFLICT (already in a company). Profile fields are absent in this response.",
    body: body(obj({
      bNo: { type: "string", pattern: "^\\d{10}$", description: "Business registration number" },
      startDt: { type: "string", pattern: "^\\d{8}$", description: "Opening date YYYYMMDD" },
      pNm: { type: "string", minLength: 1, description: "Representative name" },
      bNm: { type: "string", minLength: 1, description: "Business name" },
    })),
    responses: { 201: ok(ref("Company"), "Created") },
  }),
  get("core", "/api/v1/companies/me", {
    tag: "companies",
    summary: "My company",
    responses: { 200: ok(ref("Company")) },
  }),
  patch("core", "/api/v1/companies/me", {
    tag: "companies",
    summary: "Update company profile",
    description: "ADMIN only. Only the listed keys are allowed; null clears a field.",
    body: body({
      type: "object",
      additionalProperties: false,
      properties: {
        logoKey: nullable({ type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$", description: "Key from POST /api/v1/uploads/images" }),
        industry: nullable({ type: "string", minLength: 1, maxLength: 80 }),
        website: nullable({ type: "string", format: "uri", maxLength: 2000, description: "http or https URL" }),
        intro: nullable({ type: "string", minLength: 1, maxLength: 2000 }),
        representativeName: nullable({ type: "string", minLength: 1, maxLength: 80 }),
      },
    }),
    responses: { 200: ok(ref("Company")) },
  }),
  get("core", "/api/v1/companies/me/members", {
    tag: "companies",
    summary: "List company members",
    responses: { 200: okList(ref("CompanyMember")) },
  }),
  patch("core", "/api/v1/companies/me/members/{userId}", {
    tag: "companies",
    summary: "Transfer ADMIN role to a member",
    description: "ADMIN only. The caller becomes MEMBER.",
    params: [userIdParam],
    body: body({ type: "object", additionalProperties: false, properties: { role: enumOf("ADMIN") }, required: ["role"] }),
    responses: { 204: noContent },
  }),
  del("core", "/api/v1/companies/me/members/{userId}", {
    tag: "companies",
    summary: "Remove a company member",
    description: "ADMIN only. 409 CONFLICT when removing the last ADMIN.",
    params: [userIdParam],
    responses: { 204: noContent },
  }),
  get("core", "/api/v1/companies/me/invites", {
    tag: "companies",
    summary: "List pending invites",
    description: "ADMIN only.",
    responses: { 200: okList(ref("CompanyInvite")) },
  }),
  post("core", "/api/v1/companies/me/invites", {
    tag: "companies",
    summary: "Invite a member by email",
    description: "ADMIN only. Re-inviting a pending email resends the link. 403 SEAT_LIMIT when seats are full; 409 CONFLICT if already a member.",
    body: body(obj({ email })),
    responses: { 201: ok(obj({ email: str }), "Created") },
  }),
  get("core", "/api/v1/companies/invites/{token}", {
    tag: "companies",
    summary: "Preview an invite",
    auth: "public",
    description: "404 when the token is unknown, accepted, expired, or the company is pending deletion.",
    params: [tokenParam],
    responses: {
      200: ok(obj({ companyName: str, inviterName: str, inviterRole: companyRole, email: str, expiresAt: dateTime })),
    },
  }),
  post("core", "/api/v1/companies/invites/{token}/accept", {
    tag: "companies",
    summary: "Accept an invite",
    description: "EMPLOYER only; the account email must match the invite email (403). Joins as MEMBER.",
    params: [tokenParam],
    responses: { 204: noContent },
  }),

  get("core", "/api/v1/me/consents", {
    tag: "consents",
    summary: "Get data consents",
    responses: { 200: ok(ref("Consents")) },
  }),
  put("core", "/api/v1/me/consents", {
    tag: "consents",
    summary: "Update data consents",
    description: "Setting referenceData false deletes the user's reference samples.",
    body: body(obj({ referenceData: bool })),
    responses: { 200: ok(ref("Consents")) },
  }),
  put("core", "/api/v1/me/consents/terms", {
    tag: "consents",
    summary: "Store signup terms",
    description: "Required flags age14, serviceTerms, and privacy are accepted only as true and cannot be cleared. Send all three together. marketing can change on its own. termsVersion is stored on the first agreement; a later call keeps the stored version. Omitted version is 2026-10-29.",
    body: body(obj({
      age14: bool,
      serviceTerms: bool,
      privacy: bool,
      marketing: bool,
      termsVersion: { type: "string", minLength: 1, maxLength: 64 },
    }, [])),
    responses: { 200: ok(ref("Consents")) },
  }),

  post("core", "/api/v1/uploads/images", {
    tag: "uploads",
    summary: "Upload an image",
    description: "multipart/form-data with a `file` part, max 10 MiB. The part content type must match the sniffed bytes (JPEG, PNG, WebP or HEIC). 413 PAYLOAD_TOO_LARGE.",
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: obj({ file: { type: "string", format: "binary" } }),
          encoding: { file: { contentType: imageTypes.join(", ") } },
        },
      },
    },
    responses: { 201: ok(ref("UploadedImage"), "Created") },
  }),
  get("core", "/api/v1/uploads/images/{name}", {
    tag: "uploads",
    summary: "Download an uploaded image",
    auth: "public",
    params: [pathParam("name", { type: "string", pattern: "^[0-9a-f]{32}\\.(jpg|png|webp|heic)$", example: "0123456789abcdef0123456789abcdef.png" })],
    responses: {
      200: {
        description: "Image bytes; content type follows the file extension",
        content: Object.fromEntries(imageTypes.map((type) => [type, { schema: { type: "string", format: "binary" } }])),
      },
    },
  }),
];

export const schemas: Record<string, Schema> = {
  User: obj({
    id: uuid,
    displayName: str,
    locale: str,
    createdAt: dateTime,
    accountType,
    companyId: nullable(uuid),
    companyRole: nullable(companyRole),
    email: { type: "string", description: "Empty string when unknown" },
    provider: { type: "string", description: "google, github, email, or empty" },
    plan: enumOf("FREE", "PRO", "ULTRA"),
  }),
  AuthTokens: obj({
    accessToken: str,
    refreshToken: str,
    expiresIn: { type: "integer", description: "Access token lifetime in seconds (900)" },
    user: obj({
      id: uuid,
      displayName: str,
      locale: str,
      accountType,
      companyId: nullable(uuid),
      companyRole: nullable(companyRole),
    }),
  }),
  BillingStatus: obj({
    subscriptionStatus: enumOf("NONE", "ACTIVE", "CANCELED"),
    plan: nullable({ type: "string", enum: ["FREE", "PRO", "ULTRA", "BASIC"], description: "PERSONAL: FREE, PRO or ULTRA. EMPLOYER: BASIC, PRO, ULTRA or null" }),
    periodEndsAt: nullable(dateTime),
    balanceMicroCredits: int,
    reservedMicroCredits: int,
    monthlyMicroCredits: int,
    spentMicroCredits: { type: "integer", description: "Settled usage this UTC month" },
    audience: accountType,
    source: nullable(enumOf("STRIPE", "APP_STORE", "GOOGLE_PLAY")),
  }),
  LedgerEntry: obj({
    id: uuid,
    type: { type: "string", description: "Currently PURCHASE" },
    amountMicroCredits: int,
    balanceAfter: int,
    referenceId: nullable(str),
    createdAt: dateTime,
  }),
  AccountAiUsage: obj({
    id: uuid,
    operationId: nullable(uuid),
    provider: str,
    model: str,
    managed: bool,
    inputTokens: int,
    outputTokens: int,
    costMicroCredits: int,
    status: { type: "string", enum: ["RESERVED", "SETTLED", "RELEASED"] },
    createdAt: dateTime,
  }),
  AiJob: obj({
    id: uuid,
    type: enumOf("chat", "employer_ai", "document", "fit", "ingest", "notify"),
    status: enumOf("QUEUED", "RUNNING", "RETRY", "DONE", "FAILED", "DEAD", "CANCELLED"),
    progress: { ...any, description: "payload.progress or null" },
    result: { ...any, description: "Job result JSON or null" },
    error: { ...any, description: "Job error JSON or null" },
    createdAt: dateTime,
    updatedAt: dateTime,
  }),
  Company: obj({
    id: uuid,
    bNo: str,
    name: str,
    plan: nullable(employerPlan),
    verifiedAt: nullable(dateTime),
    role: companyRole,
    seats: obj({ used: int, limit: { type: "integer", description: "PRO 2, ULTRA 5, otherwise 0" } }),
    logoKey: nullable(str),
    logoUrl: nullable(str),
    industry: nullable(str),
    website: nullable(str),
    intro: nullable(str),
    representativeName: nullable(str),
  }, ["id", "bNo", "name", "plan", "verifiedAt", "role", "seats"]),
  CompanyMember: obj({
    userId: uuid,
    email: str,
    displayName: str,
    role: companyRole,
    joinedAt: dateTime,
  }),
  CompanyInvite: obj({
    id: uuid,
    email: str,
    expiresAt: dateTime,
  }),
  Consents: obj({
    referenceData: bool,
    updatedAt: nullable(dateTime),
    terms: obj({
      version: nullable(str),
      age14At: nullable(dateTime),
      serviceTermsAt: nullable(dateTime),
      privacyAt: nullable(dateTime),
      marketing: bool,
      marketingAt: nullable(dateTime),
    }),
  }),
  UploadedImage: obj({
    key: { type: "string", pattern: "^[0-9a-f]{32}\\.(jpg|png|webp|heic)$" },
    url: { type: "string", description: "/api/v1/uploads/images/<key>" },
  }),
  AiModel: obj({
    provider: enumOf("OPENAI", "OPENROUTER", "CLAUDE", "GEMINI", "GROK"),
    model: str,
    label: str,
    available: bool,
    supportedEfforts: arr(enumOf("LOW", "MEDIUM", "HIGH", "MAX")),
  }),
  JobSite: obj({
    provider: enumOf("WANTED", "JUMPIT", "JOBKOREA"),
    enabled: bool,
    permissionVerified: bool,
    mode: enumOf("MANUAL_CHECKLIST"),
    supportedFields: arr(str),
    checklist: arr(str),
  }),
};
